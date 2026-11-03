/*
 * Ambient declaration for the virtual module provided by the
 * `dataverse-ide-wasm-inline` plugin in vite.config.ts. It exports the URL of
 * an emitted gzip-compressed, base64-encoded esbuild.wasm asset.
 */
declare module "virtual:esbuild-wasm-gzip-url" {
  const wasmGzipUrl: string;

  export default wasmGzipUrl;
}
