/*
 * Runtime helper for the rolldown wasm binding (vite-config wasm inliner).
 *
 * The napi-rs wasi browser glue instantiates its threading workers from the
 * worker script source; this turns that source into a blob URL, which works
 * under Dataverse's same-origin CSP (worker-src blob:) without a separate
 * deployed asset file.
 */
export function createNapiWasiWorkerBlobUrl(code: string): string {
  const blob = new Blob([code], { type: 'text/javascript' })

  return URL.createObjectURL(blob)
}
