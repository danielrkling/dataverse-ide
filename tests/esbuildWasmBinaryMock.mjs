/*
 * Test-only replacement for Vite's virtual:esbuild-wasm-binary module.
 *
 * The production build embeds esbuild.wasm as a base64 string via
 * vite.config.ts. The node sanity run aliases that virtual module here so
 * the shared esbuild-wasm transformer can initialize from the real binary.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const wasmPath = resolve(process.cwd(), "node_modules/esbuild-wasm/esbuild.wasm");

export default readFileSync(wasmPath).toString("base64");
