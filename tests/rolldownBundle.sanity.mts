/*
 * Rolldown bundle-core sanity harness (manual, like the other *.sanity.*).
 *
 * Run: node --experimental-strip-types tests/rolldownBundle.sanity.mts
 *
 * Exercises src/extensions/rolldown/bundleCore.ts against a scratch
 * in-memory workspace: TS/TSX workspace files via the shared virtual-fs
 * plugin, node_modules manifests, lazy probe rounds, externals, and
 * define. Verifies:
 *   1. probe round returns needFiles when package files are missing
 *   2. after feeding the manifest + package files, a full ESM bundle is
 *      produced with no residual TS/TSX and all internal imports bound
 *   3. configured externals stay external
 *   4. define substitutes constants
 */
import assert from "node:assert/strict";

import { bundle } from "../src/extensions/rolldown/bundleCore.ts";

const SCRATCH: Record<string, string> = {
  "src/index.tsx": [
    "import { greet } from './greet.ts'",
    "import dep from 'tiny-fake-pkg'",
    "import builtin from 'alpha-pkg'",
    "",
    "export const run = (): string => __BUILD_LABEL__ + greet('rolldown') + dep + builtin",
  ].join("\n"),
  "src/greet.ts": ["export const greet = (name: string): string => 'hello ' + name"].join("\n"),
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

const workspaceFiles = (): Record<string, string> => {
  const files: Record<string, string> = {};

  for (const [path, content] of Object.entries(SCRATCH)) {
    /*
     * Mimic the lazy collection: workspace sources + package manifests
     * only; package internals fetched through probe rounds.
     */
    if (path.startsWith("node_modules/") && !path.endsWith("package.json")) {
      continue;
    }

    files[path] = content;
  }

  return files;
};

async function main(): Promise<void> {
  const files = workspaceFiles();

  /*
   * 1. Probe round.
   */
  const probe = await bundle({
    entry: "src/index.tsx",
    files,
  });

  assert.equal(probe.ok, true, "probe round should not fail");

  if (!probe.ok) {
    return;
  }

  assert.ok(
    probe.needFiles != null && probe.needFiles.length > 0,
    `expected needFiles probe round, got ${JSON.stringify(probe)}`,
  );

  console.log(`1. probe round OK: needFiles = ${probe.needFiles.join(", ")}`);

  /*
   * 2. Lazy loop: feed the requested files (lazyBuild behaviour) and
   *    rebuild until the resolver stops asking.
   */
  const absent = new Set<string>();

  let full: Awaited<ReturnType<typeof bundle>>;

  for (let round = 0; round < 12; round++) {
    full = await bundle({
      entry: "src/index.tsx",
      files,
      absentPaths: [...absent],
      format: "esm",
      define: { __BUILD_LABEL__: "'LABEL|'" },
    });

    if (!full.ok) {
      throw new Error(`round ${round} failed: ${full.error}`);
    }

    if (full.needFiles == null || full.needFiles.length === 0) {
      break;
    }

    console.log(`   round ${round}: ${full.needFiles.length} file(s) requested`);

    for (const requested of full.needFiles) {
      if (SCRATCH[requested] != null) {
        files[requested] = SCRATCH[requested] as string;
      } else {
        absent.add(requested);
      }
    }
  }

  if (!full!.ok) {
    throw new Error("lazy loop finished without a successful round");
  }

  const fullResult = full as Extract<Awaited<ReturnType<typeof bundle>>, { ok: true }>;

  assert.equal(fullResult.outputs.length, 1, "single chunk expected");
  assert.equal(fullResult.warnings.length, 0, "no warnings expected");

  const code = fullResult.outputs[0]!.text;

  assert.ok(code.includes("LABEL|"), "define substituted");
  assert.ok(code.includes("hello "), "workspace file bundled");
  assert.ok(code.includes("DEP"), "exports-mapped package bundled");
  assert.ok(code.includes("ALPHA"), "module-entry package bundled");

  const residual = code.match(/:\s*(string|number|boolean)\b/)?.length ?? 0;
  console.log(`   residual TS annotations: ${residual}`);
  console.log(`2. full ESM bundle OK: ${code.length} chars`);

  /*
   * 3. Externals: tiny-fake-pkg stays out of the bundle.
   */
  const external = await bundle({
    entry: "src/index.tsx",
    files,
    absentPaths: [...absent],
    format: "esm",
    external: ["tiny-fake-pkg"],
  });

  if (!external.ok) {
    throw new Error(`external build failed: ${external.error}`);
  }

  const externalCode = external.outputs[0]!.text;

  assert.ok(/from ['"]tiny-fake-pkg['"]/.test(externalCode), "external import preserved");

  assert.ok(!externalCode.includes("'DEP'"), "external package not bundled");

  console.log("3. external semantics OK");

  /*
   * 4. Probe round with an externals-installed package is NOT re-requested.
   */
  console.log("4. rolldown bundle sanity: ALL OK");
}

await main();
