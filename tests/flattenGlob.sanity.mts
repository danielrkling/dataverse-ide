/*
 * Flatten glob sanity harness.
 *
 * Run:
 *   npx esbuild tests/flattenGlob.sanity.mts --bundle --platform=node --format=esm \
 *     --outfile=/tmp/flattenGlob.sanity.mjs && node /tmp/flattenGlob.sanity.mjs
 */

import assert from "node:assert/strict";

import {
  createGlobMatcher,
  globBaseSegments,
  globStartsInside,
  isGlobPattern,
} from "../src/extensions/flatten/glob.ts";

assert.equal(isGlobPattern("src"), false);
assert.equal(isGlobPattern("node_modules/pkg/README.md"), false);
assert.equal(isGlobPattern("node_modules/@scope/pkg/index.d.ts"), false);
assert.equal(isGlobPattern("src/foo(bar).ts"), true);
assert.equal(isGlobPattern("*.md"), true);
assert.equal(isGlobPattern("node_modules/**/*.{md,d.ts}"), true);
assert.equal(isGlobPattern("src/file?.ts"), true);
assert.equal(isGlobPattern("src/[ab].ts"), true);
assert.equal(isGlobPattern("src/@(a|b).ts"), true);
assert.equal(isGlobPattern("src/{literal}/*.ts"), true);

const matches = createGlobMatcher("node_modules/**/*.{md,d.ts}");

for (const path of [
  "node_modules/react/README.md",
  "node_modules/react/index.d.ts",
  "node_modules/react/lib/deep/README.md",
  "node_modules/@scope/pkg/types/index.d.ts",
]) {
  assert.ok(matches(path), `expected ${path} to match`);
}

for (const path of [
  "node_modules/react/index.js",
  "node_modules/react/README.txt",
  "src/app.md",
  "node_modulesx/react/README.md",
]) {
  assert.ok(!matches(path), `expected ${path} not to match`);
}

const sourceMatches = createGlobMatcher("src/**/*.{ts,tsx}");

assert.ok(sourceMatches("src/app.ts"), "** matches zero intermediate folders");
assert.ok(sourceMatches("src/components/app.tsx"), "** matches nested folders");
assert.ok(!sourceMatches("src/app.js"), "extensions outside the brace group are excluded");
assert.ok(!sourceMatches("srcx/app.ts"), "literal prefix must match a whole segment");

const classMatches = createGlobMatcher("src/[ab].ts");

assert.ok(classMatches("src/a.ts"), "character classes match a listed character");
assert.ok(classMatches("src/b.ts"), "character classes match a listed character");
assert.ok(!classMatches("src/c.ts"), "character classes reject other characters");

const extglobMatches = createGlobMatcher("src/!(ignored).ts");

assert.ok(extglobMatches("src/app.ts"), "extglobs match regular files");
assert.ok(!extglobMatches("src/ignored.ts"), "extglobs reject excluded names");

assert.ok(createGlobMatcher("**/*.md")("node_modules/.hidden/README.md"), "dotfiles are included");
assert.ok(createGlobMatcher("SRC/**/*.TS")("src/app.ts"), "matching is case-insensitive");
assert.ok(
  !createGlobMatcher("!src/app.ts")("src/app.ts"),
  "a leading ! is literal rather than a negation",
);

assert.deepEqual(globBaseSegments("node_modules/**/*.{md,d.ts}"), ["node_modules"]);
assert.deepEqual(globBaseSegments("node_modules/react/*.md"), ["node_modules", "react"]);
assert.deepEqual(globBaseSegments("**/*.md"), []);
assert.deepEqual(globBaseSegments("src/{feature,shared}/**/*.ts"), ["src"]);
assert.deepEqual(globBaseSegments("src/{literal}/{a,b}.ts"), ["src"]);

const excluded = new Set(["node_modules", "dist", ".git"]);

assert.equal(globStartsInside("node_modules/**/*.md", excluded), true);
assert.equal(globStartsInside("packages/app/dist/**/*.d.ts", excluded), true);
assert.equal(globStartsInside("src/**/*.ts", excluded), false);
assert.equal(globStartsInside("**/*.md", excluded), false);
assert.equal(globStartsInside("node_modulesx/**/*.ts", excluded), false);

console.log("flatten glob sanity: ok");
