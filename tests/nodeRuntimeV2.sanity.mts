/*
 * node-runtime-v2 sanity harness (manual, like the other *.sanity.*).
 *
 * Run (from the repo root):
 *
 *   npx esbuild tests/nodeRuntimeV2.sanity.mts --bundle --platform=node \
 *     --format=esm --external:almostnode \
 *     --alias:esbuild-wasm=./tests/esbuildNativeShim.mjs \
 *     --alias:virtual:esbuild-wasm-binary=./tests/esbuildWasmBinaryMock.mjs \
 *     --outfile=.tmp-node-v2-sanity.mjs
 *   node .tmp-node-v2-sanity.mjs
 *   rm .tmp-node-v2-sanity.mjs
 *
 * Exercises the async loader + sync require cache against a scratch
 * workspace: TS transpilation, ".js" -> ".ts" sibling imports, JSON
 * modules, dynamic require miss/retry, sync fs read miss/retry, and
 * write-behind flush through the workspace reader.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createProcess } from "almostnode";

import { createRuntimeFs } from "../src/extensions/node-runtime-v2/fsShim.ts";
import { createModuleLoader } from "../src/extensions/node-runtime-v2/loader.ts";
import type { WorkspaceFs } from "../src/extensions/node-runtime-v2/workspace.ts";

function createNodeReader(root: string): WorkspaceFs {
  const full = (path: string) => join(root, ...path.split("/"));

  return {
    async readText(path) {
      try {
        return await readFile(full(path), "utf8");
      } catch {
        return undefined;
      }
    },
    async readBytes(path) {
      try {
        return new Uint8Array(await readFile(full(path)));
      } catch {
        return undefined;
      }
    },
    async stat(path) {
      try {
        const stat = await import("node:fs/promises").then((fs) => fs.stat(full(path)));

        return {
          type: stat.isDirectory() ? 2 : 1,
          ctime: stat.ctimeMs,
          mtime: stat.mtimeMs,
          size: stat.size,
        };
      } catch {
        return undefined;
      }
    },
    async readDirectory(path) {
      try {
        const fs = await import("node:fs/promises");
        const entries = await fs.readdir(full(path), { withFileTypes: true });

        return entries.map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]) as Array<
          [string, 1 | 2]
        >;
      } catch {
        return undefined;
      }
    },
    async writeFile(path, content) {
      await mkdir(dirname(full(path)), { recursive: true });
      await writeFile(full(path), content);
    },
    async createDirectory(path) {
      await mkdir(full(path), { recursive: true });
    },
    async deletePath(path, recursive) {
      await rm(full(path), { recursive, force: true });
    },
    async rename(from, to) {
      const fs = await import("node:fs/promises");
      await fs.rename(full(from), full(to));
    },
    async copy(from, to) {
      const fs = await import("node:fs/promises");
      await fs.copyFile(full(from), full(to));
    },
  };
}

const root = await mkdtemp(join(tmpdir(), "dv-node-v2-"));

await mkdir(join(root, "src"), { recursive: true });

await writeFile(
  join(root, "src", "main.ts"),
  [
    'import { readFileSync, writeFileSync, promises as fsp } from "node:fs";',
    'import { greet } from "./greet.js";',
    'import data from "./data.json";',
    "",
    'const dynamicName = "./extra.js";',
    "const extra = require(dynamicName);",
    "",
    'const note = readFileSync("src/note.txt", "utf8").trim();',
    'console.log(greet("world"), data.value, note);',
    'console.log("dynamic", extra.value);',
    'console.log("meta", import.meta.url.endsWith("src/main.ts"), typeof fetch);',
    "",
    'writeFileSync("out/written.txt", "flushed");',
    'writeFileSync("out/mixed.txt", "sync-then-async");',
    "",
    "export const finished = (async () => {",
    '  const mixed = await fsp.readFile("out/mixed.txt", "utf8");',
    '  await fsp.writeFile("out/async.txt", "async-ok");',
    '  const back = await fsp.readFile("out/async.txt", "utf8");',
    '  console.log("mixed", mixed);',
    '  console.log("async", back);',
    "})();",
    "",
    "export const done = true;",
  ].join("\n"),
);

await writeFile(
  join(root, "src", "greet.ts"),
  'export function greet(name: string): string { return "hello " + name; }\n',
);

await writeFile(join(root, "src", "data.json"), '{ "value": 42 }\n');
await writeFile(join(root, "src", "note.txt"), "note-ok\n");
await writeFile(join(root, "src", "extra.js"), 'exports.value = "dynamic-ok";\n');

const reader = createNodeReader(root);
const runtimeFs = createRuntimeFs({ reader, cwd: "/" });
const output: string[] = [];
const retries: string[] = [];

const runtimeProcess = createProcess({
  cwd: "/",
  onStdout: (data) => output.push(data),
  onStderr: (data) => output.push(data),
});

const loader = createModuleLoader({
  reader,
  runtimeFs,
  process: runtimeProcess,
  onConsole: (_method, args) => output.push(args.map(String).join(" ")),
  onRetry: (message) => retries.push(message),
});

const exportsValue = (await loader.run("src/main.ts")) as {
  done: boolean;
  finished: Promise<void>;
};

assert.equal(exportsValue.done, true);
await exportsValue.finished;

const flushed = await runtimeFs.flush();

assert.equal(flushed.errors.length, 0, flushed.errors.join("\n"));
assert.equal(retries.length, 2, retries.join("\n"));
assert.deepEqual(
  output.filter((line) => line.trim().length > 0),
  [
    "hello world 42 note-ok",
    "dynamic dynamic-ok",
    "meta true function",
    "mixed sync-then-async",
    "async async-ok",
  ],
);

const written = await readFile(join(root, "out", "written.txt"), "utf8");
const mixed = await readFile(join(root, "out", "mixed.txt"), "utf8");
const asyncFile = await readFile(join(root, "out", "async.txt"), "utf8");

assert.equal(written, "flushed");
assert.equal(mixed, "sync-then-async");
assert.equal(asyncFile, "async-ok");

await rm(root, { recursive: true, force: true });

console.log("OK - node-runtime-v2 loader, fs shim and flush behave as expected.");

/*
 * almostnode's shims keep module-level timers/handles alive in Node; exit
 * explicitly so the sanity run terminates.
 */
process.exit(0);
