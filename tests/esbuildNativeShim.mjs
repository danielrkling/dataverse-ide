/*
 * Test-only replacement for the esbuild-wasm package.
 *
 * compiler.ts calls esbuild.initialize({ wasmModule }) which is browser-only;
 * the node sanity run aliases esbuild-wasm here so the shared transform runs
 * on the native esbuild binary instead (same API surface, no init needed).
 */
import * as esbuild from "esbuild";

export const transform = esbuild.transform;
export const build = esbuild.build;
export const version = esbuild.version;
export const formatMessages = esbuild.formatMessages;

export async function initialize() {
  // Native esbuild is ready immediately.
}

export default esbuild;
