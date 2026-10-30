// Isolated: @rolldown/browser + JS plugins, no other napi packages in tree
import { rolldown } from "@rolldown/browser";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

let transformCalls = 0, resolveCalls = 0, loadCalls = 0;

const solidPlugin = {
  name: "solid",
  async transform(code, id) {
    transformCalls++;
    console.log("[transform]", id);
    if (!(id.endsWith(".tsx") || id.endsWith(".jsx"))) return;
    return { code: code.replace(/createSignal/g, "___ok_signal"), map: null };
  },
};

const workspacePlugin = {
  name: "workspace-fs",
  resolveId(source, importer) {
    resolveCalls++;
    if (source.startsWith(".")) {
      const dir = importer ? importer.slice(0, importer.lastIndexOf("/")) : "src";
      return `${dir}/${source.slice(2)}`;
    }
    if (source === "solid-js" || source === "@solidjs/web") return source;
    if (existsSync(source)) return source.startsWith("src/") ? source : null;
    return null;
  },
  load(id) {
    loadCalls++;
    if (id === "solid-js" || id === "@solidjs/web") return null;
    if (existsSync(id)) return readFileSync(id, "utf8");
    return null;
  },
};

try {
  const bundle = await rolldown({
    input: "src/index.tsx",
    plugins: [workspacePlugin, solidPlugin],
    moduleTypes: { ".ts": "ts", ".tsx": "tsx" },
    external: (id) => id === "solid-js" || id === "@solidjs/web",
  });
  const { output } = await bundle.generate({ format: "esm" });
  console.log(`--- ${output.length} chunks; hooks: transform=${transformCalls} resolve=${resolveCalls} load=${loadCalls}`);
  console.log(output[0].code.split("\n").slice(0, 8).join("\n"));
  writeFileSync("out.js", output[0].code);
  console.log("=== BUNDLE OK");
} catch (e) {
  console.error("=== BUNDLE FAILED:", e?.message || e);
  console.error(e?.stack?.split("\n").slice(0, 8).join("\n"));
  process.exitCode = 1;
}
