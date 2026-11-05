import{c as f,M as x,z as v,L as g,N as I,O as b,P as k,Q as m,R as y,W as w,X as S}from"./index-CzwCWkGt.js";import{r as E}from"./guide-DKuydIXd.js";const V=`# VSIX extensions

Install browser-compatible VS Code extensions from local \`.vsix\` files. Packages are stored in
IndexedDB and re-registered on every page load, so they behave like the built-in extensions
after a reload.

Use it to bring in a web extension that is not part of the IDE's built-in set.

## Before you start

- Have a \`.vsix\` file on disk. The extension cannot browse or download from the marketplace.
- The package must be a **web extension**: it needs a \`browser\` entry point in
  \`extension/package.json\`, or no code entry point at all.
- Packages that only declare a Node.js \`main\` entry point are rejected. Extensions that rely
  on native modules, child processes or the real filesystem will not work.
- Install any npm dependencies the extension needs separately with the npm extension; VSIX
  install does not resolve package dependencies.

## Quick start

1. Run \`VSIX: Install Extension from File…\`, or use **Install from VSIX…** in the Extensions
   view title.
2. Pick the \`.vsix\` file in the browser picker.
3. Wait for the install confirmation. The extension is registered immediately.
4. Reload the workbench so the Extensions view picks it up (\`Reload\` in the notification, or
   reload the page).

Installed extensions are listed in the normal **Extensions** view and can be disabled there.

## Commands

| Command                              | What it does                                                        |
| ------------------------------------ | ------------------------------------------------------------------- |
| \`VSIX: Install Extension from File…\` | Parse a local \`.vsix\`, store it and register it.                    |
| \`VSIX: Uninstall Extension…\`         | Pick an installed VSIX and remove it from storage and the registry. |
| \`VSIX: Show Installed Extensions\`    | List installed packages with their version and file name.           |

The Extensions view title also exposes **Install from VSIX…**, because the built-in desktop
action is unavailable in the browser.

## What happens on install

1. The archive is unzipped in memory and \`extension/package.json\` is read.
2. The manifest is checked for web compatibility (\`browser\` entry point).
3. The package id is checked against the built-in Dataverse IDE extensions.
4. The original archive is saved to IndexedDB (database \`dataverse-ide-vsix\`).
5. Every file is served to the extension host as a \`data:\` URL and the extension is registered.

On startup, stored packages are restored **before** the workbench initializes, so they appear
in the Extensions view alongside the built-ins.

Because files are served as \`data:\` URLs, the extension host does not need \`blob:\` access for
installed packages.

## Updating and removing

- Reinstall a newer \`.vsix\` with the same extension id to upgrade. If registration fails, the
  previously stored version is restored.
- \`VSIX: Uninstall Extension…\` removes both the stored archive and the running registration.
- Uninstalling from the Extensions view is also handled: the stored package is cleaned up so
  it does not return on reload.

## Recipes

### Install a web extension from a local build

1. Build the extension with its web target (\`browser\` entry point).
2. Package it as a \`.vsix\`.
3. Run \`VSIX: Install Extension from File…\` and pick the file.
4. Reload, then check the Extensions view and the extension's commands.

### Roll back a bad update

Uninstall the package with \`VSIX: Uninstall Extension…\`, then install the previous \`.vsix\`
again. If the new version failed to register, the old archive was already restored
automatically.

### Check what is installed

Run \`VSIX: Show Installed Extensions\`. It lists the package id, display name, version and
original file name, which is useful when several builds share a display name.

## Troubleshooting

| Symptom                                           | Cause and fix                                                                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| \`This VSIX is not a web extension\`                | The package has only a Node.js \`main\` entry. Use a browser build or a different package.                            |
| \`the "browser" entry point … is missing\`          | The manifest points at a file that is not in the archive. Rebuild the VSIX.                                         |
| \`Not a VSIX package\`                              | The file is not a valid ZIP or has no \`extension/package.json\`.                                                     |
| Install succeeds but the Extensions view is empty | Reload the workbench; the view scans extensions during startup.                                                     |
| The extension installs but does nothing           | It may have failed to activate or rely on unsupported Node APIs. Check the extension host console/browser DevTools. |
| Cannot install over a built-in                    | Built-in Dataverse IDE extension ids are protected. Choose a different package.                                     |

## Limits

- Local \`.vsix\` files only; no marketplace browsing or online updates.
- Web extensions only; no Node.js-only, native or desktop extensions.
- Dependencies are not installed automatically.
- Stored packages live in browser storage for the current origin; clearing site data removes
  them.
`,r="dataverseIde.vsix.install",c="dataverseIde.vsix.uninstall",h="dataverseIde.vsix.list";function X(){return new Promise(t=>{const e=document.createElement("input");e.type="file",e.accept=".vsix,application/octet-stream",e.style.display="none";let i=!1;const n=a=>{i||(i=!0,e.remove(),window.removeEventListener("focus",s),t(a))},s=()=>{window.setTimeout(()=>{(e.files==null||e.files.length===0)&&n(void 0)},350)};e.addEventListener("change",()=>{const a=e.files?.[0];if(a==null){n(void 0);return}a.arrayBuffer().then(o=>n({fileName:a.name,data:new Uint8Array(o)})).catch(()=>n(void 0))}),e.addEventListener("cancel",()=>n(void 0)),window.addEventListener("focus",s,{once:!0}),document.body.append(e),e.click()})}async function p(t,e){await t.window.showInformationMessage(e,"Reload")==="Reload"&&await S(t)&&location.reload()}async function N(t,e){const i=await X();if(i!=null)try{const n=await t.window.withProgress({location:t.ProgressLocation.Notification,title:`Installing ${i.fileName}…`},async s=>{s.report({message:"Validating extension…"});const a=await y(i.data,i.fileName);return s.report({message:"Registered extension."}),a});e.appendLine(`Installed ${n.id}@${n.version} from ${n.fileName}.`),await p(t,`Installed ${n.displayName} ${n.version}. Reload to make it available in the Extensions view.`)}catch(n){const s=n instanceof Error?n.message:String(n);e.appendLine(`Failed to install ${i.fileName}: ${s}`),n instanceof Error&&n.stack!=null&&e.appendLine(n.stack),await t.window.showErrorMessage(`Could not install VSIX: ${s}`)}}function u(t,e){return{label:e.displayName,description:`${e.version} · ${e.id}`,detail:e.fileName}}async function C(t,e){const i=await w();if(i.length===0){await t.window.showInformationMessage("No VSIX extensions are installed.");return}const n=i.map(l=>u(t,l)),s=await t.window.showQuickPick(n,{placeHolder:"Select a VSIX extension to uninstall",title:"Uninstall VSIX Extension"});if(s==null)return;const a=i[n.indexOf(s)];if(a==null||await t.window.showWarningMessage(`Uninstall ${a.displayName} ${a.version}?`,{modal:!0},"Uninstall")!=="Uninstall")return;if(!await m(a.id)){await t.window.showWarningMessage(`"${a.id}" is no longer installed.`);return}e.appendLine(`Uninstalled ${a.id}@${a.version}.`),await p(t,`Uninstalled ${a.displayName}. Reload to finish removing it.`)}async function R(t){const e=await w();if(e.length===0){await t.window.showInformationMessage("No VSIX extensions are installed.");return}const i=await t.window.showQuickPick(e.map(n=>u(t,n)),{placeHolder:"Installed VSIX extensions",title:"VSIX Extensions"});i!=null&&await t.window.showInformationMessage(i.description??i.label)}const T={id:"vsix",async activate(t){const{vscode:e,outputChannel:i}=t;await f({id:"vsix",displayName:"Dataverse IDE VSIX Installer",description:"Install and manage browser extensions from .vsix files.",commands:[{command:r,title:"VSIX: Install Extension from File…"},{command:c,title:"VSIX: Uninstall Extension…"},{command:h,title:"VSIX: Show Installed Extensions"},{command:"dataverseIde.vsix.openGuide",title:"VSIX: How-to Guide"}]});const n=E({vscode:e,extensionId:"vsix",content:V}),s=x.appendMenuItem(v.ViewContainerTitle,{command:{id:r,title:"Install from VSIX…"},when:g.equals("viewContainer","workbench.view.extensions"),group:"3_install",order:1}),a=await I(b).then(o=>o.onDidUninstallExtension(d=>{const l=d.identifier.id.toLowerCase();k().includes(l)&&m(l)})).catch(o=>(console.warn("[Dataverse IDE] VSIX uninstall cleanup is unavailable.",o),e.Disposable.from()));return e.Disposable.from(e.commands.registerCommand(r,()=>N(e,i)),e.commands.registerCommand(c,()=>C(e,i)),e.commands.registerCommand(h,()=>R(e)),s,a,n)}};export{T as default};
