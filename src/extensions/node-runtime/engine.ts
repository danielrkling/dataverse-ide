/*
 * node-runtime engine: direct workspace fs.
 *
 * The runtime does not mirror the workspace into a virtual filesystem. A
 * per-run loader reads and resolves only the modules the entry actually
 * reaches through vscode.workspace.fs, and the fs shim's writes are flushed
 * back to the workspace when the run finishes. almostnode supplies the
 * browser builtin shims (path, events, stream, ...); the loader, transpiler
 * and fs layer are local.
 */

import type * as vscodeType from "vscode";

import {
  describePermissions,
  permissionsForLevel,
  type NodePermissionLevel,
} from "./permissions.js";
import { blockNetworkAccess } from "./networkGate.js";

export type DirectNodeRunOptions = {
  /** Workspace-relative cwd used for relative entry paths and process.cwd(). */
  cwd?: string;
  /** Arguments after the script path (process.argv.slice(2)). */
  argv?: string[];
  level?: NodePermissionLevel;
  stdout?: (data: string) => void;
  stderr?: (data: string) => void;
  /** Runtime status lines (start/finish/retry). Defaults to the output channel. */
  log?: (line: string) => void;
  /** Prefix console output with `[node:<method>]` (default true). */
  prefixConsole?: boolean;
};

export type DirectNodeEngine = {
  runFile: (path: string, level?: NodePermissionLevel) => Promise<number>;
  runProgram: (path: string, options?: DirectNodeRunOptions) => Promise<number>;
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
  async function runProgram(
    entryPath: string,
    options: DirectNodeRunOptions = {},
  ): Promise<number> {
    const level = options.level ?? "trusted";
    const permissions = permissionsForLevel(level);
    /*
     * Imported on first run so extension activation does not pull the
     * almostnode shims or esbuild-wasm into the boot chunk.
     */
    const [
      { createProcess },
      { createRuntimeFs },
      { createModuleLoader },
      { createWorkspaceFs, normalizePath, joinPath },
    ] = await Promise.all([
      import("almostnode"),
      import("./fsShim.js"),
      import("./loader.js"),
      import("./workspace.js"),
    ]);

    const cwd = normalizePath(options.cwd ?? "");
    const normalized = normalizePath(
      entryPath.startsWith("/") ? entryPath : joinPath(cwd, entryPath),
    );
    const started = Date.now();
    const log =
      options.log ??
      ((line: string) => {
        outputChannel.appendLine(line);
      });
    const stdout =
      options.stdout ??
      ((data: string) => {
        outputChannel.append(data);
      });
    const stderr =
      options.stderr ??
      ((data: string) => {
        outputChannel.append(data);
      });

    log(`[node] Running ${normalized} (${level}: ${describePermissions(permissions)})…`);

    const reader = createWorkspaceFs(vscode, rootUri, {
      writable: permissions.filesystem === "read-write",
    });
    const runtimeFs = createRuntimeFs({
      reader,
      cwd: cwd.length === 0 ? "/" : `/${cwd}`,
      writable: permissions.filesystem === "read-write",
    });
    const runtimeProcess = createProcess({
      cwd: cwd.length === 0 ? "/" : `/${cwd}`,
      env: {
        NODE_ENV: "development",
      },
      onStdout: stdout,
      onStderr: stderr,
    });

    const loader = createModuleLoader({
      reader,
      runtimeFs,
      process: runtimeProcess,
      onConsole: (method, args) => {
        const message = args.map(formatArgument).join(" ");

        /*
         * Terminal runs own stdout; keep console output in the stream
         * instead of the output channel. The terminal does not need the
         * `[node:...]` prefix on every script console line.
         */
        if (options.log == null) {
          outputChannel.appendLine(`[node:${method}] ${message}`);
          return;
        }

        const line =
          options.prefixConsole === false ? `${message}\n` : `[node:${method}] ${message}\n`;

        if (method === "error" || method === "warn") {
          stderr(line);
        } else {
          stdout(line);
        }
      },
      onRetry: (message) => {
        log(`[node] ${message} (retrying run)…`);
      },
    });

    if (permissions.network === "blocked") {
      /*
       * esbuild-wasm fetches its gzip wasm asset on first transform. Warm
       * the shared instance before installing the network guard, so
       * TypeScript/JSX transpilation still works at workspace level while
       * user code keeps its network block.
       */
      const { ensureEsbuildCompilerReady } = await import("../esbuild/compiler.js");

      await ensureEsbuildCompilerReady();
    }

    const networkGuard = permissions.network === "blocked" ? blockNetworkAccess() : undefined;

    let exitCode = 0;

    try {
      await loader.run(normalized, options.argv);

      /*
       * CJS modules return synchronously even when they start async work
       * (`void main()`, top-level await, fs/promises chains). Wait for the
       * tracked workspace operations before flushing/reporting completion.
       */
      await runtimeFs.waitForIdle();

      log(`[node] Finished in ${Date.now() - started}ms.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exit = /^Process exited with code (\d+)/.exec(message);

      if (exit != null) {
        exitCode = Number(exit[1]);
        log(`[node] Exited with code ${exitCode}.`);
      } else {
        exitCode = 1;
        stderr(`[node] Uncaught: ${message}\n`);
        log(`[node] Uncaught: ${message}`);

        if (options.log == null) {
          outputChannel.show(true);
        }
      }
    } finally {
      try {
        await runtimeFs.waitForIdle();
      } catch {
        /* Idle tracking is best-effort. */
      }

      networkGuard?.restore();

      /*
       * Keep the loader alive for pending dynamic imports and timers; it is
       * unreachable once this run ends, so its caches follow it.
       */
      try {
        const flushed = await runtimeFs.flush();

        if (flushed.applied > 0) {
          log(`[node] Wrote ${flushed.applied} filesystem change(s) to the workspace.`);
        }

        for (const failure of flushed.errors) {
          log(`[node] fs flush failed: ${failure}`);
        }
      } catch (error) {
        log(`[node] fs flush failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return exitCode;
  }

  return {
    runFile(entryPath: string, level: NodePermissionLevel = "trusted"): Promise<number> {
      return runProgram(entryPath, { level });
    },
    runProgram,
    dispose() {},
  };
}
