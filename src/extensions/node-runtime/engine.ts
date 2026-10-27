/*
 * node-runtime extension: run JavaScript in the workspace like `node`.
 *
 * Engine: almostnode's main-thread, same-origin mode. This is the mode that
 * shares the page's auth context (cookies / fetch credentials) with the
 * Dataverse origin, which is what "run with the auth of the main thread"
 * requires. The engine is behind an interface so it can be swapped
 * (worker, sandbox, or a custom ESM engine) without touching the command
 * surface.
 *
 * almostnode executes modules with CJS-style resolution after transforming
 * ESM sources; see its transform pipeline for caveats.
 */
import { createRuntime } from 'almostnode'
import type { IRuntime } from 'almostnode'

import type * as vscodeType from 'vscode'

import { getSharedVfs } from '../sharedVfs.js'
import { EsbuildBuildRunner } from '../esbuild/buildRunner.js'

export type NodeRuntimeEngine = {
  runFile: (path: string) => Promise<number>
  dispose: () => void
}

const RUNTIME_ROOT = '/'

const IGNORED_DIRECTORIES = [
  'node_modules',
  '.git',
  '.ide-build',
]

export function createAlmostnodeEngine(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  outputChannel: vscodeType.OutputChannel,
): NodeRuntimeEngine {
  let runtime: IRuntime | undefined

  const buildRunner = new EsbuildBuildRunner(outputChannel)

  /*
   * Source files whose text changed between runs are re-transpiled with the
   * esbuild worker; results are cached so repeat runs are cheap.
   */
  const transpileCache = new Map<
    string,
    { sourceLength: number; contents: string } | { invalid: true }
  >()

  async function transpileForRuntime(
    relativePath: string,
    contents: string,
  ): Promise<string> {
    if (!/\.(ts|tsx|jsx|mts|cts)$/i.test(relativePath)) {
      return contents
    }

    const cached = transpileCache.get(relativePath)

    if (cached && 'sourceLength' in cached && cached.sourceLength === contents.length) {
      return cached.contents
    }

    const response = await buildRunner.transform({
      filename: relativePath,
      source: contents,
    })

    if (!response.ok) {
      throw new Error(
        `[node-runtime] transpiling ${relativePath} failed: ${response.error}`,
      )
    }

    const { code } = response.outputs[0] !== undefined ? { code: response.outputs[0].text } : { code: contents }

    transpileCache.set(relativePath, {
      sourceLength: contents.length,
      contents: code,
    })

    return code
  }

  async function ensureRuntime(): Promise<IRuntime> {
    if (runtime != null) {
      return runtime
    }

    const vfs = getSharedVfs()

    runtime = await createRuntime(vfs, {
      /*
       * Trusted-code mode: required to run on the main thread of the same
       * origin so executed scripts share the page's auth context.
       */
      dangerouslyAllowSameOrigin: true,

      cwd: RUNTIME_ROOT,

      env: {
        NODE_ENV: 'development',
      },

      onConsole: (method, args) => {
        const message = args
          .map((argument) =>
            typeof argument === 'string'
              ? argument
              : JSON.stringify(argument),
          )
          .join(' ')

        outputChannel.appendLine(`[node:${method}] ${message}`)
      },
    })

    return runtime
  }

  async function syncWorkspaceIntoVfs(r: IRuntime): Promise<void> {
    const vfs = r.getVFS?.()

    if (vfs == null) {
      throw new Error(
        'The active node runtime does not expose its virtual filesystem.',
      )
    }

    /*
     * node_modules is normally provided by the npm extension through the
     * shared VFS. If it is absent there (e.g. right after a reload of the
     * IDE with a workspace that has a node_modules directory), fall back to
     * syncing it from the workspace.
     */
    const syncNodeModules = !vfs.existsSync('/node_modules')

    const uris = await vscode.workspace.findFiles(
      '**/*',
      '{**/.git/**,**/.ide-build/**}',
      20000,
    )

    for (const uri of uris) {
      const relativePath = vscode.workspace
        .asRelativePath(uri, false)
        .replaceAll('\\', '/')

      if (relativePath.length === 0) {
        continue
      }

      const segments = relativePath.split('/')

      if (
        segments.some(
          (segment) =>
            segment === '.git' || segment === '.ide-build',
        )
      ) {
        continue
      }

      if (
        segments.includes('node_modules') && !syncNodeModules
      ) {
        continue
      }

      try {
        const bytes = await vscode.workspace.fs.readFile(uri)

        const directorySegments = segments.slice(0, -1)

        const isTextFile = /\.(ts|tsx|js|jsx|mjs|cjs|json|txt|css|html|md|ya?ml)$/i.test(
          relativePath,
        )

        if (!isTextFile) {
          continue
        }        if (directorySegments.length > 0) {
          vfs.mkdirSync(`/${directorySegments.join('/')}`, {
            recursive: true,
          })
        }

        // almostnode resolves relative imports with .js/.json extensions
        // only, so TS/JSX sources are transpiled (and stored as .js) before
        // being written into the VFS.
        const targetSegments = [...directorySegments]

        let fileName = segments[segments.length - 1]

        fileName = fileName.replace(/\.(ts|tsx|jsx|mts|cts)$/i, '.js')

        targetSegments.push(fileName)

        const targetPath = `/${targetSegments.join('/')}`

        const decoded = new TextDecoder().decode(bytes)

        try {
          const transformed = await transpileForRuntime(
            relativePath,
            decoded,
          )

          vfs.writeFileSync(targetPath, transformed)
        } catch (error) {
          // Transpile failure: skip the file and surface the error via the
          // output channel
          outputChannel.appendLine(
            error instanceof Error ? error.message : String(error),
          )
        }
      } catch {
        // Binary or unreadable files are skipped.
      }
    }
  }

  return {
    async runFile(entryPath: string): Promise<number> {
      outputChannel.appendLine(`[node] Running ${entryPath}…`)

      const started = Date.now()

      const r = await ensureRuntime()

      /*
       * Fresh module graph per run, but the shared VFS (and with it npm
       * installed packages) persists between runs.
       */
      r.clearCache()

      await syncWorkspaceIntoVfs(r)

      try {
        await r.runFile(`/${entryPath}`)
      } catch (error) {
        const message =
          error instanceof Error
            ? `${error.message}`
            : String(error)

        outputChannel.appendLine(`[node] Uncaught: ${message}`)
        outputChannel.show(true)

        return 1
      }

      outputChannel.appendLine(
        `[node] Finished in ${Date.now() - started}ms.`,
      )

      return 0
    },

    dispose() {
      runtime?.terminate?.()
      buildRunner.dispose()
      runtime = undefined
    },
  }
}

export { IGNORED_DIRECTORIES as NODE_RUNTIME_IGNORED_DIRECTORIES }
