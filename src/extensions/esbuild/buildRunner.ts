import type * as vscodeType from "vscode";

import {
  createWorkspaceReader,
  EsbuildBuildSession,
  runTransform,
  type BuildOutputFile,
  type BuildResponse,
  type WorkspaceReader,
} from "./compiler.js";

import { captureDirtyDocuments, dirtyDocumentText } from "../shared/liveDocuments.js";

/*
 * Main-thread esbuild runner.
 *
 * The compiler reads real workspace files through vscode.workspace.fs.
 * `virtualFiles` are an optional, per-build overlay for generated sources
 * such as Tailwind's ephemeral @plugin entry module.
 *
 * Dirty editor buffers are layered over the filesystem. Without this, a build
 * triggered while typing silently compiled the last *saved* content, which
 * made esbuild (and watch mode) look one save behind the editor.
 */

/*
 * Wraps the workspace reader so open, unsaved documents are visible to the
 * build. The snapshot is taken per build, so it always reflects the state at
 * the moment the build starts.
 */
function createLiveWorkspaceReader(
  vscode: typeof vscodeType,
  workspaceRootUri: vscodeType.Uri,
): WorkspaceReader {
  const disk = createWorkspaceReader(vscode, workspaceRootUri);
  const dirtyDocuments = captureDirtyDocuments(vscode, workspaceRootUri);

  if (dirtyDocuments.size === 0) {
    return disk;
  }

  return {
    stats: disk.stats,

    async readText(path: string): Promise<string | undefined> {
      const live = dirtyDocumentText(dirtyDocuments, path);

      return live != null ? live : disk.readText(path);
    },

    ...(disk.readDir != null ? { readDir: (path: string) => disk.readDir!(path) } : {}),
  };
}

/*
 * Compact per-build filesystem telemetry. A healthy direct-FS build does one
 * file read per module and one directory listing per directory reached; the
 * counters make it obvious when resolution is doing probe work instead.
 */
function formatReaderStats(reader: WorkspaceReader): string {
  const stats = reader.stats;

  if (stats == null) {
    return "";
  }

  return (
    ` (fs: ${stats.fileReads} file reads, ${stats.fileReadCacheHits} cached; ` +
    `${stats.directoryReads} dir listings, ${stats.directoryReadCacheHits} cached)`
  );
}

export type { BuildOutputFile };

export type BuildRequestInput = {
  /** Workspace-relative or virtual entry point, e.g. src/app.ts. */
  entry: string;

  /*
   * Optional generated source files for this build only. Keys are
   * workspace-relative virtual paths and take precedence over physical files.
   */
  virtualFiles?: Record<string, string>;

  format?: "esm" | "iife" | "cjs";
  platform?: "browser" | "node" | "neutral";
  charset?: "ascii" | "utf8";
  globalName?: string;

  minify?: boolean;
  sourcemap?: boolean | "linked" | "inline" | "external" | "both";
  sourceRoot?: string;
  sourcesContent?: boolean;

  target?: string | string[];
  treeShaking?: boolean;
  keepNames?: boolean;
  legalComments?: "none" | "inline" | "eof" | "linked" | "external";
  lineLimit?: number;
  drop?: ("console" | "debugger")[];
  banner?: { js?: string; css?: string };
  footer?: { js?: string; css?: string };
  pure?: string[];

  jsx?: "transform" | "preserve" | "automatic";
  jsxFactory?: string;
  jsxFragment?: string;
  jsxImportSource?: string;
  jsxDev?: boolean;
  jsxSideEffects?: boolean;

  bundle?: boolean;
  splitting?: boolean;
  external?: string[];
  define?: Record<string, string>;
  loader?: Record<string, string>;
  entryNames?: string;
  chunkNames?: string;
  outExtension?: Record<string, string>;

  /*
   * Solid JSX compiler backend: "off" (default), "v1" (babel-preset-solid),
   * or "v2" (@solidjs/babel-plugin). Compiles workspace .jsx/.tsx before
   * esbuild's loaders run.
   */
  solid?: "off" | "v1" | "v2";
};

export type TransformRequestInput = {
  filename: string;
  source: string;
  minify?: boolean;
};

/*
 * The compiler internally tracks request IDs, but callers do not need them.
 * Keeping IDs out of the public response keeps the runner API independent of
 * the compiler's request bookkeeping.
 */
export type BuildResponseOk = Omit<Extract<BuildResponse, { ok: true }>, "id">;

export type BuildResponseErr = Omit<Extract<BuildResponse, { ok: false }>, "id">;

export type BuildRunnerResponse = BuildResponseOk | BuildResponseErr;

export class EsbuildBuildRunner {
  private nextRequestId = 1;

  private disposed = false;

  private initialized = false;

  private readonly buildSession = new EsbuildBuildSession();

  private latestDependencies: readonly string[] = [];

  constructor(
    private readonly vscode: typeof vscodeType,
    private readonly workspaceRootUri: vscodeType.Uri,
    private readonly outputChannel: vscodeType.OutputChannel,
  ) {}

  async build(input: BuildRequestInput): Promise<BuildRunnerResponse> {
    const id = this.nextRequestId++;

    if (this.disposed) {
      return {
        ok: false,
        error: "[esbuild] build runner has been disposed.",
      };
    }

    try {
      const started = performance.now();
      const workspace = createLiveWorkspaceReader(this.vscode, this.workspaceRootUri);

      const response = await this.buildSession.build({
        id,
        type: "build",
        /*
         * New reader per build:
         *
         * - caches duplicate reads during this build
         * - cannot return stale content after a workspace file changes
         */
        workspace,
        ...input,
      });

      const elapsed = Math.round(performance.now() - started);

      if (!this.initialized) {
        this.initialized = true;

        this.outputChannel.appendLine(
          "[esbuild] main-thread compiler initialized (direct workspace filesystem reads).",
        );
      }

      this.outputChannel.appendLine(
        `[esbuild] build #${id} ${elapsed}ms${formatReaderStats(workspace)}`,
      );

      /*
       * A failed build still reports the paths resolution reached, so watch
       * can rebuild when the broken file (or its importer) is edited. Keep
       * the previous graph when the failure happened before resolution.
       */
      if (response.ok) {
        this.latestDependencies = response.dependencies;
      } else if (response.dependencies != null && response.dependencies.length > 0) {
        this.latestDependencies = response.dependencies;
      }

      return response;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async transform(input: TransformRequestInput): Promise<BuildRunnerResponse> {
    const id = this.nextRequestId++;

    if (this.disposed) {
      return {
        ok: false,
        error: "[esbuild] build runner has been disposed.",
      };
    }

    try {
      const response = await runTransform({
        id,
        type: "transform",
        ...input,
      });

      if (!this.initialized) {
        this.initialized = true;

        this.outputChannel.appendLine(
          "[esbuild] main-thread compiler initialized (direct workspace filesystem reads).",
        );
      }

      return response;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Workspace-relative files reached by the last successful build. */
  get dependencies(): readonly string[] {
    return this.latestDependencies;
  }

  dispose(): void {
    /*
     * esbuild-wasm is process-global, but this runner owns an incremental
     * context. Dispose it so the context and its cached graph are released.
     */
    this.disposed = true;
    void this.buildSession.dispose();
  }
}
