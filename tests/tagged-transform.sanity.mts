import * as ts from "typescript";
import {
  createJsxTransformer,
  createTaggedTransformer,
  createExpressionTransformCallbacks,
} from "@tagged-jsx/transform";

const toJsx = createJsxTransformer({ tags: ["html", "jsx"], ts, callbacks: createExpressionTransformCallbacks(ts) });
const toTagged = createTaggedTransformer({ tag: "html", ts, callbacks: createExpressionTransformCallbacks(ts), registeredComponents: [] });

// 1. tagged -> JSX (passes prior custom-converter failures: hello hole, dynamic tags, <//> shorthand)
const t1 = `const el = html\`<div class=\${() => active() ? "on" : "off"}>
  <span>\${() => children}</span>
</div>\`;`;
console.log("1 tagged->JSX:", JSON.stringify(toJsx(t1).code));

// 2. JSX -> tagged: Solid-style callbacks, dynamic tag wrapping
const t2 = `function App() {
  return <div class={baseClass} onClick={handler} disabled={isDisabled()}>
    <Show when={loaded()}><span>{text()}</span></Show>
    <MyComponent prop={value}>{children}</MyComponent>
  </div>;
}`;
const out2 = toTagged(t2);
console.log("2 JSX->tagged:", JSON.stringify(out2.code), out2.errors);

// 3. toggle round trips
console.log("3 roundtrip:", JSON.stringify(toJsx(out2.code).code));

// 4. nested JSX inside expressions becomes nested template
const t4 = `const list = <ul>{items.map(i => <li>{i}</li>)}</ul>;`;
console.log("4 nested:", JSON.stringify(toTagged(t4).code));
