# Dataverse IDE

A browser IDE built on [monaco-vscode-api](https://github.com/CodinGame/monaco-vscode-api),
rendering the full VSCode workbench and opening real local folders through the
[File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API).

## Dataverse hosting (production)

The whole IDE is deployed as **model-driven app web resources**:

- Binaries (`.wasm`/fonts) are **not** supported as web resource types, so only
  those are inlined into the JS chunks as base64 data URLs. Everything Dataverse
  can host (`.js`, `.json`, `.txt`, `.css`, `.html`, `.svg`, images) stays a
  separate web resource. (Inlining every asset under 1 MB used to inflate the
  entry chunk to 45 MB, ~34 MB of it base64 data URLs.)
- Source maps are dropped: `.map` is not a web resource type and they were
  ~59 MB of the old `dist/` output.
- `esbuild.wasm` ships as a gzip+base64 `.txt` web resource (~4.2 MB) and is
  fetched/decompressed at runtime (see below).
- Three files still exceed the 5 MB default: the eagerly loaded monaco/VS Code
  core chunk (~15 MB) and the two prebuilt language-server workers
  (`htmlServerMain.js` ~7.9 MB, `tsserver.web.js` ~5.8 MB). All are under
  16 MB. Splitting the monaco core with `manualChunks` causes cross-chunk TDZ
  errors, so the target org's upload limit is raised instead (see below).
- Everything is same-origin, so no CORS, no service worker needed for fetches:
  fonts, wasm data URLs, tsserver, and the File System Access API all just work
- The `{{uuid}}.localhost` iframe-remap only applies in local dev; in production
  the sandboxed extension-host iframe stays same-origin

Build for Dataverse:

```powershell
npm run build
```

Assets are referenced relatively (`./assets/...`), so the build works under any
web resource folder. The default deployment prefix is `dv_ide` (publisher
prefix `dv_` plus the `ide` folder), served at `/WebResources/dv_ide/`.

Deploy (PowerShell against your org):

```powershell
$token = (az account get-access-token --resource 00000007-0000-0000-c000-000000000000 --query accessToken -o tsv)
.\tools\deploy-webresources.ps1 -EnvironmentUrl "https://<org>.crm4.dynamics.com" -Token $token
```

The script lists `dist/**`, upserts each file as a `dv_ide/<relative-path>`
web resource via Web API v9.2 (`webresources` entity), then calls
`PublishAllCustomizations`. Notes:

- dataverse System Settings → Email tab → _Set file size limit for attachments_:
  lift it (default 5 MB) to at least 16 MB so the largest chunk fits (32 MB
  gives headroom)
- resources are created in the default solution; move them into a proper
  solution in Power Apps once crops in, or extend the script with solution-aware upserts
- the Dataverse org CSP needs to allow same-origin `blob:` workers
  (`worker-src blob:` / `child-src blob:`) for the extension-host iframe

### Package as a solution (.zip)

`deploy-webresources.ps1` pushes files straight into an org. To produce a
portable solution instead, package the same `dist/` output:

```powershell
npm run build
npm run package:solution
# -> artifacts/DataverseIDE_1.0.0.0.zip
```

The zip contains the built files as plain web resources named `dv_ide/...`,
plus the solution manifest (`solution.xml`, `customizations.xml`,
`[Content_Types].xml`). It is always **unmanaged** — Dataverse only produces
managed solutions by exporting from an org.

```powershell
npm run package:solution -- --solution=DataverseIDE --version=1.2.0.0
npm run package:solution -- --prefix=dv_ide --out=artifacts/ide.zip
```

Notes:

- No model-driven app or sitemap is included. After importing, open
  `https://<org>.crm.dynamics.com/WebResources/dv_ide/index.html`.
- The target org's `Organization.MaxUploadFileSize` must cover the largest
  single file. After the asset-inlining fix the largest files are the monaco
  core entry chunk (`assets/index-*.js`, ~15 MB) and the two language-server
  workers (`htmlServerMain.js` ~7.9 MB, `tsserver.web.js` ~5.8 MB), so raise the
  limit to at least 16 MB (32 MB gives headroom) under System Settings → Email.
  The packager prints the largest files and warns when one exceeds the default.
- `.map` and `.webmanifest` files are skipped: DevTools maps are not web
  resources, and `public/pwa.js` builds the manifest in memory because
  Dataverse has no `.webmanifest` type.

### Publish the solution on GitHub (local release)

Releases are created from this machine with the GitHub CLI — no CI required:

```powershell
gh auth login                          # once
.\tools\release.ps1 -Tag v1.0.0        # build, package, tag, upload
```

The script derives the four-part solution version from the tag (`v1.2.3` →
`1.2.3.0`), runs `npm run build` and `npm run package:solution`, writes
`artifacts/SHA256SUMS.txt`, pushes the tag if it is missing on `origin`, and
attaches both files to the GitHub Release. Options: `-SkipBuild`,
`-NotesFile notes.md`, `-Draft`, `-Prerelease`, `-Solution`, `-Prefix`, and
`-AllowDirty` (release uncommitted sources; the default refuses a dirty tree).
Re-running the same tag re-uploads the assets with `--clobber`.

Download page: <https://github.com/danielrkling/dataverse-ide/releases>

### GitHub Pages demo

The same `dist/` output can be served as a public demo from GitHub Pages:

```powershell
.\tools\deploy-pages.ps1              # build, then force-push dist/ to gh-pages
.\tools\deploy-pages.ps1 -SkipBuild
```

The script publishes `dist/` as the root of the `gh-pages` branch (the branch
history is replaced on every deploy), enables Pages on the first run, and waits
until the site answers. It writes `.nojekyll` before deploying because Jekyll
would otherwise drop Vite's `_*.js` chunks. The service worker supplies the
COOP/COEP headers, so the first visit is not cross-origin isolated and the
reload after the worker takes control is - the same two-phase behavior as the
Dataverse deployment.

Demo: <https://danielrkling.github.io/dataverse-ide/>

### Test the production build locally

`vite preview` is not a Dataverse test: it does not use the web-resource path
prefix, it serves modern MIME types, and it sends no Dataverse-like headers.
Use the harness instead (build first):

```powershell
npm run build
npm run serve:dataverse          # http://dvide.localhost:5199/WebResources/dv_ide/
```

It serves `dist/` under `/WebResources/dv_ide/`, sends **no** COOP/COEP
headers (Dataverse does not; the service worker adds them only after it takes
control), uses Dataverse's `application/x-javascript` MIME type for `.js`, and
optionally applies a CSP:

```powershell
npm run serve:dataverse -- --csp=loose             # allow blob: workers
npm run serve:dataverse -- --csp=no-blob-worker     # reproduce CSP-blocked workers
npm run serve:dataverse -- --js-mime=text/javascript --isolate
```

Open `http://dvide.localhost:<port>/WebResources/dv_ide/`, not
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

| Folder         | Status | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git`          | active | isomorphic-git SCM + HTTPS remotes (clone/fetch/pull/push); PAT cached per host in secret storage                                                                                                                                                                                                                                                                                                                                               |
| `dataverse`    | active | webresource upload/publish; additive-only table/column provisioning from dataverse.schema.json                                                                                                                                                                                                                                                                                                                                                  |
| `esbuild`      | active | esbuild-wasm bundling on the main thread; bundles a workspace entry to `dist/` (esbuild.config.json `outdir`); npm imports resolved from `node_modules`; optional `"solid": "v1"` or `"v2"` compiles JSX/TSX with Solid's Babel compilers (`babel-preset-solid` / `@solidjs/babel-plugin`) before esbuild's loaders                                                                                                                             |
| `html`         | active | self-contained HTML bundler: inlines local `<script src>`, stylesheets (including nested `@import`/`url()`), SVG/image assets and media posters, then writes the result under `dist/` (html.config.json)                                                                                                                                                                                                                                        |
| `node-runtime` | active | direct workspace-fs Node runtime: async loader resolves only the reachable module graph through `vscode.workspace.fs`, almostnode shims provide builtins, esbuild-wasm transpiles modules, sync writes flush back to the workspace; no VFS mirror. Permission levels `read-only` / `workspace` / `trusted` (default via `dataverseIde.nodeRuntime.permissions`); commands `Node: Run File` / `Run Active File` plus per-run permission variants |
| `terminal`     | active | just-bash shell in a native terminal panel, backed directly by `vscode.workspace.fs` (no VFS mirror, no sync-back); `node` delegates to `node-runtime`, `npm run` executes package.json scripts, `npm install` uses the direct installer; permission levels via `dataverseIde.terminal.permissions`; command history in IndexedDB (per workspace)                                                                                               |
| `npm`          | active | real installs via the local resolver + registry client (no VirtualFS) into workspace node_modules; `npm: Install Package`, `npm: Install All (package.json)`                                                                                                                                                                                                                                                                                    |
| `gitlab`       | active | separate from git; GitLab **REST API** with a PAT via secret storage: clone, project selection, merge requests, issues and pipelines                                                                                                                                                                                                                                                                                                            |
| `tailwind`     | active | Tailwind v4 completions + hovers generated from the installed design system's full class list (no WASM); parity checked by `tests/tailwindCandidates.sanity.mts` (`npm run test:tailwind`)                                                                                                                                                                                                                                                      |
| `welcome`      | active | editor-area welcome page: feature/extension overview, quick command buttons, Help → Welcome entry, and a `dataverseIde.welcome.showOnStartup` toggle                                                                                                                                                                                                                                                                                            |
| `vsix`         | active | connects the Extensions view to the Open VSX gallery for search/install/update, and installs browser extensions from local `.vsix` files or direct URLs (ZIP parser + IndexedDB persistence); restores them before the workbench starts so they appear in the Extensions view, and provides uninstall/list commands                                                                                                                             |

## Using the extensions

All extensions activate automatically after the workbench boots. Their commands show up
in the command palette (Ctrl+Shift+P / Cmd+Shift+P) via `contributes.commands` manifests:

| Extension    | Commands                                                                                                                                                                                       | Extra setup                                                                                                                                                                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Git          | `Git: …` (initialize/commit/branches/clone/push/pull/fetch/remotes/PAT credentials)                                                                                                            | local-folder workspace required                                                                                                                                                                                                                                                                       |
| Dataverse    | `Dataverse: …` (webresource upload/publish, schema plan/provision), `Dataverse: Open dataverse.config.json`, `Dataverse: Open dataverse.schema.json`                                           | settings in `dataverse.config.json` (prefix, solution, uploadRoot, files, exclude, publishAfterUpload, apiBaseUrl); `dataverse.schema.json` for additive table/column provisioning; watch debounce and config/schema paths via `dataverseIde.dataverse.watchDebounceMs` / `configPath` / `schemaPath` |
| esbuild      | `esbuild: Build Current File` → writes `<outdir>/<name>.js` (`dist/` by default), `esbuild: Solid Compiler…`                                                                                   | active workspace file; settings in `esbuild.config.json` (`entryPoints`, `outdir`, platform/charset, target/tree-shaking, JSX, `solid` v1/v2, source maps, banner/footer, splitting and output naming; path via `dataverseIde.esbuild.configPath`); npm imports resolved from `node_modules`          |
| HTML         | `HTML: Bundle Current File`, `HTML: Bundle Workspace…`, `HTML: Bundle Configured Entries`, `HTML: Start/Stop/Toggle Watch`, `HTML: Open html.config.json`                                      | settings in `html.config.json` (`entryPoints`, `outdir`, inline switches, `maxInlineBytes`, `minify`, `removeComments`; path via `dataverseIde.html.configPath`)                                                                                                                                      |
| Node Runtime | `Node: Run File`, `Node: Run Active File`, plus `… with Permissions…` variants — runs the workspace module graph directly, no VFS mirror                                                       | output appears in its output channel; default level via `dataverseIde.nodeRuntime.permissions`                                                                                                                                                                                                        |
| Terminal     | `Terminal: New Dataverse Shell`, `Terminal: Run Command…` — just-bash over the workspace filesystem, with `node`/`npm` commands                                                                | terminal panel; writes go straight to the workspace (no VFS mirror); default level via `dataverseIde.terminal.permissions`                                                                                                                                                                            |
| npm          | `npm: Install Package`, `npm: Install All Dependencies (package.json)`                                                                                                                         | package.json first (create one with the explorer New File if needed)                                                                                                                                                                                                                                  |
| GitLab       | `GitLab: Connect / Disconnect`, `Select Project`, `Clone Repository`, `Open Project in Browser`, `Show Merge Requests / Issues / Pipelines`, `New Issue`, `New Merge Request`                  | run **Connect** first for private projects; project auto-detected from origin or `dataverseIde.gitlab.project`; settings: `baseUrl`, `project`, `defaultBranch`, `cloneDepth` under `dataverseIde.gitlab.*`                                                                                           |
| Tailwind     | `Tailwind: Compile CSS From Workspace` — scans used class names and writes the configured output (`dist/tailwind.css` by default); completions/hovers appear only inside class-string contexts | settings in `tailwind.config.json` (`input`, `output`, `files`, `minify`; path via `dataverseIde.tailwind.configPath`)                                                                                                                                                                                |     |
| Welcome      | `Welcome: Show Welcome Page`                                                                                                                                                                   | opens automatically on startup when no editor is active; uncheck **Show this page on startup** on the page or set `dataverseIde.welcome.showOnStartup` to `false`. Also available under Help → Welcome                                                                                                |
| VSIX         | `VSIX: Install Extension from File…`, `VSIX: Install Extension from URL…`, `VSIX: Uninstall Extension…`, `VSIX: Show Installed Extensions`                                                     | the Extensions view browses Open VSX; file/URL installs need a `browser` entry point or no code entry point and persist in IndexedDB; the Welcome page has a recommended official Prettier install                                                                                                    |

### How-to guides

Each extension keeps its detailed guide next to its code as
`src/extensions/<id>/GUIDE.md`. Guides are bundled with the app (`?raw`), served as
read-only virtual documents (`dataverse-ide-guide:/<id>.md`), and opened in the markdown
preview. Every extension that ships a guide contributes a `<Feature>: How-to Guide`
command, also linked from the welcome page:

| Extension    | Command                   |
| ------------ | ------------------------- |
| Dataverse    | `Dataverse: How-to Guide` |
| esbuild      | `esbuild: How-to Guide`   |
| Flatten      | `Flatten: How-to Guide`   |
| Git          | `Git: How-to Guide`       |
| GitLab       | `GitLab: How-to Guide`    |
| HTML         | `HTML: How-to Guide`      |
| Node runtime | `Node: How-to Guide`      |
| npm          | `npm: How-to Guide`       |
| Scripts      | `Scripts: How-to Guide`   |
| Tailwind     | `Tailwind: How-to Guide`  |
| VSIX         | `VSIX: How-to Guide`      |
| Welcome      | `Welcome: How-to Guide`   |

To add a guide:

1. Create `src/extensions/<id>/GUIDE.md`.
2. Import it with `import guideContent from "./GUIDE.md?raw";`.
3. Call
   `registerGuide({ vscode, extensionId: "<id>", content: guideContent })` during
   activation and dispose the returned registration.
4. Add `dataverseIde.<id>.openGuide` to the extension's contributed commands.
5. Optionally link it from a welcome feature with `guide: "dataverseIde.<id>.openGuide"`.

### Sidebars (activity bar → "Dataverse IDE")

- **npm Packages** — Dependencies / Dev Dependencies groups; click a dependency for
  _Install specific version…_ (fetched from the npm registry), _Uninstall_, or
  _Open registry page_; palette also has `npm: Add Dependency…`.
- **Extensions** — enable/disable toggles per extension (apply after reload).

Dataverse and esbuild no longer have their own panels — everything is driven by
`dataverse.config.json` / `esbuild.config.json` and the `Dataverse: …` /
`esbuild: …` commands.

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
original script folder; pre-bundle module graphs with the esbuild extension first.

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
- The eagerly loaded portion of the production build is ~15 MB (monaco core plus
  the built-in extensions); lazy chunks add more when those features are used.
- Workers require `vite` config adjustments: `worker.format: 'es'`, `build.target: 'es2022'`
  (top-level await) and the `@codingame/esbuild-import-meta-url-plugin`.

### esbuild wasm packaging note

`esbuild.wasm` cannot ship as a `.wasm` Dataverse web resource, and raw base64
would be 15.7 MB. Instead the build emits a gzip-compressed, base64-encoded
`.txt` resource (`virtual:esbuild-wasm-gzip-url`, see `webResourceWasmInline` in
`vite.config.ts`). The extension fetches it at runtime, decompresses it with
`DecompressionStream("gzip")` and passes the bytes to `WebAssembly.compile()`.
The resulting web resource is ~4.2 MB, under the 5 MB default.

### Node runtime & npm packaging notes

The active `node-runtime` extension runs directly against the workspace:

- `src/extensions/node-runtime/loader.ts` resolves and transpiles only the
  modules the entry reaches, reading through `vscode.workspace.fs`.
- Builtins come from almostnode's shims (`path`, `process`, `events`, `stream`,
  `http`, ...) plus local fallbacks and an `fs` shim
  (`node-runtime/fsShim.ts`) whose sync calls read a per-run cache and whose
  async calls go straight to the workspace. This is the only remaining use of
  almostnode in the IDE.
- TypeScript/JSX/ESM modules are transpiled to CommonJS with esbuild-wasm
  (`node-runtime/transpile.ts`).
- Static `require()`/`import` specifiers are prefetched. Dynamic requires and
  sync fs reads that were not prefetched throw a typed miss; the engine
  hydrates that path and retries the run. Retries re-execute module side
  effects, so `onRetry` logs them to the output channel.
- `writeFileSync` and friends are recorded in an overlay and flushed to the
  workspace after the run.

### Terminal

The `terminal` extension opens a native VS Code terminal backed by
[just-bash](https://github.com/vercel-labs/just-bash), the shell almostnode
embeds. It does **not** use almostnode's `VirtualFS` or `createContainer()`:

- `terminal/shellFs.ts` implements just-bash's async `IFileSystem` directly on
  `vscode.workspace.fs`. Writes go through immediately, so there is no VFS
  mirror, no flush-back step, and no "which files changed" reconciliation.
- Only scratch paths (`/tmp`, `/home`, `/dev`, ...) live in memory.
- A metadata-only path index supplies the synchronous `getAllPaths()` call used
  by glob expansion; it is updated by writes/renames/deletes and by a workspace
  file watcher.
- The terminal is an extension-owned `Pseudoterminal`, so the workbench only
  needs `getTerminalServiceOverride()` for the panel UI - no pty backend.
- `node` is a custom command that delegates to `node-runtime`, and `npm`
  reuses the npm extension's direct installer.
- Command history is persisted in the `dataverse-ide` IndexedDB database
  (`terminalHistory` store, one record per workspace, last 1000 commands);
  `dataverseIde.terminal.history` toggles it.

npm installs use a local resolver and registry client
(`src/extensions/npm/registry.ts`) that write straight through
`vscode.workspace.fs`; they no longer use a VirtualFS or almostnode's package
manager.

#### Permissions

`dataverseIde.nodeRuntime.permissions` sets the default for `Node: Run File` and
`Node: Run Active File`. The `… with Permissions…` commands override it for one run.

| Level               | Filesystem                 | Network                     |
| ------------------- | -------------------------- | --------------------------- |
| `read-only`         | read workspace files       | blocked                     |
| `workspace`         | read/write workspace files | blocked                     |
| `trusted` (default) | read/write workspace files | same-origin network allowed |

Filesystem restrictions are enforced in both the workspace reader and the fs shim,
including sync writes, async writes, delete, rename, copy, and flush. Network blocking
temporarily replaces `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, and
`navigator.sendBeacon`; treat it as a guardrail rather than a security boundary, because
runtime code shares the extension-host worker globals. A dedicated worker with brokered
fs/network access would be required for hard isolation.

Two compatibility aliases live in `vite.config.ts`:

- `node:zlib` → `src/stubs/zlibShim.ts` (pako-backed)
- `/assets/runtime-worker-*.js` → `src/stubs/almostnodeRuntimeWorker.ts`
  (almostnode's dist references a hosted worker chunk that isn't shipped in
  the package; the direct runtime never boots it)

`vite.config.ts` inlines every `.wasm` asset and web font regardless of size;
other hostable types stay separate web resources. `esbuild.wasm` is special
cased as a gzip+base64 `.txt` asset (see above), so no separate `.wasm` web
resource is emitted.
