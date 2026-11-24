# esbuild

Bundle TypeScript, TSX and JSX with esbuild-wasm, entirely in the browser. The build reads
source files through the workspace filesystem and resolves bare imports from the workspace
`node_modules`, so the result is a deployable `.js` (or `.css`) file for a Dataverse web
resource or any static host.

Use this when you need to turn a source tree into one or more files that a browser can load
without a build server.

## Before you start

- Open a workspace: a local folder through the File System Access API, or a browser (OPFS)
  workspace.
- Install runtime dependencies first. If the entry imports a package, add or install it with
  the npm extension (`npm: Install All Dependencies (package.json)`). A missing package
  shows up as an unresolved-import build error, not as a silent external.
- Decide on an entry point. The default is `src/app.ts`; change it in
  `esbuild.config.json` if your app starts elsewhere.

## Quick start

1. Run `esbuild: Open esbuild.config.json`. If the file does not exist, the command scaffolds
   it with the defaults and opens it.
2. Point it at your entry and output folder:

   ```json
   {
     "entryPoints": ["src/app.ts"],
     "outdir": "dist"
   }
   ```

3. Build one of three ways:
   - `esbuild: Build Current File` — builds the file in the active editor.
   - `esbuild: Build Workspace…` — picks a source file from a filtered workspace list.
   - `esbuild: Build Configured Entries` — builds every configured entry point in one pass, without a prompt.
4. Check the result in `dist/` and the log in **Output → Dataverse IDE: esbuild**.

From the Dataverse shell, the same build is available as `esbuild src/app.ts` (or just
`esbuild` for all configured entries), plus `esbuild watch`, `esbuild stop`, `esbuild config`
and `esbuild output`. Multiple positional entries are built together in one pass:

```sh
esbuild src/app.ts src/admin.ts
```

The terminal command also accepts esbuild CLI-style flags for one-off builds, for example:

```sh
esbuild src/app.ts --bundle --minify --sourcemap --outfile=dist/app.min.js
esbuild src/app.ts --format=cjs --target=es2020 --define:DEBUG=false
```

`esbuild.config.json` is still the base; CLI flags override scalars, append to lists, and
merge maps for that build only. `esbuild --help` lists the supported flags.

The output keeps the entry's base name (`src/app.ts` → `dist/app.js`). Set `entryNames`,
`chunkNames` and `outExtension` when you need a different naming scheme.

## Commands

| Command                                                | What it does                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `esbuild: Build Current File`                          | Bundles the active editor's file. Alias: `esbuild: Build Active File…`.                                                  |
| `esbuild: Build Workspace…`                            | Quick-picks a `.ts/.tsx/.js/.jsx/.mts/.cts` file (up to 200, excluding `node_modules`, `.ide-build`, `.git` and `dist`). |
| `esbuild: Build Configured Entries`                    | Builds every configured entry point in one pass.                                                                         |
| `esbuild: Start Watch` / `Stop Watch` / `Toggle Watch` | Rebuilds when a file the build reaches is saved.                                                                         |
| `esbuild: Open esbuild.config.json`                    | Creates the config on first use, then opens it.                                                                          |
| `esbuild: Reload Config`                               | Re-reads the config without restarting the extension.                                                                    |
| `esbuild: Solid Compiler…`                             | Writes the `solid` mode (`off`, `v1`, `v2`).                                                                             |
| `esbuild: Show Output`                                 | Opens the build log.                                                                                                     |

## Configuration

`esbuild.config.json` lives at the workspace root. Point elsewhere with
`dataverseIde.esbuild.configPath` (workspace-relative). The file is validated by a JSON
Schema, so the editor completes keys and shows descriptions inline.

| Key                 | Default          | Notes                                                                                  |
| ------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| `entryPoints`       | `["src/app.ts"]` | Strings or `{ in, out }` objects; all entries are built together in one pass.          |
| `outdir`            | `"dist"`         | Workspace-relative output folder.                                                      |
| `outfile`           | —                | Single output file; mutually exclusive with multiple entry points.                     |
| `format`            | `"esm"`          | `esm`, `iife` or `cjs`.                                                                |
| `platform`          | `"browser"`      | `browser`, `node` or `neutral`. Resolution and builtin handling follow this.           |
| `target`            | `"esnext"`       | esbuild target (for example `es2020`).                                                 |
| `bundle`            | `true`           | Follow imports and inline them.                                                        |
| `splitting`         | `false`          | Code splitting; requires `format: "esm"`.                                              |
| `minify`            | `false`          | Minify the output. Granular flags are supported too.                                   |
| `sourcemap`         | `false`          | `true`, `"linked"`, `"inline"`, `"external"` or `"both"`.                              |
| `external`          | `[]`             | Import specifiers to leave unresolved; supports `*` wildcards.                         |
| `alias`             | `{}`             | Substitute one package or path for another.                                            |
| `define`            | `{}`             | Compile-time replacements, for example `{ "process.env.NODE_ENV": "\"production\"" }`. |
| `tsconfig`          | auto             | Uses workspace `tsconfig.json`/`jsconfig.json` (paths, baseUrl, JSX/decorators).       |
| `conditions`        | platform default | Additional package.json export conditions.                                             |
| `mainFields`        | platform default | package.json entry fields, in order.                                                   |
| `resolveExtensions` | esbuild default  | Implicit extension order (`.tsx`, `.ts`, `.jsx`, `.js`, `.css`, `.json`).              |
| `jsx`               | tsconfig/esbuild | `transform`, `preserve` or `automatic`.                                                |
| `jsxImportSource`   | —                | For automatic JSX, for example `solid-js` or `react`.                                  |
| `solid`             | `"off"`          | `v1` or `v2` compiles workspace JSX/TSX with the matching Solid Babel plugin.          |

Most remaining esbuild build options are supported (`outbase`, `entryNames`, `chunkNames`,
`assetNames`, `publicPath`, `outExtension`, `allowOverwrite`, `charset`, `treeShaking`,
`ignoreAnnotations`, `keepNames`, `legalComments`, `banner`, `footer`, `pure`, `drop`,
`dropLabels`, `lineLimit`, `mangleProps`, `reserveProps`, `supported`, `globalName`,
`sourceRoot`, `sourcesContent`, `loader`, `inject`, `nodePaths`, `packages`, `minify*`) — see
the JSON Schema completions. Unresolved imports fail the build like normal esbuild; use
`external`, `alias`, or `packages: "external"` for intentional runtime dependencies.

## Recipes

### Solid app

1. Install the Solid runtime (Solid 2: `@solidjs/web` and `solid-js`; Solid 1: `solid-js`) with
   the npm extension.
2. Run `esbuild: Solid Compiler…` and pick `v2` (Solid 2.0) or `v1` (Solid 1.x).
3. Build normally. Workspace `.jsx`/`.tsx` files are compiled with `@solidjs/babel-plugin`
   (`v2`) or `babel-preset-solid` (`v1`) before esbuild sees them; files in `node_modules`
   are left untouched.

### Minified IIFE for a single web resource

```json
{
  "entryPoints": ["src/main.ts"],
  "outdir": "dist",
  "format": "iife",
  "minify": true,
  "sourcemap": false
}
```

### Watch while editing

Set `dataverseIde.esbuild.autoStartWatch` to `true` to start watch at activation, or run
`esbuild: Start Watch`. Watch rebuilds only when a file reached by the dependency graph is
saved. The debounce is fixed; there is no per-workspace setting for it.

## Troubleshooting

| Symptom                                         | Cause and fix                                                                                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Could not resolve "…"`                         | The package is not installed. Run `npm: Install All Dependencies` or add the dependency, then rebuild.                                  |
| Build succeeds but the output is empty or stale | Check **Output → Dataverse IDE: esbuild** and `outdir`; the build writes to the workspace, so confirm the file appears in the explorer. |
| `splitting` error                               | `splitting: true` requires `format: "esm"`.                                                                                             |
| JSX stays in the output                         | Set `jsx: "automatic"` with `jsxImportSource`, or enable the Solid compiler for Solid projects.                                         |
| Command does nothing                            | The esbuild extension may be disabled in the Extensions view; enable it and reload.                                                     |

## Limits

- Runs esbuild-wasm: no native esbuild plugins, and no `tsconfig.json`/`package.json`
  resolution beyond the workspace resolver.
- The build runs on the main thread. Very large graphs briefly block the UI.
- `node_modules` must be visible to the workspace filesystem. Packages installed into a
  separate overlay folder can still resolve, but files outside the workspace cannot.
- Source maps are written next to the output; inline maps are also supported.
