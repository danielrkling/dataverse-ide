import type * as vscodeType from 'vscode'

import type { BuildOutputFile } from './worker.js'

/*
 * Main-thread runner for the esbuild worker (src/extensions/esbuild/
 * worker.ts). Shared by the esbuild extension (build commands) and by the
 * node-runtime extension (TS/JSX transpilation before script execution).
 */

export type BuildRequestInput = {
  entry: string
  files: Record<string, string>
  format?: 'esm' | 'iife' | 'cjs'
  minify?: boolean
  sourcemap?: boolean
  target?: string
  bundle?: boolean
  external?: string[]
  define?: Record<string, string>
  entryNames?: string

  /*
   * Lazy resolution: paths proven unreadable in earlier rounds, so the
   * resolver stops requesting them.
   */
  absentPaths?: string[]
}

export type TransformRequestInput = {
  filename: string
  source: string
  minify?: boolean
}

export type BuildResponseOk = {
  ok: true
  outputs: BuildOutputFile[]
  warnings: string[]

  /** Worker pipeline version (stale-bundle diagnosis). */
  pipeline?: string

  /**
   * Lazy resolution probe round: paths to read and retry with.
   * Non-empty outputs/warnings are provisional when this is set.
   */
  needFiles?: string[]
}

export type BuildResponseErr = {
  ok: false
  error: string
}

export type BuildRunnerResponse = BuildResponseOk | BuildResponseErr

type WorkerRequest =
  | ({ id: number; type: 'build' } & BuildRequestInput)
  | ({ id: number; type: 'transform' } & TransformRequestInput)

function isRunnerResponse(value: unknown): value is (BuildRunnerResponse & { id: number }) {
  return (
    typeof value === 'object' &&
    value != null &&
    'id' in value &&
    'ok' in value
  )
}

export class EsbuildBuildRunner {
  private worker: Worker | undefined

  private nextRequestId = 1

  constructor(private readonly outputChannel: vscodeType.OutputChannel) {}

  private ensureWorker(): Worker {
    if (this.worker != null) {
      return this.worker
    }

    this.worker = new Worker(
      new URL('./worker.js', import.meta.url),
      { type: 'module', name: 'dataverse-ide-esbuild' },
    )

    this.worker.onerror = (event) => {
      this.outputChannel.appendLine(
        `[esbuild] worker error: ${
          event.error instanceof Error
            ? `${event.error.message}\n${event.error.stack ?? ''}`
            : (event.message ?? 'unknown error')
        }`,
      )
    }

    this.worker.onmessageerror = (event) => {
      this.outputChannel.appendLine(
        `[esbuild] worker message error: ${JSON.stringify(
          event.data ?? null,
        ).slice(0, 400)}`,
      )
    }

    return this.worker
  }

  private request(fullRequest: WorkerRequest): Promise<BuildRunnerResponse> {
    const worker = this.ensureWorker()
    const id = fullRequest.id

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        worker.removeEventListener('message', onMessage)

        reject(new Error('[esbuild] request timed out after 120s.'))
      }, 120000)

      const onMessage = (event: MessageEvent) => {
        if (!isRunnerResponse(event.data) || event.data.id !== id) {
          return
        }

        window.clearTimeout(timeout)
        worker.removeEventListener('message', onMessage)

        if (event.data.ok === true && event.data.pipeline != null) {
          this.outputChannel.appendLine(
            `[esbuild] worker pipeline ${event.data.pipeline}`,
          )
        }

        resolve(event.data)
      }

      worker.addEventListener('message', onMessage)

      worker.postMessage(fullRequest)
    })
  }

  async build(
    input: BuildRequestInput,
  ): Promise<BuildRunnerResponse> {
    const id = this.nextRequestId++

    return this.request({ id, type: 'build', ...input })
  }

  async transform(
    input: TransformRequestInput,
  ): Promise<BuildRunnerResponse> {
    const id = this.nextRequestId++

    return this.request({ id, type: 'transform', ...input })
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = undefined
  }
}
