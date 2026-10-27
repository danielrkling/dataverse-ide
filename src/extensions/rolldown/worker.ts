/*
 * rolldown worker: runs the oxc WASM primitives (via
 * @rolldown/binding-wasm32-wasi's browser glue) off the main thread.
 *
 * Protocol (plain postMessage request/response):
 *   { id, type: 'transform' | 'minify', filename, source, options? }
 *   <- { id, ok, result }
 *   <- { id, ok: false, error }
 *
 * NOTE: the full `rolldown()` bundler API is not available in the browser
 * (rolldown's published binding loader is Node-oriented). What IS available
 * is oxc's fast transpile (TS/JSX -> JS), minify, and isolated declarations -
 * these back the extension commands.
 */

import binding from '@rolldown/binding-wasm32-wasi/rolldown-binding.wasi-browser.js'

type Request =
  | {
      id: number
      type: 'transform' | 'minify'
      filename: string
      source: string
    }

type Response =
  | {
      id: number
      ok: true
      result: string
    }
  | {
      id: number
      ok: false
      error: string
    }

self.onmessage = async (event: MessageEvent<Request>): Promise<void> => {
  const request = event.data

  if (request?.type == null) {
    return
  }

  let response: Response

  try {
    if (request.type === 'transform') {
      const result = await (binding as {
        transform: (
          filename: string,
          source: string,
        ) => Promise<{ code: string; errors: unknown[] }>
      }).transform(request.filename, request.source)

      if (result.errors.length > 0) {
        throw new Error(
          result.errors
            .map((error: unknown) => JSON.stringify(error))
            .join('\n'),
        )
      }

      response = { id: request.id, ok: true, result: result.code }
    } else if (request.type === 'minify') {
      const result = await (binding as {
        minify: (
          filename: string,
          source: string,
        ) => Promise<{ code: string; errors: unknown[] }>
      }).minify(request.filename, request.source)

      if (result.errors.length > 0) {
        throw new Error(
          result.errors
            .map((error: unknown) => JSON.stringify(error))
            .join('\n'),
        )
      }

      response = { id: request.id, ok: true, result: result.code }
    } else {
      throw new Error(`Unsupported rolldown operation: ${request.type}`)
    }
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }

  self.postMessage(response)
}
