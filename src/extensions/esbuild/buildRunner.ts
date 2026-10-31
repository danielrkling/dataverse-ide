import type * as vscodeType from "vscode";

import {
  createWorkspaceReader,
  runBuild,
  runTransform,
  type BuildOutputFile,
  type BuildResponse,
  type WorkspaceReader,
} from "./compiler.js";

/*
 * Main-thread esbuild runner.
 *
 * The compiler reads real workspace files through vscode.workspace.fs.
 * `virtualFiles` are an optional, per-build overlay for generated sources
 * such as Tailwind's ephemeral @plugin entry module.
 *
 * `files` and `absentPaths` remain in the public type only for Rolldown's
 * existing worker/lazyBuild protocol. The main-thread esbuild compiler does
 * not use them.
 */

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
  entryNames?: string;
  chunkNames?: string;
  outExtension?: Record<string, string>;

  /*
   * Tagged JSX transform applied to workspace source files before esbuild
   * transpiles them.
   */
  taggedJsx?: "off" | "toJsx" | "toTagged";

  /*
   * Compatibility fields used by the Rolldown worker and lazyBuild().
   *
   * Main-thread esbuild ignores these because it reads files directly through
   * vscode.workspace.fs.
   */
  files?: Record<string, string>;
  absentPaths?: string[];
};

export type TransformRequestInput = {
  filename: string;
  source: string;
  minify?: boolean;
};

/*
 * The compiler internally tracks request IDs, but callers do not need them.
 * Keeping IDs out of the public response lets the Rolldown runner return
 * its own synthetic failures without fabricating an esbuild request ID.
 */
export type BuildResponseOk = Omit<Extract<BuildResponse, { ok: true }>, "id"> & {
  /*
   * Rolldown's lazy worker protocol uses this. Main-thread esbuild never
   * returns it because it resolves workspace files directly.
   */
  needFiles?: string[];
};

export type BuildResponseErr = Omit<Extract<BuildResponse, { ok: false }>, "id">;

export type BuildRunnerResponse = BuildResponseOk | BuildResponseErr;

export class EsbuildBuildRunner {
  private nextRequestId = 1;

  private disposed = false;

  private initialized = false;

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
      const response = await runBuild({
        id,
        type: "build",
        /*
         * New reader per build:
         *
         * - caches duplicate reads during this build
         * - cannot return stale content after a workspace file changes
         */
        workspace: createWorkspaceReader(this.vscode, this.workspaceRootUri),

        /*
         * `files` and `absentPaths` are intentionally ignored by compiler.ts.
         * Destructure them out before passing the direct-filesystem request.
         */
        ...(() => {
          const { files: _files, absentPaths: _absentPaths, ...mainThreadInput } = input;

          return mainThreadInput;
        })(),
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

  dispose(): void {
    /*
     * esbuild-wasm is process-global and has no per-runner teardown API.
     * Mark this facade unusable so disposed extensions cannot start new work.
     */
    this.disposed = true;
  }
}
