import type * as vscodeType from 'vscode'

import { EsbuildBuildRunner } from './buildRunner.js'

import type { BuildOutputFile } from './worker.js'

import {
  contributeExtensionManifest,
} from '../api.js'

import {
  createPanelIcon,
  PANEL_GLYPHS,
  registerExtensionPanel,
} from '../panels.js'

import {
  ESBUILD_DEFAULT_CONFIG,
  configFilePath,
  readEsbuildConfig,
  updateEsbuildConfig,
  type EsbuildConfig,
} from './config.js'

import {
  EsbuildWatcher,
} from './watcher.js'

import type {
  ExtensionContext,
  IdeExtension,
} from '../api.js'

/*
 * esbuild-wasm extension.
 *
 * The wasm compiler runs in a dedicated web worker (worker.ts); the main
 * thread collects workspace sources into an in-memory file map and sends a
 * build request. Bare imports (npm packages) are externalized - install
 * them into the workspace first (npm extension) or bundle later with
 * rolldown.
 */

const OUTPUT_DIRECTORY = '.ide-build'

const SOURCE_EXTENSIONS =
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|css|json)$/i

const MAX_COLLECTED_FILES = 8000

/*
 * node_modules is collected in its own pass with its own cap: in a single
 * root-wide glob query its file count would crowd out actual sources (or
 * be truncated itself), breaking bare-import resolution.
 */
const MAX_COLLECTED_NODE_MODULES_FILES = 12000

const EXCLUDE_PATTERN =
  '{**/.git/**,**/.ide-build/**,**/dist/**,**/out/**,**/node_modules/**}'

const NODE_MODULES_EXCLUDE_PATTERN =
  '{**/.git/**,**/.ide-build/**,**/dist/**,**/out/**}'

type BuildRequest = {
  id: number
  type: 'build'
  entry: string
  files: Record<string, string>
}

type BuildResponse =
  | {
      id: number
      ok: true
      outputs: BuildOutputFile[]
      warnings: string[]
    }
  | {
      id: number
      ok: false
      error: string
    }

function isBuildResponse(value: unknown): value is BuildResponse {
  return (
    typeof value === 'object' &&
    value != null &&
    'id' in value &&
    'ok' in value
  )
}


async function collectWorkspaceSources(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<Record<string, string>> {
  const rootPath = rootUri.path.replace(/\/+$/, '')

  const collect = async (
    pattern: vscodeType.GlobPattern,
    exclude: string,
    cap: number,
  ): Promise<vscodeType.Uri[]> =>
    vscode.workspace.findFiles(pattern, exclude, cap)

  const sourceUris = await collect('**/*', EXCLUDE_PATTERN, MAX_COLLECTED_FILES)

  const nodeModulesUris = await collect(
    'node_modules/**',
    NODE_MODULES_EXCLUDE_PATTERN,
    MAX_COLLECTED_NODE_MODULES_FILES,
  )

  const uris = [...sourceUris, ...nodeModulesUris]

  const files: Record<string, string> = {}

  for (const uri of uris) {
    if (!SOURCE_EXTENSIONS.test(uri.path)) {
      continue
    }

    let relativePath = uri.path
      .slice(rootPath.length)
      .replace(/^\//, '')

    if (relativePath.length === 0) {
      continue
    }

    // Normalize Windows-style drive artifacts if any
    relativePath = relativePath.replaceAll('\\', '/')

    // Only collect text; binary assets inside node_modules (wasm, images)
    // are skipped - esbuild loaders cannot consume them via the map anyway
    try {
      const bytes = await vscode.workspace.fs.readFile(uri)

      files[relativePath] = new TextDecoder().decode(bytes)
    } catch (error) {
      console.warn(
        '[esbuild] skipping unreadable file:',
        relativePath,
        error,
      )
    }
  }

  return files
}

async function writeOutputs(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  outDir: string,
  entryPath: string,
  outputs: BuildOutputFile[],
): Promise<vscodeType.Uri[]> {
  const written: vscodeType.Uri[] = []

  for (const output of outputs) {
    const baseName = entryPath
      .split('/')
      .pop()
      ?.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i, '') ?? 'bundle'

    const suffix = output.path.endsWith('.css')
      ? '.css'
      : '.js'

    const outFile = vscode.Uri.joinPath(
      rootUri,
      outDir,
      `${baseName}${suffix}`,
    )

    const parent = vscode.Uri.joinPath(rootUri, outDir)

    await vscode.workspace.fs.createDirectory(parent)

    await vscode.workspace.fs.writeFile(
      outFile,
      new TextEncoder().encode(output.text),
    )

    written.push(outFile)
  }

  return written
}

export default {
  id: 'esbuild',

  async activate(
    context: ExtensionContext,
  ): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context

    await contributeExtensionManifest({
      id: 'esbuild',
      displayName: 'Dataverse IDE esbuild',
      description: 'esbuild-wasm bundling for workspace files.',
      commands: [
        {
          command: 'dataverseIde.esbuild.build',
          title: 'esbuild: Build Current File',
        },
        {
          command: 'dataverseIde.esbuild.buildActiveFile',
          title: 'esbuild: Build Active File…',
        },
        {
          command: 'dataverseIde.esbuild.buildWorkspace',
          title: 'esbuild: Build Workspace…',
        },
        {
          command: 'dataverseIde.esbuild.startWatch',
          title: 'esbuild: Start Watch',
        },
        {
          command: 'dataverseIde.esbuild.stopWatch',
          title: 'esbuild: Stop Watch',
        },
        {
          command: 'dataverseIde.esbuild.toggleWatch',
          title: 'esbuild: Toggle Watch',
        },
      ],
    })

    const runner = new EsbuildBuildRunner(outputChannel)

    outputChannel.appendLine('[esbuild] extension activated.')

    /*
     * Config-file driven build. All settings come from esbuild.config.json
     * (esbuild/config.ts); there is no vscode-settings fallback.
     */
    let currentConfig: EsbuildConfig = ESBUILD_DEFAULT_CONFIG
    let watcher: EsbuildWatcher | undefined
    let watchEnabled = false

    let lastStatus: 'idle' | 'ok' | 'error' = 'idle'
    let lastMessage = 'No build run yet.'
    let lastFinishedAt: number | undefined

    const statusListeners = new Set<() => void>()

    function firstLine(text: string): string {
      return text.split('\n', 1)[0] ?? text
    }

    function notifyStatus(): void {
      for (const listener of statusListeners) {
        listener()
      }
    }

    /*
     * Load the config file (or defaults when absent) once at activation so
     * the panel and watcher start from the real project settings.
     */
    currentConfig = (await readEsbuildConfig(
      vscode,
      context.workspaceRootUri,
    )).config

    if (currentConfig.watch) {
      ensureWatcher()
      watchEnabled = true
    }

    async function runBuild(
      entryPath: string,
      options?: { silent?: boolean },
    ): Promise<boolean> {
      const started = Date.now()

      try {
        if (options?.silent !== true) {
          outputChannel.show(true)
        }

        outputChannel.appendLine(`[esbuild] Building ${entryPath}…`)

        const files = await collectWorkspaceSources(
          vscode,
          context.workspaceRootUri,
        )

        if (files[entryPath] == null) {
          throw new Error(
            `Entry ${entryPath} was not collected from the workspace. Check the entry setting in esbuild.config.json.`,
          )
        }

        const response = await runner.build({
          entry: entryPath,
          files,
          format: currentConfig.format,
          minify: currentConfig.minify,
          sourcemap: currentConfig.sourcemap,
          target: currentConfig.target,
          bundle: currentConfig.bundle,
          external: currentConfig.external,
          define: currentConfig.define,
        })

        if (!response.ok) {
          outputChannel.appendLine(response.error)
          outputChannel.show(true)

          lastStatus = 'error'
          lastMessage = firstLine(response.error)
          lastFinishedAt = Date.now()
          notifyStatus()

          return false
        }

        for (const warning of response.warnings) {
          outputChannel.appendLine(`[esbuild] warning: ${warning}`)
        }

        if (response.outputs.length === 0) {
          outputChannel.appendLine('[esbuild] produced no output.')

          lastStatus = 'error'
          lastMessage = 'Build produced no output.'
          lastFinishedAt = Date.now()
          notifyStatus()

          return false
        }

        const writtenUris = await writeOutputs(
          vscode,
          context.workspaceRootUri,
          currentConfig.outDir,
          entryPath,
          response.outputs,
        )

        const elapsed = Date.now() - started

        const summary = `Built ${entryPath} in ${elapsed}ms → ${writtenUris.map((uri) => vscode.workspace.asRelativePath(uri, false)).join(', ')}`

        outputChannel.appendLine(`[esbuild] ${summary}`)

        if (options?.silent !== true) {
          outputChannel.show(true)
        }

        lastStatus = 'ok'
        lastMessage = summary
        lastFinishedAt = Date.now()
        notifyStatus()

        return true
      } catch (error) {
        console.error('[esbuild] build error:', error)

        const message =
          error instanceof Error ? error.message : String(error)

        outputChannel.appendLine(`[esbuild] ${message}`)
        outputChannel.show(true)

        lastStatus = 'error'
        lastMessage = message
        lastFinishedAt = Date.now()
        notifyStatus()

        if (options?.silent !== true) {
          await vscode.window.showErrorMessage(
            `[esbuild] Build failed: ${message}`,
          )
        }

        return false
      }
    }

    const buildActiveFileCommand = vscode.commands.registerCommand(
      'dataverseIde.esbuild.build',
      async (arg?: string | unknown) => {
        let entryPath: string

        if (typeof arg === 'string' && arg.trim().length > 0) {
          entryPath = arg.replaceAll('\\', '/')
        } else {
          const activeEditor = vscode.window.activeTextEditor

          if (activeEditor == null) {
            await vscode.window.showWarningMessage(
              '[esbuild] Open a file in the editor to build it.',
            )

            return
          }

          const document = activeEditor.document

          if (document.uri.scheme !== 'file') {
            await vscode.window.showWarningMessage(
              '[esbuild] Only workspace files can be built.',
            )

            return
          }

          entryPath = vscode.workspace
            .asRelativePath(document.uri, false)
            .replaceAll('\\', '/')
        }

        await runBuild(entryPath)
      },
    )

    /*
     * Watch lifecycle. The watcher reads the live config (entry/outDir)
     * through callbacks so config edits apply without restarting.
     */
    function ensureWatcher(): EsbuildWatcher {
      if (watcher != null) {
        return watcher
      }

      watcher = new EsbuildWatcher(
        vscode,
        context.workspaceRootUri,
        {
          outDir: () => currentConfig.outDir,
          entry: () => currentConfig.entry,
          build: async (entry) => {
            await runBuild(entry, { silent: true })
          },
        },
      )

      return watcher
    }

    async function setWatchEnabled(enabled: boolean): Promise<void> {
      if (enabled === watchEnabled) {
        return
      }

      watchEnabled = enabled

      if (enabled) {
        ensureWatcher()
      } else {
        watcher?.dispose()
        watcher = undefined
      }

      /*
       * Persist the preference into esbuild.config.json so a project
       * re-opens with the same watch behavior.
       */
      currentConfig = { ...currentConfig, watch: enabled }

      await updateEsbuildConfig(vscode, context.workspaceRootUri, {
        watch: enabled,
      })

      notifyStatus()
    }

    const startWatchCommand = vscode.commands.registerCommand(
      'dataverseIde.esbuild.startWatch',
      () => setWatchEnabled(true),
    )

    const stopWatchCommand = vscode.commands.registerCommand(
      'dataverseIde.esbuild.stopWatch',
      () => setWatchEnabled(false),
    )

    const toggleWatchCommand = vscode.commands.registerCommand(
      'dataverseIde.esbuild.toggleWatch',
      () => setWatchEnabled(!watchEnabled),
    )

    const buildConfiguredEntryCommand = vscode.commands.registerCommand(
      'dataverseIde.esbuild.buildConfigured',
      async () => {
        const { config } = await readEsbuildConfig(
          vscode,
          context.workspaceRootUri,
        )

        currentConfig = config

        await runBuild(config.entry)
      },
    )

    const openConfigCommand = vscode.commands.registerCommand(
      'dataverseIde.esbuild.openConfig',
      async () => {
        const uri = configFilePath(vscode, context.workspaceRootUri)

        try {
          await vscode.workspace.fs.stat(uri)
        } catch {
          /*
           * Scaffold the file with the merged defaults on first open so the
           * editor shows something meaningful to edit.
           */
          await updateEsbuildConfig(vscode, context.workspaceRootUri, {})
        }

        await vscode.window.showTextDocument(uri)
      },
    )

    const outputChannelCommand = vscode.commands.registerCommand(
      'dataverseIde.esbuild.showOutput',
      () => {
        outputChannel.show(true)
      },
    )

    /*
     * Sidebar panel: "esbuild" — convenience editor over esbuild.config.json
     * (the source of truth) plus watch controls. The panel uses a
     * file-backed store: reads come from the file, writes go to the file,
     * and edits made in the text editor re-sync the panel controls.
     */
    const buildPanel = registerExtensionPanel(vscode, {
      extensionId: 'esbuild',
      title: 'esbuild',
      icon: createPanelIcon(PANEL_GLYPHS.zap),
      description:
        'Settings are stored in esbuild.config.json at the workspace root (committed with the project).',
      workspaceRootUri: context.workspaceRootUri,
      store: {
        get: (_key, defaultValue) => currentConfig[
          _key as keyof EsbuildConfig
        ] as typeof defaultValue,

        set: async (key, value) => {
          currentConfig = await updateEsbuildConfig(
            vscode,
            context.workspaceRootUri,
            { [key]: value } as Partial<EsbuildConfig>,
          )
        },

        onChange: (listener) =>
          context.vscode.workspace.onDidSaveTextDocument(async (document) => {
            if (!document.uri.path.endsWith('/esbuild.config.json')) {
              return
            }

            /*
             * Reload the live config before the panel re-syncs its
             * controls so they display the file's new values.
             */
            currentConfig = (await readEsbuildConfig(
              vscode,
              context.workspaceRootUri,
            )).config

            listener()
          }),
      },
      settings: [
        {
          type: 'string',
          key: 'entry',
          label: 'Entry',
          default: ESBUILD_DEFAULT_CONFIG.entry,
          description: 'Workspace-relative entry file to bundle',
        },
        {
          type: 'string',
          key: 'outDir',
          label: 'Output directory',
          default: ESBUILD_DEFAULT_CONFIG.outDir,
        },
        {
          type: 'enum',
          key: 'format',
          label: 'Output format',
          default: 'esm',
          options: [
            { value: 'esm', label: 'ESM (default)' },
            { value: 'iife', label: 'IIFE (browser script)' },
            { value: 'cjs', label: 'CommonJS' },
          ],
        },
        {
          type: 'boolean',
          key: 'minify',
          label: 'Minify output',
          default: false,
        },
        {
          type: 'boolean',
          key: 'sourcemap',
          label: 'Source maps',
          default: false,
        },
        {
          type: 'string',
          key: 'target',
          label: 'Target',
          default: 'es2022',
          description: 'esbuild syntax target, e.g. es2020, esnext',
        },
      ],
      actions: [
        {
          label: 'Build Now',
          command: 'dataverseIde.esbuild.buildConfigured',
          primary: true,
        },
        {
          label: 'Start Watch',
          command: 'dataverseIde.esbuild.startWatch',
        },
        {
          label: 'Stop Watch',
          command: 'dataverseIde.esbuild.stopWatch',
        },
        {
          label: 'Open esbuild.config.json',
          command: 'dataverseIde.esbuild.openConfig',
        },
        {
          label: 'Show Output',
          command: 'dataverseIde.esbuild.showOutput',
        },
      ],
    })

    outputChannel.appendLine('[esbuild] commands and panel registered.')

    return {
      dispose() {
        watcher?.dispose()
        buildPanel.dispose()

        startWatchCommand.dispose()
        stopWatchCommand.dispose()
        toggleWatchCommand.dispose()
        buildConfiguredEntryCommand.dispose()
        openConfigCommand.dispose()
        outputChannelCommand.dispose()

        buildActiveFileCommand.dispose()
        runner.dispose()
      },
    }
  },
} satisfies IdeExtension

