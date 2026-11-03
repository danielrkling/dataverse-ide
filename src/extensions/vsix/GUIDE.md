# VSIX extensions

Install browser-compatible VS Code extensions from local `.vsix` files. Packages are stored in
IndexedDB and re-registered on every page load, so they behave like the built-in extensions
after a reload.

Use it to bring in a web extension that is not part of the IDE's built-in set.

## Before you start

- Have a `.vsix` file on disk. The extension cannot browse or download from the marketplace.
- The package must be a **web extension**: it needs a `browser` entry point in
  `extension/package.json`, or no code entry point at all.
- Packages that only declare a Node.js `main` entry point are rejected. Extensions that rely
  on native modules, child processes or the real filesystem will not work.
- Install any npm dependencies the extension needs separately with the npm extension; VSIX
  install does not resolve package dependencies.

## Quick start

1. Run `VSIX: Install Extension from File…`, or use **Install from VSIX…** in the Extensions
   view title.
2. Pick the `.vsix` file in the browser picker.
3. Wait for the install confirmation. The extension is registered immediately.
4. Reload the workbench so the Extensions view picks it up (`Reload` in the notification, or
   reload the page).

Installed extensions are listed in the normal **Extensions** view and can be disabled there.

## Commands

| Command                              | What it does                                                        |
| ------------------------------------ | ------------------------------------------------------------------- |
| `VSIX: Install Extension from File…` | Parse a local `.vsix`, store it and register it.                    |
| `VSIX: Uninstall Extension…`         | Pick an installed VSIX and remove it from storage and the registry. |
| `VSIX: Show Installed Extensions`    | List installed packages with their version and file name.           |

The Extensions view title also exposes **Install from VSIX…**, because the built-in desktop
action is unavailable in the browser.

## What happens on install

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

- Reinstall a newer `.vsix` with the same extension id to upgrade. If registration fails, the
  previously stored version is restored.
- `VSIX: Uninstall Extension…` removes both the stored archive and the running registration.
- Uninstalling from the Extensions view is also handled: the stored package is cleaned up so
  it does not return on reload.

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

## Limits

- Local `.vsix` files only; no marketplace browsing or online updates.
- Web extensions only; no Node.js-only, native or desktop extensions.
- Dependencies are not installed automatically.
- Stored packages live in browser storage for the current origin; clearing site data removes
  them.
