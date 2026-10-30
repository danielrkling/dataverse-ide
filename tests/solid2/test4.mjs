// FINAL: @rolldown/browser + @solidjs/compiler-wasm, full bundle, no externals
import { rolldown } from "@rolldown/browser";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import * as pathmod from "node:path";
import { transform as solidTransform } from "@solidjs/compiler-wasm32-wasi";

const nodeRequire = createRequire(import.meta.url);

let transformCalls = 0;

const solidPlugin = {
  name: "solid",
  transform(code, id) {
    if (!(id.endsWith(".tsx") || id.endsWith(".jsx"))) return;
    transformCalls++;
    const out = solidTransform(code, {
      filename: id,
      moduleName: "@solidjs/web",
      generate: "dom",
      dev: true,
      sourceMap: false,
    });
    return { code: out.code, map: out.map ?? undefined };
  },
};

const workspacePlugin = {
  name: "workspace-rs",
  resolveId(source, importer) {
    if (source.startsWith(".") || source.startsWith("/")) {
      // relative imports anywhere (workspace files *and* inside node_modules)
      const dir = importer ? pathmod.dirname(importer) : "src";
      const p = pathmod.resolve(dir, source).replace(/\\/g, "/");
      return existsSync(p) ? p : null;
    }
    if (source === "solid-js" || source.startsWith("@solidjs/")) {
      return nodeRequire.resolve(source, { paths: [process.cwd()] }); // stand-in for the IDE's resolver.ts
    }
    if (existsSync(source)) return source; // entry point
    return null;
  },
  load(id) {
    if (existsSync(id)) return readFileSync(id, "utf8");
    return null;
  },
};

try {
  const bundle = await rolldown({
    input: "src/index.tsx",
    plugins: [workspacePlugin, solidPlugin],
    moduleTypes: { ".ts": "ts", ".tsx": "tsx" },
  });
  const { output } = await bundle.generate({ format: "esm" });
  console.log(`--- chunks: ${output.length}, solid transforms: ${transformCalls}`);
  const code = output[0].code;
  console.log(code.split("\n").slice(0, 12).join("\n"));
  writeFileSync("out-final.js", code);
  console.log("--- residual JSX/TS check:", /_\$\$click|jsx\(/.test(code) || /<div\b/.test(code) ? "FOUND (bad)" : "none (good)");
  console.log("=== FULL BUNDLE OK");
} catch (e) {
  console.error("=== FAILED:", e?.message || e);
  console.error(e?.stack?.split("\n").slice(0, 10).join("\n"));
  process.exitCode = 1;
}
