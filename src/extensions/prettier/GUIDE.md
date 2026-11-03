# Prettier

Format the active document with the browser build of Prettier. The extension bundles Prettier
itself plus the Babel, TypeScript, HTML, PostCSS, YAML, Markdown and GraphQL parsers, so no
workspace install is needed and nothing runs in a Node process.

Use it to keep web resource sources consistent without a desktop formatter.

## Before you start

- Open a workspace containing the file you want to format.
- Optionally add a Prettier config at the workspace root (see below). Without one, Prettier's
  defaults apply.
- The extension formats the **workspace root's** config only; nested `.prettierrc` files are
  not resolved per folder.

## Quick start

1. Open a supported file (for example a `.tsx` or `.html` file).
2. Run `Prettier: Format Document`, or use the standard **Format Document** command
   (`Shift+Alt+F` on Windows/Linux).
3. To format on every save, set `dataverseIde.prettier.formatOnSave` to `true`.

The command edits the document in place. If Prettier makes no changes, nothing is written.

## Supported languages

| Language             | Parser                  |
| -------------------- | ----------------------- |
| JavaScript / JSX     | `babel`                 |
| TypeScript / TSX     | `typescript`            |
| HTML / Vue           | `html` / `vue`          |
| CSS / SCSS / Less    | `css` / `scss` / `less` |
| JSON / JSONC / JSON5 | `json` / `json5`        |
| YAML                 | `yaml`                  |
| Markdown / MDX       | `markdown` / `mdx`      |
| GraphQL              | `graphql`               |

The parser is picked from the editor language id, with the file extension as a fallback.

## Configuration

The extension reads, in order:

1. `.prettierrc`
2. `.prettierrc.json`
3. `.prettierrc.json5`
4. the `"prettier"` key in `package.json`

Comments and trailing commas are tolerated in the JSON files. Example:

```json
{
  "singleQuote": true,
  "printWidth": 100,
  "embeddedJsxTags": ["jsx", "html"]
}
```

`embeddedJsxTags` is an extension-specific option, not a Prettier core option. It tells the
tagged-JSX embed plugin which tagged template names contain JSX, so `html\`…\``and`jsx\`…\``blocks are formatted as JSX. The default is`["jsx", "html"]`.

### Settings

| Setting                              | Default | Notes                                 |
| ------------------------------------ | ------- | ------------------------------------- |
| `dataverseIde.prettier.formatOnSave` | `false` | Format the document when it is saved. |

## Recipes

### Format a Solid or tagged-JSX file

1. Create a `.prettierrc` with `"embeddedJsxTags": ["html", "jsx"]` (or your tag names).
2. Open the file and run `Prettier: Format Document`.

Nested JSX inside the tagged template is formatted with the Babel parser; the surrounding
template is preserved.

### Format on save for one project

Set `dataverseIde.prettier.formatOnSave` in **Workspace** settings, not user settings, so the
behavior travels with the project.

## Troubleshooting

| Symptom                                     | Cause and fix                                                                                                                                                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Formatting does nothing                     | The file's language or extension is not in the supported list, or the document is already formatted.                                                                                                      |
| Formatting silently stops on a syntax error | Prettier cannot parse invalid syntax. Fix the parse error and format again; the failure is logged to the browser console, not shown as a notification.                                                    |
| Config is ignored                           | The extension only reads `.prettierrc`, `.prettierrc.json`, `.prettierrc.json5` or `package.json#prettier` at the workspace root. `.prettierrc.js`, `.prettierrc.yaml` and `overrides` are not supported. |
| Format on save does not run                 | The setting must be `true`, and the file must be saved through the editor (external writes do not trigger it).                                                                                            |

## Limits

- Only the bundled parsers are available; plugins from `node_modules` are not loaded.
- No `.prettierignore`, no nested configs, no `overrides`, no JavaScript/YAML config files.
- Formatting runs in the browser; very large documents can briefly block the UI.
