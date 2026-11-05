# Extensions and VSIX packages

The Extensions view is connected to [Open VSX](https://open-vsx.org), so you can search for,
install and update web extensions the normal way. Local `.vsix` files and direct download URLs
are also supported through the VSIX commands.

Gallery installs use the workbench's extension management. VSIX file/URL installs use the in-IDE
ZIP parser and are stored in IndexedDB, then restored on every page load.

## Before you start

- The gallery is **Open VSX**, not the Microsoft Marketplace.
- A local or direct-URL package must be a **web extension**: it needs a `browser` entry point in
  `extension/package.json`, or no code entry point at all.
- Packages that only declare a Node.js `main` entry point are rejected. Extensions that rely
  on native modules, child processes or the real filesystem will not work.
- Install any npm dependencies the extension needs separately with the npm extension; VSIX
  install does not resolve package dependencies.

## Quick start

### From Open VSX

1. Open the **Extensions** view (`Ctrl+Shift+X`).
2. Search for the extension and click **Install**.
3. Confirm the publisher trust prompt, then **Install Anyway** if the workbench warns about
   limited web functionality.
4. Gallery installs activate immediately; reload if the extension does not show its commands yet.

### From a local file or URL

1. Run `VSIX: Install Extension from File…` or `VSIX: Install Extension from URL…`, or use
   **Install from VSIX…** in the Extensions view title.
2. Pick the file, or paste a direct `http(s)` link to a `.vsix`.
3. Wait for the install confirmation. The extension is registered immediately.
4. Reload the workbench so the Extensions view picks it up (`Reload` in the notification, or
   reload the page).

Installed extensions are listed in the normal **Extensions** view and can be disabled there.

## Commands

| Command                              | What it does                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `VSIX: Install Extension from File…` | Parse a local `.vsix`, store it and register it.                              |
| `VSIX: Install Extension from URL…`  | Download a `.vsix` over http(s) (for example from Open VSX), then install it. |
| `VSIX: Uninstall Extension…`         | Pick an installed VSIX and remove it from storage and the registry.           |
| `VSIX: Show Installed Extensions`    | List installed packages with their version and file name.                     |

The Extensions view title also exposes **Install from VSIX…**, because the built-in desktop
action is unavailable in the browser.

## Recommended extensions

The Welcome page has a **Recommended extensions** section with a one-click install from Open VSX.
A direct-URL button is kept as a fallback.

The first recommendation is the official Prettier extension. Its web build supports TSX and the
other Prettier languages, but it does not read project `.prettierrc` files, `.editorconfig` or
`.prettierignore`; configure it through `prettier.*` settings instead.

The built-in TypeScript language features also register a formatter, so VS Code asks you to pick
a default the first time you format a TS/TSX file. Choose **Configure… → Prettier - Code
formatter**, or set it explicitly:

```json
{
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "[typescriptreact]": {
    "editor.defaultFormatter": "esbenp.prettier-vscode"
  }
}
```

## What happens on install

### Gallery install

The workbench queries Open VSX, downloads the VSIX through the gallery service, unpacks it into
the web extension scanner's user data, and activates it. Updates and uninstalls go through the
normal Extensions view.

### VSIX file or URL install

1. The archive is unzipped in memory and `extension/package.json` is read.
2. The manifest is checked for web compatibility (`browser` entry point).
3. The package id is checked against the built-in Dataverse IDE extensions.
4. The original archive is saved to IndexedDB (database `dataverse-ide-vsix`).
5. Every file is served to the extension host as a `data:` URL and the extension is registered.

On startup, stored packages are restored **before** the workbench initializes, so they appear
in the Extensions view alongside the built-ins.

Because files are served as `data:` URLs, the extension host does not need `blob:` access for
installed packages.

## Updating and removing

- Gallery extensions update and uninstall from the Extensions view like normal VS Code.
- Reinstall a newer `.vsix` with the same extension id to upgrade a file/URL install. If
  registration fails, the previously stored version is restored.
- `VSIX: Uninstall Extension…` removes both the stored archive and the running registration.
- Uninstalling a VSIX-installed extension from the Extensions view is also handled: the stored
  package is cleaned up so it does not return on reload.

## Recipes

### Install a web extension from a local build

1. Build the extension with its web target (`browser` entry point).
2. Package it as a `.vsix`.
3. Run `VSIX: Install Extension from File…` and pick the file.
4. Reload, then check the Extensions view and the extension's commands.

### Roll back a bad update

Uninstall the package with `VSIX: Uninstall Extension…`, then install the previous `.vsix`
again. If the new version failed to register, the old archive was already restored
automatically.

### Check what is installed

Run `VSIX: Show Installed Extensions`. It lists the package id, display name, version and
original file name, which is useful when several builds share a display name.

## Troubleshooting

| Symptom                                           | Cause and fix                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `This VSIX is not a web extension`                | The package has only a Node.js `main` entry. Use a browser build or a different package.                            |
| `the "browser" entry point … is missing`          | The manifest points at a file that is not in the archive. Rebuild the VSIX.                                         |
| `Not a VSIX package`                              | The file is not a valid ZIP or has no `extension/package.json`.                                                     |
| Install succeeds but the Extensions view is empty | Reload the workbench; the view scans extensions during startup.                                                     |
| The extension installs but does nothing           | It may have failed to activate or rely on unsupported Node APIs. Check the extension host console/browser DevTools. |
| Cannot install over a built-in                    | Built-in Dataverse IDE extension ids are protected. Choose a different package.                                     |
| A gallery extension is missing                    | Search Open VSX first; the Microsoft Marketplace is not connected.                                                  |
| Gallery install asks for trust                    | Accept **Trust Publisher & Install**, then **Install Anyway** for web-limited extensions.                           |

## Limits

- Gallery searches Open VSX only, not the Microsoft Marketplace.
- Web extensions only; no Node.js-only, native or desktop extensions.
- VSIX file/URL installs do not resolve npm dependencies.
- Stored VSIX packages live in browser storage for the current origin; clearing site data removes
  them. Gallery installs live in the workbench's user data storage.
