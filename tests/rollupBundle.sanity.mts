/*
 * Rollup bundle-core sanity harness (manual, like the other *.sanity.*).
 *
 * Run (from the repo root):
 *
 *   npx esbuild tests/rollupBundle.sanity.mts --bundle --platform=node \
 *     --format=esm --external:@rollup/* --external:esbuild \
 *     --alias:esbuild-wasm=./tests/esbuildNativeShim.mjs \
 *     --alias:virtual:esbuild-wasm-binary=./tests/esbuildWasmBinaryMock.mjs \
 *     --outfile=.tmp-rollup-sanity.mjs
 *   node .tmp-rollup-sanity.mjs
 *   rm .tmp-rollup-sanity.mjs
 *
 * (The virtual wasm-binary module only exists in Vite builds, and the
 * esbuild-wasm initialize(wasmModule) path is browser-only; the aliases
 * swap in the native esbuild binary with the same transform API.)
 *
 * Exercises src/extensions/rollup/bundleCore.ts against a scratch
 * workspace reader (the main-thread API): TS/TSX lowering, node_modules
 * resolution, define substitution, externals, JSON modules, CSS extraction,
 * and minify + inline source maps.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/*
 * @rollup/browser's wasm initializer calls fetch(new URL(...)). Node's
 * fetch does not handle file: URLs, so serve the package wasm directly.
 */
const originalFetch = globalThis.fetch;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (input instanceof URL && input.protocol === "file:") {
    const bytes = await readFile(fileURLToPath(input));

    return new Response(bytes, {
      headers: { "Content-Type": "application/wasm" },
    });
  }

  return originalFetch(input, init);
}) as typeof fetch;

const { bundle } = await import("../src/extensions/rollup/bundleCore.ts");

const SCRATCH: Record<string, string> = {
  "src/index.tsx": [
    "import { greet } from './greet.ts'",
    "import dep from 'tiny-fake-pkg'",
    "import builtin from 'alpha-pkg'",
    "import data from './data.json'",
    "import './style.css'",
    "",
    "export const run = (): string =>",
    "  __BUILD_LABEL__ + greet('rollup') + dep + builtin + data.name",
  ].join("\n"),
  "src/greet.ts": ["export const greet = (name: string): string => 'hello ' + name"].join("\n"),
  "src/style.css": [".greeting { color: red; }", ""].join("\n"),
  "src/data.json": JSON.stringify({ name: "ROLLUP_DATA" }),
  "node_modules/tiny-fake-pkg/package.json": JSON.stringify({
    name: "tiny-fake-pkg",
    version: "1.0.0",
    exports: {
      ".": {
        import: "./dist/index.mjs",
        default: "./dist/index.js",
      },
    },
  }),
  "node_modules/tiny-fake-pkg/dist/index.mjs": ["export default 'DEP'", ""].join("\n"),
  /*
   * alpha-pkg ships bundled dist (single file, no relative imports).
   */
  "node_modules/alpha-pkg/package.json": JSON.stringify({
    name: "alpha-pkg",
    version: "0.0.1",
    module: "dist/alpha.mjs",
  }),
  "node_modules/alpha-pkg/dist/alpha.mjs": ["export default 'ALPHA'", ""].join("\n"),
};

const reader = {
  async readText(path: string): Promise<string | undefined> {
    return SCRATCH[path];
  },
};

async function main(): Promise<void> {
  /*
   * 1. Full ESM bundle.
   */
  const full = await bundle({
    entry: "src/index.tsx",
    workspace: reader,
    format: "esm",
    define: { __BUILD_LABEL__: "'LABEL|'" },
  });

  assert.equal(full.ok, true, full.ok ? "" : `full build failed: ${full.error}`);

  if (!full.ok) {
    return;
  }

  assert.equal(full.warnings.length, 0, `no warnings expected: ${full.warnings.join("; ")}`);

  const js = full.outputs.find((output) => output.path.endsWith(".js"));
  const css = full.outputs.find((output) => output.path.endsWith(".css"));

  assert.ok(js != null, "expected a JS chunk");
  assert.ok(css != null, "expected an extracted CSS asset");
  assert.ok(css.text.includes(".greeting"), "CSS contents preserved in the asset");

  const code = js.text;

  assert.ok(code.includes("LABEL|"), "define substituted");
  assert.ok(code.includes("hello "), "workspace file bundled");
  assert.ok(code.includes("DEP"), "exports-mapped package bundled");
  assert.ok(code.includes("ALPHA"), "module-entry package bundled");
  assert.ok(code.includes("ROLLUP_DATA"), "JSON module bundled");

  const residual = code.match(/:\s*(string|number|boolean)\b/)?.length ?? 0;
  assert.equal(residual, 0, "no residual TypeScript annotations");

  console.log(`1. full ESM bundle OK: ${code.length} chars; CSS asset ${css.text.length} chars`);

  /*
   * 2. Externals: tiny-fake-pkg stays out of the bundle.
   */
  const external = await bundle({
    entry: "src/index.tsx",
    workspace: reader,
    format: "esm",
    external: ["tiny-fake-pkg"],
  });

  if (!external.ok) {
    throw new Error(`external build failed: ${external.error}`);
  }

  const externalCode = external.outputs.find((output) => output.path.endsWith(".js"))!.text;

  assert.ok(/from ['"]tiny-fake-pkg['"]/.test(externalCode), "external import preserved");
  assert.ok(!externalCode.includes("'DEP'"), "external package not bundled");

  console.log("2. external semantics OK");

  /*
   * 3. Minify + inline sourcemap.
   */
  const minified = await bundle({
    entry: "src/index.tsx",
    workspace: reader,
    format: "esm",
    minify: true,
    sourcemap: true,
    define: { __BUILD_LABEL__: "'LABEL|'" },
  });

  if (!minified.ok) {
    throw new Error(`minified build failed: ${minified.error}`);
  }

  const minifiedCode = minified.outputs.find((output) => output.path.endsWith(".js"))!.text;

  assert.ok(
    minifiedCode.includes("sourceMappingURL=data:application/json;base64,"),
    "inline sourcemap appended",
  );
  assert.ok(!minifiedCode.includes("\n\nexport "), "output minified");

  console.log(`3. minify + sourcemap OK: ${minifiedCode.length} chars`);
  console.log("4. rollup bundle sanity: ALL OK");
}

await main();
