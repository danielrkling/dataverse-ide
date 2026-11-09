# Welcome page & extension management

The welcome page is the editor-area landing page. It summarizes the IDE's features, links to
the feature-specific how-to guides, and provides quick action buttons so you do not have to
hunt through the command palette.

It is a normal editor tab (not a webview), so it participates in splits, tabs and the usual
editor lifecycle.

## Opening the page

- Run `Welcome: Show Welcome Page` from the command palette.
- Use **Help → Welcome** in the menu bar.
- Let it open on startup (enabled by default).

The startup page is opened about 250 ms after the workbench boots, and only when no editor is
already active. If the previous session restored an editor, the welcome page stays closed so
it does not replace your work.

## Settings

| Setting                              | Default | Notes                                                                      |
| ------------------------------------ | ------- | -------------------------------------------------------------------------- |
| `dataverseIde.welcome.showOnStartup` | `true`  | Open the welcome page after the workbench starts when no editor is active. |

The checkbox at the bottom of the page (**Show this page on startup**) writes the same
setting.

## What the cards link to

- **Primary/secondary buttons** run the matching command directly, for example
  `Open Local Folder…`, `Build Workspace…` or `Start Watch`.
- **How-to guide →** opens that extension's `GUIDE.md` in the markdown preview. The link calls
  the extension's own `<Feature>: How-to Guide` command, so it works exactly like the palette
  entry.
- Cards whose extension has no guide yet simply omit the link.

Guides live next to the extension code as `src/extensions/<id>/GUIDE.md`. See the repository
README for the steps to add one.

## Managing extensions

The **Extensions** view lists the in-house extensions. Each one has:

- an enable/disable toggle (changes apply after a reload),
- its contributed commands, settings and configuration schema,
- an output channel named `Dataverse IDE: <id>` under **Output**.

Configuration files such as `dataverse.config.json`, `esbuild.config.json`,
`html.config.json` and `tailwind.config.json` are validated with JSON Schema, so the editor
completes keys and shows descriptions.

To diagnose an extension, open its output channel first; most actions log there even when
they fail silently in the UI.

## Recipes

### Turn off the startup page

Uncheck **Show this page on startup** on the page, or set
`dataverseIde.welcome.showOnStartup` to `false`. The command and Help menu entry remain
available.

### Find a feature's guide

Open the welcome page and use the **How-to guide →** link on the feature card, or run the
extension's command from the palette, for example `esbuild: How-to Guide`.

### Disable a feature you do not use

Open **Extensions**, disable the extension, and reload when prompted. The extension's commands
disappear; its files and settings stay untouched.

## Troubleshooting

| Symptom                                    | Cause and fix                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| The page did not open on startup           | `showOnStartup` may be off, or the workbench restored an editor. Run `Welcome: Show Welcome Page`.  |
| `How-to guide` reports "command not found" | The extension is disabled or failed to activate. Enable it and reload, or check its output channel. |
| The page content is out of date            | The page is built from `welcome/extension.ts`; it ships with the app, so update and redeploy.       |
| Toggle does not persist                    | The checkbox writes a global setting; check that settings storage is available in the browser.      |

## Limits

- Static content: the page does not scan the workspace or reflect extension state beyond the
  links it renders.
- No in-page search or table of contents; use the editor's find or the command palette.
- Guide links depend on the owning extension being active.
