const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./index-DApFg4sc.js","./index-CzwCWkGt.js","./index-B8-LU0GX.css","./index-RtUUFBge.js","./assert-Bc4zP4jx.js","./index-DzBb8I39.js","./index-DIj0uOx4.js","./index-D1HUoSrK.js","./_commonjs-dynamic-modules-TDtrdbi3.js","./index-CJQ2KH6H.js","./index-DCDJx0WE.js","./index-BWZ1Ly4_.js","./index-Kn2e8r5R.js","./index-CzIKh0v6.js","./index-DGOOsH3U.js","./typescript-md01NZxD.js","./__vite-browser-external-D7Ct-6yo.js"])))=>i.map(i=>d[i]);
import{_ as Re}from"./index-CzwCWkGt.js";import{n as ce,N as Kt,s as Qt,h as lt,p as Zt,E as qt,I as mt,C as en,R as tn}from"./packageResolver-BkDNzihu.js";var He={exports:{}},at;function nn(){return at||(at=1,(function(t){(l=>{var w=Object.defineProperty,A=Object.getOwnPropertyDescriptor,x=Object.getOwnPropertyNames,S=Object.prototype.hasOwnProperty,Y=(e,r)=>{for(var i in r)w(e,i,{get:r[i],enumerable:!0})},Z=(e,r,i,u)=>{if(r&&typeof r=="object"||typeof r=="function")for(let y of x(r))!S.call(e,y)&&y!==i&&w(e,y,{get:()=>r[y],enumerable:!(u=A(r,y))||u.enumerable});return e},ne=e=>Z(w({},"__esModule",{value:!0}),e),R=(e,r,i)=>new Promise((u,y)=>{var b=d=>{try{P(i.next(d))}catch(V){y(V)}},p=d=>{try{P(i.throw(d))}catch(V){y(V)}},P=d=>d.done?u(d.value):Promise.resolve(d.value).then(b,p);P((i=i.apply(e,r)).next())}),re={};Y(re,{analyzeMetafile:()=>Mt,analyzeMetafileSync:()=>Vt,build:()=>It,buildSync:()=>Lt,context:()=>Nt,default:()=>Ht,formatMessages:()=>Ft,formatMessagesSync:()=>Bt,initialize:()=>Jt,stop:()=>zt,transform:()=>Ut,transformSync:()=>Wt,version:()=>Rt}),l.exports=ne(re);function F(e){let r=u=>{if(u===null)i.write8(0);else if(typeof u=="boolean")i.write8(1),i.write8(+u);else if(typeof u=="number")i.write8(2),i.write32(u|0);else if(typeof u=="string")i.write8(3),i.write(J(u));else if(u instanceof Uint8Array)i.write8(4),i.write(u);else if(u instanceof Array){i.write8(5),i.write32(u.length);for(let y of u)r(y)}else{let y=Object.keys(u);i.write8(6),i.write32(y.length);for(let b of y)i.write(J(b)),r(u[b])}},i=new B;return i.write32(0),i.write32(e.id<<1|+!e.isRequest),r(e.value),ue(i.buf,i.len-4,0),i.buf.subarray(0,i.len)}function M(e){let r=()=>{switch(i.read8()){case 0:return null;case 1:return!!i.read8();case 2:return i.read32();case 3:return ie(i.read());case 4:return i.read();case 5:{let p=i.read32(),P=[];for(let d=0;d<p;d++)P.push(r());return P}case 6:{let p=i.read32(),P={};for(let d=0;d<p;d++)P[ie(i.read())]=r();return P}default:throw new Error("Invalid packet")}},i=new B(e),u=i.read32(),y=(u&1)===0;u>>>=1;let b=r();if(i.ptr!==e.length)throw new Error("Invalid packet");return{id:u,isRequest:y,value:b}}var B=class{constructor(e=new Uint8Array(1024)){this.buf=e,this.len=0,this.ptr=0}_write(e){if(this.len+e>this.buf.length){let r=new Uint8Array((this.len+e)*2);r.set(this.buf),this.buf=r}return this.len+=e,this.len-e}write8(e){let r=this._write(1);this.buf[r]=e}write32(e){let r=this._write(4);ue(this.buf,e,r)}write(e){let r=this._write(4+e.length);ue(this.buf,e.length,r),this.buf.set(e,r+4)}_read(e){if(this.ptr+e>this.buf.length)throw new Error("Invalid packet");return this.ptr+=e,this.ptr-e}read8(){return this.buf[this._read(1)]}read32(){return me(this.buf,this._read(4))}read(){let e=this.read32(),r=new Uint8Array(e),i=this._read(r.length);return r.set(this.buf.subarray(i,i+e)),r}},J,ie,ve;if(typeof TextEncoder<"u"&&typeof TextDecoder<"u"){let e=new TextEncoder,r=new TextDecoder;J=i=>e.encode(i),ie=i=>r.decode(i),ve='new TextEncoder().encode("")'}else if(typeof Buffer<"u")J=e=>Buffer.from(e),ie=e=>{let{buffer:r,byteOffset:i,byteLength:u}=e;return Buffer.from(r,i,u).toString()},ve='Buffer.from("")';else throw new Error("No UTF-8 codec found");if(!(J("")instanceof Uint8Array))throw new Error(`Invariant violation: "${ve} instanceof Uint8Array" is incorrectly false

This indicates that your JavaScript environment is broken. You cannot use
esbuild in this environment because esbuild relies on this invariant. This
is not a problem with esbuild. You need to fix your environment instead.
`);function me(e,r){return e[r++]|e[r++]<<8|e[r++]<<16|e[r++]<<24}function ue(e,r,i){e[i++]=r,e[i++]=r>>8,e[i++]=r>>16,e[i++]=r>>24}var ee=JSON.stringify,be="warning",ke="silent";function ge(e,r){const i=[];for(const u of e){if(de(u,r),u.indexOf(",")>=0)throw new Error(`Invalid ${r}: ${u}`);i.push(u)}return i.join(",")}var xe=()=>null,te=e=>typeof e=="boolean"?null:"a boolean",$=e=>typeof e=="string"?null:"a string",Me=e=>e instanceof RegExp?null:"a RegExp object",Pe=e=>typeof e=="number"&&e===(e|0)?null:"an integer",xt=e=>typeof e=="number"&&e===(e|0)&&e>=0&&e<=65535?null:"a valid port number",Qe=e=>typeof e=="function"?null:"a function",Ee=e=>Array.isArray(e)?null:"an array",fe=e=>Array.isArray(e)&&e.every(r=>typeof r=="string")?null:"an array of strings",pe=e=>typeof e=="object"&&e!==null&&!Array.isArray(e)?null:"an object",kt=e=>typeof e=="object"&&e!==null?null:"an array or an object",_t=e=>e instanceof WebAssembly.Module?null:"a WebAssembly.Module",Ze=e=>typeof e=="object"&&!Array.isArray(e)?null:"an object or null",qe=e=>typeof e=="string"||typeof e=="boolean"?null:"a string or a boolean",Et=e=>typeof e=="string"||typeof e=="object"&&e!==null&&!Array.isArray(e)?null:"a string or an object",et=e=>typeof e=="string"||Array.isArray(e)&&e.every(r=>typeof r=="string")?null:"a string or an array of strings",tt=e=>typeof e=="string"||e instanceof Uint8Array?null:"a string or a Uint8Array",St=e=>typeof e=="string"||e instanceof URL?null:"a string or a URL";function o(e,r,i,u){let y=e[i];if(r[i+""]=!0,y===void 0)return;let b=u(y);if(b!==null)throw new Error(`${ee(i)} must be ${b}`);return y}function le(e,r,i){for(let u in e)if(!(u in r))throw new Error(`Invalid option ${i}: ${ee(u)}`)}function jt(e){let r=Object.create(null),i=o(e,r,"wasmURL",St),u=o(e,r,"wasmModule",_t),y=o(e,r,"worker",te);return le(e,r,"in initialize() call"),{wasmURL:i,wasmModule:u,worker:y}}function nt(e){let r;if(e!==void 0){r=Object.create(null);for(let i in e){let u=e[i];if(typeof u=="string"||u===!1)r[i]=u;else throw new Error(`Expected ${ee(i)} in mangle cache to map to either a string or false`)}}return r}function Le(e,r,i,u,y){let b=o(r,i,"color",te),p=o(r,i,"logLevel",$),P=o(r,i,"logLimit",Pe);b!==void 0?e.push(`--color=${b}`):u&&e.push("--color=true"),e.push(`--log-level=${p||y}`),e.push(`--log-limit=${P||0}`)}function de(e,r,i){if(typeof e!="string")throw new Error(`Expected value for ${r}${i!==void 0?" "+ee(i):""} to be a string, got ${typeof e} instead`);return e}function rt(e,r,i){let u=o(r,i,"legalComments",$),y=o(r,i,"sourceRoot",$),b=o(r,i,"sourcesContent",te),p=o(r,i,"target",et),P=o(r,i,"format",$),d=o(r,i,"globalName",$),V=o(r,i,"mangleProps",Me),z=o(r,i,"reserveProps",Me),U=o(r,i,"mangleQuoted",te),q=o(r,i,"minify",te),L=o(r,i,"minifySyntax",te),X=o(r,i,"minifyWhitespace",te),K=o(r,i,"minifyIdentifiers",te),I=o(r,i,"lineLimit",Pe),oe=o(r,i,"drop",fe),C=o(r,i,"dropLabels",fe),O=o(r,i,"charset",$),v=o(r,i,"treeShaking",te),h=o(r,i,"ignoreAnnotations",te),s=o(r,i,"jsx",$),c=o(r,i,"jsxFactory",$),m=o(r,i,"jsxFragment",$),E=o(r,i,"jsxImportSource",$),j=o(r,i,"jsxDev",te),f=o(r,i,"jsxSideEffects",te),g=o(r,i,"define",pe),n=o(r,i,"logOverride",pe),a=o(r,i,"supported",pe),k=o(r,i,"pure",fe),_=o(r,i,"keepNames",te),D=o(r,i,"platform",$),W=o(r,i,"tsconfigRaw",Et),se=o(r,i,"absPaths",fe);if(u&&e.push(`--legal-comments=${u}`),y!==void 0&&e.push(`--source-root=${y}`),b!==void 0&&e.push(`--sources-content=${b}`),p&&e.push(`--target=${ge(Array.isArray(p)?p:[p],"target")}`),P&&e.push(`--format=${P}`),d&&e.push(`--global-name=${d}`),D&&e.push(`--platform=${D}`),W&&e.push(`--tsconfig-raw=${typeof W=="string"?W:JSON.stringify(W)}`),q&&e.push("--minify"),L&&e.push("--minify-syntax"),X&&e.push("--minify-whitespace"),K&&e.push("--minify-identifiers"),I&&e.push(`--line-limit=${I}`),O&&e.push(`--charset=${O}`),v!==void 0&&e.push(`--tree-shaking=${v}`),h&&e.push("--ignore-annotations"),oe)for(let T of oe)e.push(`--drop:${de(T,"drop")}`);if(C&&e.push(`--drop-labels=${ge(C,"drop label")}`),se&&e.push(`--abs-paths=${ge(se,"abs paths")}`),V&&e.push(`--mangle-props=${Ve(V)}`),z&&e.push(`--reserve-props=${Ve(z)}`),U!==void 0&&e.push(`--mangle-quoted=${U}`),s&&e.push(`--jsx=${s}`),c&&e.push(`--jsx-factory=${c}`),m&&e.push(`--jsx-fragment=${m}`),E&&e.push(`--jsx-import-source=${E}`),j&&e.push("--jsx-dev"),f&&e.push("--jsx-side-effects"),g)for(let T in g){if(T.indexOf("=")>=0)throw new Error(`Invalid define: ${T}`);e.push(`--define:${T}=${de(g[T],"define",T)}`)}if(n)for(let T in n){if(T.indexOf("=")>=0)throw new Error(`Invalid log override: ${T}`);e.push(`--log-override:${T}=${de(n[T],"log override",T)}`)}if(a)for(let T in a){if(T.indexOf("=")>=0)throw new Error(`Invalid supported: ${T}`);const Q=a[T];if(typeof Q!="boolean")throw new Error(`Expected value for supported ${ee(T)} to be a boolean, got ${typeof Q} instead`);e.push(`--supported:${T}=${Q}`)}if(k)for(let T of k)e.push(`--pure:${de(T,"pure")}`);_&&e.push("--keep-names")}function Tt(e,r,i,u,y){var b;let p=[],P=[],d=Object.create(null),V=null,z=null;Le(p,r,d,i,u),rt(p,r,d);let U=o(r,d,"sourcemap",qe),q=o(r,d,"bundle",te),L=o(r,d,"splitting",te),X=o(r,d,"preserveSymlinks",te),K=o(r,d,"metafile",te),I=o(r,d,"outfile",$),oe=o(r,d,"outdir",$),C=o(r,d,"outbase",$),O=o(r,d,"tsconfig",$),v=o(r,d,"resolveExtensions",fe),h=o(r,d,"nodePaths",fe),s=o(r,d,"mainFields",fe),c=o(r,d,"conditions",fe),m=o(r,d,"external",fe),E=o(r,d,"packages",$),j=o(r,d,"alias",pe),f=o(r,d,"loader",pe),g=o(r,d,"outExtension",pe),n=o(r,d,"publicPath",$),a=o(r,d,"entryNames",$),k=o(r,d,"chunkNames",$),_=o(r,d,"assetNames",$),D=o(r,d,"inject",fe),W=o(r,d,"banner",pe),se=o(r,d,"footer",pe),T=o(r,d,"entryPoints",kt),Q=o(r,d,"absWorkingDir",$),H=o(r,d,"stdin",pe),G=(b=o(r,d,"write",te))!=null?b:y,he=o(r,d,"allowOverwrite",te),ae=o(r,d,"mangleCache",pe);if(d.plugins=!0,le(r,d,`in ${e}() call`),U&&p.push(`--sourcemap${U===!0?"":`=${U}`}`),q&&p.push("--bundle"),he&&p.push("--allow-overwrite"),L&&p.push("--splitting"),X&&p.push("--preserve-symlinks"),K&&p.push("--metafile"),I&&p.push(`--outfile=${I}`),oe&&p.push(`--outdir=${oe}`),C&&p.push(`--outbase=${C}`),O&&p.push(`--tsconfig=${O}`),E&&p.push(`--packages=${E}`),v&&p.push(`--resolve-extensions=${ge(v,"resolve extension")}`),n&&p.push(`--public-path=${n}`),a&&p.push(`--entry-names=${a}`),k&&p.push(`--chunk-names=${k}`),_&&p.push(`--asset-names=${_}`),s&&p.push(`--main-fields=${ge(s,"main field")}`),c&&p.push(`--conditions=${ge(c,"condition")}`),m)for(let N of m)p.push(`--external:${de(N,"external")}`);if(j)for(let N in j){if(N.indexOf("=")>=0)throw new Error(`Invalid package name in alias: ${N}`);p.push(`--alias:${N}=${de(j[N],"alias",N)}`)}if(W)for(let N in W){if(N.indexOf("=")>=0)throw new Error(`Invalid banner file type: ${N}`);p.push(`--banner:${N}=${de(W[N],"banner",N)}`)}if(se)for(let N in se){if(N.indexOf("=")>=0)throw new Error(`Invalid footer file type: ${N}`);p.push(`--footer:${N}=${de(se[N],"footer",N)}`)}if(D)for(let N of D)p.push(`--inject:${de(N,"inject")}`);if(f)for(let N in f){if(N.indexOf("=")>=0)throw new Error(`Invalid loader extension: ${N}`);p.push(`--loader:${N}=${de(f[N],"loader",N)}`)}if(g)for(let N in g){if(N.indexOf("=")>=0)throw new Error(`Invalid out extension: ${N}`);p.push(`--out-extension:${N}=${de(g[N],"out extension",N)}`)}if(T)if(Array.isArray(T))for(let N=0,Te=T.length;N<Te;N++){let ye=T[N];if(typeof ye=="object"&&ye!==null){let _e=Object.create(null),$e=o(ye,_e,"in",$),we=o(ye,_e,"out",$);if(le(ye,_e,"in entry point at index "+N),$e===void 0)throw new Error('Missing property "in" for entry point at index '+N);if(we===void 0)throw new Error('Missing property "out" for entry point at index '+N);P.push([we,$e])}else P.push(["",de(ye,"entry point at index "+N)])}else for(let N in T)P.push([N,de(T[N],"entry point",N)]);if(H){let N=Object.create(null),Te=o(H,N,"contents",tt),ye=o(H,N,"resolveDir",$),_e=o(H,N,"sourcefile",$),$e=o(H,N,"loader",$);le(H,N,'in "stdin" object'),_e&&p.push(`--sourcefile=${_e}`),$e&&p.push(`--loader=${$e}`),ye&&(z=ye),typeof Te=="string"?V=J(Te):Te instanceof Uint8Array&&(V=Te)}let je=[];if(h)for(let N of h)N+="",je.push(N);return{entries:P,flags:p,write:G,stdinContents:V,stdinResolveDir:z,absWorkingDir:Q,nodePaths:je,mangleCache:nt(ae)}}function $t(e,r,i,u){let y=[],b=Object.create(null);Le(y,r,b,i,u),rt(y,r,b);let p=o(r,b,"sourcemap",qe),P=o(r,b,"sourcefile",$),d=o(r,b,"loader",$),V=o(r,b,"banner",$),z=o(r,b,"footer",$),U=o(r,b,"mangleCache",pe);return le(r,b,`in ${e}() call`),p&&y.push(`--sourcemap=${p===!0?"external":p}`),P&&y.push(`--sourcefile=${P}`),d&&y.push(`--loader=${d}`),V&&y.push(`--banner=${V}`),z&&y.push(`--footer=${z}`),{flags:y,mangleCache:nt(U)}}function Pt(e){const r={},i={didClose:!1,reason:""};let u={},y=0,b=0,p=new Uint8Array(16*1024),P=0,d=O=>{let v=P+O.length;if(v>p.length){let s=new Uint8Array(v*2);s.set(p),p=s}p.set(O,P),P+=O.length;let h=0;for(;h+4<=P;){let s=me(p,h);if(h+4+s>P)break;h+=4,X(p.subarray(h,h+s)),h+=s}h>0&&(p.copyWithin(0,h,P),P-=h)},V=O=>{i.didClose=!0,O&&(i.reason=": "+(O.message||O));const v="The service was stopped"+i.reason;for(let h in u)u[h](v,null);u={}},z=(O,v,h)=>{if(i.didClose)return h("The service is no longer running"+i.reason,null);let s=y++;u[s]=(c,m)=>{try{h(c,m)}finally{O&&O.unref()}},O&&O.ref(),e.writeToStdin(F({id:s,isRequest:!0,value:v}))},U=(O,v)=>{if(i.didClose)throw new Error("The service is no longer running"+i.reason);e.writeToStdin(F({id:O,isRequest:!1,value:v}))},q=(O,v)=>R(null,null,function*(){try{if(v.command==="ping"){U(O,{});return}if(typeof v.key=="number"){const h=r[v.key];if(!h)return;const s=h[v.command];if(s){yield s(O,v);return}}throw new Error("Invalid command: "+v.command)}catch(h){const s=[Oe(h,e,null,void 0,"")];try{U(O,{errors:s})}catch{}}}),L=!0,X=O=>{if(L){L=!1;let h=String.fromCharCode(...O);if(h!=="0.25.12")throw new Error(`Cannot start service: Host version "0.25.12" does not match binary version ${ee(h)}`);return}let v=M(O);if(v.isRequest)q(v.id,v.value);else{let h=u[v.id];delete u[v.id],v.value.error?h(v.value.error,{}):h(null,v.value)}};return{readFromStdout:d,afterClose:V,service:{buildOrContext:({callName:O,refs:v,options:h,isTTY:s,defaultWD:c,callback:m})=>{let E=0;const j=b++,f={},g={ref(){++E===1&&v&&v.ref()},unref(){--E===0&&(delete r[j],v&&v.unref())}};r[j]=f,g.ref(),Ot(O,j,z,U,g,e,f,h,s,c,(n,a)=>{try{m(n,a)}finally{g.unref()}})},transform:({callName:O,refs:v,input:h,options:s,isTTY:c,fs:m,callback:E})=>{const j=it();let f=g=>{try{if(typeof h!="string"&&!(h instanceof Uint8Array))throw new Error('The input to "transform" must be a string or a Uint8Array');let{flags:n,mangleCache:a}=$t(O,s,c,ke),k={command:"transform",flags:n,inputFS:g!==null,input:g!==null?J(g):typeof h=="string"?J(h):h};a&&(k.mangleCache=a),z(v,k,(_,D)=>{if(_)return E(new Error(_),null);let W=De(D.errors,j),se=De(D.warnings,j),T=1,Q=()=>{if(--T===0){let H={warnings:se,code:D.code,map:D.map,mangleCache:void 0,legalComments:void 0};"legalComments"in D&&(H.legalComments=D?.legalComments),D.mangleCache&&(H.mangleCache=D?.mangleCache),E(null,H)}};if(W.length>0)return E(Ie("Transform failed",W,se),null);D.codeFS&&(T++,m.readFile(D.code,(H,G)=>{H!==null?E(H,null):(D.code=G,Q())})),D.mapFS&&(T++,m.readFile(D.map,(H,G)=>{H!==null?E(H,null):(D.map=G,Q())})),Q()})}catch(n){let a=[];try{Le(a,s,{},c,ke)}catch{}const k=Oe(n,e,j,void 0,"");z(v,{command:"error",flags:a,error:k},()=>{k.detail=j.load(k.detail),E(Ie("Transform failed",[k],[]),null)})}};if((typeof h=="string"||h instanceof Uint8Array)&&h.length>1024*1024){let g=f;f=()=>m.writeFile(h,g)}f(null)},formatMessages:({callName:O,refs:v,messages:h,options:s,callback:c})=>{if(!s)throw new Error(`Missing second argument in ${O}() call`);let m={},E=o(s,m,"kind",$),j=o(s,m,"color",te),f=o(s,m,"terminalWidth",Pe);if(le(s,m,`in ${O}() call`),E===void 0)throw new Error(`Missing "kind" in ${O}() call`);if(E!=="error"&&E!=="warning")throw new Error(`Expected "kind" to be "error" or "warning" in ${O}() call`);let g={command:"format-msgs",messages:Se(h,"messages",null,"",f),isWarning:E==="warning"};j!==void 0&&(g.color=j),f!==void 0&&(g.terminalWidth=f),z(v,g,(n,a)=>{if(n)return c(new Error(n),null);c(null,a.messages)})},analyzeMetafile:({callName:O,refs:v,metafile:h,options:s,callback:c})=>{s===void 0&&(s={});let m={},E=o(s,m,"color",te),j=o(s,m,"verbose",te);le(s,m,`in ${O}() call`);let f={command:"analyze-metafile",metafile:h};E!==void 0&&(f.color=E),j!==void 0&&(f.verbose=j),z(v,f,(g,n)=>{if(g)return c(new Error(g),null);c(null,n.result)})}}}}function Ot(e,r,i,u,y,b,p,P,d,V,z){const U=it(),q=e==="context",L=(I,oe)=>{const C=[];try{Le(C,P,{},d,be)}catch{}const O=Oe(I,b,U,void 0,oe);i(y,{command:"error",flags:C,error:O},()=>{O.detail=U.load(O.detail),z(Ie(q?"Context failed":"Build failed",[O],[]),null)})};let X;if(typeof P=="object"){const I=P.plugins;if(I!==void 0){if(!Array.isArray(I))return L(new Error('"plugins" must be an array'),"");X=I}}if(X&&X.length>0){if(b.isSync)return L(new Error("Cannot use plugins in synchronous API calls"),"");Ct(r,i,u,y,b,p,P,X,U).then(I=>{if(!I.ok)return L(I.error,I.pluginName);try{K(I.requestPlugins,I.runOnEndCallbacks,I.scheduleOnDisposeCallbacks)}catch(oe){L(oe,"")}},I=>L(I,""));return}try{K(null,(I,oe)=>oe([],[]),()=>{})}catch(I){L(I,"")}function K(I,oe,C){const O=b.hasFS,{entries:v,flags:h,write:s,stdinContents:c,stdinResolveDir:m,absWorkingDir:E,nodePaths:j,mangleCache:f}=Tt(e,P,d,be,O);if(s&&!b.hasFS)throw new Error('The "write" option is unavailable in this environment');const g={command:"build",key:r,entries:v,flags:h,write:s,stdinContents:c,stdinResolveDir:m,absWorkingDir:E||V,nodePaths:j,context:q};I&&(g.plugins=I),f&&(g.mangleCache=f);const n=(_,D)=>{const W={errors:De(_.errors,U),warnings:De(_.warnings,U),outputFiles:void 0,metafile:void 0,mangleCache:void 0},se=W.errors.slice(),T=W.warnings.slice();_.outputFiles&&(W.outputFiles=_.outputFiles.map(At)),_.metafile&&(W.metafile=JSON.parse(_.metafile)),_.mangleCache&&(W.mangleCache=_.mangleCache),_.writeToStdout!==void 0&&console.log(ie(_.writeToStdout).replace(/\n$/,"")),oe(W,(Q,H)=>{if(se.length>0||Q.length>0){const G=Ie("Build failed",se.concat(Q),T.concat(H));return D(G,null,Q,H)}D(null,W,Q,H)})};let a,k;q&&(p["on-end"]=(_,D)=>new Promise(W=>{n(D,(se,T,Q,H)=>{const G={errors:Q,warnings:H};k&&k(se,T),a=void 0,k=void 0,u(_,G),W()})})),i(y,g,(_,D)=>{if(_)return z(new Error(_),null);if(!q)return n(D,(T,Q)=>(C(),z(T,Q)));if(D.errors.length>0)return z(Ie("Context failed",D.errors,D.warnings),null);let W=!1;const se={rebuild:()=>(a||(a=new Promise((T,Q)=>{let H;k=(he,ae)=>{H||(H=()=>he?Q(he):T(ae))};const G=()=>{i(y,{command:"rebuild",key:r},(ae,je)=>{ae?Q(new Error(ae)):H?H():G()})};G()})),a),watch:(T={})=>new Promise((Q,H)=>{if(!b.hasFS)throw new Error('Cannot use the "watch" API in this environment');const G={},he=o(T,G,"delay",Pe);le(T,G,"in watch() call");const ae={command:"watch",key:r};he&&(ae.delay=he),i(y,ae,je=>{je?H(new Error(je)):Q(void 0)})}),serve:(T={})=>new Promise((Q,H)=>{if(!b.hasFS)throw new Error('Cannot use the "serve" API in this environment');const G={},he=o(T,G,"port",xt),ae=o(T,G,"host",$),je=o(T,G,"servedir",$),N=o(T,G,"keyfile",$),Te=o(T,G,"certfile",$),ye=o(T,G,"fallback",$),_e=o(T,G,"cors",pe),$e=o(T,G,"onRequest",Qe);le(T,G,"in serve() call");const we={command:"serve",key:r,onRequest:!!$e};if(he!==void 0&&(we.port=he),ae!==void 0&&(we.host=ae),je!==void 0&&(we.servedir=je),N!==void 0&&(we.keyfile=N),Te!==void 0&&(we.certfile=Te),ye!==void 0&&(we.fallback=ye),_e){const Ue={},Ae=o(_e,Ue,"origin",et);le(_e,Ue,'on "cors" object'),Array.isArray(Ae)?we.corsOrigin=Ae:Ae!==void 0&&(we.corsOrigin=[Ae])}i(y,we,(Ue,Ae)=>{if(Ue)return H(new Error(Ue));$e&&(p["serve-request"]=(Yt,Xt)=>{$e(Xt.args),u(Yt,{})}),Q(Ae)})}),cancel:()=>new Promise(T=>{if(W)return T();i(y,{command:"cancel",key:r},()=>{T()})}),dispose:()=>new Promise(T=>{if(W)return T();W=!0,i(y,{command:"dispose",key:r},()=>{T(),C(),y.unref()})})};y.ref(),z(null,se)})}}var Ct=(e,r,i,u,y,b,p,P,d)=>R(null,null,function*(){let V=[],z=[],U={},q={},L=[],X=0,K=0,I=[],oe=!1;P=[...P];for(let v of P){let h={};if(typeof v!="object")throw new Error(`Plugin at index ${K} must be an object`);const s=o(v,h,"name",$);if(typeof s!="string"||s==="")throw new Error(`Plugin at index ${K} is missing a name`);try{let c=o(v,h,"setup",Qe);if(typeof c!="function")throw new Error("Plugin is missing a setup function");le(v,h,`on plugin ${ee(s)}`);let m={name:s,onStart:!1,onEnd:!1,onResolve:[],onLoad:[]};K++;let j=c({initialOptions:p,resolve:(f,g={})=>{if(!oe)throw new Error('Cannot call "resolve" before plugin setup has completed');if(typeof f!="string")throw new Error("The path to resolve must be a string");let n=Object.create(null),a=o(g,n,"pluginName",$),k=o(g,n,"importer",$),_=o(g,n,"namespace",$),D=o(g,n,"resolveDir",$),W=o(g,n,"kind",$),se=o(g,n,"pluginData",xe),T=o(g,n,"with",pe);return le(g,n,"in resolve() call"),new Promise((Q,H)=>{const G={command:"resolve",path:f,key:e,pluginName:s};if(a!=null&&(G.pluginName=a),k!=null&&(G.importer=k),_!=null&&(G.namespace=_),D!=null&&(G.resolveDir=D),W!=null)G.kind=W;else throw new Error('Must specify "kind" when calling "resolve"');se!=null&&(G.pluginData=d.store(se)),T!=null&&(G.with=Dt(T,"with")),r(u,G,(he,ae)=>{he!==null?H(new Error(he)):Q({errors:De(ae.errors,d),warnings:De(ae.warnings,d),path:ae.path,external:ae.external,sideEffects:ae.sideEffects,namespace:ae.namespace,suffix:ae.suffix,pluginData:d.load(ae.pluginData)})})})},onStart(f){let g='This error came from the "onStart" callback registered here:',n=We(new Error(g),y,"onStart");V.push({name:s,callback:f,note:n}),m.onStart=!0},onEnd(f){let g='This error came from the "onEnd" callback registered here:',n=We(new Error(g),y,"onEnd");z.push({name:s,callback:f,note:n}),m.onEnd=!0},onResolve(f,g){let n='This error came from the "onResolve" callback registered here:',a=We(new Error(n),y,"onResolve"),k={},_=o(f,k,"filter",Me),D=o(f,k,"namespace",$);if(le(f,k,`in onResolve() call for plugin ${ee(s)}`),_==null)throw new Error("onResolve() call is missing a filter");let W=X++;U[W]={name:s,callback:g,note:a},m.onResolve.push({id:W,filter:Ve(_),namespace:D||""})},onLoad(f,g){let n='This error came from the "onLoad" callback registered here:',a=We(new Error(n),y,"onLoad"),k={},_=o(f,k,"filter",Me),D=o(f,k,"namespace",$);if(le(f,k,`in onLoad() call for plugin ${ee(s)}`),_==null)throw new Error("onLoad() call is missing a filter");let W=X++;q[W]={name:s,callback:g,note:a},m.onLoad.push({id:W,filter:Ve(_),namespace:D||""})},onDispose(f){L.push(f)},esbuild:y.esbuild});j&&(yield j),I.push(m)}catch(c){return{ok:!1,error:c,pluginName:s}}}b["on-start"]=(v,h)=>R(null,null,function*(){d.clear();let s={errors:[],warnings:[]};yield Promise.all(V.map(c=>R(null,[c],function*({name:m,callback:E,note:j}){try{let f=yield E();if(f!=null){if(typeof f!="object")throw new Error(`Expected onStart() callback in plugin ${ee(m)} to return an object`);let g={},n=o(f,g,"errors",Ee),a=o(f,g,"warnings",Ee);le(f,g,`from onStart() callback in plugin ${ee(m)}`),n!=null&&s.errors.push(...Se(n,"errors",d,m,void 0)),a!=null&&s.warnings.push(...Se(a,"warnings",d,m,void 0))}}catch(f){s.errors.push(Oe(f,y,d,j&&j(),m))}}))),i(v,s)}),b["on-resolve"]=(v,h)=>R(null,null,function*(){let s={},c="",m,E;for(let j of h.ids)try{({name:c,callback:m,note:E}=U[j]);let f=yield m({path:h.path,importer:h.importer,namespace:h.namespace,resolveDir:h.resolveDir,kind:h.kind,pluginData:d.load(h.pluginData),with:h.with});if(f!=null){if(typeof f!="object")throw new Error(`Expected onResolve() callback in plugin ${ee(c)} to return an object`);let g={},n=o(f,g,"pluginName",$),a=o(f,g,"path",$),k=o(f,g,"namespace",$),_=o(f,g,"suffix",$),D=o(f,g,"external",te),W=o(f,g,"sideEffects",te),se=o(f,g,"pluginData",xe),T=o(f,g,"errors",Ee),Q=o(f,g,"warnings",Ee),H=o(f,g,"watchFiles",fe),G=o(f,g,"watchDirs",fe);le(f,g,`from onResolve() callback in plugin ${ee(c)}`),s.id=j,n!=null&&(s.pluginName=n),a!=null&&(s.path=a),k!=null&&(s.namespace=k),_!=null&&(s.suffix=_),D!=null&&(s.external=D),W!=null&&(s.sideEffects=W),se!=null&&(s.pluginData=d.store(se)),T!=null&&(s.errors=Se(T,"errors",d,c,void 0)),Q!=null&&(s.warnings=Se(Q,"warnings",d,c,void 0)),H!=null&&(s.watchFiles=Be(H,"watchFiles")),G!=null&&(s.watchDirs=Be(G,"watchDirs"));break}}catch(f){s={id:j,errors:[Oe(f,y,d,E&&E(),c)]};break}i(v,s)}),b["on-load"]=(v,h)=>R(null,null,function*(){let s={},c="",m,E;for(let j of h.ids)try{({name:c,callback:m,note:E}=q[j]);let f=yield m({path:h.path,namespace:h.namespace,suffix:h.suffix,pluginData:d.load(h.pluginData),with:h.with});if(f!=null){if(typeof f!="object")throw new Error(`Expected onLoad() callback in plugin ${ee(c)} to return an object`);let g={},n=o(f,g,"pluginName",$),a=o(f,g,"contents",tt),k=o(f,g,"resolveDir",$),_=o(f,g,"pluginData",xe),D=o(f,g,"loader",$),W=o(f,g,"errors",Ee),se=o(f,g,"warnings",Ee),T=o(f,g,"watchFiles",fe),Q=o(f,g,"watchDirs",fe);le(f,g,`from onLoad() callback in plugin ${ee(c)}`),s.id=j,n!=null&&(s.pluginName=n),a instanceof Uint8Array?s.contents=a:a!=null&&(s.contents=J(a)),k!=null&&(s.resolveDir=k),_!=null&&(s.pluginData=d.store(_)),D!=null&&(s.loader=D),W!=null&&(s.errors=Se(W,"errors",d,c,void 0)),se!=null&&(s.warnings=Se(se,"warnings",d,c,void 0)),T!=null&&(s.watchFiles=Be(T,"watchFiles")),Q!=null&&(s.watchDirs=Be(Q,"watchDirs"));break}}catch(f){s={id:j,errors:[Oe(f,y,d,E&&E(),c)]};break}i(v,s)});let C=(v,h)=>h([],[]);z.length>0&&(C=(v,h)=>{R(null,null,function*(){const s=[],c=[];for(const{name:m,callback:E,note:j}of z){let f,g;try{const n=yield E(v);if(n!=null){if(typeof n!="object")throw new Error(`Expected onEnd() callback in plugin ${ee(m)} to return an object`);let a={},k=o(n,a,"errors",Ee),_=o(n,a,"warnings",Ee);le(n,a,`from onEnd() callback in plugin ${ee(m)}`),k!=null&&(f=Se(k,"errors",d,m,void 0)),_!=null&&(g=Se(_,"warnings",d,m,void 0))}}catch(n){f=[Oe(n,y,d,j&&j(),m)]}if(f){s.push(...f);try{v.errors.push(...f)}catch{}}if(g){c.push(...g);try{v.warnings.push(...g)}catch{}}}h(s,c)})});let O=()=>{for(const v of L)setTimeout(()=>v(),0)};return oe=!0,{ok:!0,requestPlugins:I,runOnEndCallbacks:C,scheduleOnDisposeCallbacks:O}});function it(){const e=new Map;let r=0;return{clear(){e.clear()},load(i){return e.get(i)},store(i){if(i===void 0)return-1;const u=r++;return e.set(u,i),u}}}function We(e,r,i){let u,y=!1;return()=>{if(y)return u;y=!0;try{let b=(e.stack+"").split(`
`);b.splice(1,1);let p=st(r,b,i);if(p)return u={text:e.message,location:p},u}catch{}}}function Oe(e,r,i,u,y){let b="Internal error",p=null;try{b=(e&&e.message||e)+""}catch{}try{p=st(r,(e.stack+"").split(`
`),"")}catch{}return{id:"",pluginName:y,text:b,location:p,notes:u?[u]:[],detail:i?i.store(e):-1}}function st(e,r,i){let u="    at ";if(e.readFileSync&&!r[0].startsWith(u)&&r[1].startsWith(u))for(let y=1;y<r.length;y++){let b=r[y];if(b.startsWith(u))for(b=b.slice(u.length);;){let p=/^(?:new |async )?\S+ \((.*)\)$/.exec(b);if(p){b=p[1];continue}if(p=/^eval at \S+ \((.*)\)(?:, \S+:\d+:\d+)?$/.exec(b),p){b=p[1];continue}if(p=/^(\S+):(\d+):(\d+)$/.exec(b),p){let P;try{P=e.readFileSync(p[1],"utf8")}catch{break}let d=P.split(/\r\n|\r|\n|\u2028|\u2029/)[+p[2]-1]||"",V=+p[3]-1,z=d.slice(V,V+i.length)===i?i.length:0;return{file:p[1],namespace:"file",line:+p[2],column:J(d.slice(0,V)).length,length:J(d.slice(V,V+z)).length,lineText:d+`
`+r.slice(1).join(`
`),suggestion:""}}break}}return null}function Ie(e,r,i){let u=5;e+=r.length<1?"":` with ${r.length} error${r.length<2?"":"s"}:`+r.slice(0,u+1).map((b,p)=>{if(p===u)return`
...`;if(!b.location)return`
error: ${b.text}`;let{file:P,line:d,column:V}=b.location,z=b.pluginName?`[plugin: ${b.pluginName}] `:"";return`
${P}:${d}:${V}: ERROR: ${z}${b.text}`}).join("");let y=new Error(e);for(const[b,p]of[["errors",r],["warnings",i]])Object.defineProperty(y,b,{configurable:!0,enumerable:!0,get:()=>p,set:P=>Object.defineProperty(y,b,{configurable:!0,enumerable:!0,value:P})});return y}function De(e,r){for(const i of e)i.detail=r.load(i.detail);return e}function ot(e,r,i){if(e==null)return null;let u={},y=o(e,u,"file",$),b=o(e,u,"namespace",$),p=o(e,u,"line",Pe),P=o(e,u,"column",Pe),d=o(e,u,"length",Pe),V=o(e,u,"lineText",$),z=o(e,u,"suggestion",$);if(le(e,u,r),V){const U=V.slice(0,(P&&P>0?P:0)+(d&&d>0?d:0)+(i&&i>0?i:80));!/[\x7F-\uFFFF]/.test(U)&&!/\n/.test(V)&&(V=U)}return{file:y||"",namespace:b||"",line:p||0,column:P||0,length:d||0,lineText:V||"",suggestion:z||""}}function Se(e,r,i,u,y){let b=[],p=0;for(const P of e){let d={},V=o(P,d,"id",$),z=o(P,d,"pluginName",$),U=o(P,d,"text",$),q=o(P,d,"location",Ze),L=o(P,d,"notes",Ee),X=o(P,d,"detail",xe),K=`in element ${p} of "${r}"`;le(P,d,K);let I=[];if(L)for(const oe of L){let C={},O=o(oe,C,"text",$),v=o(oe,C,"location",Ze);le(oe,C,K),I.push({text:O||"",location:ot(v,K,y)})}b.push({id:V||"",pluginName:z||u,text:U||"",location:ot(q,K,y),notes:I,detail:i?i.store(X):-1}),p++}return b}function Be(e,r){const i=[];for(const u of e){if(typeof u!="string")throw new Error(`${ee(r)} must be an array of strings`);i.push(u)}return i}function Dt(e,r){const i=Object.create(null);for(const u in e){const y=e[u];if(typeof y!="string")throw new Error(`key ${ee(u)} in object ${ee(r)} must be a string`);i[u]=y}return i}function At({path:e,contents:r,hash:i}){let u=null;return{path:e,contents:r,hash:i,get text(){const y=this.contents;return(u===null||y!==r)&&(r=y,u=ie(y)),u}}}function Ve(e){let r=e.source;return e.flags&&(r=`(?${e.flags})${r}`),r}var Rt="0.25.12",It=e=>Ne().build(e),Nt=e=>Ne().context(e),Ut=(e,r)=>Ne().transform(e,r),Ft=(e,r)=>Ne().formatMessages(e,r),Mt=(e,r)=>Ne().analyzeMetafile(e,r),Lt=()=>{throw new Error('The "buildSync" API only works in node')},Wt=()=>{throw new Error('The "transformSync" API only works in node')},Bt=()=>{throw new Error('The "formatMessagesSync" API only works in node')},Vt=()=>{throw new Error('The "analyzeMetafileSync" API only works in node')},zt=()=>(ze&&ze(),Promise.resolve()),Ce,ze,Je,Ne=()=>{if(Je)return Je;throw Ce?new Error('You need to wait for the promise returned from "initialize" to be resolved before calling this'):new Error('You need to call "initialize" before calling this')},Jt=e=>{e=jt(e||{});let r=e.wasmURL,i=e.wasmModule,u=e.worker!==!1;if(!r&&!i)throw new Error('Must provide either the "wasmURL" option or the "wasmModule" option');if(Ce)throw new Error('Cannot call "initialize" more than once');return Ce=Gt(r||"",i,u),Ce.catch(()=>{Ce=void 0}),Ce},Gt=(e,r,i)=>R(null,null,function*(){let u,y;const b=new Promise(U=>y=U);if(i){let U=new Blob([`onmessage=((postMessage) => {
      // Copyright 2018 The Go Authors. All rights reserved.
      // Use of this source code is governed by a BSD-style
      // license that can be found in the LICENSE file.
      var __async = (__this, __arguments, generator) => {
        return new Promise((resolve, reject) => {
          var fulfilled = (value) => {
            try {
              step(generator.next(value));
            } catch (e) {
              reject(e);
            }
          };
          var rejected = (value) => {
            try {
              step(generator.throw(value));
            } catch (e) {
              reject(e);
            }
          };
          var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
          step((generator = generator.apply(__this, __arguments)).next());
        });
      };
      let onmessage;
      let globalThis = {};
      for (let o = self; o; o = Object.getPrototypeOf(o))
        for (let k of Object.getOwnPropertyNames(o))
          if (!(k in globalThis))
            Object.defineProperty(globalThis, k, { get: () => self[k] });
      "use strict";
      (() => {
        const enosys = () => {
          const err = new Error("not implemented");
          err.code = "ENOSYS";
          return err;
        };
        if (!globalThis.fs) {
          let outputBuf = "";
          globalThis.fs = {
            constants: { O_WRONLY: -1, O_RDWR: -1, O_CREAT: -1, O_TRUNC: -1, O_APPEND: -1, O_EXCL: -1 },
            // unused
            writeSync(fd, buf) {
              outputBuf += decoder.decode(buf);
              const nl = outputBuf.lastIndexOf("\\n");
              if (nl != -1) {
                console.log(outputBuf.substring(0, nl));
                outputBuf = outputBuf.substring(nl + 1);
              }
              return buf.length;
            },
            write(fd, buf, offset, length, position, callback) {
              if (offset !== 0 || length !== buf.length || position !== null) {
                callback(enosys());
                return;
              }
              const n = this.writeSync(fd, buf);
              callback(null, n);
            },
            chmod(path, mode, callback) {
              callback(enosys());
            },
            chown(path, uid, gid, callback) {
              callback(enosys());
            },
            close(fd, callback) {
              callback(enosys());
            },
            fchmod(fd, mode, callback) {
              callback(enosys());
            },
            fchown(fd, uid, gid, callback) {
              callback(enosys());
            },
            fstat(fd, callback) {
              callback(enosys());
            },
            fsync(fd, callback) {
              callback(null);
            },
            ftruncate(fd, length, callback) {
              callback(enosys());
            },
            lchown(path, uid, gid, callback) {
              callback(enosys());
            },
            link(path, link, callback) {
              callback(enosys());
            },
            lstat(path, callback) {
              callback(enosys());
            },
            mkdir(path, perm, callback) {
              callback(enosys());
            },
            open(path, flags, mode, callback) {
              callback(enosys());
            },
            read(fd, buffer, offset, length, position, callback) {
              callback(enosys());
            },
            readdir(path, callback) {
              callback(enosys());
            },
            readlink(path, callback) {
              callback(enosys());
            },
            rename(from, to, callback) {
              callback(enosys());
            },
            rmdir(path, callback) {
              callback(enosys());
            },
            stat(path, callback) {
              callback(enosys());
            },
            symlink(path, link, callback) {
              callback(enosys());
            },
            truncate(path, length, callback) {
              callback(enosys());
            },
            unlink(path, callback) {
              callback(enosys());
            },
            utimes(path, atime, mtime, callback) {
              callback(enosys());
            }
          };
        }
        if (!globalThis.process) {
          globalThis.process = {
            getuid() {
              return -1;
            },
            getgid() {
              return -1;
            },
            geteuid() {
              return -1;
            },
            getegid() {
              return -1;
            },
            getgroups() {
              throw enosys();
            },
            pid: -1,
            ppid: -1,
            umask() {
              throw enosys();
            },
            cwd() {
              throw enosys();
            },
            chdir() {
              throw enosys();
            }
          };
        }
        if (!globalThis.crypto) {
          throw new Error("globalThis.crypto is not available, polyfill required (crypto.getRandomValues only)");
        }
        if (!globalThis.performance) {
          throw new Error("globalThis.performance is not available, polyfill required (performance.now only)");
        }
        if (!globalThis.TextEncoder) {
          throw new Error("globalThis.TextEncoder is not available, polyfill required");
        }
        if (!globalThis.TextDecoder) {
          throw new Error("globalThis.TextDecoder is not available, polyfill required");
        }
        const encoder = new TextEncoder("utf-8");
        const decoder = new TextDecoder("utf-8");
        globalThis.Go = class {
          constructor() {
            this.argv = ["js"];
            this.env = {};
            this.exit = (code) => {
              if (code !== 0) {
                console.warn("exit code:", code);
              }
            };
            this._exitPromise = new Promise((resolve) => {
              this._resolveExitPromise = resolve;
            });
            this._pendingEvent = null;
            this._scheduledTimeouts = /* @__PURE__ */ new Map();
            this._nextCallbackTimeoutID = 1;
            const setInt64 = (addr, v) => {
              this.mem.setUint32(addr + 0, v, true);
              this.mem.setUint32(addr + 4, Math.floor(v / 4294967296), true);
            };
            const setInt32 = (addr, v) => {
              this.mem.setUint32(addr + 0, v, true);
            };
            const getInt64 = (addr) => {
              const low = this.mem.getUint32(addr + 0, true);
              const high = this.mem.getInt32(addr + 4, true);
              return low + high * 4294967296;
            };
            const loadValue = (addr) => {
              const f = this.mem.getFloat64(addr, true);
              if (f === 0) {
                return void 0;
              }
              if (!isNaN(f)) {
                return f;
              }
              const id = this.mem.getUint32(addr, true);
              return this._values[id];
            };
            const storeValue = (addr, v) => {
              const nanHead = 2146959360;
              if (typeof v === "number" && v !== 0) {
                if (isNaN(v)) {
                  this.mem.setUint32(addr + 4, nanHead, true);
                  this.mem.setUint32(addr, 0, true);
                  return;
                }
                this.mem.setFloat64(addr, v, true);
                return;
              }
              if (v === void 0) {
                this.mem.setFloat64(addr, 0, true);
                return;
              }
              let id = this._ids.get(v);
              if (id === void 0) {
                id = this._idPool.pop();
                if (id === void 0) {
                  id = this._values.length;
                }
                this._values[id] = v;
                this._goRefCounts[id] = 0;
                this._ids.set(v, id);
              }
              this._goRefCounts[id]++;
              let typeFlag = 0;
              switch (typeof v) {
                case "object":
                  if (v !== null) {
                    typeFlag = 1;
                  }
                  break;
                case "string":
                  typeFlag = 2;
                  break;
                case "symbol":
                  typeFlag = 3;
                  break;
                case "function":
                  typeFlag = 4;
                  break;
              }
              this.mem.setUint32(addr + 4, nanHead | typeFlag, true);
              this.mem.setUint32(addr, id, true);
            };
            const loadSlice = (addr) => {
              const array = getInt64(addr + 0);
              const len = getInt64(addr + 8);
              return new Uint8Array(this._inst.exports.mem.buffer, array, len);
            };
            const loadSliceOfValues = (addr) => {
              const array = getInt64(addr + 0);
              const len = getInt64(addr + 8);
              const a = new Array(len);
              for (let i = 0; i < len; i++) {
                a[i] = loadValue(array + i * 8);
              }
              return a;
            };
            const loadString = (addr) => {
              const saddr = getInt64(addr + 0);
              const len = getInt64(addr + 8);
              return decoder.decode(new DataView(this._inst.exports.mem.buffer, saddr, len));
            };
            const timeOrigin = Date.now() - performance.now();
            this.importObject = {
              _gotest: {
                add: (a, b) => a + b
              },
              gojs: {
                // Go's SP does not change as long as no Go code is running. Some operations (e.g. calls, getters and setters)
                // may synchronously trigger a Go event handler. This makes Go code get executed in the middle of the imported
                // function. A goroutine can switch to a new stack if the current stack is too small (see morestack function).
                // This changes the SP, thus we have to update the SP used by the imported function.
                // func wasmExit(code int32)
                "runtime.wasmExit": (sp) => {
                  sp >>>= 0;
                  const code = this.mem.getInt32(sp + 8, true);
                  this.exited = true;
                  delete this._inst;
                  delete this._values;
                  delete this._goRefCounts;
                  delete this._ids;
                  delete this._idPool;
                  this.exit(code);
                },
                // func wasmWrite(fd uintptr, p unsafe.Pointer, n int32)
                "runtime.wasmWrite": (sp) => {
                  sp >>>= 0;
                  const fd = getInt64(sp + 8);
                  const p = getInt64(sp + 16);
                  const n = this.mem.getInt32(sp + 24, true);
                  globalThis.fs.writeSync(fd, new Uint8Array(this._inst.exports.mem.buffer, p, n));
                },
                // func resetMemoryDataView()
                "runtime.resetMemoryDataView": (sp) => {
                  sp >>>= 0;
                  this.mem = new DataView(this._inst.exports.mem.buffer);
                },
                // func nanotime1() int64
                "runtime.nanotime1": (sp) => {
                  sp >>>= 0;
                  setInt64(sp + 8, (timeOrigin + performance.now()) * 1e6);
                },
                // func walltime() (sec int64, nsec int32)
                "runtime.walltime": (sp) => {
                  sp >>>= 0;
                  const msec = (/* @__PURE__ */ new Date()).getTime();
                  setInt64(sp + 8, msec / 1e3);
                  this.mem.setInt32(sp + 16, msec % 1e3 * 1e6, true);
                },
                // func scheduleTimeoutEvent(delay int64) int32
                "runtime.scheduleTimeoutEvent": (sp) => {
                  sp >>>= 0;
                  const id = this._nextCallbackTimeoutID;
                  this._nextCallbackTimeoutID++;
                  this._scheduledTimeouts.set(id, setTimeout(
                    () => {
                      this._resume();
                      while (this._scheduledTimeouts.has(id)) {
                        console.warn("scheduleTimeoutEvent: missed timeout event");
                        this._resume();
                      }
                    },
                    getInt64(sp + 8)
                  ));
                  this.mem.setInt32(sp + 16, id, true);
                },
                // func clearTimeoutEvent(id int32)
                "runtime.clearTimeoutEvent": (sp) => {
                  sp >>>= 0;
                  const id = this.mem.getInt32(sp + 8, true);
                  clearTimeout(this._scheduledTimeouts.get(id));
                  this._scheduledTimeouts.delete(id);
                },
                // func getRandomData(r []byte)
                "runtime.getRandomData": (sp) => {
                  sp >>>= 0;
                  crypto.getRandomValues(loadSlice(sp + 8));
                },
                // func finalizeRef(v ref)
                "syscall/js.finalizeRef": (sp) => {
                  sp >>>= 0;
                  const id = this.mem.getUint32(sp + 8, true);
                  this._goRefCounts[id]--;
                  if (this._goRefCounts[id] === 0) {
                    const v = this._values[id];
                    this._values[id] = null;
                    this._ids.delete(v);
                    this._idPool.push(id);
                  }
                },
                // func stringVal(value string) ref
                "syscall/js.stringVal": (sp) => {
                  sp >>>= 0;
                  storeValue(sp + 24, loadString(sp + 8));
                },
                // func valueGet(v ref, p string) ref
                "syscall/js.valueGet": (sp) => {
                  sp >>>= 0;
                  const result = Reflect.get(loadValue(sp + 8), loadString(sp + 16));
                  sp = this._inst.exports.getsp() >>> 0;
                  storeValue(sp + 32, result);
                },
                // func valueSet(v ref, p string, x ref)
                "syscall/js.valueSet": (sp) => {
                  sp >>>= 0;
                  Reflect.set(loadValue(sp + 8), loadString(sp + 16), loadValue(sp + 32));
                },
                // func valueDelete(v ref, p string)
                "syscall/js.valueDelete": (sp) => {
                  sp >>>= 0;
                  Reflect.deleteProperty(loadValue(sp + 8), loadString(sp + 16));
                },
                // func valueIndex(v ref, i int) ref
                "syscall/js.valueIndex": (sp) => {
                  sp >>>= 0;
                  storeValue(sp + 24, Reflect.get(loadValue(sp + 8), getInt64(sp + 16)));
                },
                // valueSetIndex(v ref, i int, x ref)
                "syscall/js.valueSetIndex": (sp) => {
                  sp >>>= 0;
                  Reflect.set(loadValue(sp + 8), getInt64(sp + 16), loadValue(sp + 24));
                },
                // func valueCall(v ref, m string, args []ref) (ref, bool)
                "syscall/js.valueCall": (sp) => {
                  sp >>>= 0;
                  try {
                    const v = loadValue(sp + 8);
                    const m = Reflect.get(v, loadString(sp + 16));
                    const args = loadSliceOfValues(sp + 32);
                    const result = Reflect.apply(m, v, args);
                    sp = this._inst.exports.getsp() >>> 0;
                    storeValue(sp + 56, result);
                    this.mem.setUint8(sp + 64, 1);
                  } catch (err) {
                    sp = this._inst.exports.getsp() >>> 0;
                    storeValue(sp + 56, err);
                    this.mem.setUint8(sp + 64, 0);
                  }
                },
                // func valueInvoke(v ref, args []ref) (ref, bool)
                "syscall/js.valueInvoke": (sp) => {
                  sp >>>= 0;
                  try {
                    const v = loadValue(sp + 8);
                    const args = loadSliceOfValues(sp + 16);
                    const result = Reflect.apply(v, void 0, args);
                    sp = this._inst.exports.getsp() >>> 0;
                    storeValue(sp + 40, result);
                    this.mem.setUint8(sp + 48, 1);
                  } catch (err) {
                    sp = this._inst.exports.getsp() >>> 0;
                    storeValue(sp + 40, err);
                    this.mem.setUint8(sp + 48, 0);
                  }
                },
                // func valueNew(v ref, args []ref) (ref, bool)
                "syscall/js.valueNew": (sp) => {
                  sp >>>= 0;
                  try {
                    const v = loadValue(sp + 8);
                    const args = loadSliceOfValues(sp + 16);
                    const result = Reflect.construct(v, args);
                    sp = this._inst.exports.getsp() >>> 0;
                    storeValue(sp + 40, result);
                    this.mem.setUint8(sp + 48, 1);
                  } catch (err) {
                    sp = this._inst.exports.getsp() >>> 0;
                    storeValue(sp + 40, err);
                    this.mem.setUint8(sp + 48, 0);
                  }
                },
                // func valueLength(v ref) int
                "syscall/js.valueLength": (sp) => {
                  sp >>>= 0;
                  setInt64(sp + 16, parseInt(loadValue(sp + 8).length));
                },
                // valuePrepareString(v ref) (ref, int)
                "syscall/js.valuePrepareString": (sp) => {
                  sp >>>= 0;
                  const str = encoder.encode(String(loadValue(sp + 8)));
                  storeValue(sp + 16, str);
                  setInt64(sp + 24, str.length);
                },
                // valueLoadString(v ref, b []byte)
                "syscall/js.valueLoadString": (sp) => {
                  sp >>>= 0;
                  const str = loadValue(sp + 8);
                  loadSlice(sp + 16).set(str);
                },
                // func valueInstanceOf(v ref, t ref) bool
                "syscall/js.valueInstanceOf": (sp) => {
                  sp >>>= 0;
                  this.mem.setUint8(sp + 24, loadValue(sp + 8) instanceof loadValue(sp + 16) ? 1 : 0);
                },
                // func copyBytesToGo(dst []byte, src ref) (int, bool)
                "syscall/js.copyBytesToGo": (sp) => {
                  sp >>>= 0;
                  const dst = loadSlice(sp + 8);
                  const src = loadValue(sp + 32);
                  if (!(src instanceof Uint8Array || src instanceof Uint8ClampedArray)) {
                    this.mem.setUint8(sp + 48, 0);
                    return;
                  }
                  const toCopy = src.subarray(0, dst.length);
                  dst.set(toCopy);
                  setInt64(sp + 40, toCopy.length);
                  this.mem.setUint8(sp + 48, 1);
                },
                // func copyBytesToJS(dst ref, src []byte) (int, bool)
                "syscall/js.copyBytesToJS": (sp) => {
                  sp >>>= 0;
                  const dst = loadValue(sp + 8);
                  const src = loadSlice(sp + 16);
                  if (!(dst instanceof Uint8Array || dst instanceof Uint8ClampedArray)) {
                    this.mem.setUint8(sp + 48, 0);
                    return;
                  }
                  const toCopy = src.subarray(0, dst.length);
                  dst.set(toCopy);
                  setInt64(sp + 40, toCopy.length);
                  this.mem.setUint8(sp + 48, 1);
                },
                "debug": (value) => {
                  console.log(value);
                }
              }
            };
          }
          run(instance) {
            return __async(this, null, function* () {
              if (!(instance instanceof WebAssembly.Instance)) {
                throw new Error("Go.run: WebAssembly.Instance expected");
              }
              this._inst = instance;
              this.mem = new DataView(this._inst.exports.mem.buffer);
              this._values = [
                // JS values that Go currently has references to, indexed by reference id
                NaN,
                0,
                null,
                true,
                false,
                globalThis,
                this
              ];
              this._goRefCounts = new Array(this._values.length).fill(Infinity);
              this._ids = /* @__PURE__ */ new Map([
                // mapping from JS values to reference ids
                [0, 1],
                [null, 2],
                [true, 3],
                [false, 4],
                [globalThis, 5],
                [this, 6]
              ]);
              this._idPool = [];
              this.exited = false;
              let offset = 4096;
              const strPtr = (str) => {
                const ptr = offset;
                const bytes = encoder.encode(str + "\\0");
                new Uint8Array(this.mem.buffer, offset, bytes.length).set(bytes);
                offset += bytes.length;
                if (offset % 8 !== 0) {
                  offset += 8 - offset % 8;
                }
                return ptr;
              };
              const argc = this.argv.length;
              const argvPtrs = [];
              this.argv.forEach((arg) => {
                argvPtrs.push(strPtr(arg));
              });
              argvPtrs.push(0);
              const keys = Object.keys(this.env).sort();
              keys.forEach((key) => {
                argvPtrs.push(strPtr(\`\${key}=\${this.env[key]}\`));
              });
              argvPtrs.push(0);
              const argv = offset;
              argvPtrs.forEach((ptr) => {
                this.mem.setUint32(offset, ptr, true);
                this.mem.setUint32(offset + 4, 0, true);
                offset += 8;
              });
              const wasmMinDataAddr = 4096 + 8192;
              if (offset >= wasmMinDataAddr) {
                throw new Error("total length of command line and environment variables exceeds limit");
              }
              this._inst.exports.run(argc, argv);
              if (this.exited) {
                this._resolveExitPromise();
              }
              yield this._exitPromise;
            });
          }
          _resume() {
            if (this.exited) {
              throw new Error("Go program has already exited");
            }
            this._inst.exports.resume();
            if (this.exited) {
              this._resolveExitPromise();
            }
          }
          _makeFuncWrapper(id) {
            const go = this;
            return function() {
              const event = { id, this: this, args: arguments };
              go._pendingEvent = event;
              go._resume();
              return event.result;
            };
          }
        };
      })();
      onmessage = ({ data: wasm }) => {
        let decoder = new TextDecoder();
        let fs = globalThis.fs;
        let stderr = "";
        fs.writeSync = (fd, buffer) => {
          if (fd === 1) {
            postMessage(buffer);
          } else if (fd === 2) {
            stderr += decoder.decode(buffer);
            let parts = stderr.split("\\n");
            if (parts.length > 1) console.log(parts.slice(0, -1).join("\\n"));
            stderr = parts[parts.length - 1];
          } else {
            throw new Error("Bad write");
          }
          return buffer.length;
        };
        let stdin = [];
        let resumeStdin;
        let stdinPos = 0;
        onmessage = ({ data }) => {
          if (data.length > 0) {
            stdin.push(data);
            if (resumeStdin) resumeStdin();
          }
          return go;
        };
        fs.read = (fd, buffer, offset, length, position, callback) => {
          if (fd !== 0 || offset !== 0 || length !== buffer.length || position !== null) {
            throw new Error("Bad read");
          }
          if (stdin.length === 0) {
            resumeStdin = () => fs.read(fd, buffer, offset, length, position, callback);
            return;
          }
          let first = stdin[0];
          let count = Math.max(0, Math.min(length, first.length - stdinPos));
          buffer.set(first.subarray(stdinPos, stdinPos + count), offset);
          stdinPos += count;
          if (stdinPos === first.length) {
            stdin.shift();
            stdinPos = 0;
          }
          callback(null, count);
        };
        let go = new globalThis.Go();
        go.argv = ["", \`--service=\${"0.25.12"}\`];
        tryToInstantiateModule(wasm, go).then(
          (instance) => {
            postMessage(null);
            go.run(instance);
          },
          (error) => {
            postMessage(error);
          }
        );
        return go;
      };
      function tryToInstantiateModule(wasm, go) {
        return __async(this, null, function* () {
          if (wasm instanceof WebAssembly.Module) {
            return WebAssembly.instantiate(wasm, go.importObject);
          }
          const res = yield fetch(wasm);
          if (!res.ok) throw new Error(\`Failed to download \${JSON.stringify(wasm)}\`);
          if ("instantiateStreaming" in WebAssembly && /^application\\/wasm($|;)/i.test(res.headers.get("Content-Type") || "")) {
            const result2 = yield WebAssembly.instantiateStreaming(res, go.importObject);
            return result2.instance;
          }
          const bytes = yield res.arrayBuffer();
          const result = yield WebAssembly.instantiate(bytes, go.importObject);
          return result.instance;
        });
      }
      return (m) => onmessage(m);
    })(postMessage)`],{type:"text/javascript"});u=new Worker(URL.createObjectURL(U))}else{let U=(L=>{var X=(C,O,v)=>new Promise((h,s)=>{var c=j=>{try{E(v.next(j))}catch(f){s(f)}},m=j=>{try{E(v.throw(j))}catch(f){s(f)}},E=j=>j.done?h(j.value):Promise.resolve(j.value).then(c,m);E((v=v.apply(C,O)).next())});let K,I={};for(let C=self;C;C=Object.getPrototypeOf(C))for(let O of Object.getOwnPropertyNames(C))O in I||Object.defineProperty(I,O,{get:()=>self[O]});(()=>{const C=()=>{const h=new Error("not implemented");return h.code="ENOSYS",h};if(!I.fs){let h="";I.fs={constants:{O_WRONLY:-1,O_RDWR:-1,O_CREAT:-1,O_TRUNC:-1,O_APPEND:-1,O_EXCL:-1},writeSync(s,c){h+=v.decode(c);const m=h.lastIndexOf(`
`);return m!=-1&&(console.log(h.substring(0,m)),h=h.substring(m+1)),c.length},write(s,c,m,E,j,f){if(m!==0||E!==c.length||j!==null){f(C());return}const g=this.writeSync(s,c);f(null,g)},chmod(s,c,m){m(C())},chown(s,c,m,E){E(C())},close(s,c){c(C())},fchmod(s,c,m){m(C())},fchown(s,c,m,E){E(C())},fstat(s,c){c(C())},fsync(s,c){c(null)},ftruncate(s,c,m){m(C())},lchown(s,c,m,E){E(C())},link(s,c,m){m(C())},lstat(s,c){c(C())},mkdir(s,c,m){m(C())},open(s,c,m,E){E(C())},read(s,c,m,E,j,f){f(C())},readdir(s,c){c(C())},readlink(s,c){c(C())},rename(s,c,m){m(C())},rmdir(s,c){c(C())},stat(s,c){c(C())},symlink(s,c,m){m(C())},truncate(s,c,m){m(C())},unlink(s,c){c(C())},utimes(s,c,m,E){E(C())}}}if(I.process||(I.process={getuid(){return-1},getgid(){return-1},geteuid(){return-1},getegid(){return-1},getgroups(){throw C()},pid:-1,ppid:-1,umask(){throw C()},cwd(){throw C()},chdir(){throw C()}}),!I.crypto)throw new Error("globalThis.crypto is not available, polyfill required (crypto.getRandomValues only)");if(!I.performance)throw new Error("globalThis.performance is not available, polyfill required (performance.now only)");if(!I.TextEncoder)throw new Error("globalThis.TextEncoder is not available, polyfill required");if(!I.TextDecoder)throw new Error("globalThis.TextDecoder is not available, polyfill required");const O=new TextEncoder("utf-8"),v=new TextDecoder("utf-8");I.Go=class{constructor(){this.argv=["js"],this.env={},this.exit=n=>{n!==0&&console.warn("exit code:",n)},this._exitPromise=new Promise(n=>{this._resolveExitPromise=n}),this._pendingEvent=null,this._scheduledTimeouts=new Map,this._nextCallbackTimeoutID=1;const h=(n,a)=>{this.mem.setUint32(n+0,a,!0),this.mem.setUint32(n+4,Math.floor(a/4294967296),!0)},s=n=>{const a=this.mem.getUint32(n+0,!0),k=this.mem.getInt32(n+4,!0);return a+k*4294967296},c=n=>{const a=this.mem.getFloat64(n,!0);if(a===0)return;if(!isNaN(a))return a;const k=this.mem.getUint32(n,!0);return this._values[k]},m=(n,a)=>{if(typeof a=="number"&&a!==0){if(isNaN(a)){this.mem.setUint32(n+4,2146959360,!0),this.mem.setUint32(n,0,!0);return}this.mem.setFloat64(n,a,!0);return}if(a===void 0){this.mem.setFloat64(n,0,!0);return}let _=this._ids.get(a);_===void 0&&(_=this._idPool.pop(),_===void 0&&(_=this._values.length),this._values[_]=a,this._goRefCounts[_]=0,this._ids.set(a,_)),this._goRefCounts[_]++;let D=0;switch(typeof a){case"object":a!==null&&(D=1);break;case"string":D=2;break;case"symbol":D=3;break;case"function":D=4;break}this.mem.setUint32(n+4,2146959360|D,!0),this.mem.setUint32(n,_,!0)},E=n=>{const a=s(n+0),k=s(n+8);return new Uint8Array(this._inst.exports.mem.buffer,a,k)},j=n=>{const a=s(n+0),k=s(n+8),_=new Array(k);for(let D=0;D<k;D++)_[D]=c(a+D*8);return _},f=n=>{const a=s(n+0),k=s(n+8);return v.decode(new DataView(this._inst.exports.mem.buffer,a,k))},g=Date.now()-performance.now();this.importObject={_gotest:{add:(n,a)=>n+a},gojs:{"runtime.wasmExit":n=>{n>>>=0;const a=this.mem.getInt32(n+8,!0);this.exited=!0,delete this._inst,delete this._values,delete this._goRefCounts,delete this._ids,delete this._idPool,this.exit(a)},"runtime.wasmWrite":n=>{n>>>=0;const a=s(n+8),k=s(n+16),_=this.mem.getInt32(n+24,!0);I.fs.writeSync(a,new Uint8Array(this._inst.exports.mem.buffer,k,_))},"runtime.resetMemoryDataView":n=>{this.mem=new DataView(this._inst.exports.mem.buffer)},"runtime.nanotime1":n=>{n>>>=0,h(n+8,(g+performance.now())*1e6)},"runtime.walltime":n=>{n>>>=0;const a=new Date().getTime();h(n+8,a/1e3),this.mem.setInt32(n+16,a%1e3*1e6,!0)},"runtime.scheduleTimeoutEvent":n=>{n>>>=0;const a=this._nextCallbackTimeoutID;this._nextCallbackTimeoutID++,this._scheduledTimeouts.set(a,setTimeout(()=>{for(this._resume();this._scheduledTimeouts.has(a);)console.warn("scheduleTimeoutEvent: missed timeout event"),this._resume()},s(n+8))),this.mem.setInt32(n+16,a,!0)},"runtime.clearTimeoutEvent":n=>{n>>>=0;const a=this.mem.getInt32(n+8,!0);clearTimeout(this._scheduledTimeouts.get(a)),this._scheduledTimeouts.delete(a)},"runtime.getRandomData":n=>{n>>>=0,crypto.getRandomValues(E(n+8))},"syscall/js.finalizeRef":n=>{n>>>=0;const a=this.mem.getUint32(n+8,!0);if(this._goRefCounts[a]--,this._goRefCounts[a]===0){const k=this._values[a];this._values[a]=null,this._ids.delete(k),this._idPool.push(a)}},"syscall/js.stringVal":n=>{n>>>=0,m(n+24,f(n+8))},"syscall/js.valueGet":n=>{n>>>=0;const a=Reflect.get(c(n+8),f(n+16));n=this._inst.exports.getsp()>>>0,m(n+32,a)},"syscall/js.valueSet":n=>{n>>>=0,Reflect.set(c(n+8),f(n+16),c(n+32))},"syscall/js.valueDelete":n=>{n>>>=0,Reflect.deleteProperty(c(n+8),f(n+16))},"syscall/js.valueIndex":n=>{n>>>=0,m(n+24,Reflect.get(c(n+8),s(n+16)))},"syscall/js.valueSetIndex":n=>{n>>>=0,Reflect.set(c(n+8),s(n+16),c(n+24))},"syscall/js.valueCall":n=>{n>>>=0;try{const a=c(n+8),k=Reflect.get(a,f(n+16)),_=j(n+32),D=Reflect.apply(k,a,_);n=this._inst.exports.getsp()>>>0,m(n+56,D),this.mem.setUint8(n+64,1)}catch(a){n=this._inst.exports.getsp()>>>0,m(n+56,a),this.mem.setUint8(n+64,0)}},"syscall/js.valueInvoke":n=>{n>>>=0;try{const a=c(n+8),k=j(n+16),_=Reflect.apply(a,void 0,k);n=this._inst.exports.getsp()>>>0,m(n+40,_),this.mem.setUint8(n+48,1)}catch(a){n=this._inst.exports.getsp()>>>0,m(n+40,a),this.mem.setUint8(n+48,0)}},"syscall/js.valueNew":n=>{n>>>=0;try{const a=c(n+8),k=j(n+16),_=Reflect.construct(a,k);n=this._inst.exports.getsp()>>>0,m(n+40,_),this.mem.setUint8(n+48,1)}catch(a){n=this._inst.exports.getsp()>>>0,m(n+40,a),this.mem.setUint8(n+48,0)}},"syscall/js.valueLength":n=>{n>>>=0,h(n+16,parseInt(c(n+8).length))},"syscall/js.valuePrepareString":n=>{n>>>=0;const a=O.encode(String(c(n+8)));m(n+16,a),h(n+24,a.length)},"syscall/js.valueLoadString":n=>{n>>>=0;const a=c(n+8);E(n+16).set(a)},"syscall/js.valueInstanceOf":n=>{n>>>=0,this.mem.setUint8(n+24,c(n+8)instanceof c(n+16)?1:0)},"syscall/js.copyBytesToGo":n=>{n>>>=0;const a=E(n+8),k=c(n+32);if(!(k instanceof Uint8Array||k instanceof Uint8ClampedArray)){this.mem.setUint8(n+48,0);return}const _=k.subarray(0,a.length);a.set(_),h(n+40,_.length),this.mem.setUint8(n+48,1)},"syscall/js.copyBytesToJS":n=>{n>>>=0;const a=c(n+8),k=E(n+16);if(!(a instanceof Uint8Array||a instanceof Uint8ClampedArray)){this.mem.setUint8(n+48,0);return}const _=k.subarray(0,a.length);a.set(_),h(n+40,_.length),this.mem.setUint8(n+48,1)},debug:n=>{console.log(n)}}}}run(h){return X(this,null,function*(){if(!(h instanceof WebAssembly.Instance))throw new Error("Go.run: WebAssembly.Instance expected");this._inst=h,this.mem=new DataView(this._inst.exports.mem.buffer),this._values=[NaN,0,null,!0,!1,I,this],this._goRefCounts=new Array(this._values.length).fill(1/0),this._ids=new Map([[0,1],[null,2],[!0,3],[!1,4],[I,5],[this,6]]),this._idPool=[],this.exited=!1;let s=4096;const c=n=>{const a=s,k=O.encode(n+"\0");return new Uint8Array(this.mem.buffer,s,k.length).set(k),s+=k.length,s%8!==0&&(s+=8-s%8),a},m=this.argv.length,E=[];this.argv.forEach(n=>{E.push(c(n))}),E.push(0),Object.keys(this.env).sort().forEach(n=>{E.push(c(`${n}=${this.env[n]}`))}),E.push(0);const f=s;if(E.forEach(n=>{this.mem.setUint32(s,n,!0),this.mem.setUint32(s+4,0,!0),s+=8}),s>=12288)throw new Error("total length of command line and environment variables exceeds limit");this._inst.exports.run(m,f),this.exited&&this._resolveExitPromise(),yield this._exitPromise})}_resume(){if(this.exited)throw new Error("Go program has already exited");this._inst.exports.resume(),this.exited&&this._resolveExitPromise()}_makeFuncWrapper(h){const s=this;return function(){const c={id:h,this:this,args:arguments};return s._pendingEvent=c,s._resume(),c.result}}}})(),K=({data:C})=>{let O=new TextDecoder,v=I.fs,h="";v.writeSync=(j,f)=>{if(j===1)L(f);else if(j===2){h+=O.decode(f);let g=h.split(`
`);g.length>1&&console.log(g.slice(0,-1).join(`
`)),h=g[g.length-1]}else throw new Error("Bad write");return f.length};let s=[],c,m=0;K=({data:j})=>(j.length>0&&(s.push(j),c&&c()),E),v.read=(j,f,g,n,a,k)=>{if(j!==0||g!==0||n!==f.length||a!==null)throw new Error("Bad read");if(s.length===0){c=()=>v.read(j,f,g,n,a,k);return}let _=s[0],D=Math.max(0,Math.min(n,_.length-m));f.set(_.subarray(m,m+D),g),m+=D,m===_.length&&(s.shift(),m=0),k(null,D)};let E=new I.Go;return E.argv=["","--service=0.25.12"],oe(C,E).then(j=>{L(null),E.run(j)},j=>{L(j)}),E};function oe(C,O){return X(this,null,function*(){if(C instanceof WebAssembly.Module)return WebAssembly.instantiate(C,O.importObject);const v=yield fetch(C);if(!v.ok)throw new Error(`Failed to download ${JSON.stringify(C)}`);if("instantiateStreaming"in WebAssembly&&/^application\/wasm($|;)/i.test(v.headers.get("Content-Type")||""))return(yield WebAssembly.instantiateStreaming(v,O.importObject)).instance;const h=yield v.arrayBuffer();return(yield WebAssembly.instantiate(h,O.importObject)).instance})}return C=>K(C)})(L=>u.onmessage({data:L})),q;u={onmessage:null,postMessage:L=>setTimeout(()=>{try{q=U({data:L})}catch(X){y(X)}}),terminate(){if(q)for(let L of q._scheduledTimeouts.values())clearTimeout(L)}}}let p,P;const d=new Promise((U,q)=>{p=U,P=q});u.onmessage=({data:U})=>{u.onmessage=({data:q})=>V(q),U?P(U):p()},u.postMessage(r||new URL(e,location.href).toString());let{readFromStdout:V,service:z}=Pt({writeToStdin(U){u.postMessage(U)},isSync:!1,hasFS:!1,esbuild:re});yield d,ze=()=>{u.terminate(),Ce=void 0,ze=void 0,Je=void 0},Je={build:U=>new Promise((q,L)=>{b.then(L),z.buildOrContext({callName:"build",refs:null,options:U,isTTY:!1,defaultWD:"/",callback:(X,K)=>X?L(X):q(K)})}),context:U=>new Promise((q,L)=>{b.then(L),z.buildOrContext({callName:"context",refs:null,options:U,isTTY:!1,defaultWD:"/",callback:(X,K)=>X?L(X):q(K)})}),transform:(U,q)=>new Promise((L,X)=>{b.then(X),z.transform({callName:"transform",refs:null,input:U,options:q||{},isTTY:!1,fs:{readFile(K,I){I(new Error("Internal error"),null)},writeFile(K,I){I(null)}},callback:(K,I)=>K?X(K):L(I)})}),formatMessages:(U,q)=>new Promise((L,X)=>{b.then(X),z.formatMessages({callName:"formatMessages",refs:null,messages:U,options:q,callback:(K,I)=>K?X(K):L(I)})}),analyzeMetafile:(U,q)=>new Promise((L,X)=>{b.then(X),z.analyzeMetafile({callName:"analyzeMetafile",refs:null,metafile:typeof U=="string"?U:JSON.stringify(U),options:q,callback:(K,I)=>K?X(K):L(I)})})}}),Ht=re})(t)})(He)),He.exports}var Ge=nn();const rn=new URL("esbuild.wasm.gz.b64-BlufU7PE.txt",import.meta.url).href,ct=new Map;function Ye(t){return t.default??t}function sn(t){let l=ct.get(t);return l==null&&(l=(async()=>{const[w,A,x]=await Promise.all([Re(()=>import("./index-DApFg4sc.js").then(S=>S.i),__vite__mapDeps([0,1,2,3,4,5,6]),import.meta.url),t==="v2"?Re(()=>import("./index-D1HUoSrK.js").then(S=>S.i),__vite__mapDeps([7,1,2,8,9,4,5,10]),import.meta.url):Re(()=>import("./index-BWZ1Ly4_.js").then(S=>S.i),__vite__mapDeps([11,1,2,9,4,5,10]),import.meta.url),Re(()=>import("./index-Kn2e8r5R.js").then(S=>S.i),__vite__mapDeps([12,1,2,9,3,4,5,6]),import.meta.url)]);return{babel:Ye(w),compiler:Ye(A),presetTypeScript:Ye(x)}})(),ct.set(t,l)),l}function on(t){return/\.[mc]?tsx?$/i.test(t)}function ln(t){return/\.tsx$/i.test(t)}function an(t,l){return t==="v2"?{moduleName:"@solidjs/web",generate:"dom",hydratable:!1,dev:l}:{generate:"dom",hydratable:!1,dev:l}}function cn(t,l){const w=JSON.stringify(l),A=new TextEncoder().encode(w);let x="";for(let S=0;S<A.length;S+=32768)x+=String.fromCharCode(...A.subarray(S,S+32768));return`${t}
//# sourceMappingURL=data:application/json;charset=utf-8;base64,${btoa(x)}
`}function un(t,l){const w=t?.loc;if(w?.line!=null)return{file:l,line:w.line,column:Math.max(0,w.column??0)}}function fn(t,l,w){const A=t instanceof Error?t.message:String(t);return{text:`[solid:${l}] ${dn(A,w)}`,location:un(t,w)}}function dn(t,l){const w=t.indexOf(": ");if(w<=0)return t;const A=t.slice(0,w).replaceAll("\\","/"),x=l.replaceAll("\\","/");return A.endsWith(x)||A.endsWith(`/${x}`)?t.slice(w+2):t}async function hn(t,l){const{babel:w,compiler:A,presetTypeScript:x}=await sn(l.version),S=on(l.filename),Y=ln(l.filename),Z=l.dev??!1,ne=an(l.version,Z),R=l.version==="v1"?[[A,ne]]:[],re=l.version==="v2"?[[A,ne]]:[],F=w.transformSync(t,{filename:l.filename,sourceFileName:l.filename,cwd:"/",root:"/",configFile:!1,babelrc:!1,browserslistConfigFile:!1,presets:[...R,...S?[[x,{isTSX:Y,allExtensions:!0}]]:[]],plugins:re,sourceMaps:l.sourcemap===!0,ast:!1,code:!0,comments:!0});if(F==null||F.code==null)throw new Error("The Solid compiler produced no output.");const M=F.map;return M!=null&&(M.sources=[l.filename],M.sourcesContent=[t],M.file=l.filename),{code:F.code,map:M??void 0}}function pt(t){return!t.startsWith("node_modules/")&&!t.startsWith("__")}function mn(t){return{name:`dataverse-ide-solid-${t.version}`,setup(l){l.onLoad({filter:/\.[jt]sx$/,namespace:"workspace"},async w=>{const A=w.path.replaceAll("\\","/");if(!pt(A))return;let x=await t.readText(A);if(x!=null){if(t.beforeTransform!=null){const S=await t.beforeTransform(x,A);if(S!=null&&(x=S.code,S.errors!=null&&S.errors.length>0))return{errors:S.errors.slice(0,8).map(Y=>({text:Y,location:{file:A,line:1,column:0}}))}}try{const S=await hn(x,{version:t.version,filename:A,sourcemap:t.sourcemap,dev:t.dev});return{contents:S.map!=null?cn(S.code,S.map):S.code,loader:"js"}}catch(S){return{errors:[fn(S,t.version,A)]}}}})}}}let Xe,ut;function Rn(t,l){const w=new Map,A=new Map,x={fileReads:0,fileReadCacheHits:0,directoryReads:0,directoryReadCacheHits:0},S=Y=>t.Uri.joinPath(l,...Y.split("/").filter(Z=>Z.length>0));return{stats:x,readText(Y){const Z=ce(Y);if(Z.length===0)return Promise.resolve(void 0);const ne=w.get(Z);if(ne!=null)return x.fileReadCacheHits++,ne;x.fileReads++;const R=(async()=>{try{const re=await t.workspace.fs.readFile(S(Z));return new TextDecoder().decode(re)}catch{return}})();return w.set(Z,R),R},readDir(Y){const Z=ce(Y),ne=A.get(Z);if(ne!=null)return x.directoryReadCacheHits++,ne;x.directoryReads++;const R=(async()=>{try{const re=await t.workspace.fs.readDirectory(S(Z)),F=new Map;for(const[M,B]of re)F.set(M,B===t.FileType.Directory?"directory":"file");return F}catch{return}})();return A.set(Z,R),R}}}function ft(t,l){if(l==null||Object.keys(l).length===0)return t;const w=new Map,A=new Map;for(const[x,S]of Object.entries(l)){const Y=ce(x);w.set(Y,S);const{directory:Z,name:ne}=vt(Y),R=A.get(Z)??new Set;R.add(ne),A.set(Z,R)}return{stats:t.stats,async readText(x){const S=ce(x),Y=w.get(S);return Y??t.readText(S)},async readDir(x){if(t.readDir==null)return;const S=ce(x),Y=A.get(S),Z=await t.readDir(S);if(Y==null)return Z;const ne=new Map(Z??[]);for(const R of Y)ne.set(R,"file");return ne}}}async function pn(){const t=await fetch(rn);if(!t.ok)throw new Error(`Failed to load esbuild.wasm (${t.status} ${t.statusText}).`);const l=Uint8Array.from(atob((await t.text()).trim()),A=>A.charCodeAt(0)),w=new Blob([l]).stream().pipeThrough(new DecompressionStream("gzip"));return new Response(w).arrayBuffer()}async function Ke(){Xe==null&&(Xe=(async()=>{const t=await pn(),l=await WebAssembly.compile(t);await Ge.initialize({wasmModule:l,worker:!1})})()),await Xe}function gt(){return ut??=Promise.all([Re(()=>import("./index-CzIKh0v6.js"),__vite__mapDeps([13,14,15,1,2,8,16,6]),import.meta.url),Re(()=>import("./typescript-md01NZxD.js").then(t=>t.t),__vite__mapDeps([15,1,2,8,16,6]),import.meta.url)]).then(([t,l])=>{const w=t.createExpressionTransformCallbacks(l);return{toJsx:t.createJsxTransformer({tags:["html","jsx"],ts:l,callbacks:w}),toTagged:t.createTaggedTransformer({tag:"html",ts:l,callbacks:w,registeredComponents:[]})}}),ut}function yt(t){return t.endsWith(".css")?"css":t.endsWith(".json")?"json":t.endsWith(".ts")||t.endsWith(".mts")||t.endsWith(".cts")?"ts":t.endsWith(".tsx")?"tsx":t.endsWith(".jsx")?"jsx":"js"}function gn(t){return t==="ts"||t==="tsx"||t==="js"||t==="jsx"}function yn(t,l){return t==="ts"?"tsx":t==="js"?"jsx":t}function wt(t,l,w){const A=l==="toJsx"?w.toJsx(t):w.toTagged(t);return{code:A.code,errors:(A.errors??[]).map(x=>String(x))}}function wn(t,l){return l.some(w=>t===w||t.startsWith(`${w}/`))}function vn(t){const l=ce(t).split("/").filter(w=>w.length>0);return l.pop(),l.join("/")}function vt(t){const l=ce(t),w=l.lastIndexOf("/");return w===-1?{directory:"",name:l}:{directory:l.slice(0,w),name:l.slice(w+1)}}function dt(t,l){return t.length>0?`${t}/${l}`:l}async function ht(t,l){if(t.readDir!=null)try{return await t.readDir(l)}catch{return}}async function bt(t,l,w,A){const x=ce(l);if(x.length===0)return;const{directory:S,name:Y}=vt(x),Z=await ht(t,S);if(Z!=null){const ne=Z.get(Y);if(ne==="file")return x;if(!lt(x))for(const R of w){if(R.length===0)continue;const re=`${Y}${R}`;if(Z.get(re)==="file")return dt(S,re)}if(ne==="directory"){const R=await ht(t,x);if(R!=null){for(const re of A){const F=re.replace(/^\/+/,"");if(R.get(F)==="file")return dt(x,F)}return}}else if(ne==null)return}if(await t.readText(x)!=null)return x;if(!lt(x)){for(const ne of w){const R=`${x}${ne}`;if(await t.readText(R)!=null)return R}for(const ne of A){const R=`${x}${ne}`;if(await t.readText(R)!=null)return R}}}function bn(t,l){if(l.startsWith("/"))return ce(l);const w=vn(t);return ce(w.length>0?`${w}/${l}`:l)}function xn(t){return`${t}/package.json`}function Fe(t){if(typeof t=="string")return t;if(Array.isArray(t)){for(const l of t){const w=Fe(l);if(w!=null)return w}return}if(!(typeof t!="object"||t==null))for(const l of Object.keys(t)){if(!qt.has(l))continue;const w=Fe(t[l]);if(w!=null)return w}}function kn(t,l){if(l.startsWith("./"))return ce(`${t}/${l}`)}function _n(t,l=()=>0){const w=new Map;let A=l();async function x(F){const M=xn(F);A!==l()&&(w.clear(),A=l());const B=w.get(M);if(B!=null)return B;const J=t().readText(M).then(ie=>{if(ie!=null)return Zt(ie)});return w.set(M,J),J}async function S(F){return bt(t(),F,en,mt)}async function Y(F,M){const B=kn(F,M);if(B!=null)return S(B)}async function Z(F,M,B){if(F==null)return;if(typeof F=="string")return M.length>0?void 0:Y(B,F);if(Array.isArray(F)){for(const ue of F){const ee=await Z(ue,M,B);if(ee!=null)return ee}return}if(typeof F!="object")return;const J=F,ie=M.length===0?".":`./${M.replace(/^\.\//,"")}`;if(Object.keys(J).some(ue=>ue==="."||ue.startsWith("./"))){const ue=J[ie];if(ue!=null)return Z(ue,"",B);for(const[ee,be]of Object.entries(J)){if(!ee.includes("*"))continue;const ke=ee.indexOf("*"),ge=ee.slice(0,ke),xe=ee.slice(ke+1);if(!ie.startsWith(ge)||!ie.endsWith(xe)||ie.length<ge.length+xe.length)continue;const te=ie.slice(ge.length,ie.length-xe.length);if(typeof be=="string")return Y(B,be.replaceAll("*",te));const $=Fe(be);if($!=null)return Y(B,$.replaceAll("*",te))}return}const me=Fe(J);if(me!=null)return Y(B,me)}async function ne(F){const M=ce(F).split("/").filter(B=>B.length>0);M.pop();for(let B=M.length;B>=0;B-=1){const J=M.slice(0,B).join("/"),ie=J.length>0?`${J}/package.json`:"package.json";if(await t().readText(ie)!=null)return J}}async function R(F,M,B=0){if(B>3)return;const J=await ne(M);if(J==null)return;const ie=await x(J);if(ie?.imports==null||typeof ie.imports!="object"||Array.isArray(ie.imports))return;const ve=ie.imports;let me=ve[F],ue;if(me==null)for(const[ke,ge]of Object.entries(ve)){if(!ke.includes("*"))continue;const xe=ke.indexOf("*"),te=ke.slice(0,xe),$=ke.slice(xe+1);if(!(!F.startsWith(te)||!F.endsWith($)||F.length<te.length+$.length)){ue=F.slice(te.length,F.length-$.length),me=ge;break}}if(me==null)return;const ee=Fe(me);if(ee==null)return;const be=ue==null?ee:ee.replaceAll("*",ue);if(be.startsWith("#"))return R(be,M,B+1);if(be.startsWith("./"))return Y(J,be)}async function re(F){const{packageDir:M,subpath:B}=Qt(F),J=await x(M);if(J!=null){if(J.exports!=null)return Z(J.exports,B,M);if(B.length>0)return S(`${M}/${B}`);for(const ie of["browser","module","main"]){const ve=J[ie];if(typeof ve!="string"||ve.length===0)continue;const me=await Y(M,ve);if(me!=null)return me}}return B.length>0?S(`${M}/${B}`):S(M)}return{resolveBareImport:re,resolvePackageImport:R}}async function En(t,l){return bt(t,l,tn,mt)}function Sn(t,l,w,A,x,S="off"){return{name:"dataverse-ide-workspace-fs",setup(Y){const Z=_n(t,l),ne=R=>{const re=ce(R);return x.add(re),{path:re,namespace:"workspace"}};Y.onResolve({filter:/.*/},async R=>{if(R.kind==="entry-point")return ne(R.path);if(wn(R.path,w))return{path:R.path,external:!0};if(R.path.startsWith("#")){const M=await Z.resolvePackageImport(R.path.normalize("NFC"),R.importer.normalize("NFC"));return M!=null?ne(M):void 0}if(!R.path.startsWith(".")&&!R.path.startsWith("/")){if(Kt.has(R.path)||R.path.startsWith("node:"))return{path:R.path,external:!0};const M=await Z.resolveBareImport(ce(R.path));return M!=null?ne(M):(A.add(`${R.path} imported by ${R.importer||"<entry point>"}`),{path:R.path,external:!0})}const re=bn(R.importer,R.path),F=await En(t(),re);return F!=null?ne(F):(A.add(`Relative import "${R.path}" imported by "${R.importer||"<entry point>"}" was not found in the workspace and was left external in the output.`),{path:re,external:!0})}),Y.onLoad({filter:/.*/,namespace:"workspace"},async R=>{const re=ce(R.path);let F=await t().readText(re);if(F==null)return{errors:[{text:`File not found in workspace: "${re}".`}]};let M=yt(re);if(S!=="off"&&pt(re)&&gn(M))try{const B=await gt(),J=wt(F,S,B);if(J.code!==F&&(F=J.code,M=yn(M,!0)),J.errors.length>0)return{contents:F,loader:M,errors:J.errors.slice(0,8).map(ie=>({text:ie}))}}catch(B){return{contents:F,loader:M,errors:[{text:`taggedJsx transform failed: ${B instanceof Error?B.message:String(B)}`}]}}return{contents:F,loader:M}})}}}async function In(t){try{await Ke();const l=t.filename.split(".").at(-1)?.toLowerCase()??"js",w={ts:"ts",mts:"ts",cts:"ts",tsx:"tsx",jsx:"jsx",css:"css",json:"json"},A=await Ge.transform(t.source,{loader:w[l]??"js",format:"cjs",target:"es2022",sourcemap:!1,minify:t.minify??!1,logLevel:"silent"});return{id:t.id,ok:!0,outputs:[{path:t.filename,text:A.code}],warnings:A.warnings.map(x=>x.text),dependencies:[]}}catch(l){return{id:t.id,ok:!1,error:l instanceof Error?l.message:String(l)}}}async function Nn(t){await Ke();const l=await Ge.transform(t.source,{loader:yt(t.filename),...t.format!=null?{format:t.format}:{},target:"es2022",define:t.define,minify:t.minify??!1,sourcemap:t.sourcemap===!0,jsx:"automatic",logLevel:"silent"});return{code:l.code,map:l.map!=null&&l.map.length>0?JSON.parse(l.map):void 0}}function jn(t){const{request:l}=t,w=l.taggedJsx??"off",A=l.solid??"off",x=[];return A!=="off"&&x.push(mn({version:A,readText:S=>t.reader.readText(S),sourcemap:l.sourcemap!=null&&l.sourcemap!==!1,beforeTransform:w==="off"?void 0:async S=>{const Y=await gt(),Z=wt(S,w,Y);return{code:Z.code,errors:Z.errors}}})),x.push(Sn(()=>t.reader,()=>t.generation,l.external??[],t.unresolvedImports,t.dependencyPaths,w)),x}function Tn(t,l){const w=ce(t.entry),A=w.includes("/")?w.slice(0,w.lastIndexOf("/")):".";return{entryPoints:[w],bundle:t.bundle??!0,write:!1,format:t.format??"esm",platform:t.platform,charset:t.charset,globalName:t.globalName,minify:t.minify??!1,sourcemap:t.sourcemap??!1,sourceRoot:t.sourceRoot,sourcesContent:t.sourcesContent,target:t.target??"es2022",treeShaking:t.treeShaking,keepNames:t.keepNames,legalComments:t.legalComments,lineLimit:t.lineLimit!=null&&t.lineLimit>0?t.lineLimit:void 0,drop:t.drop,banner:t.banner,footer:t.footer,pure:t.pure,jsx:t.jsx,jsxFactory:t.jsxFactory,jsxFragment:t.jsxFragment,jsxImportSource:t.jsxImportSource,jsxDev:t.jsxDev,jsxSideEffects:t.jsxSideEffects,external:t.external,define:t.define,splitting:t.splitting,entryNames:t.entryNames,chunkNames:t.chunkNames,outExtension:t.outExtension,logLevel:"silent",metafile:!0,plugins:l,outbase:A,outdir:"out"}}function $n(t){return JSON.stringify({entry:ce(t.entry),format:t.format??"esm",platform:t.platform,charset:t.charset,globalName:t.globalName,minify:t.minify??!1,sourcemap:t.sourcemap??!1,sourceRoot:t.sourceRoot,sourcesContent:t.sourcesContent,target:t.target??"es2022",treeShaking:t.treeShaking,keepNames:t.keepNames,legalComments:t.legalComments,lineLimit:t.lineLimit,drop:t.drop,banner:t.banner,footer:t.footer,pure:t.pure,jsx:t.jsx,jsxFactory:t.jsxFactory,jsxFragment:t.jsxFragment,jsxImportSource:t.jsxImportSource,jsxDev:t.jsxDev,jsxSideEffects:t.jsxSideEffects,bundle:t.bundle??!0,splitting:t.splitting,external:t.external??[],define:t.define,entryNames:t.entryNames,chunkNames:t.chunkNames,outExtension:t.outExtension,taggedJsx:t.taggedJsx??"off",solid:t.solid??"off",virtualFiles:Object.keys(t.virtualFiles??{}).sort()})}function Pn(t,l){const w=t.metafile,A=new Set;for(const x of Object.keys(w?.inputs??{})){const S=x.startsWith("workspace:")?x.slice(10):x;S.startsWith("<")||S.startsWith("__")||A.add(ce(S))}for(const x of l)!x.startsWith("<")&&!x.startsWith("__")&&A.add(ce(x));return[...A].sort()}function On(t,l,w,A){const x=[...l.warnings.map(S=>`${S.text}${S.location!=null?` (${Cn(S.location)})`:""}`),...[...w].sort().map(S=>`Could not resolve npm package "${S}". It was left external in the output bundle.`)];return{id:t.id,ok:!0,outputs:(l.outputFiles??[]).filter(S=>S.contents!=null).map(S=>({path:S.path,text:S.text})),warnings:x,dependencies:Pn(l,A)}}class Un{context;contextKey;state;async build(l){try{await Ke();const w=$n(l);if(this.context==null||this.contextKey!==w){await this.disposeContext();const x={request:l,reader:ft(l.workspace,l.virtualFiles),unresolvedImports:new Set,dependencyPaths:new Set,generation:0};this.context=await Ge.context(Tn(l,jn(x))),this.contextKey=w,this.state=x}else{const x=this.state;if(x==null)throw new Error("esbuild build session lost its state.");x.request=l,x.reader=ft(l.workspace,l.virtualFiles),x.unresolvedImports.clear(),x.dependencyPaths.clear(),x.generation+=1}const A=await this.context.rebuild();if(this.state==null)throw new Error("esbuild build session lost its state.");return On(l,A,this.state.unresolvedImports,this.state.dependencyPaths)}catch(w){const A=this.state==null?[]:[...this.state.dependencyPaths].filter(x=>!x.startsWith("<")&&!x.startsWith("__")).map(x=>ce(x)).sort();return{id:l.id,ok:!1,error:w instanceof Error?w.message:String(w),...A.length>0?{dependencies:A}:{}}}}async dispose(){await this.disposeContext()}async disposeContext(){const l=this.context;if(this.context=void 0,this.contextKey=void 0,this.state=void 0,l!=null)try{await l.dispose()}catch{}}}function Cn(t){return`${t.file??""}:${t.line??0}:${t.column??0}`}export{Un as EsbuildBuildSession,Rn as createWorkspaceReader,In as runTransform,Nn as transformForBundler};
