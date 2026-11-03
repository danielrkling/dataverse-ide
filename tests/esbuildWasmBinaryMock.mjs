/*
 * Test-only replacement for Vite's virtual:esbuild-wasm-gzip-url module.
 *
 * The production build emits esbuild.wasm as a gzip-compressed, base64-encoded
 * .txt web resource. The node sanity run aliases that virtual module here and
 * exposes the same payload as a data: URL so `fetch()` / DecompressionStream
 * behave like they do in the browser.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

const wasmPath = resolve(process.cwd(), "node_modules/esbuild-wasm/esbuild.wasm");
const base64 = gzipSync(readFileSync(wasmPath)).toString("base64");

/* A data URL whose *text* is the base64 payload, like the emitted .txt file. */
export default `data:text/plain;charset=utf-8,${encodeURIComponent(base64)}`;
