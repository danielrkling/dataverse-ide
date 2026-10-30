/*
 * Ambient declarations for @solidjs/compiler-wasm32-wasi's browser glue
 * (compiler.wasi-browser.js; the package ships no ESM types).
 */
declare module "@solidjs/compiler-wasm32-wasi" {
  export type SolidWasmTransformOptions = {
    filename: string;
    moduleName: string;
    generate: "dom" | "ssr" | "universal" | "hydrate";
    dev?: boolean;
    sourceMap?: boolean;
  };

  export type SolidWasmTransformResult = {
    code: string;
    map?: unknown;
    html?: string | null;
    css?: string | null;
    errors: unknown[];
  };

  export const transform: (
    code: string,
    options?: Partial<SolidWasmTransformOptions>,
    context?: unknown,
  ) => Promise<SolidWasmTransformResult> | SolidWasmTransformResult;

  export const transformDirectives: (code: string, options?: unknown) => Promise<unknown>;

  export const transformLazy: (code: string, options?: unknown) => Promise<unknown>;

  export const transformRefresh: (code: string, options?: unknown) => Promise<unknown>;

  export const transformSourceNames: (code: string, options?: unknown) => Promise<unknown>;

  export const projectTsrxForTypecheck: (code: string, options?: unknown) => Promise<unknown>;

  export const __napiBindingTarget: string;
}
