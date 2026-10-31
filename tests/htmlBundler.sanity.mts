import assert from "node:assert/strict";

import {
  bundleHtml,
  minifyHtml,
  resolveWorkspaceReference,
  type HtmlInlineOptions,
} from "../src/extensions/html/bundler.js";

/*
 * Sanity checks for the pure HTML inlining core:
 *   npx esbuild tests/htmlBundler.sanity.mts --bundle --platform=node --format=esm --outfile=... && node ...
 */

const textFiles: Record<string, string> = {
  "index.html": `<!doctype html>
<html>
  <head>
    <!-- remove me -->
    <link rel="stylesheet" href="css/app.css" media="screen">
    <link rel="icon" href="img/logo.svg">
    <script src="js/app.js" defer></script>
    <script src="https://cdn.example.com/remote.js"></script>
    <style>.inline { background: url("./img/logo.svg"); }</style>
  </head>
  <body>
    <img src="img/logo.svg" alt="logo">
    <img src="img/photo.png" srcset="img/photo.png 1x, img/photo@2x.png 2x">
    <img src="img/missing.png" alt="missing">
  </body>
</html>`,
  "css/app.css": `@import "./base.css";\nbody { background: url("../img/photo.png"); }`,
  "css/base.css": `.base { color: red; }`,
  "js/app.js": `console.log("</script>");`,
  "img/logo.svg": `<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>`,
};

const binaryFiles: Record<string, Uint8Array> = {
  "img/photo.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "img/photo@2x.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b]),
};

const options: HtmlInlineOptions = {
  inlineScripts: true,
  inlineStyles: true,
  inlineSvg: true,
  inlineImages: true,
  inlineFonts: false,
  inlineCssUrls: true,
  maxInlineBytes: 0,
  minify: false,
  removeComments: true,
};

const touched: string[] = [];

const result = await bundleHtml({
  path: "index.html",
  html: textFiles["index.html"],
  options,
  readText: async (path) => textFiles[path],
  readBytes: async (path) => {
    const binary = binaryFiles[path];

    if (binary != null) {
      return binary;
    }

    const text = textFiles[path];

    return text != null ? new TextEncoder().encode(text) : undefined;
  },
  onDependency: (path) => touched.push(path),
});

assert.equal(result.warnings.length, 1, "one warning for the missing image");
assert.match(result.warnings[0], /img\/missing\.png/);

assert.ok(!result.html.includes("remove me"), "HTML comments are removed");
assert.ok(
  result.html.includes('<style media="screen">'),
  "stylesheet link becomes a style tag with its media attribute",
);
assert.ok(result.html.includes(".base { color: red; }"), "nested @import content is inlined");
assert.ok(result.html.includes("data:image/png;base64,"), "CSS url() and img src become data URIs");
assert.ok(result.html.includes("data:image/svg+xml;base64,"), "SVG assets become data URIs");
assert.ok(
  result.html.includes('srcset="data:image/png;base64,'),
  "srcset entries become data URIs",
);
assert.ok(
  result.html.includes("<\\/script>"),
  "script content cannot close the surrounding script tag",
);
assert.ok(!result.html.includes('src="js/app.js"'), "local script src is removed");
assert.ok(
  result.html.includes('src="https://cdn.example.com/remote.js"'),
  "remote references are untouched",
);
assert.ok(
  result.html.includes('src="img/missing.png"'),
  "missing assets keep their original reference",
);
assert.ok(
  result.html.includes('<style>.inline { background: url("data:image/svg+xml;base64,'),
  "inline style blocks have their url() assets inlined",
);

for (const dependency of [
  "css/app.css",
  "css/base.css",
  "js/app.js",
  "img/logo.svg",
  "img/photo.png",
  "img/photo@2x.png",
]) {
  assert.ok(result.dependencies.includes(dependency), `dependency ${dependency} was recorded`);
}

assert.ok(
  result.dependencies.includes("img/missing.png"),
  "missing dependencies are recorded so watch can rebuild when they appear",
);

assert.equal(
  resolveWorkspaceReference("pages/about.html", "../src/app.js"),
  "src/app.js",
  "parent segments resolve within the workspace",
);

assert.equal(
  resolveWorkspaceReference("pages/about.html", "../../outside.js"),
  undefined,
  "paths escaping the workspace are rejected",
);

assert.equal(
  resolveWorkspaceReference("index.html", "https://example.com/a.js"),
  undefined,
  "remote URLs are rejected",
);

const minified = minifyHtml(`<div>\n  <pre> keep\n   this </pre>\n  <span>a</span>\n</div>`);

assert.ok(minified.includes("keep\n   this"), "pre content is preserved");
assert.ok(
  minified.includes("</span></div>") && !minified.includes("\n  <span>"),
  "whitespace outside protected blocks is collapsed",
);

const minifiedBlocks = minifyHtml(
  `<script>const x = "a  b";</script>\n<style>.a { color: red; }</style>\n<div>  text  </div>`,
);

assert.ok(
  minifiedBlocks.includes('const x = "a  b";'),
  "script content is preserved while minifying",
);
assert.ok(
  minifiedBlocks.includes(".a { color: red; }"),
  "style content is preserved while minifying",
);
assert.ok(minifiedBlocks.includes("<div> text </div>"), "text whitespace is collapsed");

console.log("htmlBundler.sanity: all assertions passed");
