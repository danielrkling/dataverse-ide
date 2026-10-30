// Smoke test 1: native @solidjs/compiler transform
import { transform } from "@solidjs/compiler";
import { readFileSync } from "node:fs";

const code = readFileSync("sample.tsx", "utf8");
const out = transform(code, {
  filename: "sample.tsx",
  moduleName: "@solidjs/web",
  generate: "dom",
  dev: true,
  sourceMap: true,
});
console.log("--- code ---");
console.log(out.code);
console.log("--- map present:", !!out.map);
const imports = [...out.code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
console.log("--- external imports:", JSON.stringify(imports));
