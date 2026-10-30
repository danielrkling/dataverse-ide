/*
 * Ambient declaration for the virtual module provided by the
 * `dataverse-ide-esbuild-wasm-inline` plugin in vite.config.ts. It exports
 * the esbuild.wasm binary contents as a base64 string.
 */
declare module 'virtual:esbuild-wasm-binary' {
  const wasmBase64: string

  export default wasmBase64
}
