# Flatten files

Combine selected files or folders into one markdown bundle: each file becomes a heading with
its workspace-relative path and a fenced code block tagged with the file's language.

Use it to prepare LLM context, review a feature across many files, or capture a snapshot of a
folder without zip files.

## Before you start

- Open a workspace.
- Select one or more files or folders in the explorer. The command is also available from the
  explorer context menu (right-click → **Combine Selected Files into Markdown**).
- Be aware of size: the bundle includes the full text of every selected text file.

## Quick start

1. Select files or folders in the explorer.
2. Right-click and choose `Flatten: Combine Selected Files into Markdown`.
3. The bundle opens in the editor and is written to the workspace root as
   `#<folders>#<n>.md`.

Examples:

- Selecting `src/extensions` creates `#src-extensions#1.md`.
- Selecting a single file `src/app.ts` creates `#src#1.md`.
- If the derived name is too long or empty, the bundle is `#1.md`.

The number auto-increments from the highest existing bundle, so repeated runs never overwrite
an earlier one.

## Flatten a configured set of files

`Flatten: Combine Configured Files into Markdown` reads the workspace settings below. The
selected-files command uses the same settings except for `name` and `include`.

| Setting                                | Default   | Purpose                                                        |
| -------------------------------------- | --------- | -------------------------------------------------------------- |
| `dataverseIde.flatten.name`            | `flatten` | Output file name; `.md` is appended when omitted.              |
| `dataverseIde.flatten.include`         | `[]`      | Workspace-relative files, folders and glob patterns.           |
| `dataverseIde.flatten.exclude`         | `[]`      | Glob patterns skipped while expanding folders and globs.       |
| `dataverseIde.flatten.maxFileBytes`    | `400000`  | Larger files become a short note instead of their full text.   |
| `dataverseIde.flatten.outputDirectory` | `""`      | Workspace-relative output folder; empty means workspace root.  |
| `dataverseIde.flatten.includeHidden`   | `true`    | Include dotfiles/dot-folders during folder and glob expansion. |
| `dataverseIde.flatten.header`          | `true`    | Write the generated title and timestamp.                       |
| `dataverseIde.flatten.lineNumbers`     | `false`   | Prefix each bundled line with its line number.                 |
| `dataverseIde.flatten.manifest`        | `false`   | Add a `## Files` summary with line counts and sizes.           |

```json
"dataverseIde.flatten.name": "llm-context",
"dataverseIde.flatten.include": ["src", "node_modules/**/*.{md,d.ts}", "package.json"],
"dataverseIde.flatten.exclude": ["**/*.map", "**/*.min.*", "**/package-lock.json"],
"dataverseIde.flatten.outputDirectory": ".flatten",
"dataverseIde.flatten.header": false,
"dataverseIde.flatten.manifest": true
```

From the Dataverse shell, combine explicit paths or the configured includes:

```sh
flatten                       # use dataverseIde.flatten.include
flatten src/app.ts src/extensions
flatten --configured
```

Paths resolve against the shell's current directory. The command prints the bundle file name.

- Paths are relative to the workspace root. Absolute paths are not used.
- Folders are expanded recursively with the same exclusions and 500-file cap as selected
  folders.
- Glob entries match workspace-relative file paths using [picomatch](https://github.com/micromatch/picomatch)
  syntax: `*` matches inside one folder, `**` matches any number of folders, `?` matches
  one character, `{md,d.ts}` lists alternatives, and character classes (`[ab]`) and
  extglobs (`@(a|b)`) also work. Matching is case-insensitive.
- If an entry exists as a literal file or folder, it is treated as a path even when its name
  contains glob characters, so folders like `src/app/[slug]` still work.
- `dataverseIde.flatten.exclude` drops matching files from expanded folders and globs.
  Explicitly selected or explicitly included files are still bundled.
- With `dataverseIde.flatten.includeHidden` set to `false`, dotfiles and dot-folders are
  skipped during expansion. Explicit paths such as `.env` are still included.
- Files larger than `dataverseIde.flatten.maxFileBytes` are replaced by a note with their
  size. Set it to `0` to embed everything.
- A glob may start inside a normally excluded folder (`node_modules`, `dist`, `.git`,
  `.ide-build`) because traversal begins at the pattern's literal prefix. When it does, the
  default exclusions are disabled below that prefix, so package `dist` type definitions are
  included. Globs rooted elsewhere keep the normal exclusions. Each glob is capped at 10,000
  matched files and 20,000 visited folders.
- The output is written to `dataverseIde.flatten.outputDirectory` (the workspace root by
  default) and replaced on each run; use the selected-files command when you need numbered,
  non-overwriting bundles.
- Run the command from the command palette or the welcome page. If the include list is empty
  or contains no readable files, a warning explains what to fix.

## What goes into the bundle

````
# Flattened workspace files

Generated 2026-11-02T10:14:00.000Z — 3 file(s)

## src/app.ts

```ts
…
```

## src/styles.css

```css
…
```
````

- Files appear in selection order; folders are expanded recursively.
- Each section starts with `## <workspace-relative path>`.
- The fence is lengthened when a file contains backtick runs, so nested code blocks do not
  break the bundle.
- Binary or unsupported files appear as a short placeholder note instead of their content.
- Unreadable files are skipped and counted in the header.
- `dataverseIde.flatten.header` toggles the generated title and timestamp; disable it for
  output that stays identical between runs.
- `dataverseIde.flatten.manifest` adds a `## Files` list before the sections:
  `- src/app.ts (42 lines, 1.2 KB)`.
- `dataverseIde.flatten.lineNumbers` renders each line as `12 | const x = 1`. This makes
  line references unambiguous for a chat model, but the numbers are inside the code block,
  so leave it off when the model should reproduce code exactly.

## Folder and glob rules

- Folder selections recurse up to **500 files** per folder.
- `.git`, `node_modules`, `.ide-build` and `dist` are excluded from folder recursion.
- Files matching `dataverseIde.flatten.exclude` are dropped from folder and glob expansion.
- With `dataverseIde.flatten.includeHidden` set to `false`, dotfiles and dot-folders are
  skipped during expansion.
- Glob includes start at their literal prefix, so `node_modules/**/*.md` can read Markdown
  from `node_modules`. If that prefix is inside a normally excluded folder, exclusions are
  disabled for the rest of that glob's subtree.
- Each glob is capped at **10,000 matched files** and **20,000 visited folders**.
- Previous flatten bundles (`#…#n.md`, plus legacy `~…#n.md`) are skipped, so flattening a
  folder twice does not fold an earlier bundle into the new one. Place bundles in
  `dataverseIde.flatten.outputDirectory` to keep them out of the source tree.

## Recipes

### Build LLM context for one feature

Select `src/extensions/esbuild` and flatten it. The resulting markdown has every source file
with its path and language, ready to paste into a chat.

### Feed a chat that has no file access

Configure a reusable context bundle:

```json
"dataverseIde.flatten.include": ["src", "package.json", "README.md"],
"dataverseIde.flatten.exclude": ["**/*.map", "**/*.min.*", "**/*.test.ts"],
"dataverseIde.flatten.maxFileBytes": 400000,
"dataverseIde.flatten.manifest": true,
"dataverseIde.flatten.header": false,
"dataverseIde.flatten.outputDirectory": ".flatten"
```

Then run `flatten --configured`. The `## Files` manifest tells the model what is present and
how large each file is, `maxFileBytes` keeps generated files from crowding out source, and
turning the header off makes repeat bundles diff cleanly. Enable
`dataverseIde.flatten.lineNumbers` only when you want the model to cite exact line numbers.

### Review a change set

Select several modified files (Ctrl/Cmd-click in the explorer) and flatten them into one
document. The relative paths make it easy to trace each block.

### Snapshot a folder before refactoring

Flatten the folder, keep the generated `#…md` file, and refactor. The bundle is a plain
markdown file, so it diffs and commits like any other.

## Troubleshooting

| Symptom                                          | Cause and fix                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `select one or more files in the explorer first` | The command was run from the palette with no selection. Select files in the explorer or pass them from the context menu.                                                                          |
| `no readable text files in the selection`        | Everything selected was unreadable. Check permissions and that the paths exist.                                                                                                                   |
| `set "dataverseIde.flatten.include" …`           | The configured command has no include paths. Add workspace-relative files, folders or globs to the setting.                                                                                       |
| A file appears as a placeholder                  | Its extension is not in the known text list (for example an image or a binary), it could not be read, or it is larger than `dataverseIde.flatten.maxFileBytes`. Raise the limit or set it to `0`. |
| Folder output is incomplete                      | Folder selections cap at 500 files and exclude `node_modules`, `dist`, `.git` and `.ide-build`. Check `dataverseIde.flatten.exclude` and `includeHidden`.                                         |
| Glob output is incomplete                        | Globs cap at 10,000 matched files and 20,000 visited folders. Check `dataverseIde.flatten.exclude` and `includeHidden`.                                                                           |
| Bundle is huge                                   | Lower `dataverseIde.flatten.maxFileBytes`, add `exclude` patterns, or select fewer files; there is no automatic total size cap.                                                                   |
| Bundle changes on every run                      | Set `dataverseIde.flatten.header` to `false` to drop the generated timestamp.                                                                                                                     |

## Limits

- Text formats only; binary content is not embedded.
- 500-file cap per folder selection; 10,000-file cap per glob.
- `maxFileBytes` defaults to 400,000 bytes per file; `0` disables the per-file limit.
- Output is written to the workspace root unless `outputDirectory` is set, not to the
  selected folder.
- Globs use picomatch syntax but do not support negation (`!`); a leading `!` is treated
  literally. Use `exclude` or separate include entries to choose what to bundle.

```

```
