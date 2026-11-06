# Terminal

A browser shell for the workspace, built on just-bash. Commands run against the real
workspace filesystem through `vscode.workspace.fs`; there is no virtual filesystem copy and
no sync-back step.

## Before you start

- Open a workspace (local folder or browser workspace).
- Install any npm packages you need with the npm extension first, or run `npm install` in the
  shell.
- The shell has the same workspace-write semantics as an external process. There is no undo.

## Quick start

1. Run `Terminal: New Dataverse Shell`, or use **Terminal → New Terminal** after enabling the
   terminal panel.
2. Try `ls`, `cat package.json`, `echo hi > note.txt`.
3. Run `node scripts/build.ts` or `npm run build`.
4. Type `exit` or press <kbd>Ctrl</kbd>+<kbd>D</kbd> on an empty prompt to close the terminal.

## Commands

| Command                         | What it does                                      |
| ------------------------------- | ------------------------------------------------- |
| `Terminal: New Dataverse Shell` | Opens a new shell terminal.                       |
| `Terminal: Run Command…`        | Asks for a command and runs it in a new terminal. |
| `Terminal: How-to Guide`        | Opens this guide.                                 |

The shell itself provides the usual just-bash commands: `ls`, `cat`, `grep`, `sed`, `awk`,
`find`, `cp`, `mv`, `rm`, `mkdir`, `echo`, `printf`, `jq`, `yq`, `tar`, and more.

### `node`

```sh
node scripts/build.ts
node src/index.js --flag value
node --version
```

`node` uses the same direct workspace-filesystem runtime as the node-runtime extension.
Relative paths resolve against the shell's current directory. `node -e` and the interactive
REPL are not available.

Output from a top-level `node ...` command is streamed live to the terminal. If the command
is piped or redirected (`node app.js | grep x`, `node app.js > out.txt`), output is buffered
so the shell can route it. `npm run` output is buffered until the script finishes.

Async work that is not backed by workspace fs operations (timers, `fetch`, etc.) can keep
logging after the prompt returns; those late logs still stream to the terminal.

### `npm`

```sh
npm run build
npm test
npm start
npm install
npm install lodash
npm install --save-dev vitest
```

`npm run` executes `pre<script>`, `<script>` and `post<script>` through the shell.
`npm install` uses the same direct installer as the npm extension and writes straight into
`node_modules`.

## History

Command history is saved in browser storage (IndexedDB), not in the workspace:

- database: `dataverse-ide`, store: `terminalHistory`
- one record per workspace, keyed by the workspace root URI
- loaded when a terminal opens, so it works across reloads and new terminal
  sessions for the same workspace
- capped at the last 1000 commands
- not committed to git and not visible in the file explorer

Disable it with `dataverseIde.terminal.history` (`true` by default).

## Permissions

`dataverseIde.terminal.permissions` controls filesystem writes and the permission level used
by `node` runs started from the terminal.

| Level                 | Filesystem                        |
| --------------------- | --------------------------------- |
| `read-only`           | Reads workspace files only.       |
| `workspace` (default) | Reads and writes workspace files. |
| `trusted`             | Same as `workspace` today.        |

Scratch paths (`/tmp`, `/home`, `/dev`) live in memory and are discarded when the terminal
closes.

## How it works

- `just-bash` parses and runs the command.
- The shell filesystem reads and writes `vscode.workspace.fs` directly. There is no workspace
  mirror and no flush-back step.
- A metadata-only path index supplies `getAllPaths()` for glob expansion; it is refreshed by
  the workspace file watcher and after `npm install`.
- `node` delegates to `node-runtime`; `npm install` delegates to the npm extension.

## Limits

- Not a real PTY: no job control (`&`, `fg`, `bg`), no full-screen programs (`vi`, `top`),
  and output is buffered until a command finishes.
- Long CPU-bound commands run on the main thread and can block the workbench.
- No real network commands; `curl`/`wget` are not configured.
- Symlinks are not supported by the workspace adapter.
- `npm run` scripts that invoke `node_modules/.bin` tools (`tsc`, `vite`, `esbuild`, ...)
  are not supported yet. Scripts that use `node ...` or shell built-ins work.
- `node` reads only workspace files; scratch files under `/tmp` are shell-only.
- `node`/`npm` run in the same page context; permissions are a guardrail, not a sandbox.
