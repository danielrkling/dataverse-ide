import { transform } from '@solidjs/compiler-wasm32-wasi';

const a = `export function App(){
    return <div>
        <button> Hello World</button>
    </div>
}`;
console.log('A explicit export:', JSON.stringify(transform(a, { filename: 'a.tsx', moduleName: '@solidjs/web', generate: 'dom', dev: true, sourceMap: false }).code));

const b = `export function App(){
    return <div onClick={() => 1}>
        <button> hello</button>
    </div>
}`;
console.log('B dynamic attrs:', JSON.stringify(transform(b, { filename: 'b.tsx', moduleName: '@solidjs/web', generate: 'dom', dev: true, sourceMap: false }).code));

const c = `export const App = () => <div><button> hello</button></div>`;
console.log('C arrow:', JSON.stringify(transform(c, { filename: 'c.tsx', moduleName: '@solidjs/web', generate: 'dom', dev: true, sourceMap: false }).code));
