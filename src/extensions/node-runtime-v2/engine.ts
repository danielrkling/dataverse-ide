/*
 * node-runtime-v2 engine: direct workspace fs.
 *
 * Unlike the original node-runtime extension, this does not copy the
 * workspace into almostnode's VirtualFS. A per-run loader reads and
 * resolves only the modules the entry actually reaches through
 * vscode.workspace.fs, and the fs shim's writes are flushed back to the
 * workspace when the run finishes.
 */

import type * as vscodeType from "vscode";

export type DirectNodeEngine = {
  runFile: (path: string) => Promise<number>;
  dispose: () => void;
};

function formatArgument(argument: unknown): string {
  if (typeof argument === "string") {
    return argument;
  }

  try {
    return JSON.stringify(argument);
  } catch {
    return String(argument);
  }
}

export function createDirectNodeEngine(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  outputChannel: vscodeType.OutputChannel,
): DirectNodeEngine {
  return {
    async runFile(entryPath: string): Promise<number> {
      /*
       * Imported on first run so extension activation does not pull
       * almostnode or esbuild-wasm into the boot chunk.
       */
      const [
        { createProcess },
        { createRuntimeFs },
        { createModuleLoader },
        { createWorkspaceFs, normalizePath },
      ] = await Promise.all([
        import("almostnode"),
        import("./fsShim.js"),
        import("./loader.js"),
        import("./workspace.js"),
      ]);

      const normalized = normalizePath(entryPath.replace(/^\/+/, ""));
      const started = Date.now();

      outputChannel.appendLine(`[node] Running ${normalized} (direct workspace fs)…`);

      const reader = createWorkspaceFs(vscode, rootUri);
      const runtimeFs = createRuntimeFs({
        reader,
        cwd: "/",
      });

      const runtimeProcess = createProcess({
        cwd: "/",
        env: {
          NODE_ENV: "development",
        },
        onStdout: (data: string) => outputChannel.append(data),
        onStderr: (data: string) => outputChannel.append(data),
      });

      const loader = createModuleLoader({
        reader,
        runtimeFs,
        process: runtimeProcess,
        onConsole: (method, args) => {
          outputChannel.appendLine(`[node:${method}] ${args.map(formatArgument).join(" ")}`);
        },
        onRetry: (message) => {
          outputChannel.appendLine(`[node] ${message} (retrying run)…`);
        },
      });

      let exitCode = 0;

      try {
        await loader.run(normalized);
        outputChannel.appendLine(`[node] Finished in ${Date.now() - started}ms.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const exit = /^Process exited with code (\d+)/.exec(message);

        if (exit != null) {
          exitCode = Number(exit[1]);
          outputChannel.appendLine(`[node] Exited with code ${exitCode}.`);
        } else {
          exitCode = 1;
          outputChannel.appendLine(`[node] Uncaught: ${message}`);
          outputChannel.show(true);
        }
      } finally {
        /*
         * Keep the loader alive for pending dynamic imports and timers; it is
         * unreachable once this run ends, so its caches follow it.
         */
        try {
          const flushed = await runtimeFs.flush();

          if (flushed.applied > 0) {
            outputChannel.appendLine(
              `[node] Wrote ${flushed.applied} filesystem change(s) to the workspace.`,
            );
          }

          for (const failure of flushed.errors) {
            outputChannel.appendLine(`[node] fs flush failed: ${failure}`);
          }
        } catch (error) {
          outputChannel.appendLine(
            `[node] fs flush failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      return exitCode;
    },

    dispose() {},
  };
}
