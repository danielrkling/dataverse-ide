/*
 * Solid 2.0 + rolldown bundle-core sanity harness (manual).
 *
 * Run: build with esbuild then execute:
 *   npx esbuild tests/rolldownSolid.sanity.mts --bundle --platform=node
 *     --format=esm --external:@rolldown/* --external:@solidjs/*
 *     --external:@emnapi/* --external:@napi-rs/* --outfile=tmp-solid-sanity.mjs
 *   node tmp-solid-sanity.mjs
 *
 * Verifies, through src/extensions/rolldown/bundleCore.ts:
 *   1. request.solid = 'v2' compiles workspace .tsx via
 *      @solidjs/compiler-wasm32-wasi (no residual JSX/TS in the output)
 *   2. compiled output imports solid-js + @solidjs/web
 *   3. request.solid = 'off' keeps the raw oxc TSX loader (bundle still
 *      produced, but with residual JSX)
 */
import assert from "node:assert/strict";

import { bundle } from "../src/extensions/rolldown/bundleCore.ts";

const FILES: Record<string, string> = {
  "src/index.tsx": [
    "import { render } from 'solid-js/web'",
    "import { Greeting } from './greeting'",
    "const root = document.getElementById('root')",
    "export default () => render(() => <Greeting name='rolldown' />, root!)",
  ].join("\n"),
  "src/greeting.tsx": [
    "export function Greeting(props: { name: string }) {",
    "  return <div class='greeting'>Hello {props.name}</div>",
    "}",
  ].join("\n"),
};

async function main(): Promise<void> {
  /*
   * 1. Solid v2: workspace TSX compiled by the wasm plugin.
   */
  const solid = await bundle({
    entry: "src/index.tsx",
    files: { ...FILES },
    solid: "v2",
    format: "esm",
    external: ["solid-js", "solid-js/web", "@solidjs/web"],
    absentPaths: [],
  });

  if (!solid.ok) {
    throw new Error(`solid bundle failed: ${solid.error}`);
  }

  assert.equal(solid.warnings.length, 0);

  const output = solid.outputs[0]!.text;

  assert.ok(
    output.includes("@solidjs/web") || output.includes("solid-js/web"),
    "solid runtime import present",
  );
  assert.ok(
    output.includes("template(") || output.includes("template()") || output.includes("cloneNode"),
    "solid DOM template emitted",
  );
  assert.ok(!/render\(\(\) => </.test(output), "no residual JSX expression (template strings legitimately contain <div)");
  assert.ok(!/: *string/.test(output), "no residual TS annotation");

  console.log(`1. solid v2 bundle OK: ${output.length} chars`);

  /*
   * 2. solid 'off' still bundles via the default loader (but keeps JSX).
   */
  const off = await bundle({
    entry: "src/index.tsx",
    files: { ...FILES },
    solid: "off",
    format: "esm",
    /* oxc keeps JSX in "off" mode and its default jsx-runtime import is
     * react-style; nothing react is installed in this fixture. */
    external: ["solid-js", "solid-js/web", "@solidjs/web", "react"],
  });

  if (!off.ok) {
    throw new Error(`off bundle failed: ${off.error}`);
  }

  if (off.needFiles != null) {
  console.error("off probe files:", off.needFiles.slice(0, 12).join(" | "));
}

if (off.outputs.length === 0) {
  console.error("off response:", JSON.stringify(off).slice(0, 400));
  process.exit(3);
}

const offOutput = off.outputs[0]!.text;

  assert.ok(/<div|jsx|__jsx/.test(offOutput), "default loader leaves JSX (no solid compile)");

  console.log(`2. solid 'off' bundle OK (JSX preserved): ${offOutput.length} chars`);

  console.log("3. rolldown solid sanity: ALL OK");
}

await main();
