# Tailwind v4

Tailwind CSS support without a WASM runtime: class completions and hovers come from the
bundled Tailwind v4 design system, and the workspace's used classes are compiled to CSS on
demand.

Use it to write Tailwind classes with IntelliSense and produce a deployable stylesheet for a
Dataverse web resource.

## Before you start

- Open a workspace containing the markup or source files that use Tailwind classes.
- Have an input CSS file if you use `@theme`, `@plugin`, `@config` or custom variants. If
  `input` is empty, the extension compiles `@import "tailwindcss";` for you.
- Install any `@plugin`/`@config` packages with the npm extension; plugin modules are bundled
  from the workspace `node_modules`.

## Quick start

1. Run `Tailwind: Open tailwind.config.json`. On first use the file is scaffolded and opened.
2. Set the input and output:

   ```json
   {
     "input": "src/tailwind.css",
     "output": "dist/tailwind.css",
     "minify": true
   }
   ```

3. Run `Tailwind: Compile CSS From Workspace`.
4. The CSS is written to the configured output; details are in
   **Output → Dataverse IDE: tailwind**.

Completions and hovers appear automatically while typing inside `class`/`className`
attributes.

## Commands

| Command                                                 | What it does                                                    |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| `Tailwind: Compile CSS From Workspace`                  | Scans the workspace for used classes and writes the CSS output. |
| `Tailwind: Start Watch` / `Stop Watch` / `Toggle Watch` | Recompiles when classes or dependencies change.                 |
| `Tailwind: Open tailwind.config.json`                   | Creates the config on first use, then opens it.                 |
| `Tailwind: Show Output`                                 | Opens the compiler log.                                         |

## Configuration

`tailwind.config.json` lives at the workspace root. Point elsewhere with
`dataverseIde.tailwind.configPath` (workspace-relative).

| Key      | Default               | Notes                                                                  |
| -------- | --------------------- | ---------------------------------------------------------------------- |
| `input`  | `""`                  | Workspace-relative CSS entry. Empty compiles `@import "tailwindcss";`. |
| `output` | `"dist/tailwind.css"` | Workspace-relative output path.                                        |
| `minify` | `false`               | Minify the compiled CSS through the esbuild CSS minifier.              |

Settings:

| Setting                                | Default                | Notes                                 |
| -------------------------------------- | ---------------------- | ------------------------------------- |
| `dataverseIde.tailwind.autoStartWatch` | `false`                | Start watch when the workspace opens. |
| `dataverseIde.tailwind.configPath`     | `tailwind.config.json` | Where the config file is read from.   |

## IntelliSense

- Completions are generated from the Tailwind v4 design system bundled with the IDE
  (roughly 23,000 utilities), not from a hand-maintained list.
- Hovers show the class name and its generated CSS description.
- Completions only fire inside `class=` / `className=` string values, in HTML, PHP, CSS,
  SCSS, Less, JavaScript, TypeScript, JSX/TSX, Vue and Svelte files.
- Variants such as `hover:`, `md:` and `dark:` are suggested too.

Because the design system is the IDE's bundled Tailwind v4, a workspace on a very different
Tailwind version may see a slightly different class list. The compiler still runs Tailwind
v4 semantics.

## How compilation works

1. The workspace is scanned for class names in the configured languages.
2. The input CSS is loaded (or `@import "tailwindcss";` when `input` is empty).
3. `@plugin`/`@config` modules are bundled through the main-thread esbuild compiler, including
   packages in the `node_modules` overlay.
4. Tailwind compiles only the classes actually found and writes the result to `output`.

Watch mode is debounced by 750 ms, rebuilds while you type, and also reacts to files written
outside the editor. Saving `tailwind.config.json` reloads the config.

## Recipes

### Deploy the stylesheet with the Dataverse extension

```json
{
  "input": "src/tailwind.css",
  "output": "dist/tailwind.css",
  "minify": true
}
```

Compile, then upload `dist/tailwind.css` with the Dataverse extension. Add it to the page with
a `<link rel="stylesheet">`.

### Use a Tailwind plugin

1. Install the plugin package with npm.
2. Reference it from the input CSS:

   ```css
   @import "tailwindcss";
   @plugin "@tailwindcss/typography";
   ```

3. Compile. The plugin is bundled from the workspace, so it does not need to be imported in a
   JavaScript config.

### Customize the theme

```css
@import "tailwindcss";

@theme {
  --color-brand: #0f6cbd;
}
```

Then use `bg-brand` and `text-brand` in markup. The class index is the stock design system;
custom theme variables still work in the compiled CSS even if they are not offered as
completions.

## Troubleshooting

| Symptom                         | Cause and fix                                                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| No completions                  | The cursor must be inside a `class`/`className` string. Check the language is in the supported list.                                      |
| Output is empty                 | No matching classes were found in the scanned files. Check the input CSS and that markup uses literal class names (not computed strings). |
| Plugin not found                | Install the plugin package with npm; `@plugin` is resolved from the workspace.                                                            |
| Watch does not react            | Watch may be stopped; check the status bar and output channel. Config saves trigger a reload.                                             |
| Compile error after editing CSS | Check the output channel; invalid `@theme`/`@plugin` syntax fails the compile.                                                            |

## Limits

- Tailwind v4 only.
- Completions use the IDE's bundled design system, not an arbitrary workspace Tailwind
  version.
- Dynamic class names assembled at runtime are not detected by the scanner.
- The scanner covers the configured languages; templates in unsupported languages are
  ignored.
