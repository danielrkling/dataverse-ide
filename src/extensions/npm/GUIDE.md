# npm

Install real npm packages into the workspace `node_modules` from the browser. The extension
resolves versions against the npm registry, downloads tarballs, extracts them through
`vscode.workspace.fs`, and updates `package.json` and `node_modules/.package-lock.json`.

Use it to add runtime dependencies for esbuild, the Node runtime, Tailwind plugins or any
other workspace tool. No Node process or virtual filesystem is involved.

## Before you start

- Open a workspace. Packages are written into its `node_modules`.
- A `package.json` is not strictly required: the installer creates a minimal one on first
  install. Creating it yourself first is still the cleanest way to control name and version.
- Decide whether the package belongs in `dependencies` or `devDependencies` — the install
  commands record the section you choose.

## Quick start

1. Open the **npm** view in the **Dataverse IDE** activity bar (the `npm Packages` tree).
2. Run `npm: Add Dependency…` and enter a package and optional range, for example
   `lodash@^4`.
3. Watch progress in **Output → Dataverse IDE: npm**.
4. The tree refreshes with the new dependency. Imports now resolve in esbuild builds and the
   Node runtime.

For an existing `package.json`, run `npm: Install All Dependencies (package.json)`.

## Commands

| Command                                        | What it does                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `npm: Install Package`                         | Prompt for one or more specs and install them into `dependencies`. |
| `npm: Install All Dependencies (package.json)` | Install everything declared in `dependencies`.                     |
| `npm: Add Dependency…`                         | Prompt for a spec and save it under `dependencies`.                |
| `npm: Add Dev Dependency…`                     | Prompt for a spec and save it under `devDependencies`.             |
| `npm: Install Specific Dependency Version…`    | Pick a published version for an existing dependency.               |
| `npm: Uninstall Dependency`                    | Remove a package from `package.json` and `node_modules`.           |
| `npm: Open Dependency Registry Page`           | Open the package page on npmjs.com.                                |
| `npm: Refresh Package Tree`                    | Re-read `package.json`.                                            |
| `npm: List Installed Packages`                 | Show installed top-level packages.                                 |
| `npm: View Package Info…`                      | Show registry metadata for a package.                              |
| `npm: Check Outdated Dependencies`             | Compare declared ranges with the registry.                         |
| `npm: Prune Extraneous Packages`               | Remove packages not declared and not required transitively.        |

Specs accept `name`, `name@version`, `name@range` and scoped packages. Multiple specs can be
space-separated.

## How an install works

1. Ensure a `package.json` exists at the workspace root (a minimal one is created if needed).
2. Resolve the requested specs' full dependency closure against `https://registry.npmjs.org`
   using semver matching.
3. Download each tarball, gunzip/untar it, and write the files directly into
   `node_modules`.
4. Write resolved versions to `node_modules/.package-lock.json`.
5. Save the requested roots as `^range` in the chosen `package.json` section.

Installs are dependency-closure based, so shared transitive packages are installed once.
Up to six packages are downloaded concurrently.

## Recipes

### Add a dev dependency for type checking

Run `npm: Add Dev Dependency…` and enter `@types/node@^22`. It is written to
`devDependencies` and installed into `node_modules`, so `tsc` in the editor sees it.

### Install a package without touching package.json

`npm: Install Package` saves to `dependencies` by default. To install a package for a
throwaway experiment, install it and then remove the entry, or use
`Node: Run Active File` only after it is installed — the runtime does not resolve on demand.

### Recover a stale tree

Run `npm: Check Outdated Dependencies` to see drift, then
`npm: Install All Dependencies (package.json)`. If extra packages remain, run
`npm: Prune Extraneous Packages`; it asks for modal confirmation before deleting anything.

## Troubleshooting

| Symptom                                           | Cause and fix                                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `Could not resolve …` during an esbuild build     | The package is missing or the version range did not resolve. Install it with npm, then rebuild.                                  |
| An install fails halfway                          | Check the npm output channel. Re-run the same command; the resolver is idempotent and rewrites already-extracted files.          |
| `package.json` is invalid JSON                    | The installer cannot merge into it. Fix the file (or delete it to let the starter be created) and retry.                         |
| Dev dependencies are not installed by Install All | That command covers `dependencies`; add dev packages with `npm: Add Dev Dependency…`.                                            |
| Prune wants to remove something you need          | Extraneous means "not declared and not a transitive requirement". Declare it in `package.json` instead of keeping it undeclared. |

## Limits

- Registry is fixed to `https://registry.npmjs.org`; private registries and auth are not
  configurable.
- No lifecycle scripts (`preinstall`, `postinstall`, build scripts) and no `npm run`.
  Use the Scripts extension for command chains.
- No `package-lock.json` generation at the workspace root; resolved versions live in
  `node_modules/.package-lock.json`.
- Packages are installed into the workspace (or its `node_modules` OPFS overlay), not into a
  hidden global cache.
