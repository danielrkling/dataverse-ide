// Smoke test 2: WASM binding transform (the path a browser worker would use)
import { transform } from "@solidjs/compiler-wasm32-wasi";
import { readFileSync } from "node:fs";

const code = readFileSync("sample.tsx", "utf8");
const t0 = performance.now();
const out = transform(code, {
  filename: "sample.tsx",
  moduleName: "@solidjs/web",
  generate: "dom",
  dev: true,
  sourceMap: true,
});
const dt = performance.now() - t0;
console.log("--- code ok, length:", out.code.length, "| took", dt.toFixed(1), "ms");
const imports = [...out.code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
console.log("imports:", JSON.stringify([...new Set(imports)]));
console.log("map present:", !!out.map);
