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

1. A Dataverse shell opens automatically on startup. You can also run
   `Terminal: New Dataverse Shell`, or use **Terminal → New Terminal** after enabling the
   terminal panel.
2. Try `ls`, `cat package.json`, `echo hi > note.txt`.
3. Run `node scripts/build.ts` or `npm run build`.
4. Type `exit` or press <kbd>Ctrl</kbd>+<kbd>D</kbd> on an empty prompt to close the terminal.

## Commands

| Command                         | What it does                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Terminal: New Dataverse Shell` | Opens a new shell terminal.                                                                                                            |
| `Terminal: Run Command…`        | Asks for a command and runs it in a new terminal. Other extensions can pass a command directly (for example npm's script play button). |
| `Terminal: How-to Guide`        | Opens this guide.                                                                                                                      |

The shell itself provides the usual just-bash commands: `ls`, `cat`, `grep`, `sed`, `awk`,
`find`, `cp`, `mv`, `rm`, `mkdir`, `echo`, `printf`, `jq`, `yq`, `tar`, and more.

Dataverse-specific commands:

| Command         | What it does                                                     |
| --------------- | ---------------------------------------------------------------- |
| `open <file>`   | Open a workspace file in the editor.                             |
| `code <file>`   | Alias for `open`.                                                |
| `node ...`      | Run a file with the direct runtime.                              |
| `npm ...`       | Run scripts or install dependencies.                             |
| `npx ...`       | Install if needed and run a package binary.                      |
| `git ...`       | status/add/commit/log/branch/switch/init/remote/fetch/pull/push. |
| `esbuild ...`   | Build an entry, or control esbuild watch/config/output.          |
| `tailwind ...`  | Compile Tailwind CSS, or control tailwind watch/config/output.   |
| `dataverse ...` | Upload web resources and manage Dataverse schema files.          |
| `flatten ...`   | Combine files into a markdown bundle.                            |

### `git`

```sh
git status
git add src/app.ts
git add .
git commit -m "Update app"
git log 20
git branch
git switch main
git init
git remote
git fetch
git pull
git push
```

A local folder workspace is required, matching the Git extension. Remote commands use
the same cached credential provider as the SCM integration and may prompt once.

### `esbuild`

```sh
esbuild                       # build esbuild.config.json's first entry
esbuild src/app.ts            # build a specific entry
esbuild build src/app.ts
esbuild workspace             # pick an entry with the workspace quick pick
esbuild watch
esbuild stop
esbuild config
esbuild output
esbuild guide

esbuild src/app.ts --bundle --minify --sourcemap --outfile=dist/app.min.js
esbuild src/app.ts --format=cjs --target=es2020 --define:DEBUG=false
esbuild src/app.ts --loader:.png=dataurl --external:react
```

Builds use the workspace `esbuild.config.json` as the base. CLI flags override scalars,
append to lists (`--external`, `--pure`), and merge maps (`--define`, `--loader`,
`--banner`, `--footer`, `--out-extension`). Supported flags are the subset that maps to the
workspace build config: `--bundle`, `--minify`, `--sourcemap`, `--format`, `--platform`,
`--target`, `--outfile`/`--outdir`, `--define`, `--external`, `--loader`,
`--jsx*`, `--entry-names`, `--chunk-names`, and the related output options. Unsupported
esbuild flags fail with an error instead of being ignored. Use `esbuild --help` for the
list.

Full build logs stay in the esbuild output channel.

### `tailwind`

```sh
tailwind                 # compile the configured CSS
tailwind build
tailwind watch
tailwind stop
tailwind toggle
tailwind config
tailwind output
tailwind guide
```

`tailwind` uses the same compiler and `tailwind.config.json` as the Tailwind extension.
The command exits non-zero when compilation fails.

### `dataverse`

```sh
dataverse                         # upload configured web resources
dataverse upload                  # same as above
dataverse upload dist/index.html  # upload specific files or folders
dataverse upload-active           # upload the active editor file
dataverse preview dist/index.html # open the deployed HTML resource
dataverse watch
dataverse stop
dataverse identity
dataverse config
dataverse schema
dataverse schema preview
dataverse schema provision
dataverse schema publish
```

Uploads report the number of resources and exit non-zero when any file fails. A local
folder workspace is required, matching the Dataverse extension.

### `flatten`

```sh
flatten                       # use dataverseIde.flatten.include
flatten src/app.ts src/extensions
flatten --configured
```

Paths resolve against the shell's current directory. The bundle is written to the
workspace root and the command prints the file name.

## Adding commands

Built-in commands live in `terminal/commands.ts` as just-bash `defineCommand`
handlers. Other in-house extensions can contribute commands during activation:

```ts
import { registerTerminalCommand } from "../terminal/registry.js";

const disposable = registerTerminalCommand({
  name: "deploy",
  description: "Upload the active web resource",
  async execute(args, ctx, terminal) {
    await terminal.vscode.commands.executeCommand(
      "dataverseIde.dataverse.uploadSelection",
      args[0],
    );

    return { stdout: "", stderr: "", exitCode: 0 };
  },
});
```

The terminal context provides `vscode`, `rootUri`, `fs` and `output`; the
just-bash `ctx` adds `cwd`, `env`, `stdin`, `exec` and `signal`. Commands are
read when a terminal is created, so open a new shell after registering.
Built-in command names (`open`, `code`, `node`, `npm`, `npx`) take precedence over
contributed commands.

### `node`

```sh
node scripts/build.ts
node src/index.js --flag value
node --eager scripts/build.ts
node --lazy scripts/build.ts
node --version
```

`node` uses the same direct workspace-filesystem runtime as the node-runtime extension.
Relative paths resolve against the shell's current directory. `node -e` and the interactive
REPL are not available.

Sync `fs` reads hydrate on demand by default. `--eager` preloads workspace files before the
run (skipping `node_modules`, `.git`, `dist`, `.ide-build`; capped at 5000 paths / 64 MB),
which avoids retry restarts for scripts that read many files. `--lazy` forces the default.
The same behavior is available through `dataverseIde.nodeRuntime.fsCache`.

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

### `npx`

```sh
npx tsc --noEmit
npx prettier --write src
npx -p typescript tsc --version
npx --no-install esbuild src/app.ts
```

`npx` looks for the package under the workspace `node_modules`, installs it without saving it
to `package.json` when missing, then runs the matching `bin` entry through the Node runtime.
`--no-install` fails instead of installing. This is the intended way to run package binaries:
the shell does not create `node_modules/.bin` shims.

## Auto-start

A Dataverse shell opens when the workbench starts if no terminal is already present.
Disable it with `dataverseIde.terminal.autoStart` (`true` by default). The panel opens without
stealing focus, so the welcome page or restored editor stays active.

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
- `node_modules/.bin` shims are not created, so `npm run` scripts that invoke bare `tsc`,
  `vite`, `esbuild`, ... do not resolve. Use `npx <tool>` or call the package entry with
  `node node_modules/<pkg>/...`. Scripts that use `node ...` or shell built-ins work.
- `node` reads only workspace files; scratch files under `/tmp` are shell-only.
- `node`/`npm` run in the same page context; permissions are a guardrail, not a sandbox.
