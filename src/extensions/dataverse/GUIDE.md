# Dataverse web resources and schema

Upload files from the workspace straight into a Dataverse organisation as web resources.
The extension creates or updates each resource, optionally adds it to a solution, and
publishes the result. Watch mode keeps the organisation in sync while you edit.

The same extension can provision custom tables and columns from
`dataverse.schema.json`. Provisioning is **additive only**: it creates what is missing and
never updates or deletes existing metadata.

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
   **Output → Dataverse**.

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
| `Dataverse: Open dataverse.schema.json`               | Creates an empty schema file on first use, then opens it.                                                                   |
| `Dataverse: Preview Schema Plan`                      | Reads the org's metadata and opens a `+`/`=`/`!` diff. Makes no changes.                                                    |
| `Dataverse: Provision Schema (Create Only)`           | Shows the plan, asks for confirmation, then creates the missing tables/columns/lookups and publishes them.                  |
| `Dataverse: Publish Schema Tables`                    | Publishes every table declared in `dataverse.schema.json`; useful after a failed publish.                                   |
| `Dataverse: Open dataverse.config.json`               | Creates the config on first use, then opens it.                                                                             |

From the Dataverse shell:

```sh
dataverse                         # upload configured web resources
dataverse upload dist/index.html  # upload specific files or folders
dataverse upload-active
dataverse preview dist/index.html
dataverse watch
dataverse stop
dataverse identity
dataverse config
dataverse schema
dataverse schema preview
dataverse schema provision
dataverse schema publish
dataverse guide
```

Uploads print the resource count and exit non-zero when any file fails.

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
- `dataverseIde.dataverse.configPath` — where the upload config file is read from.
- `dataverseIde.dataverse.schemaPath` (default `dataverse.schema.json`) — where the schema
  provisioning file is read from.

## How upload behaves

- Files are uploaded one by one. Existing resources with the same name are updated; new
  ones are created.
- Publishing is all-or-nothing: if any file fails, **nothing is published**, so a partial
  deploy never goes live. Fix the failing file and run the same command again.
- Watch only uploads files that still match the configured patterns. Deletions are not
  propagated — removing a file locally does not delete the web resource.
- Watch batches rapid saves (for example an esbuild rebuild touching several files) into one
  upload pass. Changes made while an upload is running are queued for the next pass.
- Publishing is much slower than uploading (often 20s or more) and is shown by the
  `dataverse: Publishing…` status bar item; hover it for the resource count and result.
  Watch mode coalesces resource IDs for about 1.5s and then publishes them once in the
  background, so a burst of saves does not trigger a publish per file.
- A publish request has a longer timeout than normal API calls. A timed-out publish is not
  retried automatically because Dataverse may still be completing it server-side.

## Provision tables and columns

`dataverse.schema.json` describes custom tables and columns and gets JSON Schema validation
in the editor. The provisioner reads the org's metadata first, shows a plan, and then
creates only the missing components.

### Quick start

1. Run `Dataverse: Open dataverse.schema.json`. On first use an empty
   `{ "tables": [] }` file is created.
2. Add tables and columns:

   ```json
   {
     "prefix": "new_",
     "tables": [
       {
         "name": "project",
         "displayName": "Project",
         "displayCollectionName": "Projects",
         "primaryName": { "name": "name", "displayName": "Project Name", "maxLength": 200 },
         "columns": [
           { "name": "description", "type": "memo", "maxLength": 4000 },
           {
             "name": "status",
             "type": "choice",
             "options": [{ "label": "Active" }, { "label": "Closed" }]
           },
           { "name": "budget", "type": "money", "precision": 2 },
           { "name": "dueDate", "type": "datetime", "format": "DateOnly" },
           {
             "name": "serialNumber",
             "type": "string",
             "autoNumberFormat": "PRJ-{SEQNUM:5}"
           },
           { "name": "account", "type": "lookup", "target": "account" }
         ]
       }
     ]
   }
   ```

3. Run `Dataverse: Preview Schema Plan`. A markdown diff opens with `+` create, `=` already
   present, and `!` conflict. The same text is written to the output channel.
4. Run `Dataverse: Provision Schema (Create Only)`, review the plan, and confirm. The
   extension creates missing tables, columns and lookups, then publishes the changed
   tables once.

### Naming and the publisher prefix

`name` is the part **after** the publisher prefix. With `"name": "project"` and
`"prefix": "new_"`, the logical name is `new_project` (schema name `new_Project`) and the
primary name column is `new_name` (`new_Name`).

The prefix is taken from `dataverse.config.json` unless `dataverse.schema.json` sets its
own `prefix`. This matters when the web resource prefix (`dv_ide`) and the Dataverse
publisher prefix (`new_`) are different: set `"prefix": "new_"` in the schema file.
The schema file's `solution` key likewise overrides the configured solution.

The prefix should match the publisher of the solution in `dataverse.config.json`. Dataverse
only checks that a customization prefix is present, not that it matches the publisher, so a
wrong prefix creates inconsistent metadata. The caller needs System Customizer or System
Administrator.

### Supported column types

| `type`        | Notes                                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------------------- |
| `string`      | `maxLength` 1–4000 (default 200), `format` (default `Text`), optional `autoNumberFormat`.                     |
| `memo`        | `maxLength` 1–1048576 (default 2000), `format` (default `TextArea`).                                          |
| `integer`     | Optional `minValue` / `maxValue`.                                                                             |
| `bigint`      | 64-bit integer.                                                                                               |
| `decimal`     | `precision` 0–10 (default 2), optional `minValue` / `maxValue`.                                               |
| `money`       | Currency column. By default precision follows the transaction currency; set `precision` to use a fixed value. |
| `boolean`     | Optional `trueLabel`, `falseLabel`, `defaultValue`.                                                           |
| `datetime`    | `format` is `DateOnly` (default) or `DateAndTime`.                                                            |
| `choice`      | Local choice; `options` is required. Values auto-start at `100000000`.                                        |
| `multichoice` | Multi-select local choice; same `options` rules.                                                              |
| `lookup`      | Requires `target`; creates a one-to-many relationship and its lookup column.                                  |

Common keys: `displayName`, `description`, `required`, `format`, `minValue`, `maxValue`,
`precision`, `options`, `optionSetBase`, `target`, `relationshipName`, and
`autoNumberFormat`. `relationshipName` overrides the generated relationship schema name (for
example `new_project_new_account`).

`target` may be a table declared in the same file (short name, for example `project`) or
an existing table logical name (for example `account`). Lookup columns assume the target's
primary key is `<logicalname>id`.

### Autonumber columns

Dataverse autonumber columns are string columns with an `AutoNumberFormat`. Set
`autoNumberFormat` on a `type: "string"` column, or on the table's `primaryName`:

```json
{
  "name": "serialNumber",
  "type": "string",
  "maxLength": 100,
  "autoNumberFormat": "PRJ-{SEQNUM:5}-{RANDSTRING:4}"
}
```

Supported placeholders:

| Placeholder            | Notes                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `{SEQNUM:n}`           | Required. Zero-padded sequential number; it keeps growing past `n` rather than truncating. |
| `{RANDSTRING:n}`       | Optional. `n` must be between 1 and 6.                                                     |
| `{DATETIMEUTC:format}` | Optional. Uses a .NET date/time format string, for example `yyyyMMddhhmmss`.               |

Examples: `PRJ-{SEQNUM:5}`, `TKT-{SEQNUM:6}-{DATETIMEUTC:yyyyMM}`, `INV-{SEQNUM:4}-{RANDSTRING:3}`.

Notes:

- The column format must be `Text`. The provisioner rejects other formats when
  `autoNumberFormat` is set.
- Leave enough room in `maxLength` for the literal text plus realistic sequential values. The
  default is 200.
- Sequential values start at 1000 by default. The provisioner does not call
  `SetAutoNumberSeed`; that setting is environment-specific and is not stored in a solution.
  Set it separately if you need a different starting number.
- An existing plain string column is **not** converted to an autonumber column. Delete it and
  provision again if you want the autonumber behavior.
- An autonumber primary name column is supported.

### What the plan shows

The preview is a diff:

```diff
+ table new_project — Project (create — table does not exist)
+   column new_name — Project Name (create — primary name column, created with the table)
+   column new_description — Description (create — column does not exist)
=   column new_status — Status (skip — column already exists)
!   column new_account — Account (conflict — existing StringType, expected LookupType)
```

- `+` is created by the provision command.
- `=` is left alone because it already exists.
- `!` is a conflict: the existing column has a different type. Conflicts block the whole
  run, so a partial schema is never applied.

### Additive-only behavior

- Existing tables are never altered. Existing columns with the same type are skipped; their
  options, labels and required level are not updated. A different type is reported as a
  conflict.
- Missing columns can be added to an existing table.
- A missing primary name column on an existing table is a conflict because Dataverse
  cannot add one after the fact.
- To rename, retype or delete a table or column, delete it first in the maker portal (or
  with the Web API) and provision again. Deleting a table removes its columns too. Only
  unmanaged custom components can be deleted this way.
- A failure does not roll back earlier creates. Re-running is safe and idempotent: the
  plan sees what already exists and skips it.
- Publishing happens once at the end for every changed table. If publishing fails, the
  metadata exists but is not yet active in model-driven apps; run
  `Dataverse: Publish Schema Tables` after fixing the cause.

### Deleting a component to edit it

Use the maker portal, or these Web API calls from the same org session:

```http
DELETE /api/data/v9.2/EntityDefinitions(LogicalName='new_project')
DELETE /api/data/v9.2/EntityDefinitions(LogicalName='new_project')/Attributes(LogicalName='new_description')
DELETE /api/data/v9.2/RelationshipDefinitions(<relationshipid>)
```

Publish the affected table afterwards. This is intentionally not exposed as an IDE command;
deletion is a separate, deliberate action.

### Limitations

- Tables, columns and lookups only. Forms, views, charts, sitemaps, security roles, global
  choice sets and many-to-many relationships are not provisioned.
- No update or delete path, by design.
- Autonumber formats are created, but seed values (`SetAutoNumberSeed`) are not provisioned
  because they are environment-specific.
- Lookup creation assumes the target primary key is `<logicalname>id`.
- The schema file uses short names plus one publisher prefix; multi-publisher schemas are
  not supported.
- Metadata changes are environment-wide; use a development environment first.

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

| Symptom                                                                           | Cause and fix                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `The dataverse extension currently requires a local workspace directory handle.`  | You are in a browser/OPFS workspace. Open a local folder.                                                                                                                                                     |
| `Set "prefix" in dataverse.config.json before uploading.`                         | `prefix` is empty. Set a publisher prefix such as `dv_ide`.                                                                                                                                                   |
| `"prefix" … must contain an underscore somewhere after its first two characters.` | Use the publisher prefix format (`dv_ide`), not a plain folder name.                                                                                                                                          |
| `No dataverse.schema.json found`                                                  | Run `Dataverse: Open dataverse.schema.json` to scaffold it, or set `dataverseIde.dataverse.schemaPath`.                                                                                                       |
| `dataverse.schema.json is invalid`                                                | Open the file: the error lists the failing key path. Fix it and run the plan again.                                                                                                                           |
| `… is not a valid Dataverse publisher prefix`                                     | Use the publisher's customization prefix (`new_`), not the web resource prefix from `dataverse.config.json`. Add `"prefix": "new_"` to the schema file if they differ.                                        |
| `Dataverse schema has N conflict(s)`                                              | An existing table/column does not match the declared type. Delete it in Dataverse, or change the schema, then run the plan again.                                                                             |
| `403` while planning or provisioning                                              | The signed-in user needs System Customizer or System Administrator in that environment.                                                                                                                       |
| Provisioning created some components but reported failures                        | Some creates failed after earlier ones succeeded. Open the output channel, fix the reported item, and rerun; already-created items are skipped. For a failed publish, run `Dataverse: Publish Schema Tables`. |
| A schema change did not take effect                                               | Provisioning is additive only. Delete the existing table/column and provision again; in-place edits are not applied.                                                                                          |
| 401 / 403 from the Web API                                                        | The browser session is not signed in to that org, or the org blocks the cross-origin request when the IDE is served elsewhere. Open the IDE from the org or set `apiBaseUrl`.                                 |

## Limits

- Local folder workspace only (the File System Access API handle is required).
- The extension does not delete remote resources when a local file disappears.
- Schema provisioning only creates tables, columns and lookups; it never updates or deletes
  existing metadata.
- Every request goes through the browser's Web API session; there is no service principal or
  token configuration in the IDE.
