/*
 * Browser shim for node:zlib, as required by just-bash (via almostnode's
 * shell). Only the APIs actually imported by the dependency bundle are
 * re-exported; pako provides compliant gzip implementations.
 */
import {
  constants as pakoConstants,
  gunzipSync as pakoGunzipSync,
  gzipSync as pakoGzipSync,
} from 'pako'

export const constants = {
  ...pakoConstants,
  Z_DEFAULT_COMPRESSION: -1,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
}

export function gunzipSync(buffer: Uint8Array, options?: object): Uint8Array {
  void options
  return pakoGunzipSync(buffer)
}

export function gzipSync(data: Uint8Array | string, options?: object): Uint8Array {
  void options
  return pakoGzipSync(data)
}
