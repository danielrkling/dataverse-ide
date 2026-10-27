/*
 * Ambient declarations for @rolldown/binding-wasm32-wasi's browser glue.
 * The package ships .d.cts for node's wasi glue; the ESM browser glue has
 * no d.ts.
 */
declare module '@rolldown/binding-wasm32-wasi/rolldown-binding.wasi-browser.js' {
  type WasmBinding = {
    transform: (
      filename: string,
      source: string,
      options?: unknown,
    ) => Promise<{ code: string; errors: unknown[] }>

    minify: (
      filename: string,
      source: string,
      options?: unknown,
    ) => Promise<{ code: string; errors: unknown[] }>

    parse: (
      filename: string,
      source: string,
      options?: unknown,
    ) => Promise<unknown>

    isolatedDeclaration: (
      filename: string,
      source: string,
      options?: unknown,
    ) => Promise<{ code: string; errors: unknown[] }>

    __napiBindingTarget: string
  }

  const binding: WasmBinding

  export default binding
}
