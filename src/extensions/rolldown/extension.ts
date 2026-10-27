import type * as vscodeType from 'vscode'

import {
  contributeCommandManifest,
} from '../api.js'

import type {
  ExtensionContext,
  IdeExtension,
} from '../api.js'

/*
 * rolldown extension: oxc-powered WASM compilation primitives in a worker.
 *
 * Capabilities (browser-verified pieces of the wasm binding):
 *   - "rolldown: Transform Current File"  TS/JSX -> JS (oxc transform)
 *   - "rolldown: Minify Current File"     minified single-line output
 *
 * Explicitly NOT supported in the browser: full rolldown bundling. The
 * published rolldown loader is Node/WebContainer-only (it shells out to
 * pnpm + fs); revisit when rolldown ships a first-class browser entry.
 * Bundling today goes through the esbuild extension.
 */

const OUTPUT_DIRECTORY = '.ide-build'

type Request =
  | {
      id: number
      type: 'transform' | 'minify'
      filename: string
      source: string
    }

type Response =
  | { id: number; ok: true; result: string }
  | { id: number; ok: false; error: string }

function isResponse(value: unknown): value is Response {
  return (
    typeof value === 'object' &&
    value != null &&
    'ok' in value &&
    'id' in value
  )
}

class RolldownRunner {
  private worker: Worker | undefined

  private nextRequestId = 1

  constructor(private readonly outputChannel: vscodeType.OutputChannel) {}

  private ensureWorker(): Worker {
    if (this.worker != null) {
      return this.worker
    }

    this.worker = new Worker(
      new URL('./worker.js', import.meta.url),
      { type: 'module', name: 'dataverse-ide-rolldown' },
    )

    this.worker.onerror = (event) => {
      this.outputChannel.appendLine(
        `[rolldown] worker error: ${event.message ?? 'unknown error'}`,
      )
    }

    return this.worker
  }

  async run(request: Omit<Request, 'id'>): Promise<string> {
    const worker = this.ensureWorker()
    const id = this.nextRequestId++

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        worker.removeEventListener('message', onMessage)
        reject(new Error('[rolldown] operation timed out after 120s.'))
      }, 120000)

      const onMessage = (event: MessageEvent) => {
        if (!isResponse(event.data) || event.data.id !== id) {
          return
        }

        window.clearTimeout(timeout)
        worker.removeEventListener('message', onMessage)

        if (event.data.ok) {
          resolve(event.data.result)
        } else {
          reject(new Error(event.data.error))
        }
      }

      worker.addEventListener('message', onMessage)

      worker.postMessage({ id, ...request })
    })
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = undefined
  }
}

async function resolveCurrentFile(
  vscode: typeof vscodeType,
): Promise<{
  document: vscodeType.TextDocument
  relativePath: string
} | undefined> {
  const activeEditor = vscode.window.activeTextEditor

  if (activeEditor == null || activeEditor.document.uri.scheme !== 'file') {
    return undefined
  }

  const document = activeEditor.document

  const relativePath = vscode.workspace
    .asRelativePath(document.uri, false)
    .replaceAll('\\', '/')

  return { document, relativePath }
}

export default {
  id: 'rolldown',

  async activate(
    context: ExtensionContext,
  ): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context

    await contributeCommandManifest({
      id: 'rolldown',
      displayName: 'Dataverse IDE Rolldown (oxc wasm)',
      description: 'oxc-powered transform/minify via the rolldown wasm binding.',
      commands: [
        {
          command: 'dataverseIde.rolldown.transform',
          title: 'rolldown: Transform Current File (TS/JSX → JS)',
        },
        {
          command: 'dataverseIde.rolldown.minify',
          title: 'rolldown: Minify Current File',
        },
      ],
    })

    const runner = new RolldownRunner(outputChannel)

    outputChannel.appendLine('[rolldown] extension activated (wasm primitives).')

    async function withCurrentFile(
      operation: 'transform' | 'minify',
    ): Promise<void> {
      const current = await resolveCurrentFile(vscode)

      if (current == null) {
        await vscode.window.showWarningMessage(
          '[rolldown] Open a workspace file in the editor first.',
        )

        return
      }

      const { document, relativePath } = current

      try {
        const started = Date.now()

        outputChannel.show(true)
        outputChannel.appendLine(
          `[rolldown] ${operation}: ${relativePath}…`,
        )

        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `[rolldown] ${operation} ${relativePath}…`,
            cancellable: false,
          },
          async () => {
            const result = await runner.run({
              type: operation,
              filename: relativePath,
              source: document.getText(),
            })

            return result
          },
        )

        const baseName = relativePath
          .split('/')
          .pop()
          ?.replace(/\.[^.]+$/, '') ?? 'output'

        const extension = operation === 'minify' ? '.min.js' : '.mjs'

        const outFile = vscode.Uri.joinPath(
          context.workspaceRootUri,
          OUTPUT_DIRECTORY,
          `${baseName}${extension}`,
        )

        await vscode.workspace.fs.createDirectory(
          vscode.Uri.joinPath(context.workspaceRootUri, OUTPUT_DIRECTORY),
        )

        await vscode.workspace.fs.writeFile(
          outFile,
          new TextEncoder().encode(result),
        )

        const elapsed = Date.now() - started

        outputChannel.appendLine(
          `[rolldown] ${operation} finished in ${elapsed}ms -> ${vscode.workspace.asRelativePath(outFile, false)}`,
        )

        await vscode.window.showInformationMessage(
          `[rolldown] ${operation} finished in ${elapsed}ms.`,
        )
      } catch (error) {
        console.error('[rolldown] operation error:', error)

        const message =
          error instanceof Error ? error.message : String(error)

        outputChannel.appendLine(`[rolldown] ${message}`)
        outputChannel.show(true)

        await vscode.window.showErrorMessage(
          `[rolldown] ${operation} failed: ${message}`,
        )
      }
    }

    const transformCommand = vscode.commands.registerCommand(
      'dataverseIde.rolldown.transform',
      async () => {
        await withCurrentFile('transform')
      },
    )

    const minifyCommand = vscode.commands.registerCommand(
      'dataverseIde.rolldown.minify',
      async () => {
        await withCurrentFile('minify')
      },
    )

    outputChannel.appendLine(
      '[rolldown] commands registered: transform, minify.',
    )

    return {
      dispose() {
        transformCommand.dispose()
        minifyCommand.dispose()
        runner.dispose()
      },
    }
  },
} satisfies IdeExtension
