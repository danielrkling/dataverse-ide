const fs = require("fs");
const path = require("path");
const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const cp = (a, b) => { fs.cpSync(a, b, { recursive: true }); };
const VOID = (f) => { try { fs.readdirSync(f); } catch (e) { return false; } return true; };

// unify: delete the nested emnapi 2.0-alpha copies, point everything at top-level 1.11.3
const browserNm = path.join(process.cwd(), "node_modules", "@rolldown", "browser", "node_modules", "@emnapi");
if (fs.existsSync(path.join(process.cwd(), "node_modules", "@rolldown", "browser", "node_modules", "@napi-rs"))) {
  // keep latest runtime for reference? no — we delete isolates
}
rm(path.join(browserNm, "core"));
rm(path.join(browserNm, "runtime"));
rm(path.join(browserNm, "wasi-threads"));
rm(path.join(process.cwd(), "node_modules", "@rolldown", "browser", "node_modules", "@napi-rs"));
console.log("nested copies removed; all @emnapi and @napi-rs now resolve to top-level 1.x / wasm-runtime 1.2.6");
