import assert from "node:assert/strict";

import { toJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";

import {
  defaultOutputPath,
  HTML_CONFIG_SCHEMA,
  HTML_DEFAULT_CONFIG,
} from "../src/extensions/html/config.js";

const defaults = v.parse(HTML_CONFIG_SCHEMA, {});

assert.deepEqual(defaults, HTML_DEFAULT_CONFIG);
assert.equal(defaults.outdir, "dist");
assert.deepEqual(defaults.entryPoints, [{ input: "index.html" }]);
assert.equal(defaults.inlineScripts, true);
assert.equal(defaults.inlineFonts, false);
assert.equal(defaults.maxInlineBytes, 0);
assert.deepEqual(defaults.external, []);

const custom = v.parse(HTML_CONFIG_SCHEMA, {
  entryPoints: ["a.html", { input: "pages/b.html", output: "dist/b.html" }],
  outdir: "build",
  inlineFonts: true,
  maxInlineBytes: 1024,
  external: ["vendor/**", "*.min.js"],
});

assert.deepEqual(custom.entryPoints, [
  { input: "a.html" },
  { input: "pages/b.html", output: "dist/b.html" },
]);
assert.equal(custom.inlineFonts, true);
assert.equal(custom.maxInlineBytes, 1024);
assert.deepEqual(custom.external, ["vendor/**", "*.min.js"]);

const invalid = v.parse(HTML_CONFIG_SCHEMA, {
  entryPoints: ["", { input: "" }, "index.html"],
  maxInlineBytes: -1,
  external: [" vendor/** ", "", 3, "*.min.js"],
});

assert.deepEqual(invalid.entryPoints, [{ input: "index.html" }], "empty entries are dropped");
assert.equal(invalid.maxInlineBytes, 0, "invalid values fall back to defaults");
assert.deepEqual(
  invalid.external,
  ["vendor/**", "*.min.js"],
  "invalid external entries are dropped and values are trimmed",
);

const jsonSchema = toJsonSchema(HTML_CONFIG_SCHEMA, { errorMode: "ignore" });

assert.ok(jsonSchema.properties != null, "config produces a JSON schema");

assert.equal(defaultOutputPath("index.html", "dist"), "dist/index.html");
assert.equal(defaultOutputPath("pages/about.html", "dist"), "dist/about.html");

console.log("htmlConfig.sanity: all assertions passed");
