/*
 * Incremental esbuild session sanity harness (manual).
 *
 * Run:
 *   npx esbuild tests/esbuildBuildSession.sanity.mts --bundle --platform=node \
 *     --format=esm \
 *     --alias:esbuild-wasm=./tests/esbuildNativeShim.mjs \
 *     --alias:virtual:esbuild-wasm-binary=./tests/esbuildWasmBinaryMock.mjs \
 *     --external:esbuild --external:@babel/* --external:@solidjs/babel-plugin \
 *     --external:babel-preset-solid --external:@babel/preset-typescript \
 *     --external:typescript --external:@tagged-jsx/transform \
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
  ["src/unused.ts", "export const unused = true;\n"],
]);

function reader() {
  return {
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
  entry: "src/entry.ts",
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

await session.dispose();
console.log("esbuildBuildSession.sanity: all assertions passed");
