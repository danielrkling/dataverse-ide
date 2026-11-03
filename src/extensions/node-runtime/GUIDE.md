# Node runtime

Run JavaScript and TypeScript files against the workspace filesystem, directly in the
browser. The runtime resolves only the modules the entry actually reaches, transpiles
TypeScript/JSX to CommonJS with esbuild-wasm, and provides Node built-ins through browser
shims.

Use it for build scripts, small CLIs, data transforms and quick experiments that read or
write workspace files.

## Before you start

- Open a workspace (local folder or browser workspace). Paths are relative to the workspace
  root.
- Install any npm packages the entry imports with the npm extension (`npm: Install All
Dependencies`). The runtime does not download packages on demand.
- Decide on a permission level. `trusted` is the default; use `read-only` or `workspace` for
  code you do not fully trust.

## Quick start

1. Open a `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` or `.cjs` file.
2. Run `Node: Run Active File`, or `Node: Run File` to pick from the workspace.
3. Read the result in **Output → Dataverse IDE: node-runtime**.
4. For a one-off different permission level, run `Node: Run Active File with Permissions…`
   and pick the level.

A non-zero exit code is reported with an error notification; the output channel keeps the
full log.

## Commands

| Command                                   | What it does                                               |
| ----------------------------------------- | ---------------------------------------------------------- |
| `Node: Run File`                          | Quick-picks an entry from the workspace and runs it.       |
| `Node: Run Active File`                   | Runs the file in the active editor when it is runnable.    |
| `Node: Run File with Permissions…`        | Same as Run File, but asks for the permission level first. |
| `Node: Run Active File with Permissions…` | Same as Run Active File, with a permission prompt.         |

`Run File` scans `*`, `src/*` and `scripts/*`, excluding `node_modules`, `.git`, `.ide-build`
and `dist`, and shows up to 500 candidates.

## Permissions

`dataverseIde.nodeRuntime.permissions` sets the default for the non-prompting commands. The
`… with Permissions…` commands override it for that run only.

| Level               | Filesystem                      | Network                       |
| ------------------- | ------------------------------- | ----------------------------- |
| `read-only`         | Read workspace files.           | Blocked.                      |
| `workspace`         | Read and write workspace files. | Blocked.                      |
| `trusted` (default) | Read and write workspace files. | Same-origin requests allowed. |

Filesystem rules apply to sync and async operations, including delete, rename, copy and flush.
Network blocking temporarily replaces `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`
and `navigator.sendBeacon`.

The blocking is a guardrail, not a security boundary: runtime code shares the extension-host
worker globals. Treat `trusted` as "I wrote this code" rather than a sandbox.

## How it runs

- The loader walks imports and `require()` calls and reads files through
  `vscode.workspace.fs`. There is no workspace-wide virtual filesystem copy.
- TypeScript, JSX and ESM sources are transpiled to CommonJS with esbuild-wasm.
- Node built-ins come from almostnode's browser shims plus local fallbacks (`path`,
  `process`, `events`, `stream`, `http`, and an `fs` shim).
- Static imports are prefetched. A dynamic `require()` or an uncached synchronous `fs` read
  throws a typed miss; the engine hydrates that path and retries. Retries re-execute module
  side effects, which are logged to the output channel.
- `writeFileSync` and friends are recorded in an overlay and flushed to the workspace after
  the run.
- Each run starts with a fresh module graph.

## Recipes

### Run a build script

1. Put the script at `scripts/build.ts` so it appears in the default quick pick.
2. Install its dependencies.
3. Run `Node: Run File`, pick `scripts/build.ts`, and choose `workspace` if it should write
   files but not call the network.

### Read a config, write a generated file

```ts
import { readFileSync, writeFileSync } from "node:fs";

const source = JSON.parse(readFileSync("dataverse.config.json", "utf8")) as {
  prefix: string;
};

writeFileSync("generated/prefix.txt", `${source.prefix}\n`);
```

Use `workspace` or `trusted`; `read-only` rejects the write.

### Block network access for untrusted code

Set `dataverseIde.nodeRuntime.permissions` to `workspace` (or `read-only`) before running, or
use `Node: Run File with Permissions…` and pick that level for one run.

## Troubleshooting

| Symptom                                                            | Cause and fix                                                                                                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Cannot find module "…"`                                           | The package is not installed in the workspace. Install it with npm, then run again.                                                                          |
| A file written by the script is missing                            | Writes are buffered and flushed after the run. Check the output channel for a flush error or a permission denial.                                            |
| `EACCES` / permission error                                        | The selected level is `read-only` or the path is outside the workspace.                                                                                      |
| `fetch is not defined` or a blocked request                        | Network access is disabled at `read-only`/`workspace`. Use `trusted` for same-origin requests.                                                               |
| Script seems to run twice                                          | Dynamic requires and uncached sync reads retry after hydration, which re-executes module side effects. Log work from module top level is expected to repeat. |
| `crypto.createHash`, `child_process` or native `.node` addons fail | These are stubs in the browser runtime.                                                                                                                      |

## Limits

- No child processes, native addons, worker threads or real sockets.
- `crypto.createHash`, `child_process` and `.node` binaries are stubs.
- Network blocking is best-effort; runtime code shares the extension-host worker globals.
- Runs on the page/worker thread; long CPU-bound scripts block other work.
