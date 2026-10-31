# Dataverse IDE

A browser IDE built on [monaco-vscode-api](https://github.com/CodinGame/monaco-vscode-api),
rendering the full VSCode workbench and opening real local folders through the
[File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API).

## Dataverse hosting (production)

The whole IDE is deployed as **model-driven app web resources**:

- Binaries (`.wasm`/`.ttf`) are **not** supported as web resource types, so the
  build config inlines them into the JS chunks as base64 data URLs
  (`build.assetsInlineLimit: 1_000_000`) - verified: no `.wasm`/`.ttf` files are emitted
- The module graph splits into chunks kept under the default per-file limit
  via `manualChunks` (`workbench`, `editor-core`, `builtin-extensions`)
- Everything is same-origin, so no CORS, no service worker needed for fetches:
  fonts, wasm data URLs, tsserver, and the File System Access API all just work
- The `{{uuid}}.localhost` iframe-remap only applies in local dev; in production
  the sandboxed extension-host iframe stays same-origin

Build for Dataverse:

```powershell
$env:DV_BASE = "/webresources/dv_/ide"   # served path prefix of the IDE shell web resource
npm run build
```

This bakes absolute asset URLs like `/webresources/dv_/ide/assets/index-*.js` into `dist/index.html`
(with the publisher prefix `dv_/` and folder path `ide/`).

Deploy (PowerShell against your org):

```powershell
$token = (az account get-access-token --resource 00000007-0000-0000-c000-000000000000 --query accessToken -o tsv)
.\tools\deploy-webresources.ps1 -EnvironmentUrl "https://<org>.crm4.dynamics.com" -Token $token
```

The script lists `dist/**`, upserts each file as a `dv_/ide/<relative-path>`
web resource via Web API v9.2 (`webresources` entity), then calls
`PublishAllCustomizations`. Notes:

- dataverse System Settings → Email tab → _Set file size limit for attachments_:
  lift it (default 5 MB) to at least 32 MB so the `builtin-extensions` chunk fits
- resources are created in the default solution; move them into a proper
  solution in Power Apps once crops in, or extend the script with solution-aware upserts
- the Dataverse org CSP needs to allow same-origin `blob:` workers
  (`worker-src blob:` / `child-src blob:`) for the extension-host iframe

### Test the production build locally

`vite preview` is not a Dataverse test: it does not use the web-resource path
prefix, it serves modern MIME types, and it sends no Dataverse-like headers.
Use the harness instead (build first):

```powershell
npm run build
npm run serve:dataverse          # http://dvide.localhost:5199/WebResources/dv_/ide/
```

It serves `dist/` under `/WebResources/dv_/ide/`, sends **no** COOP/COEP
headers (Dataverse does not; the service worker adds them only after it takes
control), uses Dataverse's `application/x-javascript` MIME type for `.js`, and
optionally applies a CSP:

```powershell
npm run serve:dataverse -- --csp=loose             # allow blob: workers
npm run serve:dataverse -- --csp=no-blob-worker     # reproduce CSP-blocked workers
npm run serve:dataverse -- --js-mime=text/javascript --isolate
```

Open `http://dvide.localhost:<port>/WebResources/dv_/ide/`, not
`localhost`/`127.0.0.1`: `pwa.js` treats those as dev and unregisters the
service worker. Expect the first load to be non-isolated
(`crossOriginIsolated === false`) and the post-service-worker reload to become
isolated - that two-phase behavior only exists in production.

A browser IDE built on [monaco-vscode-api](https://github.com/CodinGame/monaco-vscode-api),
rendering the full VSCode workbench and opening real local folders through the
[File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API).

## Features

- Full VSCode workbench UI (explorer, search, quick open/command palette, markers, output, outline)
- Opens a real directory of the user's machine via `showDirectoryPicker()`
  (Chromium browsers: Chrome 86+, Edge 86+) — files are read and written directly through
  the File System Access API mounted as the `file://` FileSystemProvider
- The picked directory handle is stored in IndexedDB and permission is re-verified on reload
- Project-wide IntelliSense for TS/JS via `@codingame/monaco-vscode-typescript-language-features-default-extension`
  (tsserver runs inside the extension host worker and reads files through the FileSystemProvider);
  HTML/CSS/JSON language features included as well

## Run

```
npm install
npm run dev      # then open http://localhost:5173 in Chrome/Edge
```

Click **Open Folder…**, grant the permission prompt, and the IDE opens that folder.

Firefox/Safari don't support the File System Access API yet — the splash will fail there.
A fallback (virtual in-memory workspace, or OPFS) can be added later.

## Architecture

- `index.html` — splash screen + workbench container
- `src/main.ts` — entry: restores/picks a directory, then boots the workbench; imports all default extensions
- `src/fsProvider.ts` — mounts the picked `FileSystemDirectoryHandle` via `registerHTMLFileSystemProvider()`
- `src/workbench.ts` — service overrides, workers, and workbench construction options
- `src/db.ts` — tiny IndexedDB helper for handle persistence

## Extensions

Features live as one folder under `src/extensions/<feature>/` with an
`extension.ts` exporting `default` as an `IdeExtension`:

```ts
interface IdeExtension {
  id: string;
  activate(context: ExtensionContext): Promise<vscode.Disposable | void>;
}
```

`ExtensionContext` (see `src/extensions/api.ts`) gives each feature the vscode API,
workspace root/handle, its own output channel, namespaced secret storage, and a
shared `http` fetch (future home of auto-injected Dataverse auth).

The registry (`src/extensions/registry.ts`) lazily imports each module and
activates it; new features require only a folder plus one entry in
`extensionModules` and an `extensionEnabled` flag.

Current extensions:

| Folder            | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git`             | active | isomorphic-git SCM + HTTPS remotes (clone/fetch/pull/push); PAT cached per host in secret storage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `dataverse`       | active | webresource upload/publish                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `esbuild`         | active | esbuild-wasm bundling on the main thread; bundles a workspace entry to `dist/` (esbuild.config.json `outdir`); npm imports resolved from `node_modules`; optional `"solid": "v1"` or `"v2"` compiles JSX/TSX with Solid's Babel compilers (`babel-preset-solid` / `@solidjs/babel-plugin`) before esbuild's loaders                                                                                                                                                                                                                                                                       |
| `html`            | active | self-contained HTML bundler: inlines local `<script src>`, stylesheets (including nested `@import`/`url()`), SVG/image assets and media posters, then writes the result under `dist/` (html.config.json)                                                                                                                                                                                                                                                                                                                                                                                  |
| `node-runtime`    | active | almostnode engine, main-thread same-origin (shares page auth); syncs workspace sources into the shared VFS per run; commands `runFile`/`runEntry`                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `node-runtime-v2` | active | direct workspace-fs Node runtime: async loader resolves only the reachable module graph through `vscode.workspace.fs`, almostnode shims provide builtins, sync writes flush back to the workspace; no VFS mirror. Commands `Node (direct): Run File` / `Run Active File`                                                                                                                                                                                                                                                                                                                  |
| `npm`             | active | real installs via almostnode PackageManager into node_modules; `npm: Install Package`, `npm: Install All (package.json)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `gitlab`          | stub   | separate from git; GitLab **REST API** with a PAT via secret storage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `tailwind`        | active | Tailwind v4 completions + hovers from default-theme data (no WASM); @tailwindcss/browser preview is a later step                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `rolldown`        | active | `@rolldown/browser` wasm bundling in a dedicated worker: Build Current File / Build Workspace / configured entry + watch (`rolldown.config.json`), plus Transform TS/JSX→JS and Minify (oxc primitives). Bundle verified live in-browser (Solid JSX app: glue boot, thread workers, lazy two-pass rounds over workspace node_modules, single bundle ~2s). Requires cross-origin isolation for the wasi threads runtime. Dev servers need `rolldownPatchHotReload` (or restart) after npm i; `scripts/unify-rolldown.cjs` (postinstall) fixes `@rolldown/browser` dep tree + glue in-place |
| `rollup`          | active | `@rollup/browser` bundling on the main thread with direct `vscode.workspace.fs` reads: Build Current File / Build Workspace / configured entry + watch (`rollup.config.json`), plus Transform TS/JSX→JS and Minify via the shared esbuild-wasm transformer. No workspace-wide collection, node_modules manifest scan, or lazy probe loop — the resolver reads only files reached by the graph. The browser build's parser wasm is inlined by Vite so Dataverse deploys never emit a separate `.wasm` asset                                                                                |

## Using the extensions

All extensions activate automatically after the workbench boots. Their commands show up
in the command palette (Ctrl+Shift+P / Cmd+Shift+P) via `contributes.commands` manifests:

| Extension    | Commands                                                                                                                                                                                                                                        | Extra setup                                                                                                                                                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git          | `Git: …` (initialize/commit/branches/clone/push/pull/fetch/remotes/PAT credentials)                                                                                                                                                             | local-folder workspace required                                                                                                                                                                                                                                                              |
| Dataverse    | `Dataverse: …` (webresource upload/publish), `Dataverse: Open dataverse.config.json`                                                                                                                                                            | settings in `dataverse.config.json` (prefix, solution, uploadRoot, files, exclude, publishAfterUpload, apiBaseUrl); watch debounce and config-file location via `dataverseIde.dataverse.watchDebounceMs` / `configPath`                                                                      |
| esbuild      | `esbuild: Build Current File` → writes `<outdir>/<name>.js` (`dist/` by default), `esbuild: Solid Compiler…`                                                                                                                                    | active workspace file; settings in `esbuild.config.json` (`entryPoints`, `outdir`, platform/charset, target/tree-shaking, JSX, `solid` v1/v2, source maps, banner/footer, splitting and output naming; path via `dataverseIde.esbuild.configPath`); npm imports resolved from `node_modules` |
| HTML         | `HTML: Bundle Current File`, `HTML: Bundle Workspace…`, `HTML: Bundle Configured Entries`, `HTML: Start/Stop/Toggle Watch`, `HTML: Open html.config.json`                                                                                       | settings in `html.config.json` (`entryPoints`, `outdir`, inline switches, `maxInlineBytes`, `minify`, `removeComments`; path via `dataverseIde.html.configPath`)                                                                                                                             |
| Node Runtime | `Node: Run File`, `Node: Run Active File` — also powers `require()` for installed npm packages                                                                                                                                                  | output appears in its output channel                                                                                                                                                                                                                                                         |
| npm          | `npm: Install Package`, `npm: Install All Dependencies (package.json)`                                                                                                                                                                          | package.json first (create one with the explorer New File if needed)                                                                                                                                                                                                                         |
| GitLab       | `GitLab: Connect`, `Show Merge Requests / Issues / Pipelines`, `New Merge Request`                                                                                                                                                              | run **Connect** first; project auto-detected from origin or `dataverseIde.gitlab.project`; baseUrl via `dataverseIde.gitlab.baseUrl`                                                                                                                                                         |
| Tailwind     | `Tailwind: Compile CSS From Workspace` — scans used class names and writes the configured output (`dist/tailwind.css` by default); completions/hovers appear only inside class-string contexts                                                  | settings in `tailwind.config.json` (path via `dataverseIde.tailwind.configPath`)                                                                                                                                                                                                             |     |
| Rolldown     | olldown: Transform Current File (TS/JSX → JS), olldown: Minify Current File, olldown: Build Current File, olldown: Build Workspace…, olldown: Build Configured Entry, olldown: Start/Stop/Toggle Watch, olldown: Open rolldown.config.json      | settings in rolldown.config.json (entryPoints, outdir, format esm/iife/cjs/umd, minify, sourcemap [inline], external, define; path via `dataverseIde.rolldown.configPath`); npm imports resolved from ode_modules via lazy two-pass rounds                                                   |
| Rollup       | `rollup: Transform Current File` (TS/JSX → JS), `rollup: Minify Current File`, `rollup: Build Current File`, `rollup: Build Workspace…`, `rollup: Build Configured Entry`, `rollup: Start/Stop/Toggle Watch`, `rollup: Open rollup.config.json` | settings in rollup.config.json (entryPoints, outdir, format esm/iife/cjs/umd, minify, sourcemap [inline], external, define; path via `dataverseIde.rollup.configPath`); npm imports resolved from node_modules by direct workspace reads                                                     |

### Sidebars (activity bar → "Dataverse IDE")

- **npm Packages** — Dependencies / Dev Dependencies groups; click a dependency for
  _Install specific version…_ (fetched from the npm registry), _Uninstall_, or
  _Open registry page_; palette also has `npm: Add Dependency…`.
- **Extensions** — enable/disable toggles per extension (apply after reload).

Dataverse, esbuild, rolldown, and rollup no longer have their own panels — everything is
driven by `dataverse.config.json` / `esbuild.config.json` / `rolldown.config.json` /
`rollup.config.json` and the `Dataverse: …` / `esbuild: …` / `rolldown: …` /
`rollup: …` commands.

The `html` extension has a small sidebar panel (actions plus auto-start watch) and is
configured entirely through `html.config.json`:

```json
{
  "entryPoints": ["index.html", { "input": "pages/about.html", "output": "dist/about.html" }],
  "outdir": "dist",
  "inlineScripts": true,
  "inlineStyles": true,
  "inlineSvg": true,
  "inlineImages": true,
  "inlineFonts": false,
  "inlineCssUrls": true,
  "maxInlineBytes": 0,
  "minify": false,
  "removeComments": false,
  "external": ["vendor/**", "*.min.js"]
}
```

Local references become inline content/data URIs; `http:`, `https:`, `//`, `data:`,
`blob:`, `mailto:`, `javascript:` and fragment-only references are left untouched.
`external` leaves matching sources un-inlined; patterns support `*`, `**` and `?`,
and a pattern without a slash matches the file name. External files are not copied to
the output, so they must be deployed or served separately. Inside an inlined stylesheet,
external `@import`/`url()` references are kept verbatim, so prefer absolute or
root-relative URLs for those (their base moves to the HTML document).
Watch mode rebuilds an entry when any file it inlined changes, and saving
`html.config.json` rebuilds every known entry.

HTML parsing uses parse5. The document is reserialized after rewriting, so attribute
quoting/case, implied `html`/`head`/`body` tags, and whitespace may be normalized; setting
`minify` additionally collapses whitespace outside `pre`/`textarea`/`script`/`style`.

Scripts are inlined verbatim. A `<script type="module">` that imports other files keeps
its import specifiers, which then resolve relative to the HTML document rather than the
original script folder; pre-bundle module graphs with the esbuild/rollup extensions first.

Each config file is validated by a Valibot schema exported as `<FEATURE>_CONFIG_SCHEMA`
(shared path/list/define helpers live in `src/extensions/shared/configSchema.ts`).
Invalid or missing values fall back to the feature defaults.
They are also converted to JSON Schema and contributed through a virtual extension's
`jsonValidation` manifest, so the config files get inline validation, completion, and
hover in the JSON editor.

Each extension also owns an output channel: Output panel → "Dataverse IDE: <id>".

## Notes / tradeoffs

- Only a lean subset of the demo's service overrides is wired in; more can be added as
  needed (terminal, SCM, debug, welcome, chat, liveSearch, etc.) by installing the matching
  `@codingame/monaco-vscode-*-service-override` package and spreading it into `initialize()`.
- Extension host runs in a web worker (`enableWorkerExtensionHost: true`, worker `extensionHostWorkerMain`).
- The production build is ~11 MB single chunk before splitting; the demo ships similarly sized.
- Workers require `vite` config adjustments: `worker.format: 'es'`, `build.target: 'es2022'`
  (top-level await) and the `@codingame/esbuild-import-meta-url-plugin`.

### esbuild wasm packaging note

`esbuild.wasm` cannot ship as a discrete Dataverse web resource, so the esbuild
extension imports it via `virtual:esbuild-wasm-binary` (see
`esbuildWasmInline` in `vite.config.ts`), which embeds the binary as base64 and
is compiled with `new WebAssembly.Module()` inside the build worker.

### node-runtime & npm packaging notes

The original `node-runtime` extension and the shared `VirtualFS` are kept for the
VFS-mirroring path. The active `node-runtime-v2` extension does not use
`sharedVfs.ts`:

- `src/extensions/node-runtime-v2/loader.ts` resolves and transpiles only the
  modules the entry reaches, reading through `vscode.workspace.fs`.
- Builtins come from almostnode's shims (`path`, `process`, `events`, `stream`,
  `http`, `crypto` fallbacks, ...) plus a local `fs` shim
  (`node-runtime-v2/fsShim.ts`) whose sync calls read a per-run cache and whose
  async calls go straight to the workspace.
- Static `require()`/`import` specifiers are prefetched. Dynamic requires and
  sync fs reads that were not prefetched throw a typed miss; the engine
  hydrates that path and retries the run. Retries re-execute module side
  effects, so `onRetry` logs them to the output channel.
- `writeFileSync` and friends are recorded in an overlay and flushed to the
  workspace after the run.

Both extensions share one almostnode `VirtualFS` (`src/extensions/sharedVfs.ts`):
npm installs packages into it (and mirrors `node_modules` back into the real
workspace), while the node-runtime extension requires them out of it. Two
compatibility aliases live in `vite.config.ts`:

- `node:zlib` → `src/stubs/zlibShim.ts` (pako-backed; used by just-bash)
- `/assets/runtime-worker-*.js` → `src/stubs/almostnodeRuntimeWorker.ts`
  (almostnode's dist references a hosted worker chunk that isn't shipped in
  the package; the main-thread runtime never boots it)

The rolldown wasm binding's browser glue is source-patched at build time in
`webResourceWasmInline` (vite.config.ts): its wasm URL becomes an inlined
data URL and its WASI worker is embedded as a blob URL
(`src/extensions/rolldown/inlineWorkerFactory.ts`), so the build never emits
separate .wasm asset files. The patch covers both glue copies (the
`@rolldown/binding-wasm32-wasi` package used by the oxc transform/minify
primitives, and the `@rolldown/browser` copy bundled with the full
`rolldown()` bundler in the rolldown worker).

The rollup extension uses `@rollup/browser`, whose parser is a separate
~588 KB wasm asset referenced via `new URL("bindings_wasm_bg.wasm",
import.meta.url)`. `vite.config.ts` inlines every `.wasm` asset regardless of
size (the 1 MB threshold still applies to non-wasm assets), so the production
build embeds it as a data URL and no separate `.wasm` web resource is emitted.
