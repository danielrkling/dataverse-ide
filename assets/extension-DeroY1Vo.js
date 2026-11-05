import{c as k,y as S,M as E,z as C,S as b,I as v,A as T,B as g,U as D,C as W}from"./index-CzwCWkGt.js";import{r as R}from"./guide-DKuydIXd.js";const O=`# Welcome page & extension management

The welcome page is the editor-area landing page. It summarizes the IDE's features, links to
the feature-specific how-to guides, and provides quick action buttons so you do not have to
hunt through the command palette.

It is a normal editor tab (not a webview), so it participates in splits, tabs and the usual
editor lifecycle.

## Opening the page

- Run \`Welcome: Show Welcome Page\` from the command palette.
- Use **Help → Welcome** in the menu bar.
- Let it open on startup (enabled by default).

The startup page is opened about 250 ms after the workbench boots, and only when no editor is
already active. If the previous session restored an editor, the welcome page stays closed so
it does not replace your work.

## Settings

| Setting                              | Default | Notes                                                                      |
| ------------------------------------ | ------- | -------------------------------------------------------------------------- |
| \`dataverseIde.welcome.showOnStartup\` | \`true\`  | Open the welcome page after the workbench starts when no editor is active. |

The checkbox at the bottom of the page (**Show this page on startup**) writes the same
setting.

## What the cards link to

- **Primary/secondary buttons** run the matching command directly, for example
  \`Open Local Folder…\`, \`Build Workspace…\` or \`Start Watch\`.
- **How-to guide →** opens that extension's \`GUIDE.md\` in the markdown preview. The link calls
  the extension's own \`<Feature>: How-to Guide\` command, so it works exactly like the palette
  entry.
- Cards whose extension has no guide yet simply omit the link.

Guides live next to the extension code as \`src/extensions/<id>/GUIDE.md\`. See the repository
README for the steps to add one.

## Managing extensions

The **Extensions** view lists the in-house extensions. Each one has:

- an enable/disable toggle (changes apply after a reload),
- its contributed commands, settings and configuration schema,
- an output channel named \`Dataverse IDE: <id>\` under **Output**.

Configuration files such as \`dataverse.config.json\`, \`esbuild.config.json\`,
\`html.config.json\`, \`tailwind.config.json\` and \`dataverseIde.scripts.scripts\` are validated
with JSON Schema, so the editor completes keys and shows descriptions.

To diagnose an extension, open its output channel first; most actions log there even when
they fail silently in the UI.

## Recipes

### Turn off the startup page

Uncheck **Show this page on startup** on the page, or set
\`dataverseIde.welcome.showOnStartup\` to \`false\`. The command and Help menu entry remain
available.

### Find a feature's guide

Open the welcome page and use the **How-to guide →** link on the feature card, or run the
extension's command from the palette, for example \`esbuild: How-to Guide\`.

### Disable a feature you do not use

Open **Extensions**, disable the extension, and reload when prompted. The extension's commands
disappear; its files and settings stay untouched.

## Troubleshooting

| Symptom                                    | Cause and fix                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| The page did not open on startup           | \`showOnStartup\` may be off, or the workbench restored an editor. Run \`Welcome: Show Welcome Page\`.  |
| \`How-to guide\` reports "command not found" | The extension is disabled or failed to activate. Enable it and reload, or check its output channel. |
| The page content is out of date            | The page is built from \`welcome/extension.ts\`; it ships with the app, so update and redeploy.       |
| Toggle does not persist                    | The checkbox writes a global setting; check that settings storage is available in the browser.      |

## Limits

- Static content: the page does not scan the workspace or reflect extension state beyond the
  links it renders.
- No in-page search or table of contents; use the editor's find or the command palette.
- Guide links depend on the owning extension being active.
`,p="dataverseIde.welcome.open",f="dataverseIde.welcome",x="showOnStartup",N="workbench.editors.dataverseIdeWelcome",G=D.parse("dataverse-ide-welcome:/Welcome"),L=[{id:"workspace",title:"Workspace & editing",features:[{title:"Real local folders",description:"Mount a directory from your machine through the File System Access API. Files are read and written directly, and dirty buffers are saved automatically after one second.",icon:"folder-opened",actions:[{label:"Open Local Folder…",command:"dataverseIde.workspace.openLocalFolder",primary:!0},{label:"Recent Workspaces…",command:"dataverseIde.workspace.chooseRecent"}]},{title:"Browser workspaces",description:"No local folder access? Create a persistent workspace in the Origin Private File System (OPFS). Top-level node_modules can be layered in browser storage too.",icon:"cloud",actions:[{label:"New Browser Workspace…",command:"dataverseIde.workspace.newBrowserWorkspace"}]},{title:"Language smarts in the browser",description:"Project-wide TypeScript and JavaScript IntelliSense via tsserver, plus HTML, CSS, JSON, Markdown, Emmet and XML language features.",icon:"code"},{title:"Configure & extend",description:"Every feature is an IDE extension with its own enable/disable toggle and output channel. Config files such as dataverse.config.json and esbuild.config.json get JSON Schema validation in the editor.",icon:"extensions",guide:"dataverseIde.welcome.openGuide",actions:[{label:"Open Extensions",command:"workbench.view.extensions",primary:!0},{label:"Open Settings",command:"workbench.action.openSettings"}]},{title:"Install VSIX extensions",description:"Bring browser-ready extensions into the IDE from local .vsix files. Packages persist in browser storage and are restored alongside the built-in extension toggles.",icon:"cloud-download",guide:"dataverseIde.vsix.openGuide",actions:[{label:"Install from VSIX…",command:"dataverseIde.vsix.install",primary:!0}]}]},{id:"dataverse",title:"Dataverse deployment",features:[{title:"Web resource uploads",description:"Push files straight to a Dataverse organisation as web resources, preview the plan, and publish when the upload completes. Watch mode keeps the org in sync while you edit.",icon:"cloud-upload",guide:"dataverseIde.dataverse.openGuide",actions:[{label:"Upload Configured Files",command:"dataverseIde.dataverse.uploadConfiguredFiles",primary:!0},{label:"Open dataverse.config.json",command:"dataverseIde.dataverse.openConfig"}]},{title:"Watch & publish",description:"Start a debounced watch on the configured files. Uploads and publishing are driven entirely by dataverse.config.json, which has inline JSON Schema validation.",icon:"sync",guide:"dataverseIde.dataverse.openGuide",actions:[{label:"Start Watch",command:"dataverseIde.dataverse.startWatch"},{label:"Stop Watch",command:"dataverseIde.dataverse.stopWatch"}]},{title:"Dataverse identity",description:"Resolve the signed-in Dataverse user and use their name and email for file metadata and commit authorship.",icon:"person",guide:"dataverseIde.dataverse.openGuide",actions:[{label:"Load User Identity",command:"dataverseIde.dataverse.loadUserIdentity"}]}]},{id:"build",title:"Build & bundle",features:[{title:"esbuild, Solid & JSX",description:"Bundle TypeScript, TSX and JSX with esbuild-wasm. Resolve npm imports from the workspace, compile Solid v1/v2 with Babel, and optionally run the Tagged JSX transform before bundling.",icon:"zap",guide:"dataverseIde.esbuild.openGuide",actions:[{label:"Build Workspace…",command:"dataverseIde.esbuild.buildWorkspace",primary:!0},{label:"Open esbuild.config.json",command:"dataverseIde.esbuild.openConfig"}]},{title:"Self-contained HTML",description:"Inline local scripts, stylesheets, SVG, images and media into a single deployable HTML file. Watch mode rebuilds when any inlined dependency changes.",icon:"file-code",guide:"dataverseIde.html.openGuide",actions:[{label:"Bundle Workspace…",command:"dataverseIde.html.bundleWorkspace",primary:!0},{label:"Open html.config.json",command:"dataverseIde.html.openConfig"}]},{title:"Tailwind v4",description:"Class completions and hovers generated from the installed design system, with no WASM runtime. Compile the classes actually used in the workspace to CSS on demand.",icon:"paintcan",guide:"dataverseIde.tailwind.openGuide",actions:[{label:"Compile CSS",command:"dataverseIde.tailwind.compileCss",primary:!0},{label:"Open tailwind.config.json",command:"dataverseIde.tailwind.openConfig"}]}]},{id:"run-ship",title:"Run & ship",features:[{title:"Node runtime",description:"Run a workspace module graph directly through the File System Access API. Permission levels control filesystem writes and same-origin network access per run.",icon:"play",guide:"dataverseIde.node-runtime.openGuide",actions:[{label:"Run File…",command:"dataverseIde.nodeRuntime.runFile",primary:!0},{label:"Run Active File",command:"dataverseIde.nodeRuntime.runEntry"}]},{title:"npm in the browser",description:"Real installs into the workspace node_modules through a local resolver and registry client. Add dependencies, install from package.json, or prune extraneous packages.",icon:"package",guide:"dataverseIde.npm.openGuide",actions:[{label:"Install All",command:"dataverseIde.npm.installAll",primary:!0},{label:"Add Dependency…",command:"dataverseIde.npm.addDependency"}]},{title:"Git",description:"isomorphic-git brings clone, fetch, pull and push to the browser. Stage, commit, branch and review history, with PATs cached safely in secret storage.",icon:"git-branch",guide:"dataverseIde.git.openGuide",actions:[{label:"Initialize Repository",command:"dataverseGit.initialize",primary:!0},{label:"Sync",command:"dataverseGit.sync"}]},{title:"GitLab",description:"Connect with a personal access token to clone projects, browse merge requests, issues and pipelines, or open a new merge request without leaving the IDE.",icon:"git-pull-request",guide:"dataverseIde.gitlab.openGuide",actions:[{label:"Connect…",command:"dataverseIde.gitlab.connect",primary:!0},{label:"Clone Repository",command:"dataverseIde.gitlab.cloneRepository"},{label:"Merge Requests",command:"dataverseIde.gitlab.showMergeRequests"}]}]},{id:"utilities",title:"Utilities & automation",features:[{title:"Prettier",description:"Format the active document with the browser build of Prettier and the bundled Babel, TypeScript, HTML, PostCSS, YAML, Markdown and GraphQL parsers — including Tagged JSX templates.",icon:"wand",guide:"dataverseIde.prettier.openGuide",actions:[{label:"Format Document",command:"dataverseIde.prettier.formatDocument",primary:!0}]},{title:"Flatten files",description:"Right-click one or more files or folders in the explorer to combine their text into a numbered markdown bundle, or run the configured variant to collect paths from `dataverseIde.flatten.include` — handy as LLM context or for a quick review.",icon:"files",guide:"dataverseIde.flatten.openGuide",actions:[{label:"Flatten Selection",command:"dataverseIde.flatten.selected"},{label:"Flatten Configured",command:"dataverseIde.flatten.configured"}]},{title:"Scripts",description:"Run command chains from a dataverseIde.scripts.scripts setting: steps run in series, arrays run in parallel, and failures can abort or continue per script.",icon:"run-all",guide:"dataverseIde.scripts.openGuide",actions:[{label:"Run Script…",command:"dataverseIde.scripts.run",primary:!0}]}]}];let m;function d(){if(m==null)throw new Error("[welcome] The welcome editor was opened before activation.");return m}function y(){return d().workspace.getConfiguration(f).get(x,!0)}async function F(t){await d().workspace.getConfiguration(f).update(x,t,d().ConfigurationTarget.Global)}class s extends T{static ID=N;static RESOURCE=G;constructor(){super(s.RESOURCE),this.setName("Welcome"),this.setTitle("Welcome to Dataverse IDE"),this.setDescription("Features & extensions"),this.addCapability(g.Readonly|g.Singleton)}get typeId(){return s.ID}}class M extends W{constructor(e){super(s.ID,e)}initialize(){U();const e=document.createElement("div");e.className="diw-root",e.tabIndex=0,e.setAttribute("role","document"),e.setAttribute("aria-label","Dataverse IDE welcome page");const n=document.createElement("div");n.className="diw-page",e.append(n),n.append(A());for(const o of L)n.append(P(o));return n.append(H()),e}async renderInput(){return{dispose(){}}}}function A(){const t=document.createElement("header");t.className="diw-hero";const e=document.createElement("div");e.className="diw-eyebrow",e.textContent="DATAVERSE IDE";const n=document.createElement("h1");n.textContent="Welcome to your browser IDE";const o=document.createElement("p");o.className="diw-lead",o.textContent="A full VS Code workbench that opens real local folders, deploys Dataverse web resources, builds bundles and runs Node — all without a desktop install.";const a=document.createElement("div");return a.className="diw-hero-actions",a.append(l({label:"Show All Commands",command:"workbench.action.showCommands",primary:!0}),l({label:"Open Extensions",command:"workbench.view.extensions"}),l({label:"Open Settings",command:"workbench.action.openSettings"})),t.append(e,n,o,a),t}function P(t){const e=document.createElement("section");e.className="diw-section",e.id=`diw-section-${t.id}`;const n=document.createElement("h2");n.textContent=t.title,e.append(n);const o=document.createElement("div");o.className="diw-grid",e.append(o);for(const a of t.features)o.append(z(a));return e}function z(t){const e=document.createElement("article");e.className="diw-card";const n=document.createElement("div");n.className="diw-card-head";const o=document.createElement("span");o.className=`codicon codicon-${t.icon} diw-card-icon`,o.setAttribute("aria-hidden","true");const a=document.createElement("h3");a.textContent=t.title,n.append(o,a),e.append(n);const i=document.createElement("p");if(i.textContent=t.description,e.append(i),t.actions!=null&&t.actions.length>0){const r=document.createElement("div");r.className="diw-card-actions";for(const c of t.actions)r.append(l(c));e.append(r)}return t.guide!=null&&e.append(B(t.guide)),e}function I(t,e){d().commands.executeCommand(t,...e??[]).then(void 0,n=>{d().window.showErrorMessage(`Could not run "${t}": ${n instanceof Error?n.message:String(n)}`)})}function l(t){const e=document.createElement("button");return e.type="button",e.className=t.primary===!0?"diw-button primary":"diw-button",e.textContent=t.label,e.addEventListener("click",()=>{I(t.command,t.args)}),e}function B(t){const e=document.createElement("button");return e.type="button",e.className="diw-guide-link",e.textContent="How-to guide →",e.addEventListener("click",()=>{I(t)}),e}function H(){const t=document.createElement("footer");t.className="diw-footer";const e=document.createElement("label");e.className="diw-toggle";const n=document.createElement("input");n.type="checkbox",n.checked=y(),n.addEventListener("change",()=>{F(n.checked).catch(i=>{d().window.showErrorMessage(`Could not save the welcome setting: ${i instanceof Error?i.message:String(i)}`)})});const o=document.createElement("span");o.textContent="Show this page on startup",e.append(n,o);const a=document.createElement("span");return a.className="diw-hint",a.append(document.createTextNode("Run "),u("Ctrl"),document.createTextNode(" + "),u("Shift"),document.createTextNode(" + "),u("P"),document.createTextNode(' and choose "Welcome: Show Welcome Page" any time.')),t.append(e,a),t}function u(t){const e=document.createElement("kbd");return e.textContent=t,e}const h="dataverse-ide-welcome-styles";function U(){if(document.getElementById(h)!=null)return;const t=document.createElement("style");t.id=h,t.textContent=`
.diw-root {
  box-sizing: border-box;
  min-height: 100%;
  background: var(--vscode-editor-background);
  color: var(--vscode-editor-foreground);
}

.diw-page {
  box-sizing: border-box;
  width: min(1120px, 100%);
  margin: 0 auto;
  padding: 48px 40px 64px;
}

.diw-hero {
  margin-bottom: 48px;
}

.diw-eyebrow {
  color: var(--vscode-textLink-foreground);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.6px;
  margin-bottom: 10px;
}

.diw-hero h1 {
  margin: 0 0 14px;
  font-size: 34px;
  font-weight: 300;
  line-height: 1.2;
  letter-spacing: -0.4px;
}

.diw-lead {
  max-width: 760px;
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: 15px;
  line-height: 1.6;
}

.diw-hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 24px;
}

.diw-button {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: 1px solid transparent;
  border-radius: 3px;
  padding: 6px 13px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.diw-button:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}

.diw-button:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: 1px;
}

.diw-button.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}

.diw-button.primary:hover {
  background: var(--vscode-button-hoverBackground);
}

.diw-section {
  margin-bottom: 40px;
}

.diw-section h2 {
  margin: 0 0 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
  font-size: 17px;
  font-weight: 500;
}

.diw-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 14px;
}

.diw-card {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 16px 18px 18px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
  border-radius: 6px;
  background: var(--vscode-editorWidget-background, transparent);
}

.diw-card-head {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 8px;
}

.diw-card-icon {
  color: var(--vscode-textLink-foreground);
  font-size: 18px;
  line-height: 1;
}

.diw-card h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.diw-card p {
  flex: 1;
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: 12.5px;
  line-height: 1.55;
}

.diw-card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}

.diw-guide-link {
  align-self: flex-start;
  margin-top: 12px;
  padding: 0;
  border: none;
  background: none;
  color: var(--vscode-textLink-foreground);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}

.diw-guide-link:hover {
  color: var(--vscode-textLink-activeForeground);
  text-decoration: underline;
}

.diw-guide-link:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: 1px;
}

.diw-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  padding-top: 20px;
  border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}

.diw-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.diw-toggle input {
  accent-color: var(--vscode-checkbox-background);
}

.diw-hint {
  line-height: 1.6;
}

.diw-hint kbd {
  padding: 1px 5px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
  border-radius: 3px;
  background: var(--vscode-keybindingLabel-background, rgba(128, 128, 128, 0.12));
  color: var(--vscode-keybindingLabel-foreground, inherit);
  font-family: inherit;
  font-size: 11px;
}
`,document.head.append(t)}async function w(){const t=b.get(v),e=t.findEditors(s.RESOURCE)[0]?.editor;await t.openEditor(e??new s,{pinned:!0,revealIfOpened:!0})}const _={id:"welcome",async activate(t){m=t.vscode;let e;await k({id:"welcome",displayName:"Dataverse IDE Welcome",description:"Landing page describing the IDE's features and extensions.",commands:[{command:p,title:"Welcome: Show Welcome Page"},{command:"dataverseIde.welcome.openGuide",title:"Welcome: How-to Guide"}],configuration:{title:"Dataverse IDE Welcome",properties:{"dataverseIde.welcome.showOnStartup":{type:"boolean",default:!0,description:"Show the Dataverse IDE welcome page when the workbench starts."}}}});const n=R({vscode:t.vscode,extensionId:"welcome",content:O}),o=S(s.ID,"Dataverse IDE Welcome",M,[s]),a=t.vscode.commands.registerCommand(p,()=>w()),i=E.appendMenuItem(C.MenubarHelpMenu,{command:{id:p,title:"Welcome"},group:"1_welcome",order:0});return y()&&(e=window.setTimeout(()=>{try{b.get(v).activeEditor==null&&w().catch(c=>{t.outputChannel.appendLine(`[welcome] Could not open the welcome page: ${c instanceof Error?c.message:String(c)}`)})}catch(r){t.outputChannel.appendLine(`[welcome] Could not read the editor service: ${r instanceof Error?r.message:String(r)}`)}},250)),t.outputChannel.appendLine("[welcome] extension activated."),{dispose(){e!=null&&window.clearTimeout(e),o.dispose(),a.dispose(),i.dispose(),n.dispose()}}}};export{_ as default};
