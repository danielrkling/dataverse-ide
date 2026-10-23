/**
 * Copyright (c) 2014-2024 The xterm.js authors. All rights reserved.
 * @license MIT
 *
 * Copyright (c) 2012-2013, Christopher Jeffrey (MIT License)
 * @license MIT
 *
 * Originally forked from (with the author's permission):
 *   Fabrice Bellard's javascript vt100 for jslinux:
 *   http://bellard.org/jslinux/
 *   Copyright (c) 2011 Fabrice Bellard
 */var c=class{constructor(t=new l,e=new d){this._base64=t,this._provider=e}activate(t){this._terminal=t,this._disposable=t.parser.registerOscHandler(52,e=>this._setOrReportClipboard(e))}dispose(){return this._disposable?.dispose()}_readText(t,e){let r=this._base64.encodeText(e);this._terminal?.input(`\x1B]52;${t};${r}\x07`,!1)}_setOrReportClipboard(t){let e=t.split(";");if(e.length<2)return!0;let r=e[0],i=e[1];if(i==="?"){let a=this._provider.readText(r);return a instanceof Promise?a.then(n=>(this._readText(r,n),!0)):(this._readText(r,a),!0)}let s="";try{s=this._base64.decodeText(i)}catch{}let o=this._provider.writeText(r,s);return o instanceof Promise?o.then(()=>!0):!0}},d=class{readText(t){return navigator.clipboard.readText()}writeText(t,e){return navigator.clipboard.writeText(e)}},l=class{encodeText(t){let e=new TextEncoder().encode(t);if(e.toBase64!==void 0)return e.toBase64();let r="";for(let i=0;i<e.length;i++)r+=String.fromCharCode(e[i]);return btoa(r)}decodeText(t){if(Uint8Array.fromBase64!==void 0){try{return new TextDecoder().decode(Uint8Array.fromBase64(t))}catch{}return""}try{let e=atob(t),r=new Uint8Array(e.length);for(let i=0;i<e.length;++i)r[i]=e.charCodeAt(i);return new TextDecoder().decode(r)}catch{}return""}};export{l as Base64,d as BrowserClipboardProvider,c as ClipboardAddon};
