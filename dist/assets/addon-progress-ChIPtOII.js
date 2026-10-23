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
 */function n(e){let r=0;for(let t=0;t<e.length;++t){let s=e.charCodeAt(t);if(s<48||57<s)return-1;r=r*10+s-48}return r}var i=class{constructor(){this._st=0,this._pr=0}dispose(){this._seqHandler?.dispose(),this._onChange?.dispose()}activate(e){this._seqHandler=e.parser.registerOscHandler(9,r=>{if(!r.startsWith("4;"))return!1;let t=r.split(";");if(t.length>3)return!0;t.length===2&&t.push("");let s=n(t[1]),a=n(t[2]);switch(s){case 0:this.progress={state:s,value:0};break;case 1:if(a<0)return!0;this.progress={state:s,value:a};break;case 2:case 4:if(a<0)return!0;this.progress={state:s,value:a||this._pr};break;case 3:this.progress={state:s,value:this._pr};break}return!0}),this._onChange=new e._core._onData.constructor,this.onChange=this._onChange.event}get progress(){return{state:this._st,value:this._pr}}set progress(e){if(e.state<0||e.state>4){console.warn("progress state out of bounds, not applied");return}this._st=e.state,this._pr=Math.min(Math.max(e.value,0),100),this._onChange?.fire({state:this._st,value:this._pr})}};export{i as ProgressAddon};
