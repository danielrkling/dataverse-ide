/*
 * Solid 2.0 toolchain prototype harness (proven 2026-10-29).
 * Lives here for reference; run notes and findings in ../TODO.md ("Solid JS toolchain").
 *
 * NOTE: after the 2026-10-29 revert (the in-worker integration wasn't stable),
 * @solidjs/compiler-wasm32-wasi is no longer a repo dependency - install it in
 * a scratch dir as below if you want to re-run these.
 *
 * Standalone usage (in a scratch dir, not this repo):
 *   npm i @rolldown/browser@1.2.15 @solidjs/compiler-wasm32-wasi@next solid-js@next @solidjs/web@next @emnapi/core@1.11.3 @emnapi/runtime@1.11.3
 *   node unify.cjs                      # fix @rolldown/browser's emnapi 2.0-alpha nested copies
 *   copy .tsx app files into ./src      # simplest: use @solidjs/vite-plugin-free entry into src/index.tsx
 *   node test4.mjs                      # -> out-final.js
 */
