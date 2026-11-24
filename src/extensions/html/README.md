# HTML bundler

Turn an HTML page plus its local scripts, stylesheets, SVG, images and media into one
self-contained `.html` file. The bundler reads the entry from the workspace, inlines local
references, and writes the result under `outdir`.

Use it for Dataverse HTML web resources or any single-file deployment where relative asset
paths are inconvenient.

## Before you start

- Open a workspace containing the HTML entry (local folder or browser workspace).
- Decide whether scripts are already bundled. The HTML bundler inlines script files; it does
  **not** bundle their ES module graph. Pre-bundle module entry points with the esbuild
  extension first if the page uses `import`.
- Know which assets should stay external — large files or assets deployed separately can be
  listed in `external`.

## Quick start

1. Run `HTML: Open html.config.json`. On first use the file is scaffolded and opened.
2. Point it at the entry:

   ```json
   {
     "entryPoints": ["index.html"],
     "outdir": "dist"
   }
   ```

3. Run `HTML: Bundle Current File` with the HTML file open, or
   `HTML: Bundle Configured Entries`.
4. The result is written to `dist/index.html`; details appear in
   **Output → Dataverse IDE: html**.

Entries can be strings or objects with an explicit output:

```json
{
  "entryPoints": ["index.html", { "input": "pages/about.html", "output": "dist/about.html" }],
  "outdir": "dist"
}
```

## Commands

| Command                                             | What it does                                          |
| --------------------------------------------------- | ----------------------------------------------------- |
| `HTML: Bundle Current File`                         | Bundles the HTML file in the active editor.           |
| `HTML: Bundle Workspace…`                           | Quick-picks an HTML file from the workspace.          |
| `HTML: Bundle Configured Entries`                   | Bundles every entry in `html.config.json`.            |
| `HTML: Start Watch` / `Stop Watch` / `Toggle Watch` | Rebuilds an entry when any file it inlined changes.   |
| `HTML: Open html.config.json`                       | Creates the config on first use, then opens it.       |
| `HTML: Reload Config`                               | Re-reads the config without restarting the extension. |
| `HTML: Show Output`                                 | Opens the bundler log.                                |

## Configuration

`html.config.json` lives at the workspace root. Point elsewhere with
`dataverseIde.html.configPath` (workspace-relative). The file has JSON Schema validation in
the editor.

| Key              | Default          | Notes                                                             |
| ---------------- | ---------------- | ----------------------------------------------------------------- |
| `entryPoints`    | `["index.html"]` | Strings or `{ input, output }` objects.                           |
| `outdir`         | `"dist"`         | Used when an entry has no explicit `output`.                      |
| `inlineScripts`  | `true`           | Inline local `<script src>`.                                      |
| `inlineStyles`   | `true`           | Inline local stylesheets, including nested `@import` and `url()`. |
| `inlineSvg`      | `true`           | Inline local SVG references.                                      |
| `inlineImages`   | `true`           | Inline local image references.                                    |
| `inlineFonts`    | `false`          | Inline local font files.                                          |
| `inlineCssUrls`  | `true`           | Inline local `url()` targets inside CSS.                          |
| `maxInlineBytes` | `0`              | Leave assets larger than this as references. `0` means no limit.  |
| `minify`         | `false`          | Collapse whitespace outside `pre`/`textarea`/`script`/`style`.    |
| `removeComments` | `false`          | Remove HTML comments.                                             |
| `external`       | `[]`             | Glob patterns to leave un-inlined.                                |

Runtime tuning lives in settings:

- `dataverseIde.html.autoStartWatch` (default `false`) — start watch when the workspace opens.
- `dataverseIde.html.configPath` — where the config file is read from.

### What gets inlined

Local references are rewritten to inline content or `data:` URIs. `http:`, `https:`, `//`,
`data:`, `blob:`, `mailto:`, `javascript:` and fragment-only references are left untouched.

`external` patterns use [picomatch](https://github.com/micromatch/picomatch) syntax, so
`*`, `**`, `?`, `{a,b}`, character classes and extglobs all work; a pattern without a slash
matches the file name. External files are **not copied** to the output, so they must be
deployed or served separately. Inside an inlined stylesheet, external `@import`/`url()`
references stay verbatim, so prefer absolute or root-relative URLs there.

## How watch behaves

- Each bundle records the workspace files it inlined.
- Changing or saving any of those files rebuilds that entry from the live editor buffer.
- Saving `html.config.json` reloads it and rebuilds every known entry.
- A workspace file watcher also catches dependencies written by other tools.
- Rebuilds are debounced by 300 ms, and a build already running queues the next one.

## Recipes

### One-page Dataverse web resource

```json
{
  "entryPoints": ["src/index.html"],
  "outdir": "dist",
  "inlineScripts": true,
  "inlineStyles": true,
  "inlineSvg": true,
  "inlineImages": true,
  "inlineFonts": true,
  "maxInlineBytes": 0,
  "minify": true,
  "removeComments": true
}
```

Build with `HTML: Bundle Configured Entries`, then upload `dist/` with the Dataverse
extension.

### Keep a vendor script external

```json
{
  "entryPoints": ["index.html"],
  "outdir": "dist",
  "external": ["vendor/**", "*.min.js"]
}
```

The `<script src>` stays as written. Remember to deploy the vendor files next to the page.

### Bundle before inlining modules

If the page uses `<script type="module" src="src/app.ts">`, run
`esbuild: Build Current File` first and point the HTML at the bundle. The HTML bundler keeps
module import specifiers relative to the HTML document, not the original script folder.

## Troubleshooting

| Symptom                                   | Cause and fix                                                                                                               |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| An asset stayed as a URL                  | It matched `external`, exceeded `maxInlineBytes`, or is a remote/`data:` reference. The output channel logs the reason.     |
| Module imports resolve to the wrong place | Module scripts are inlined verbatim; their imports now resolve relative to the HTML document. Pre-bundle them with esbuild. |
| Markup looks reformatted                  | The bundler parses with parse5 and reserializes, which can normalize quoting, case, implied tags and whitespace.            |
| Watch does not rebuild                    | The changed file may not be in the recorded dependency set, or watch is stopped. Check the status bar and output channel.   |
| `no entry` / config errors                | `entryPoints` must contain at least one valid entry; validation problems are logged to the output channel.                  |

## Limits

- Inlines one HTML document at a time; it is not a site generator.
- Does not fetch or inline remote resources.
- Does not bundle JavaScript module graphs or transform TypeScript.
- Asset inlining loads whole files into memory; very large images or fonts can be slow.
