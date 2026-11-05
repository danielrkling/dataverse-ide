import{s as z,V as F}from"./index-CzwCWkGt.js";const P="dataverse-ide-panel-styles";function M(){if(document.getElementById(P)!=null)return;const u=document.createElement("style");u.id=P,u.textContent=`
.di-panel {
  padding: 10px 14px 16px;
  font-size: 12px;
  color: var(--vscode-foreground);
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  box-sizing: border-box;
}
.di-panel-description {
  color: var(--vscode-descriptionForeground);
  line-height: 1.45;
  margin: 0;
}
.di-panel-section-title {
  font-weight: 600;
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.4px;
  color: var(--vscode-descriptionForeground);
  margin: 2px 0 0;
}
.di-panel-setting {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.di-panel-setting-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 500;
  color: var(--vscode-foreground);
}
.di-panel-setting-description {
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  line-height: 1.35;
}
.di-panel-input,
.di-panel-select {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
  border-radius: 2px;
  padding: 4px 6px;
  font-size: 12px;
  font-family: inherit;
  width: 100%;
  box-sizing: border-box;
}
.di-panel-input:focus,
.di-panel-select:focus {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
.di-panel-checkbox-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.di-panel-checkbox {
  accent-color: var(--vscode-checkbox-background);
}
.di-panel-slider-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.di-panel-slider {
  flex: 1;
  accent-color: var(--vscode-slider-background, var(--vscode-focusBorder));
}
.di-panel-slider-value {
  min-width: 40px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--vscode-descriptionForeground);
}
.di-panel-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.di-panel-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.di-panel-list-entry {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
  border-radius: 2px;
  padding: 2px 6px;
}
.di-panel-list-entry-text {
  flex: 1;
  overflow-wrap: anywhere;
}
.di-panel-list-remove {
  background: none;
  border: none;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 2px 4px;
}
.di-panel-list-remove:hover {
  color: var(--vscode-errorForeground);
}
.di-panel-list-add {
  display: flex;
  gap: 6px;
}
.di-panel-button {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  border-radius: 2px;
  padding: 5px 10px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  text-align: center;
}
.di-panel-button:hover {
  background: var(--vscode-button-secondaryHoverBackground);
}
.di-panel-button.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.di-panel-button.primary:hover {
  background: var(--vscode-button-hoverBackground);
}
`,document.head.append(u)}function D(u){const p='<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">'+u+"</svg>";return`data:image/svg+xml;base64,${btoa(p)}`}const A={package:'<path d="M4 8l8-4.5L20 8v8l-8 4.5L4 16V8Z" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/><path d="M4 8l8 4.5L20 8M12 12.5V20" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/>',gitlab:'<g transform="translate(2 2) scale(1.25)"><path d="M3.43969 7.55996C2.71969 7.01996 1.88969 6.66996 1.02969 6.49996C0.969687 6.76996 0.929688 7.03996 0.929688 7.30996C0.929688 8.39996 1.42969 9.44996 2.33969 10.14L2.35969 10.16L4.83969 12.02L7.09969 10.32L3.44969 7.55996H3.43969ZM7.91969 9.68996L11.7997 6.75996C12.6097 6.14996 13.5297 5.75996 14.4997 5.54996L12.7597 1.02996C12.6297 0.709961 12.2997 0.709961 12.2897 0.709961C11.9297 0.709961 11.8197 1.01996 11.8097 1.07996L10.5197 5.01996H5.30969L4.01969 1.07996C3.95969 0.859961 3.74969 0.709961 3.53969 0.709961C3.19969 0.709961 3.07969 1.00996 3.06969 1.02996L1.33969 5.54996C2.30969 5.75996 3.21969 6.14996 4.02969 6.74996L7.91969 9.68996ZM5.65969 12.64L6.68969 13.42L7.55969 14.08C7.66969 14.16 7.78969 14.2 7.91969 14.2C8.04969 14.2 8.16969 14.16 8.27969 14.08L9.14969 13.42L10.1797 12.64L7.91969 10.94L5.65969 12.64ZM14.8097 6.49996C13.9397 6.66996 13.1197 7.00996 12.4097 7.54996L8.74969 10.32L11.0097 12.02L13.5097 10.15C14.4197 9.45996 14.9197 8.40996 14.9197 7.31996C14.9197 7.03996 14.8797 6.76996 14.8097 6.49996Z" fill="#fff"/></g>'};function H(u,p){M();const k=`dataverseIde.${p.extensionId}`,R=p.workspaceRootUri!=null?u.ConfigurationTarget.Workspace:u.ConfigurationTarget.Global,g=new Map,y=[],h=p.store??{get(d,l){return u.workspace.getConfiguration(k,p.workspaceRootUri??null).get(d,l)},async set(d,l){await u.workspace.getConfiguration(k,p.workspaceRootUri??null).update(d,l,R)},onChange(d){return u.workspace.onDidChangeConfiguration(l=>{l.affectsConfiguration(k)&&d()})}},m=(d,l)=>h.get(d,l),b=async(d,l)=>h.set(d,l),B=z({id:`dataverseIde.${p.extensionId}`,name:p.title,icon:p.icon,location:F.Sidebar,renderBody:d=>{const l=document.createElement("div");if(l.className="di-panel",d.append(l),p.description!=null){const e=document.createElement("p");e.className="di-panel-description",e.textContent=p.description,l.append(e)}const E=p.settings??[];if(E.length>0){const e=document.createElement("div");e.className="di-panel-section-title",e.textContent="Settings",l.append(e)}for(const e of E){const r=document.createElement("div");if(r.className="di-panel-setting",e.type==="boolean"){const n=document.createElement("label");n.className="di-panel-label di-panel-checkbox-row";const t=document.createElement("input");t.type="checkbox",t.className="di-panel-checkbox",t.checked=m(e.key,e.default);const o=document.createElement("span");o.textContent=e.label,n.append(t,o),r.append(n),g.set(e.key,()=>{t.checked=m(e.key,e.default)}),t.addEventListener("change",()=>{b(e.key,t.checked)})}else if(e.type==="number"){const n=document.createElement("label");n.className="di-panel-setting-label",n.textContent=e.label,r.append(n);const t=document.createElement("div");t.className="di-panel-slider-row";const o=document.createElement("input");o.type="range",o.className="di-panel-slider",o.min=String(e.min??0),o.max=String(e.max??100),o.step=String(e.step??(e.integer?1:.1)),o.value=String(m(e.key,e.default));const i=document.createElement("span");i.className="di-panel-slider-value",i.textContent=o.value,t.append(o,i),r.append(t),g.set(e.key,()=>{const a=String(m(e.key,e.default));o.value=a,i.textContent=a}),o.addEventListener("input",()=>{i.textContent=o.value}),o.addEventListener("change",()=>{const a=e.integer?Number.parseInt(o.value,10):Number.parseFloat(o.value);b(e.key,Number.isNaN(a)?e.default:a)})}else if(e.type==="enum"){const n=document.createElement("label");n.className="di-panel-setting-label",n.textContent=e.label,r.append(n);const t=document.createElement("select");t.className="di-panel-select";const o=e.options??[];for(const a of o){const s=document.createElement("option");s.value=a.value,s.textContent=a.label,t.append(s)}t.value=m(e.key,e.default),r.append(t);const i=async()=>{if(e.optionsProvider==null)return;t.disabled=!0;let a;try{a=await e.optionsProvider()}catch{a=[{value:m(e.key,e.default),label:"(options unavailable)"}]}t.replaceChildren();for(const c of a){const v=document.createElement("option");v.value=c.value,v.textContent=c.label,t.append(v)}const s=m(e.key,e.default);t.value=a.some(c=>c.value===s)?s:a[0]?.value??"",t.disabled=!1};i(),y.push(i),g.set(e.key,()=>{const a=m(e.key,e.default);((e.optionsProvider==null?o.some(c=>c.value===a):Array.from(t.options).some(c=>c.value===a))||e.optionsProvider==null)&&(t.value=a)}),t.addEventListener("change",()=>{b(e.key,t.value)})}else if(e.type==="stringList"){const n=document.createElement("label");n.className="di-panel-setting-label",n.textContent=e.label,r.append(n);const t=document.createElement("div");t.className="di-panel-list",r.append(t);const o=()=>m(e.key,e.default),i=()=>{t.replaceChildren();const v=o();for(const[x,C]of v.entries()){const w=document.createElement("div");w.className="di-panel-list-entry";const L=document.createElement("span");L.className="di-panel-list-entry-text",L.textContent=C;const f=document.createElement("button");f.type="button",f.className="di-panel-list-remove",f.textContent="✕",f.title=`Remove ${C}`,f.setAttribute("aria-label",`Remove ${C}`),f.addEventListener("click",()=>{const S=o();S.splice(x,1),b(e.key,S),i()}),w.append(L,f),t.append(w)}};i();const a=document.createElement("div");a.className="di-panel-list-add";const s=document.createElement("input");s.type="text",s.className="di-panel-input",s.spellcheck=!1,s.placeholder=e.placeholder??"add entry…";const c=document.createElement("button");c.type="button",c.className="di-panel-button",c.textContent="Add",c.addEventListener("click",()=>{const v=s.value.trim();if(v.length===0)return;const x=o();x.includes(v)||(x.push(v),b(e.key,x)),s.value="",i()}),s.addEventListener("keydown",v=>{v.key==="Enter"&&(v.preventDefault(),c.click())}),a.append(s,c),r.append(a),g.set(e.key,()=>{i()})}else{const n=document.createElement("label");n.className="di-panel-setting-label",n.textContent=e.label,r.append(n);const t=document.createElement("input");t.type="text",t.className="di-panel-input",t.spellcheck=!1,t.value=m(e.key,e.default),t.placeholder=e.placeholder??"",r.append(t),g.set(e.key,()=>{const i=m(e.key,e.default);document.activeElement!==t&&(t.value=i)});const o=()=>{b(e.key,t.value.trim())};t.addEventListener("change",o),t.addEventListener("keydown",i=>{i.key==="Enter"&&(i.preventDefault(),t.blur(),o())})}if(e.description!=null){const n=document.createElement("div");n.className="di-panel-setting-description",n.textContent=e.description,r.append(n)}l.append(r)}const N=p.actions??[];if(N.length>0){const e=document.createElement("div");e.className="di-panel-section-title",e.textContent="Actions",l.append(e);const r=document.createElement("div");r.className="di-panel-actions",l.append(r);for(const n of N){const t=document.createElement("button");t.type="button",t.className=n.primary?"di-panel-button primary":"di-panel-button",t.textContent=n.label,n.tooltip!=null&&(t.title=n.tooltip),t.addEventListener("click",()=>{u.commands.executeCommand(n.command,...n.args??[])}),r.append(t)}}const I=h.onChange(()=>{for(const e of g.values())e();for(const e of y)e()});return{dispose(){I.dispose(),l.remove()}}}});return{getSetting(d,l){return m(d,l)},refresh(){for(const d of y)d()},dispose(){B.dispose(),g.clear(),y.length=0}}}export{A as P,D as c,H as r};
