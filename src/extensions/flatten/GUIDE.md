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

`Flatten: Combine Configured Files into Markdown` reads two workspace settings:

| Setting                        | Default   | Purpose                                              |
| ------------------------------ | --------- | ---------------------------------------------------- |
| `dataverseIde.flatten.name`    | `flatten` | Output file name; `.md` is appended when omitted.    |
| `dataverseIde.flatten.include` | `[]`      | Workspace-relative files, folders and glob patterns. |

```json
"dataverseIde.flatten.name": "llm-context",
"dataverseIde.flatten.include": ["src", "node_modules/**/*.{md,d.ts}", "package.json"]
```

- Paths are relative to the workspace root. Absolute paths are not used.
- Folders are expanded recursively with the same exclusions and 500-file cap as selected
  folders.
- Glob entries match workspace-relative file paths using [picomatch](https://github.com/micromatch/picomatch)
  syntax: `*` matches inside one folder, `**` matches any number of folders, `?` matches
  one character, `{md,d.ts}` lists alternatives, and character classes (`[ab]`) and
  extglobs (`@(a|b)`) also work. Matching is case-insensitive.
- If an entry exists as a literal file or folder, it is treated as a path even when its name
  contains glob characters, so folders like `src/app/[slug]` still work.
- A glob may start inside a normally excluded folder (`node_modules`, `dist`, `.git`,
  `.ide-build`) because traversal begins at the pattern's literal prefix. When it does, the
  default exclusions are disabled below that prefix, so package `dist` type definitions are
  included. Globs rooted elsewhere keep the normal exclusions. Each glob is capped at 10,000
  matched files and 20,000 visited folders.
- The output is written to the workspace root as `<name>.md` and replaced on each run; use
  the selected-files command when you need numbered, non-overwriting bundles.
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

## Folder and glob rules

- Folder selections recurse up to **500 files** per folder.
- `.git`, `node_modules`, `.ide-build` and `dist` are excluded from folder recursion.
- Glob includes start at their literal prefix, so `node_modules/**/*.md` can read Markdown
  from `node_modules`. If that prefix is inside a normally excluded folder, exclusions are
  disabled for the rest of that glob's subtree.
- Each glob is capped at **10,000 matched files** and **20,000 visited folders**.
- Previous flatten bundles (`#…#n.md`, plus legacy `~…#n.md`) are skipped, so flattening a
  folder twice does not fold an earlier bundle into the new one.

## Recipes

### Build LLM context for one feature

Select `src/extensions/esbuild` and flatten it. The resulting markdown has every source file
with its path and language, ready to paste into a chat.

### Review a change set

Select several modified files (Ctrl/Cmd-click in the explorer) and flatten them into one
document. The relative paths make it easy to trace each block.

### Snapshot a folder before refactoring

Flatten the folder, keep the generated `#…md` file, and refactor. The bundle is a plain
markdown file, so it diffs and commits like any other.

## Troubleshooting

| Symptom                                          | Cause and fix                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `select one or more files in the explorer first` | The command was run from the palette with no selection. Select files in the explorer or pass them from the context menu. |
| `no readable text files in the selection`        | Everything selected was unreadable. Check permissions and that the paths exist.                                          |
| `set "dataverseIde.flatten.include" …`           | The configured command has no include paths. Add workspace-relative files, folders or globs to the setting.              |
| A file appears as a placeholder                  | Its extension is not in the known text list (for example an image or a binary), or it could not be read.                 |
| Folder output is incomplete                      | Folder selections cap at 500 files and exclude `node_modules`, `dist`, `.git` and `.ide-build`.                          |
| Glob output is incomplete                        | Globs cap at 10,000 matched files and 20,000 visited folders.                                                            |
| Bundle is huge                                   | Select fewer files or a narrower folder/glob; there is no automatic size cap.                                            |

## Limits

- Text formats only; binary content is not embedded.
- 500-file cap per folder selection; 10,000-file cap per glob.
- Output is always written to the workspace root, not to the selected folder.
- Globs use picomatch syntax but do not support negation (`!`); a leading `!` is treated
  literally. Use separate include entries to choose what to bundle.

```

```
