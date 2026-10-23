import { Buffer as BrowserBuffer } from 'buffer'

/*
 * isomorphic-git expects the Node-compatible Buffer global for portions of its
 * index/object implementation. Browsers do not provide Buffer natively.
 */
const globalScope = globalThis as typeof globalThis & {
  Buffer?: typeof BrowserBuffer
}

globalScope.Buffer ??= BrowserBuffer