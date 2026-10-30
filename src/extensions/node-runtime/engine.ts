/*
 * node-runtime extension: run JavaScript in the workspace like `node`.
 *
 * Engine: almostnode's main-thread, same-origin mode. This shares the page
 * auth context with the Dataverse origin.
 *
 * TypeScript/TSX/JSX files are transpiled through the main-thread esbuild
 * compiler before being copied into almostnode's VirtualFS.
 */

import { createRuntime } from "almostnode";
import type { IRuntime } from "almostnode";

import type * as vscodeType from "vscode";

import { getSharedVfs } from "../sharedVfs.js";
import { EsbuildBuildRunner } from "../esbuild/buildRunner.js";

export type NodeRuntimeEngine = {
  runFile: (path: string) => Promise<number>;
  dispose: () => void;
};

const RUNTIME_ROOT = "/";

const IGNORED_DIRECTORIES = [
  "node_modules",
  ".git",
  ".ide-build",
];

export function createAlmostnodeEngine(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  outputChannel: vscodeType.OutputChannel,
): NodeRuntimeEngine {
  let runtime: IRuntime | undefined;

  /*
   * esbuild now runs in the main thread and reads workspace files directly
   * through vscode.workspace.fs. For transform() calls we still provide the
   * source text explicitly, so this is primarily used as a TS/JSX compiler.
   */
  const buildRunner = new EsbuildBuildRunner(
    vscode,
    rootUri,
    outputChannel,
  );

  /*
   * Source files whose content changed between runs are re-transpiled and
   * cached. The previous length-only key could incorrectly reuse output when
   * two revisions had the same character count, so cache by full source text.
   */
  const transpileCache = new Map<
    string,
    | {
      source: string;
      contents: string;
    }
    | {
      invalid: true;
    }
  >();

  async function transpileForRuntime(
    relativePath: string,
    contents: string,
  ): Promise<string> {
    if (!/\.(ts|tsx|jsx|mts|cts)$/i.test(relativePath)) {
      return contents;
    }

    const cached = transpileCache.get(relativePath);

    if (
      cached != null &&
      "source" in cached &&
      cached.source === contents
    ) {
      return cached.contents;
    }

    const response = await buildRunner.transform({
      filename: relativePath,
      source: contents,
    });

    if (!response.ok) {
      transpileCache.set(relativePath, {
        invalid: true,
      });

      throw new Error(
        `[node-runtime] Transpiling ${relativePath} failed: ${response.error}`,
      );
    }

    const output = response.outputs[0];

    if (output == null) {
      transpileCache.set(relativePath, {
        invalid: true,
      });

      throw new Error(
        `[node-runtime] Transpiling ${relativePath} produced no output.`,
      );
    }

    transpileCache.set(relativePath, {
      source: contents,
      contents: output.text,
    });

    return output.text;
  }

  async function ensureRuntime(): Promise<IRuntime> {
    if (runtime != null) {
      return runtime;
    }

    const vfs = getSharedVfs();

    runtime = await createRuntime(vfs, {
      /*
       * Trusted-code mode: required for main-thread same-origin execution.
       */
      dangerouslyAllowSameOrigin: true,

      cwd: RUNTIME_ROOT,

      env: {
        NODE_ENV: "development",
      },

      onConsole: (method, args) => {
        const message = args
          .map((argument) => {
            if (typeof argument === "string") {
              return argument;
            }

            try {
              return JSON.stringify(argument);
            } catch {
              return String(argument);
            }
          })
          .join(" ");

        outputChannel.appendLine(`[node:${method}] ${message}`);
      },
    });

    return runtime;
  }

  async function syncWorkspaceIntoVfs(runtimeInstance: IRuntime): Promise<void> {
    const vfs = runtimeInstance.getVFS?.();

    if (vfs == null) {
      throw new Error(
        "The active node runtime does not expose its virtual filesystem.",
      );
    }

/*
 * The shared VFS may contain an empty or incomplete node_modules directory
 * after a reload or a partial install. Its mere existence does not prove
 * that workspace dependencies are available, so synchronize node_modules
 * from the mounted workspace for every run.
 */
const syncNodeModules = true;

    const uris = await vscode.workspace.findFiles(
      "**/*",
      "{**/.git/**,**/.ide-build/**}",
      20000,
    );

    for (const uri of uris) {
      const relativePath = vscode.workspace
        .asRelativePath(uri, false)
        .replaceAll("\\", "/");

      if (relativePath.length === 0) {
        continue;
      }

      const segments = relativePath.split("/");

      if (
        segments.some(
          (segment) =>
            segment === ".git"
        )
      ) {
        continue;
      } 

      if (segments.includes("node_modules") && !syncNodeModules) {
        continue;
      }

      const isTextFile =
        /\.(ts|tsx|js|jsx|mjs|cjs|json|txt|css|html|md|ya?ml)$/i.test(
          relativePath,
        );

      if (!isTextFile) {
        continue;
      }

      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const contents = new TextDecoder().decode(bytes);

        const directorySegments = segments.slice(0, -1);

        if (directorySegments.length > 0) {
          vfs.mkdirSync(`/${directorySegments.join("/")}`, {
            recursive: true,
          });
        }

        /*
         * almostnode resolves JS/JSON-style CommonJS paths. Store TS-family
         * source files as .js after transpilation.
         */
        let fileName = segments.at(-1) ?? "";

        fileName = fileName.replace(
          /\.(ts|tsx|jsx|mts|cts)$/i,
          ".js",
        );

        const targetPath =
          directorySegments.length > 0
            ? `/${directorySegments.join("/")}/${fileName}`
            : `/${fileName}`;

        try {
          const transformed = await transpileForRuntime(
            relativePath,
            contents,
          );

          vfs.writeFileSync(targetPath, transformed);
        } catch (error) {
          outputChannel.appendLine(
            error instanceof Error ? error.message : String(error),
          );
        }
      } catch {
        /*
         * Ignore unreadable or binary files. Runtime dependency resolution
         * will report a meaningful error if one is actually required.
         */
      }
    }
  }

  return {
    async runFile(entryPath: string): Promise<number> {
      const normalizedEntry = entryPath
        .replaceAll("\\", "/")
        .replace(/^\/+/, "");

      const runtimeEntry = normalizedEntry.replace(
        /\.(ts|tsx|jsx|mts|cts)$/i,
        ".js",
      );

      outputChannel.appendLine(`[node] Running ${normalizedEntry}…`);

      const started = Date.now();

      const runtimeInstance = await ensureRuntime();

      /*
       * Fresh module graph per run; shared VFS content persists, including
       * npm packages synchronized by the npm extension.
       */
      runtimeInstance.clearCache();

      await syncWorkspaceIntoVfs(runtimeInstance);

      try {
        await runtimeInstance.runFile(`/${runtimeEntry}`);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);

        outputChannel.appendLine(`[node] Uncaught: ${message}`);
        outputChannel.show(true);

        return 1;
      }

      outputChannel.appendLine(
        `[node] Finished in ${Date.now() - started}ms.`,
      );

      return 0;
    },

    dispose() {
      runtime?.terminate?.();
      buildRunner.dispose();
      runtime = undefined;
      transpileCache.clear();
    },
  };
}

export {
  IGNORED_DIRECTORIES as NODE_RUNTIME_IGNORED_DIRECTORIES,
};