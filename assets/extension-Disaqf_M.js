import{c as M}from"./index-CzwCWkGt.js";import{r as j}from"./guide-DKuydIXd.js";const D=`# Flatten files\r
\r
Combine selected files or folders into one markdown bundle: each file becomes a heading with\r
its workspace-relative path and a fenced code block tagged with the file's language.\r
\r
Use it to prepare LLM context, review a feature across many files, or capture a snapshot of a\r
folder without zip files.\r
\r
## Before you start\r
\r
- Open a workspace.\r
- Select one or more files or folders in the explorer. The command is also available from the\r
  explorer context menu (right-click → **Combine Selected Files into Markdown**).\r
- Be aware of size: the bundle includes the full text of every selected text file.\r
\r
## Quick start\r
\r
1. Select files or folders in the explorer.\r
2. Right-click and choose \`Flatten: Combine Selected Files into Markdown\`.\r
3. The bundle opens in the editor and is written to the workspace root as\r
   \`#<folders>#<n>.md\`.\r
\r
Examples:\r
\r
- Selecting \`src/extensions\` creates \`#src-extensions#1.md\`.\r
- Selecting a single file \`src/app.ts\` creates \`#src#1.md\`.\r
- If the derived name is too long or empty, the bundle is \`#1.md\`.\r
\r
The number auto-increments from the highest existing bundle, so repeated runs never overwrite\r
an earlier one.\r
\r
## Flatten a configured set of files\r
\r
\`Flatten: Combine Configured Files into Markdown\` reads two workspace settings:\r
\r
| Setting                        | Default   | Purpose                                           |\r
| ------------------------------ | --------- | ------------------------------------------------- |\r
| \`dataverseIde.flatten.name\`    | \`flatten\` | Output file name; \`.md\` is appended when omitted. |\r
| \`dataverseIde.flatten.include\` | \`[]\`      | Workspace-relative files and folders to combine.  |\r
\r
\`\`\`json\r
"dataverseIde.flatten.name": "llm-context",\r
"dataverseIde.flatten.include": ["src/app", "src/styles.css", "package.json"]\r
\`\`\`\r
\r
- Paths are relative to the workspace root. Absolute paths are not used.\r
- Folders are expanded recursively with the same exclusions and 500-file cap as selected\r
  folders.\r
- The output is written to the workspace root as \`<name>.md\` and replaced on each run; use\r
  the selected-files command when you need numbered, non-overwriting bundles.\r
- Run the command from the command palette or the welcome page. If the include list is empty\r
  or contains no readable files, a warning explains what to fix.\r
\r
## What goes into the bundle\r
\r
\`\`\`\`\r
# Flattened workspace files\r
\r
Generated 2026-11-02T10:14:00.000Z — 3 file(s)\r
\r
## src/app.ts\r
\r
\`\`\`ts\r
…\r
\`\`\`\r
\r
## src/styles.css\r
\r
\`\`\`css\r
…\r
\`\`\`\r
\`\`\`\`\r
\r
- Files appear in selection order; folders are expanded recursively.\r
- Each section starts with \`## <workspace-relative path>\`.\r
- The fence is lengthened when a file contains backtick runs, so nested code blocks do not\r
  break the bundle.\r
- Binary or unsupported files appear as a short placeholder note instead of their content.\r
- Unreadable files are skipped and counted in the header.\r
\r
## Folder rules\r
\r
- Folder selections recurse up to **500 files** per folder.\r
- \`.git\`, \`node_modules\`, \`.ide-build\` and \`dist\` are excluded.\r
- Previous flatten bundles (\`#…#n.md\`, plus legacy \`~…#n.md\`) are skipped, so flattening a\r
  folder twice does not fold an earlier bundle into the new one.\r
\r
## Recipes\r
\r
### Build LLM context for one feature\r
\r
Select \`src/extensions/esbuild\` and flatten it. The resulting markdown has every source file\r
with its path and language, ready to paste into a chat.\r
\r
### Review a change set\r
\r
Select several modified files (Ctrl/Cmd-click in the explorer) and flatten them into one\r
document. The relative paths make it easy to trace each block.\r
\r
### Snapshot a folder before refactoring\r
\r
Flatten the folder, keep the generated \`#…md\` file, and refactor. The bundle is a plain\r
markdown file, so it diffs and commits like any other.\r
\r
## Troubleshooting\r
\r
| Symptom                                          | Cause and fix                                                                                                            |\r
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |\r
| \`select one or more files in the explorer first\` | The command was run from the palette with no selection. Select files in the explorer or pass them from the context menu. |\r
| \`no readable text files in the selection\`        | Everything selected was unreadable. Check permissions and that the paths exist.                                          |\r
| \`set "dataverseIde.flatten.include" …\`           | The configured command has no include paths. Add workspace-relative files or folders to the setting.                     |\r
| A file appears as a placeholder                  | Its extension is not in the known text list (for example an image or a binary), or it could not be read.                 |\r
| Folder output is incomplete                      | Folder selections cap at 500 files and exclude \`node_modules\`, \`dist\`, \`.git\` and \`.ide-build\`.                          |\r
| Bundle is huge                                   | Select fewer files or a narrower folder; there is no automatic size cap.                                                 |\r
\r
## Limits\r
\r
- Text formats only; binary content is not embedded.\r
- 500-file cap per folder selection.\r
- Output is always written to the workspace root, not to the selected folder.\r
- No filtering by glob or file size beyond the fixed exclusions.\r
\r
\`\`\`\r
\r
\`\`\`\r
`,w="dataverseIde.flatten.selected",k="dataverseIde.flatten.configured",h="dataverseIde.flatten",b="name",m="include",E="flatten",x=40,S=/^#(?:.*#)?(\d+)\.md$/,v=/^~(?:.*#)?(\d+)\.md$/,F=500,L=new Set([".git","node_modules",".ide-build","dist"]);function T(e){return typeof e=="object"&&e!=null&&"scheme"in e&&typeof e.scheme=="string"&&"path"in e&&typeof e.path=="string"}function I(e){if(Array.isArray(e))return e.flatMap(t=>I(t));if(T(e))return[e];if(typeof e=="object"&&e!=null)for(const t of["resourceUri","resource","uri"]){const n=e[t];if(T(n))return[n]}return[]}function _(e,t,n){if(n.scheme==="file"){const r=t.path.replace(/\/+$/,""),s=n.path.replace(/\/+$/,"");if(r.length===0||s===r||s.startsWith(`${r}/`)){const o=(r.length>0?s.slice(r.length):s).replace(/^\/+/,"").replaceAll("\\","/");if(o.length>0)return o}}return e.workspace.asRelativePath(n,!1).replaceAll("\\","/")}async function N(e,t,n){const r=[],s=[t];for(;s.length>0&&r.length<F;){const o=s.shift();let c;try{c=await e.workspace.fs.readDirectory(o)}catch{n.appendLine(`[flatten] could not read directory ${e.workspace.asRelativePath(o,!1)}`);continue}c.sort(([a],[i])=>a.localeCompare(i));for(const[a,i]of c){const l=e.Uri.joinPath(o,a);if((i&e.FileType.Directory)!==0){L.has(a.toLowerCase())||s.push(l);continue}if(!((i&e.FileType.File)===0||P(l))&&(r.push(l),r.length>=F))break}}return r}const U=new Set(["txt","md","markdown","json","jsonc","json5","webmanifest","js","mjs","cjs","jsx","ts","mts","cts","tsx","css","scss","sass","less","html","htm","xml","svg","xsl","yml","yaml","csv","ini","cfg","toml","env","sh","bat","ps1","resx","config"]);function A(e){const t=e.path.split("/").at(-1)??"",n=t.lastIndexOf(".");return n===-1?"":t.slice(n+1).toLowerCase()}function R(e){const t=A(e);return{htm:"html",mjs:"javascript",cjs:"javascript",jsx:"javascript",ts:"typescript",mts:"typescript",cts:"typescript",tsx:"tsx",md:"markdown",markdown:"markdown",yml:"yaml",jsonc:"json",json5:"json",resx:"xml",config:"xml"}[t]??(t||"")}function P(e){const t=e.path.split("/").at(-1)??"";return S.test(t)||v.test(t)}function O(e){return e.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")}function G(e){const t=[];for(const r of e){const s=r.path.replace(/\\/g,"/").replace(/^\.?\//,"").split("/").filter(Boolean),o=r.isDirectory?s:s.slice(0,-1);for(const c of o){const a=O(c);a!==""&&!t.includes(a)&&t.push(a)}}for(;t.length>1&&t.join("-").length>x;)t.shift();const n=t.join("-");return n===""||n.length>x?void 0:n}async function W(e,t){let n;try{n=await e.workspace.fs.readDirectory(t)}catch{return 1}let r=0;for(const[s]of n){const o=S.exec(s)??v.exec(s);o!=null&&(r=Math.max(r,Number(o[1])))}return r+1}async function B(e,t,n){const r=G(n),s=await W(e,t);return`#${r!=null?`${r}#`:""}${s}.md`}function z(e,t){const n=t.match(/`+/g)?.reduce((s,o)=>Math.max(s,o.length),0)??0,r="`".repeat(Math.max(3,n+1));return`${r}${e}
${t.replace(/\s+$/,"")}
${r}`}async function $(e,t,n,r){const s=[],o=[],c=new Set;let a=0,i=0;for(const l of n){const f=_(e,t,l);let d;try{d=await e.workspace.fs.stat(l)}catch{i++,r.appendLine(`[flatten] could not stat ${f}`);continue}const p=(d.type&e.FileType.Directory)!==0;o.push({path:f,isDirectory:p});const u=p?await N(e,l,r):[l];for(const g of u){if(!c.add(g.toString()))continue;const y=await Q(e,t,g);y!=null?(s.push(y),a++):i++}}return{sections:s,selections:o,included:a,skipped:i}}function X(e){return`${`# Flattened workspace files

Generated ${new Date().toISOString()} — ${e.included} file(s)`+(e.skipped>0?`, ${e.skipped} skipped (binary or unreadable)`:"")+`
`}
${e.sections.join(`

`)}
`}async function C(e,t,n,r,s){const o=e.Uri.joinPath(t,n);await e.workspace.fs.writeFile(o,new TextEncoder().encode(X(r))),s.appendLine(`[flatten] wrote ${r.included} file(s) to ${n}.`),await e.window.showTextDocument(o)}function H(e){const t=(e??"").trim(),r=(t.toLowerCase().endsWith(".md")?t.slice(0,-3):t).replace(/[\\/:*?"<>|~]+/g,"-").replace(/^[.\s]+|[.\s]+$/g,"");return`${r.length>0?r:E}.md`}function Y(e,t,n){const r=[],s=[],o=new Set;for(const c of n){const i=c.trim().replaceAll("\\","/").replace(/^\.?\//,"").replace(/\/+$/,"").split("/").filter(Boolean);if(i.length===0){s.push(`Ignored empty include entry "${c}".`);continue}if(i.some(d=>d==="."||d==="..")){s.push(`Ignored include entry outside the workspace: "${c}".`);continue}const l=e.Uri.joinPath(t,...i),f=l.toString();o.has(f)||(o.add(f),r.push(l))}return{uris:r,problems:s}}const J={id:"flatten",async activate(e){const{vscode:t,outputChannel:n}=e,r=j({vscode:t,extensionId:"flatten",content:D});await M({id:"flatten",displayName:"Dataverse IDE Flatten",description:"Combine selected or configured files into a single markdown document.",commands:[{command:w,title:"Flatten: Combine Selected Files into Markdown"},{command:k,title:"Flatten: Combine Configured Files into Markdown"},{command:"dataverseIde.flatten.openGuide",title:"Flatten: How-to Guide"}],configuration:{title:"Dataverse IDE Flatten",properties:{[`${h}.${b}`]:{type:"string",default:E,scope:"window",markdownDescription:"Output file name used by `Flatten: Combine Configured Files into Markdown`. `.md` is appended when omitted. The bundle is written to the workspace root and replaced on each run."},[`${h}.${m}`]:{type:"array",items:{type:"string"},default:[],scope:"window",markdownDescription:'Workspace-relative files and folders included by `Flatten: Combine Configured Files into Markdown`. Folders are expanded recursively; `.git`, `node_modules`, `.ide-build` and `dist` are skipped. Example: `["src", "package.json"]`.'}}},menus:[{menu:"explorer/context",command:w,group:"dataverse@70"}]});const s=t.commands.registerCommand(w,async(...c)=>{const a=[],i=new Set;for(const d of c)for(const p of I(d)){const u=p.toString();i.has(u)||(i.add(u),a.push(p))}if(a.length===0){const d=t.window.activeTextEditor?.document.uri;if(d!=null&&d.scheme==="file"){const p=e.workspaceRootUri.path.replace(/\/+$/,""),u=d.path.replace(/\/+$/,"");(p.length===0||u===p||u.startsWith(`${p}/`))&&a.push(d)}}if(a.length===0){await t.window.showWarningMessage("Flatten: select one or more files in the explorer first.");return}const l=await $(t,e.workspaceRootUri,a,n);if(l.sections.length===0){await t.window.showWarningMessage("Flatten: no readable text files in the selection.");return}const f=await B(t,e.workspaceRootUri,l.selections);await C(t,e.workspaceRootUri,f,l,n)}),o=t.commands.registerCommand(k,async()=>{const c=t.workspace.getConfiguration(h,e.workspaceRootUri),a=c.get(m,[]),i=[];Array.isArray(a)||i.push(`"${h}.${m}" must be an array of paths.`);const l=Array.isArray(a)?a.filter(u=>typeof u=="string"):[];if(Array.isArray(a)&&l.length!==a.length&&i.push(`Ignored non-string entries in "${h}.${m}".`),l.length===0){await t.window.showWarningMessage(`Flatten: set "${h}.${m}" to at least one workspace-relative file or folder.`);return}const f=Y(t,e.workspaceRootUri,l);if(i.push(...f.problems),f.uris.length===0){await t.window.showWarningMessage(`Flatten: no valid paths in "${h}.${m}".`);return}for(const u of i)n.appendLine(`[flatten] ${u}`);const d=await $(t,e.workspaceRootUri,f.uris,n);if(d.sections.length===0){await t.window.showWarningMessage("Flatten: no readable text files in the configured includes.");return}const p=H(c.get(b));await C(t,e.workspaceRootUri,p,d,n)});return n.appendLine("[flatten] extension activated."),{dispose(){s.dispose(),o.dispose(),r.dispose()}}}};async function Q(e,t,n){const r=_(e,t,n);if(!U.has(A(n)))return`## ${r}

_(binary or unsupported file type - skipped)_`;try{const s=await e.workspace.fs.readFile(n),o=new TextDecoder().decode(s);return`## ${r}

${z(R(n),o)}`}catch{return`## ${r}

_(unreadable - skipped)_`}}export{J as default};
