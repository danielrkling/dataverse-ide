/*
 * Incremental esbuild session sanity harness (manual).
 *
 * Run:
 *   npx esbuild tests/esbuildBuildSession.sanity.mts --bundle --platform=node \
 *     --format=esm \
 *     --alias:esbuild-wasm=./tests/esbuildNativeShim.mjs \
 *     --alias:virtual:esbuild-wasm-gzip-url=./tests/esbuildWasmBinaryMock.mjs \
 *     --external:esbuild --external:@babel/* --external:@solidjs/babel-plugin \
 *     --external:babel-preset-solid --external:@babel/preset-typescript \
 *     --external:typescript \
 *     --outfile=tmp-esbuild-session-sanity.mjs
 *   node tmp-esbuild-session-sanity.mjs
 *
 * Verifies context reuse across rebuilds, dependency reporting, context
 * recreation when build options change, and recovery after a failed rebuild.
 */
import assert from "node:assert/strict";
import { EsbuildBuildSession } from "../src/extensions/esbuild/compiler.ts";

const files = new Map<string, string>([
  ["src/entry.ts", 'import { value } from "./dep";\nconsole.log(value);\n'],
  ["src/dep.ts", 'export const value = "one";\n'],
  ["src/second.ts", 'import { value } from "./dep";\nexport const second = `${value}!`;\n'],
  ["src/unused.ts", "export const unused = true;\n"],
]);

function reader() {
  return {
    async readBytes(path: string) {
      const text = files.get(path.replace(/^\/+/, ""));

      return text == null ? undefined : new TextEncoder().encode(text);
    },
    async readText(path: string) {
      return files.get(path.replace(/^\/+/, ""));
    },
    async readDir(path: string) {
      const normalized = path.replace(/^\/+/, "");
      const prefix = normalized.length > 0 ? `${normalized}/` : "";
      const listing = new Map<string, "file" | "directory">();

      for (const key of files.keys()) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        const name = slash === -1 ? rest : rest.slice(0, slash);
        if (name.length > 0) listing.set(name, slash === -1 ? "file" : "directory");
      }

      return listing;
    },
  };
}

const session = new EsbuildBuildSession();
const base = {
  type: "build" as const,
  entries: ["src/entry.ts"],
  workspace: reader(),
  format: "esm" as const,
  bundle: true,
  target: "es2022",
};

let result = await session.build({ ...base, id: 1 });
assert.equal(result.ok, true, result.ok ? "" : result.error);
if (!result.ok) throw new Error(result.error);
console.log("build1", result.outputs[0].text.trim());
console.log("deps1", result.dependencies);
assert.ok(result.outputs[0].text.includes('"one"'));
assert.deepEqual(result.dependencies, ["src/dep.ts", "src/entry.ts"]);

files.set("src/dep.ts", 'export const value = "two";\n');
result = await session.build({ ...base, id: 2, workspace: reader() });
if (!result.ok) throw new Error(result.error);
console.log("build2", result.outputs[0].text.trim());
assert.ok(result.outputs[0].text.includes('"two"'), "rebuild sees changed dependency");

files.set(
  "src/entry.ts",
  'import { value } from "./dep";\nimport { unused } from "./unused";\nconsole.log(value, unused);\n',
);
result = await session.build({ ...base, id: 3, workspace: reader() });
if (!result.ok) throw new Error(result.error);
console.log("deps3", result.dependencies);
assert.deepEqual(result.dependencies, ["src/dep.ts", "src/entry.ts", "src/unused.ts"]);

result = await session.build({ ...base, id: 4, workspace: reader(), minify: true });
if (!result.ok) throw new Error(result.error);
console.log("build4", result.outputs[0].text.trim());
assert.ok(
  !result.outputs[0].text.includes("var value"),
  "options change recreates context and applies minify",
);

files.set("src/other.ts", "export const other = ;\n");
files.set(
  "src/entry.ts",
  'import { value } from "./dep";\nimport { other } from "./other";\nconsole.log(value, other);\n',
);
result = await session.build({ ...base, id: 5, workspace: reader() });
assert.equal(result.ok, false, "syntax error is reported");
console.log("failure deps", result.dependencies);
assert.ok(
  result.dependencies?.includes("src/other.ts"),
  "failed build still reports the new dependency",
);

files.set("src/other.ts", 'export const other = "recovered";\n');
result = await session.build({ ...base, id: 6, workspace: reader() });
if (!result.ok) throw new Error(result.error);
assert.ok(
  result.outputs[0].text.includes('"recovered"'),
  "context recovers after a failed rebuild",
);

/*
 * Multi-entry: one build pass must emit every entry file, and code splitting
 * must share the common dependency instead of duplicating it.
 */
result = await session.build({
  ...base,
  id: 7,
  entries: ["src/entry.ts", "src/second.ts"],
  splitting: true,
  workspace: reader(),
});
if (!result.ok) throw new Error(result.error);

const multiPaths = result.outputs.map((output) => output.path.replaceAll("\\", "/"));
console.log("multi outputs", multiPaths);
assert.ok(
  multiPaths.some((path) => path.endsWith("/entry.js")),
  "multi-entry build writes the first entry",
);
assert.ok(
  multiPaths.some((path) => path.endsWith("/second.js")),
  "multi-entry build writes every entry",
);
assert.ok(multiPaths.length >= 3, "multi-entry splitting emits a shared chunk");

/*
 * Entry points now use esbuild's extension/index resolution.
 */
result = await session.build({ ...base, id: 8, entries: ["src/entry"], workspace: reader() });
if (!result.ok) throw new Error(result.error);
assert.ok(
  result.outputs[0].path.endsWith("/entry.js"),
  "extensionless entry resolves to src/entry.ts",
);

/*
 * Unresolved imports must fail like esbuild instead of being externalized.
 */
files.set("src/missing-relative.ts", 'import "./does-not-exist";\n');
result = await session.build({
  ...base,
  id: 9,
  entries: ["src/missing-relative.ts"],
  workspace: reader(),
});
assert.equal(result.ok, false, "unresolved relative import fails the build");

files.set("src/missing-bare.ts", 'import "not-a-real-package";\n');
result = await session.build({
  ...base,
  id: 10,
  entries: ["src/missing-bare.ts"],
  workspace: reader(),
});
assert.equal(result.ok, false, "unresolved bare import fails the build");

/*
 * Node builtins are external only on platform=node.
 */
files.set("src/builtin.ts", 'import { readFileSync } from "fs";\nconsole.log(readFileSync);\n');
result = await session.build({
  ...base,
  id: 11,
  entries: ["src/builtin.ts"],
  platform: "node",
  format: "cjs",
  workspace: reader(),
});
if (!result.ok) throw new Error(result.error);
console.log("builtin node output", result.outputs[0].text.trim());
assert.ok(
  result.outputs[0].text.includes('require("fs")'),
  "node platform leaves builtins external",
);

result = await session.build({
  ...base,
  id: 12,
  entries: ["src/builtin.ts"],
  platform: "browser",
  workspace: reader(),
});
assert.equal(result.ok, false, "browser platform reports unresolved builtins");

/*
 * Default extension order is .tsx before .ts, matching esbuild.
 */
files.set("src/pick.ts", 'export const pick = "ts";\n');
files.set("src/pick.tsx", 'export const pick = "tsx";\n');
files.set("src/ambiguous.ts", 'import { pick } from "./pick";\nconsole.log(pick);\n');
result = await session.build({
  ...base,
  id: 13,
  entries: ["src/ambiguous.ts"],
  workspace: reader(),
});
if (!result.ok) throw new Error(result.error);
assert.ok(result.outputs[0].text.includes('"tsx"'), "extensionless imports prefer .tsx");

/*
 * Conditional exports honor import vs require.
 */
files.set(
  "node_modules/demo/package.json",
  JSON.stringify({
    name: "demo",
    exports: {
      ".": {
        require: "./cjs.js",
        import: "./esm.js",
      },
    },
  }),
);
files.set("node_modules/demo/esm.js", 'export const mode = "esm";\n');
files.set("node_modules/demo/cjs.js", 'exports.mode = "cjs";\n');
files.set("src/use-demo.ts", 'import { mode } from "demo";\nconsole.log(mode);\n');
result = await session.build({
  ...base,
  id: 14,
  entries: ["src/use-demo.ts"],
  workspace: reader(),
});
if (!result.ok) throw new Error(result.error);
assert.ok(result.outputs[0].text.includes('"esm"'), "import condition selects ESM export");

files.set("src/use-demo-require.ts", 'const { mode } = require("demo");\nconsole.log(mode);\n');
result = await session.build({
  ...base,
  id: 15,
  entries: ["src/use-demo-require.ts"],
  workspace: reader(),
});
if (!result.ok) throw new Error(result.error);
assert.ok(result.outputs[0].text.includes('"cjs"'), "require condition selects CommonJS export");

files.set("src/use-alias.ts", 'import { mode } from "demo-alias";\nconsole.log(mode);\n');
result = await session.build({
  ...base,
  id: 25,
  entries: ["src/use-alias.ts"],
  alias: { "demo-alias": "demo" },
  workspace: reader(),
});
if (!result.ok) throw new Error(result.error);
assert.ok(result.outputs[0].text.includes('"esm"'), "alias substitutes package specifiers");

/*
 * tsconfig baseUrl/paths are read from the workspace.
 */
files.set(
  "tsconfig.json",
  JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
);
files.set("src/use-paths.ts", 'import { value } from "@/dep";\nconsole.log(value);\n');
result = await session.build({
  ...base,
  id: 16,
  entries: ["src/use-paths.ts"],
  workspace: reader(),
});
if (!result.ok) throw new Error(result.error);
assert.ok(result.outputs[0].text.includes('"two"'), "tsconfig paths resolve bare imports");

/*
 * outfile and { in, out } entry objects use real esbuild output paths.
 */
result = await session.build({
  ...base,
  id: 17,
  entries: ["src/entry.ts"],
  outdir: undefined,
  outfile: "build/app.js",
  workspace: reader(),
});
if (!result.ok) throw new Error(result.error);
assert.equal(result.outputs[0].path, "build/app.js", "outfile writes the exact path");

result = await session.build({
  ...base,
  id: 18,
  entries: [{ in: "src/entry.ts", out: "pages/home" }],
  workspace: reader(),
});
if (!result.ok) throw new Error(result.error);
assert.equal(result.outputs[0].path, "out/pages/home.js", "{ in, out } controls output path");

/*
 * External wildcards and binary loaders.
 */
files.set("src/use-asset.ts", 'import asset from "./asset.png";\nconsole.log(asset);\n');
files.set("src/asset.png", "abc");
result = await session.build({
  ...base,
  id: 19,
  entries: ["src/use-asset.ts"],
  loader: { ".png": "file" },
  workspace: reader(),
});
if (!result.ok) throw new Error(result.error);

const asset = result.outputs.find((output) => output.path.endsWith(".png"));

assert.ok(asset != null, "file loader emits an asset output");
assert.equal(new TextDecoder().decode(asset.contents), "abc", "assets keep their bytes");

files.set("src/use-json.ts", 'import data from "./data.json";\nconsole.log(data);\n');
files.set("src/data.json", '{"ok":true}');
result = await session.build({
  ...base,
  id: 20,
  entries: ["src/use-json.ts"],
  external: ["*.json"],
  workspace: reader(),
});
if (!result.ok) throw new Error(result.error);
assert.ok(result.outputs[0].text.includes("./data.json"), "external wildcards match imports");

/*
 * Inject files resolve through the workspace plugin.
 */
files.set("src/inject.ts", "globalThis.__injected = true;\n");
result = await session.build({
  ...base,
  id: 21,
  entries: ["src/entry.ts"],
  inject: ["src/inject.ts"],
  workspace: reader(),
});
if (!result.ok) throw new Error(result.error);
assert.ok(result.outputs[0].text.includes("__injected"), "inject files are bundled");

/*
 * package.json browser maps only apply on platform=browser.
 */
files.set(
  "node_modules/browserpkg/package.json",
  JSON.stringify({
    name: "browserpkg",
    main: "./node.js",
    browser: { "./node.js": "./browser.js" },
  }),
);
files.set("node_modules/browserpkg/node.js", 'export const target = "node";\n');
files.set("node_modules/browserpkg/browser.js", 'export const target = "browser";\n');
files.set("src/use-browserpkg.ts", 'import { target } from "browserpkg";\nconsole.log(target);\n');

result = await session.build({
  ...base,
  id: 22,
  entries: ["src/use-browserpkg.ts"],
  platform: "browser",
  workspace: reader(),
});
if (!result.ok) throw new Error(result.error);
assert.ok(result.outputs[0].text.includes('"browser"'), "browser field maps apply on browser");

result = await session.build({
  ...base,
  id: 23,
  entries: ["src/use-browserpkg.ts"],
  platform: "node",
  format: "cjs",
  workspace: reader(),
});
if (!result.ok) throw new Error(result.error);
assert.ok(!result.outputs[0].text.includes('"browser"'), "browser field maps do not apply on node");

/*
 * package.json sideEffects participates in tree shaking.
 */
files.set(
  "node_modules/sidepkg/package.json",
  JSON.stringify({ name: "sidepkg", main: "./index.js", sideEffects: false }),
);
files.set("node_modules/sidepkg/index.js", "globalThis.__sideEffect = true;\n");
files.set("src/use-sidepkg.ts", 'import "sidepkg";\nconsole.log("entry");\n');
result = await session.build({
  ...base,
  id: 24,
  entries: ["src/use-sidepkg.ts"],
  workspace: reader(),
});
if (!result.ok) throw new Error(result.error);
assert.ok(
  !result.outputs[0].text.includes("__sideEffect"),
  "sideEffects: false removes unused package imports",
);

await session.dispose();
console.log("esbuildBuildSession.sanity: all assertions passed");
