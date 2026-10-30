declare module 'pako' {
  export const constants: Record<string, number>

  export function gunzipSync(
    data: Uint8Array,
    options?: unknown,
  ): Uint8Array

  export function gzipSync(
    data: Uint8Array | string,
    options?: unknown,
  ): Uint8Array
}
