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

- dataverse System Settings → Email tab → *Set file size limit for attachments*:
  lift it (default 5 MB) to at least 32 MB so the `builtin-extensions` chunk fits
- resources are created in the default solution; move them into a proper
  solution in Power Apps once crops in, or extend the script with solution-aware upserts
- the Dataverse org CSP needs to allow same-origin `blob:` workers
  (`worker-src blob:` / `child-src blob:`) for the extension-host iframe


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
  id: string
  activate(context: ExtensionContext): Promise<vscode.Disposable | void>
}
```

`ExtensionContext` (see `src/extensions/api.ts`) gives each feature the vscode API,
workspace root/handle, its own output channel, namespaced secret storage, and a
shared `http` fetch (future home of auto-injected Dataverse auth).

The registry (`src/extensions/registry.ts`) lazily imports each module and
activates it; new features require only a folder plus one entry in
`extensionModules` and an `extensionEnabled` flag.

Current extensions:

| Folder            | Status     | Notes                                                        |
| ----------------- | ---------- | ------------------------------------------------------------ |
| `git`             | active     | isomorphic-git SCM + HTTPS remotes (clone/fetch/pull/push); PAT cached per host in secret storage |
| `dataverse`       | active     | webresource upload/publish                                   |
| `esbuild`         | active     | esbuild-wasm build worker; bundles a workspace entry to `.ide-build/`; npm imports are externalized |
| `node-runtime`    | active     | almostnode engine, main-thread same-origin (shares page auth); syncs workspace sources into the shared VFS per run; commands `runFile`/`runEntry` |
| `npm`             | active     | real installs via almostnode PackageManager into node_modules; `npm: Install Package`, `npm: Install All (package.json)` |
| `gitlab`          | stub       | separate from git; GitLab **REST API** with a PAT via secret storage |
| `tailwind`        | active     | Tailwind v4 completions + hovers from default-theme data (no WASM); @tailwindcss/browser preview is a later step |
| `rolldown`        | active*    | oxc WASM primitives in a worker: Transform TS/JSX→JS, Minify. **Full `rolldown()` bundling not available in-browser** — the published binding loader is Node/WebContainer-only, so bundling routes through the esbuild extension; revisit if rolldown ships a browser entry. Also requires cross-origin isolation (SharedArrayBuffer) for the wasi threads runtime |


## Using the extensions

All extensions activate automatically after the workbench boots. Their commands show up
in the command palette (Ctrl+Shift+P / Cmd+Shift+P) via `contributes.commands` manifests:

| Extension    | Commands                                                                                             | Extra setup                                                            |
| ------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Git          | `Git: …` (initialize/commit/branches/clone/push/pull/fetch/remotes/PAT credentials)                  | local-folder workspace required                                         |
| Dataverse    | `Dataverse: …` (webresource upload/publish)                                                          | `dataverseWebResources.*` settings                                      |
| esbuild      | `esbuild: Build Current File` → writes `.ide-build/<name>.js`                                        | active workspace file; npm imports resolved from `node_modules`         |
| Node Runtime | `Node: Run File`, `Node: Run Active File` — also powers `require()` for installed npm packages        | output appears in its output channel                                    |
| npm          | `npm: Install Package`, `npm: Install All Dependencies (package.json)`                                | package.json first (create one with the explorer New File if needed)    |
| GitLab       | `GitLab: Connect`, `Show Merge Requests / Issues / Pipelines`, `New Merge Request`                     | run **Connect** first; project auto-detected from origin or `dataverseIde.gitlab.project`; baseUrl via `dataverseIde.gitlab.baseUrl` |
| Tailwind     | `Tailwind: Compile CSS From Workspace` — scans used class names and writes `.ide-build/tailwind.css`; completions/hovers appear only inside class-string contexts |                              |
| Rolldown     | `rolldown: Transform Current File (TS/JSX → JS)`, `rolldown: Minify Current File`                      | active workspace file; full bundling routes through esbuild (see table) |

### Sidebars (activity bar → "Dataverse IDE")

- **Dataverse Settings** — click an item to edit (`Web Resource Prefix`, `Solution`,
  `Upload Root`, `Publish After Upload`, `API Base URL Override`, include/exclude globs).
- **npm Packages** — Dependencies / Dev Dependencies groups; click a dependency for
  *Install specific version…* (fetched from the npm registry), *Uninstall*, or
  *Open registry page*; palette also has `npm: Add Dependency…`.
- **esbuild Build Settings** — Output Directory, Minify on/off, output Format
  (esm/iife/cjs), and **Watch** (re-bundles the last built entry on save).

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
separate .wasm asset files.
