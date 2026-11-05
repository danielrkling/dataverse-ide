# Dataverse web resources

Upload files from the workspace straight into a Dataverse organisation as web resources.
The extension creates or updates each resource, optionally adds it to a solution, and
publishes the result. Watch mode keeps the organisation in sync while you edit.

Use it when the workspace contains the source for model-driven app web resources (HTML, JS,
CSS, images, icons) and you want to deploy without the Power Apps CLI or a desktop terminal.

## Before you start

- **Open a local folder.** Uploads use the File System Access API handle; a browser (OPFS)
  workspace has no handle and the extension refuses to activate. Open the folder with
  `Open Local Folder…` first.
- **Be signed in to the organisation.** The IDE is normally served from the Dataverse org,
  so the API call is same-origin and reuses the existing session cookie. If you run the IDE
  locally, set `apiBaseUrl` (and make sure the org allows the cross-origin request).
- **Choose a publisher prefix.** Dataverse web resource names need a publisher prefix such
  as `dv_ide`. The config is rejected when `prefix` is empty or has no underscore after the
  first two characters.

## Quick start

1. Run `Dataverse: Open dataverse.config.json`. On first use the file is scaffolded with the
   defaults and opened.
2. Set at least a prefix and the files you want to upload:

   ```json
   {
     "prefix": "dv_ide",
     "solution": "DataverseIDE",
     "uploadRoot": "dist",
     "files": ["**/*"],
     "exclude": ["**/*.map"],
     "publishAfterUpload": true
   }
   ```

3. Run `Dataverse: Upload Configured Web Resource Folder`.
4. Watch the progress notification; per-file results are in
   **Output → Dataverse Web Resource Upload**.

The web resource name is `<prefix>/<path relative to uploadRoot>`. With the config above,
`dist/index.html` becomes `dv_ide/index.html`.

## Commands

| Command                                               | What it does                                                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Dataverse: Upload Configured Web Resource Folder`    | Uploads every file matched by `files`/`exclude` under `uploadRoot`.                                                         |
| `Dataverse: Upload Selected Files or Folders`         | Explorer context-menu upload for a specific selection.                                                                      |
| `Dataverse: Upload Active File`                       | Uploads only the file in the active editor.                                                                                 |
| `Dataverse: Preview Selected HTML Web Resource`       | Opens the deployed HTML resource in a browser tab. Also available on `.html`/`.htm` files in the explorer and editor title. |
| `Dataverse: Start Watch Upload` / `Stop Watch Upload` | Watches the configured files and re-uploads the changed ones.                                                               |
| `Dataverse: Load User Identity`                       | Resolves the signed-in user and writes their name/email to IDE and Git settings.                                            |
| `Dataverse: Open dataverse.config.json`               | Creates the config on first use, then opens it.                                                                             |

## Configuration

`dataverse.config.json` lives at the workspace root. Point elsewhere with
`dataverseIde.dataverse.configPath` (workspace-relative). The file is validated by a JSON
Schema in the editor.

| Key                  | Default     | Notes                                                                                                  |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------------------ |
| `prefix`             | `""`        | Required. Web resource prefix, for example `dv_ide`.                                                   |
| `solution`           | —           | Optional unique solution name. When set, uploads are added to that solution.                           |
| `uploadRoot`         | `""`        | Workspace-relative folder that paths are taken from. Empty means the workspace root. `..` is rejected. |
| `files`              | `["**/*"]`  | Glob list relative to `uploadRoot`.                                                                    |
| `exclude`            | `[]`        | Glob list relative to `uploadRoot`.                                                                    |
| `publishAfterUpload` | `true`      | Publish after a completely successful upload.                                                          |
| `apiBaseUrl`         | same origin | Organisation base URL when the IDE is not served from the org.                                         |

Runtime tuning lives in settings, not the config file:

- `dataverseIde.dataverse.watchDebounceMs` (default `300`, minimum `100`) — how long watch
  waits for a burst of saves.
- `dataverseIde.dataverse.configPath` — where the config file is read from.

## How upload behaves

- Files are uploaded one by one. Existing resources with the same name are updated; new
  ones are created.
- Publishing is all-or-nothing: if any file fails, **nothing is published**, so a partial
  deploy never goes live. Fix the failing file and run the same command again.
- Watch only uploads files that still match the configured patterns. Deletions are not
  propagated — removing a file locally does not delete the web resource.
- Watch batches rapid saves (for example an esbuild rebuild touching several files) into one
  upload pass. Changes made while an upload is running are queued for the next pass.

## Recipes

### Deploy the output of the esbuild extension

```json
{
  "prefix": "dv_ide",
  "uploadRoot": "dist",
  "files": ["**/*.js", "**/*.css", "**/*.html", "**/*.svg", "**/*.png"],
  "exclude": ["**/*.map"],
  "publishAfterUpload": true
}
```

Build first (`esbuild: Build Workspace…`), then upload, or start watch and let each build
flow through.

### Deploy only one web resource

Right-click the file in the explorer and choose
`Dataverse: Upload Selected Files or Folders`, or open it and run
`Dataverse: Upload Active File`. The file must sit inside `uploadRoot`.

### Commit with the Dataverse identity

The IDE loads the signed-in Dataverse user automatically at startup and writes
`dataverseIde.git.authorName`, `dataverseIde.git.authorEmail`, `dataverseIde.user.name` and
`dataverseIde.user.email`, so Git stops prompting for an author and commits carry the Dataverse
user. Run `Dataverse: Load User Identity` to refresh those values after your name or email
changes in Dataverse.

## Troubleshooting

| Symptom                                                                           | Cause and fix                                                                                                                                                                 |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `The dataverse extension currently requires a local workspace directory handle.`  | You are in a browser/OPFS workspace. Open a local folder.                                                                                                                     |
| `Set "prefix" in dataverse.config.json before uploading.`                         | `prefix` is empty. Set a publisher prefix such as `dv_ide`.                                                                                                                   |
| `"prefix" … must contain an underscore somewhere after its first two characters.` | Use the publisher prefix format (`dv_ide`), not a plain folder name.                                                                                                          |
| 401 / 403 from the Web API                                                        | The browser session is not signed in to that org, or the org blocks the cross-origin request when the IDE is served elsewhere. Open the IDE from the org or set `apiBaseUrl`. |
| Upload reports failures and nothing is published                                  | At least one file failed. Open the output channel, fix the reported file, and rerun. Failed files are never partially published.                                              |
| Watch does not react                                                              | Check that the changed file matches `files` and is not covered by `exclude`; watch state is runtime-only and stops on reload.                                                 |

## Limits

- Local folder workspace only (the File System Access API handle is required).
- The extension does not delete remote resources when a local file disappears.
- Every upload goes through the browser's Web API session; there is no service principal or
  token configuration in the IDE.
