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

## Notes / tradeoffs

- Only a lean subset of the demo's service overrides is wired in; more can be added as
  needed (terminal, SCM, debug, welcome, chat, liveSearch, etc.) by installing the matching
  `@codingame/monaco-vscode-*-service-override` package and spreading it into `initialize()`.
- Extension host runs in a web worker (`enableWorkerExtensionHost: true`, worker `extensionHostWorkerMain`).
- The production build is ~11 MB single chunk before splitting; the demo ships similarly sized.
- Workers require `vite` config adjustments: `worker.format: 'es'`, `build.target: 'es2022'`
  (top-level await) and the `@codingame/esbuild-import-meta-url-plugin`.
