import{c as M,y as I,S as f,D as P,A as D,B as v,U,F as T,G as b,C as O,I as A,J as z,K as R}from"./index-CzwCWkGt.js";const k="workbench.editors.dataverseIdeMarkdownPreview",L="dataverse-ide-markdown-preview",y="dataverseIde.markdown.openPreview",x="dataverseIde.markdown.openPreviewToSide",p="dataverseIde.markdown.showSource",w="dataverseIde.markdown.togglePreview";let i;function F(o){return U.parse(`${L}:/${encodeURIComponent(o.toString())}`)}function _(o){const e=o.path.split("/").pop();return e==null||e.length===0?"Markdown":e}function m(o){if(o!=null){if(typeof o=="string")try{return i.Uri.parse(o)}catch{return}if(typeof o=="object"&&"scheme"in o&&"path"in o)return o}}function $(o){switch(o.toLowerCase().split(".").pop()){case"png":return"image/png";case"jpg":case"jpeg":return"image/jpeg";case"gif":return"image/gif";case"webp":return"image/webp";case"avif":return"image/avif";case"bmp":return"image/bmp";case"ico":return"image/x-icon";case"svg":return"image/svg+xml";default:return"application/octet-stream"}}function B(o){let e="";for(let t=0;t<o.length;t+=32768)e+=String.fromCharCode(...o.subarray(t,t+32768));return btoa(e)}function C(o,e){const r=e.split("#")[0].split("?")[0];if(r.length!==0){if(r.startsWith("/")){const t=i.workspace.workspaceFolders?.[0]?.uri;return t==null?void 0:i.Uri.joinPath(t,r.replace(/^\/+/,""))}try{return i.Uri.joinPath(o,r)}catch{return}}}async function N(o,e){const r=Array.from(o.querySelectorAll("img"));await Promise.all(r.map(async t=>{t.setAttribute("loading","lazy"),t.setAttribute("referrerpolicy","no-referrer");const n=t.getAttribute("src");if(n==null||n.length===0||/^[a-z][a-z0-9+.-]*:/i.test(n))return;const a=C(e,n);if(a!=null)try{const s=await i.workspace.fs.readFile(a);t.setAttribute("src",`data:${$(a.path)};base64,${B(s)}`)}catch(s){t.removeAttribute("src"),t.setAttribute("alt",`${t.getAttribute("alt")??""} (image unavailable)`),console.warn("[markdown] Could not read preview image:",a.toString(),s)}}))}async function H(o,e){const r=String(await z.parse(o,{async:!0,gfm:!0})),t=R.sanitize(r,{USE_PROFILES:{html:!0},FORBID_TAGS:["base","button","embed","form","iframe","input","link","meta","object","script","select","style","textarea"],FORBID_ATTR:["style"]}),n=document.createElement("template");return n.innerHTML=t,await N(n.content,e),n.innerHTML}const V=`
:host {
  display: block;
  min-height: 100%;
  color: var(--vscode-editor-foreground);
  background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Ubuntu, sans-serif);
  font-size: var(--vscode-font-size, 14px);
}

.markdown-body {
  box-sizing: border-box;
  max-width: 920px;
  min-height: 100%;
  margin: 0 auto;
  padding: 24px 32px 64px;
  line-height: 1.6;
  overflow-wrap: break-word;
}

.markdown-body > :first-child {
  margin-top: 0;
}

h1, h2, h3, h4, h5, h6 {
  margin: 24px 0 12px;
  font-weight: 600;
  line-height: 1.25;
}

h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); }
h2 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); }
h3 { font-size: 1.25em; }
h4 { font-size: 1em; }
h5 { font-size: 0.875em; }
h6 { font-size: 0.85em; color: var(--vscode-descriptionForeground); }

p, ul, ol, blockquote, pre, table {
  margin: 0 0 16px;
}

ul, ol {
  padding-left: 2em;
}

li + li {
  margin-top: 0.25em;
}

li > p {
  margin-top: 16px;
}

a {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
  cursor: pointer;
}

a:hover {
  color: var(--vscode-textLink-activeForeground);
  text-decoration: underline;
}

strong { font-weight: 600; }

code, kbd, samp {
  font-family: var(--vscode-editor-font-family, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace);
  font-size: 0.9em;
}

:not(pre) > code {
  padding: 2px 5px;
  border-radius: 4px;
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.17));
}

pre {
  padding: 14px 16px;
  overflow: auto;
  border-radius: 6px;
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.17));
  line-height: 1.45;
}

pre code {
  padding: 0;
  background: transparent;
  font-size: 0.9em;
}

blockquote {
  padding: 0 1em;
  color: var(--vscode-descriptionForeground);
  border-left: 4px solid var(--vscode-textBlockQuote-border, rgba(128,128,128,0.35));
}

blockquote > :last-child {
  margin-bottom: 0;
}

hr {
  height: 0;
  margin: 24px 0;
  border: 0;
  border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
}

table {
  display: block;
  width: max-content;
  max-width: 100%;
  overflow: auto;
  border-collapse: collapse;
}

th, td {
  padding: 6px 13px;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
}

th {
  font-weight: 600;
  background: var(--vscode-keybindingLabel-background, rgba(128,128,128,0.08));
}

tr:nth-child(2n) td {
  background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.04));
}

img {
  max-width: 100%;
  box-sizing: border-box;
}

del { color: var(--vscode-descriptionForeground); }

.markdown-body .task-list-item {
  list-style: none;
}

.markdown-body .task-list-item input {
  margin: 0 0.4em 0.25em -1.4em;
  vertical-align: middle;
}
`;class d extends D{static ID=k;documentUri;constructor(e){super(F(e)),this.documentUri=e;const r=_(e);this.setName(`[Preview] ${r}`),this.setTitle(`${r} (Preview)`),this.setDescription("Markdown Preview"),this.addCapability(v.Readonly|v.Singleton)}get typeId(){return d.ID}}class E extends O{host;shadow;content;currentDocumentUri;renderVersion=0;constructor(e){super(d.ID,e)}initialize(){const e=document.createElement("div");e.className="dim-markdown-preview",e.tabIndex=0,e.setAttribute("role","document"),e.setAttribute("aria-label","Markdown preview");const r=e.attachShadow({mode:"open"}),t=document.createElement("style");t.textContent=V;const n=document.createElement("div");return n.className="markdown-body",r.append(t,n),e.addEventListener("click",this.handleClick),this.host=e,this.shadow=r,this.content=n,e}async renderInput(e){if(!(e instanceof d))return{dispose(){}};this.currentDocumentUri=e.documentUri;let r,t=!1;const n=()=>{this.renderDocument(e.documentUri).catch(s=>{t||(console.warn("[markdown] Preview render failed:",s),this.content.textContent=s instanceof Error?s.message:"Could not render the Markdown preview.")})},a=i.workspace.onDidChangeTextDocument(s=>{s.document.uri.toString()!==e.documentUri.toString()||s.contentChanges.length===0||(r!=null&&window.clearTimeout(r),r=window.setTimeout(()=>{r=void 0,n()},150))});return n(),{dispose(){t=!0,r!=null&&(window.clearTimeout(r),r=void 0),a.dispose()}}}async refresh(){this.currentDocumentUri!=null&&await this.renderDocument(this.currentDocumentUri)}async renderDocument(e){const r=++this.renderVersion,t=await i.workspace.openTextDocument(e),n=await H(t.getText(),e);if(r!==this.renderVersion)return;const a=this.host.closest(".monaco-scrollable-element"),s=a?.scrollTop??0;this.content.innerHTML=n,a!=null&&(a.scrollTop=s)}handleClick=e=>{const r=e.composedPath().find(n=>n instanceof HTMLAnchorElement);if(r==null)return;const t=r.getAttribute("href");t==null||t.length===0||(e.preventDefault(),e.stopPropagation(),this.openLink(t))};async openLink(e){if(e.startsWith("#")){const n=decodeURIComponent(e.slice(1));this.shadow.getElementById(n)?.scrollIntoView({behavior:"smooth",block:"start"});return}if(e.startsWith("command:")){try{const n=i.Uri.parse(e),a=n.query;let s=[];if(a.length>0)try{const u=JSON.parse(decodeURIComponent(a));s=Array.isArray(u)?u:[u]}catch{s=[decodeURIComponent(a)]}await i.commands.executeCommand(n.path,...s)}catch(n){console.warn("[markdown] Could not run preview command link:",e,n)}return}if(/^(https?|mailto):/i.test(e)){await i.env.openExternal(i.Uri.parse(e));return}if(/^[a-z][a-z0-9+.-]*:/i.test(e)){try{await i.commands.executeCommand("vscode.open",i.Uri.parse(e))}catch(n){console.warn("[markdown] Could not open preview link:",e,n)}return}const r=this.currentDocumentUri;if(r==null)return;const t=C(r,e);if(t!=null)try{await i.commands.executeCommand("vscode.open",t)}catch(n){console.warn("[markdown] Could not open preview link:",e,n)}}}function l(){return f.get(A)}function S(){const e=l().activeEditor;return e instanceof d?e.documentUri:i.window.activeTextEditor?.document.uri}async function c(o,e){const r=o??S();if(r==null){i.window.showInformationMessage("Open a Markdown file before opening the preview.");return}const t=l(),n=new d(r),a=n.resource==null?void 0:t.findEditors(n.resource)[0]?.editor;await t.openEditor(a??n,{pinned:!0,revealIfOpened:!0},e?T:b)}async function g(){const o=l(),e=o.activeEditor,r=e instanceof d?e.documentUri:i.window.activeTextEditor?.document.uri;if(r==null)return;const t=o.findEditors(r)[0];if(t!=null){await o.openEditor(t.editor,{pinned:!0,revealIfOpened:!0},t.groupId);return}await o.openEditor({resource:r},b)}async function h(){if(l().activeEditor instanceof d){await g();return}await c(S(),!1)}async function j(){const o=l().activeEditorPane;o instanceof E&&await o.refresh()}function q(){const o=[i.commands.registerCommand(y,e=>c(m(e),!1)),i.commands.registerCommand(x,e=>c(m(e),!0)),i.commands.registerCommand(p,()=>g()),i.commands.registerCommand(w,()=>h()),i.commands.registerCommand("markdown.showPreview",e=>c(m(e),!1)),i.commands.registerCommand("markdown.showPreviewToSide",e=>c(m(e),!0)),i.commands.registerCommand("markdown.showLockedPreviewToSide",e=>c(m(e),!0)),i.commands.registerCommand("markdown.reopenAsPreview",e=>c(m(e),!1)),i.commands.registerCommand("markdown.togglePreview",()=>h()),i.commands.registerCommand("markdown.showSource",()=>g()),i.commands.registerCommand("markdown.preview.refresh",()=>j())];return{dispose(){for(const e of o)e.dispose()}}}const G={id:"markdown",async activate(o){i=o.vscode,await M({id:"markdown",displayName:"Dataverse IDE Markdown",description:"DOM-based Markdown preview that does not require webviews or service workers.",commands:[{command:y,title:"Markdown: Open Preview (DOM)",icon:"$(preview)"},{command:x,title:"Markdown: Open Preview to the Side (DOM)",icon:"$(open-preview)"},{command:p,title:"Markdown: Show Source (DOM)",icon:"$(file-code)"},{command:w,title:"Markdown: Toggle Preview (DOM)",icon:"$(preview)"}],menus:[{menu:"editor/title",command:p,when:`activeCustomEditorId == '${k}'`,group:"navigation@1"}],keybindings:[{command:w,key:"ctrl+shift+v",mac:"shift+cmd+v",when:"!terminalFocus && !inputFocus"}]});const e=I(d.ID,"Markdown Preview",E,[d]);try{const t=f.get(P);await Promise.race([t.activateByEvent("onLanguage:markdown"),new Promise(n=>window.setTimeout(n,5e3))])}catch(t){o.outputChannel.appendLine(`[markdown] Could not pre-activate markdown-language-features: ${t instanceof Error?t.message:String(t)}`)}const r=q();return o.outputChannel.appendLine("[markdown] DOM preview extension activated."),{dispose(){r.dispose(),e.dispose()}}}};export{G as default};
