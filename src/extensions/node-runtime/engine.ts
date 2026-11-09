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
import {
  DEFAULT_NODE_FS_CACHE,
  EAGER_FS_EXCLUDE,
  EAGER_FS_MAX_BYTES,
  EAGER_FS_MAX_FILES,
  formatByteCount,
  type NodeFsCacheMode,
} from "./fsCache.js";
import { blockNetworkAccess } from "./networkGate.js";

export type DirectNodeRunOptions = {
  /** Workspace-relative cwd used for relative entry paths and process.cwd(). */
  cwd?: string;
  /** Arguments after the script path (process.argv.slice(2)). */
  argv?: string[];
  level?: NodePermissionLevel;
  /** `lazy` hydrates on demand; `eager` preloads workspace files first. */
  fsCache?: NodeFsCacheMode;
  stdout?: (data: string) => void;
  stderr?: (data: string) => void;
  /** Runtime status lines (start/finish/retry). Defaults to the output channel. */
  log?: (line: string) => void;
  /** Prefix console output with `[node:<method>]` (default true). */
  prefixConsole?: boolean;
};

export type DirectNodeEngine = {
  runFile: (
    path: string,
    level?: NodePermissionLevel,
    options?: { fsCache?: NodeFsCacheMode },
  ) => Promise<number>;
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

/*
 * Some CLI bins export their asynchronous main work as `__promise` instead of
 * returning it (prettier does this). Node stays alive until the underlying
 * I/O finishes; the browser runtime has no such event loop, so await the
 * exported promise explicitly before reporting the run as finished.
 */
async function waitForEntryPromise(value: unknown): Promise<void> {
  if (value == null || typeof value !== "object") {
    return;
  }

  const promise = (value as { __promise?: unknown }).__promise;

  if (
    promise == null ||
    (typeof promise !== "object" && typeof promise !== "function") ||
    typeof (promise as PromiseLike<unknown>).then !== "function"
  ) {
    return;
  }

  await promise;
}

/*
 * Node writes go through vscode.workspace.fs, which does not fire
 * onDidSaveTextDocument. Ask the Git extension to refresh the written paths
 * so the SCM view and decorations update.
 */
async function notifyFilesChanged(vscode: typeof vscodeType, paths: string[]): Promise<void> {
  if (paths.length === 0) {
    return;
  }

  try {
    await vscode.commands.executeCommand("dataverseGit.refreshPaths", paths);
  } catch {
    /* Git may be disabled or the workspace may not be a repository. */
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
    const fsCache = options.fsCache ?? DEFAULT_NODE_FS_CACHE;
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

    if (fsCache === "eager") {
      const preloadStarted = Date.now();

      try {
        const uris = await vscode.workspace.findFiles(
          "**/*",
          EAGER_FS_EXCLUDE,
          EAGER_FS_MAX_FILES + 1,
        );
        const limited = uris.length > EAGER_FS_MAX_FILES;
        const paths = uris
          .slice(0, EAGER_FS_MAX_FILES)
          .map((uri) => vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/"))
          .filter((path) => path.length > 0);
        const preloaded = await runtimeFs.preload(paths, {
          maxBytes: EAGER_FS_MAX_BYTES,
        });

        log(
          `[node] Eager fs cache: ${preloaded.files} file(s), ` +
            `${formatByteCount(preloaded.bytes)} in ${Date.now() - preloadStarted}ms` +
            (limited ? ` (limited to ${EAGER_FS_MAX_FILES} paths)` : "") +
            (preloaded.skipped > 0
              ? `, ${preloaded.skipped} path(s) left lazy by the size cap`
              : "") +
            ".",
        );
      } catch (error) {
        log(
          `[node] Eager fs preload failed; falling back to lazy hydration: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const runtimeProcess = createProcess({
      cwd: cwd.length === 0 ? "/" : `/${cwd}`,
      env: {
        NODE_ENV: "development",
      },
      onStdout: stdout,
      onStderr: stderr,
    });

    /*
     * almostnode's stdin stream is not async-iterable. CLIs that read stdin
     * (`prettier` with no file arguments, for example) use `for await` and
     * would throw instead of seeing EOF. The browser shell has no piped
     * stdin, so expose an empty async iterator.
     */
    const stdin = (runtimeProcess as unknown as { stdin?: Record<PropertyKey, unknown> }).stdin;

    if (stdin != null && typeof stdin[Symbol.asyncIterator] !== "function") {
      stdin[Symbol.asyncIterator] = async function* () {
        /* EOF */
      };
    }

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
      const entryExports = await loader.run(normalized, options.argv);

      await waitForEntryPromise(entryExports);

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

        if (flushed.changed.length > 0) {
          await notifyFilesChanged(vscode, flushed.changed);
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
    runFile(
      entryPath: string,
      level: NodePermissionLevel = "trusted",
      options?: { fsCache?: NodeFsCacheMode },
    ): Promise<number> {
      return runProgram(entryPath, {
        level,
        fsCache: options?.fsCache,
      });
    },
    runProgram,
    dispose() {},
  };
}
