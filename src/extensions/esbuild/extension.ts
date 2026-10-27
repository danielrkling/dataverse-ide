import type * as vscodeType from 'vscode'

import { EsbuildBuildRunner } from './buildRunner.js'

import type { BuildOutputFile } from './worker.js'

import {
  contributeExtensionManifest,
} from '../api.js'

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

const EXCLUDE_PATTERN =
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
  const uris = await vscode.workspace.findFiles(
    '**/*',
    EXCLUDE_PATTERN,
    MAX_COLLECTED_FILES,
  )

  const files: Record<string, string> = {}

  const rootPath = rootUri.path

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
      OUTPUT_DIRECTORY,
      `${baseName}${suffix}`,
    )

    const parent = vscode.Uri.joinPath(rootUri, OUTPUT_DIRECTORY)

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
      ],
      views: {
        containerId: 'dataverseIde',
        containerTitle: 'Dataverse IDE',
        views: [
          {
            id: 'dataverseIde.esbuild.buildSettings',
            name: 'esbuild Build Settings',
          },
        ],
      },
    })

    const runner = new EsbuildBuildRunner(outputChannel)

    outputChannel.appendLine('[esbuild] extension activated.')

    const buildActiveFileCommand = vscode.commands.registerCommand(
      'dataverseIde.esbuild.build',
      async (arg?: string | unknown) => {
        const settings = getBuildSettings('')

        let entryPath: string

        if (typeof arg === 'string' && arg.trim().length > 0) {
          lastBuiltEntry = arg.replaceAll('\\', '/')
          entryPath = lastBuiltEntry
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

        try {
          const started = Date.now()

          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `[esbuild] Bundling ${entryPath}…`,
              cancellable: false,
            },
            async () => {
              outputChannel.show(true)
              outputChannel.appendLine(`[esbuild] Building ${entryPath}…`)

              const files = await collectWorkspaceSources(
                vscode,
                context.workspaceRootUri,
              )

              if (files[entryPath] == null) {
                throw new Error(
                  `Entry ${entryPath} was not collected from the workspace.`,
                )
              }

              const response = await runner.build({
                entry: entryPath,
                files,
              })

              if (!response.ok) {
                outputChannel.appendLine(response.error)
                outputChannel.show(true)

                await vscode.window.showErrorMessage(
                  `[esbuild] Build failed (see output).`,
                )

                return
              }

              for (const warning of response.warnings) {
                outputChannel.appendLine(`[esbuild] warning: ${warning}`)
              }

              if (response.outputs.length === 0) {
                outputChannel.appendLine('[esbuild] produced no output.')
                outputChannel.show(true)

                return
              }

              const writtenUris = await writeOutputs(
                vscode,
                context.workspaceRootUri,
                entryPath,
                response.outputs,
              )

              const elapsed = Date.now() - started

              outputChannel.appendLine(
                `[esbuild] Build finished in ${elapsed}ms: ${writtenUris.map((uri) => vscode.workspace.asRelativePath(uri, false)).join(', ')}`,
              )

              await vscode.window.showInformationMessage(
                `[esbuild] Built ${entryPath} in ${elapsed}ms.`,
              )
            },
          )
        } catch (error) {
          console.error('[esbuild] build error:', error)

          const message =
            error instanceof Error ? error.message : String(error)

          outputChannel.appendLine(`[esbuild] ${message}`)
          outputChannel.show(true)

          await vscode.window.showErrorMessage(
            `[esbuild] Build failed: ${message}`,
          )
        }
      },
    )

    /*
     * Sidebar: "esbuild Build Settings" — output directory, minify, format,
     * and a watch toggle. Watch re-bundles the last built entry on save.
     */
    type BuildSettingsTreeKey =
      | 'outDir'
      | 'minify'
      | 'format'
      | 'watch'

    const CONFIG_SECTION = 'dataverseIde.esbuild'

    function getBuildSettings(
      section: string,
    ): {
      outDir: string
      minify: boolean
      format: 'esm' | 'iife' | 'cjs'
      watch: boolean
    } {
      const config = vscode.workspace.getConfiguration(CONFIG_SECTION, null)

      return {
        outDir: config.get<string>('outDir', '.ide-build').trim() || '.ide-build',
        minify: config.get<boolean>('minify', false),
        format: (config.get<'esm' | 'iife' | 'cjs'>('format', 'esm') ?? 'esm'),
        watch: config.get<boolean>('watch', false),
      }
    }

    let lastBuiltEntry: string | undefined

    const saveWatcherForWatchMode = vscode.workspace.onDidSaveTextDocument(
      (document) => {
        const settings = getBuildSettings('')

        if (!settings.watch) {
          return
        }

        if (document.uri.scheme !== 'file') {
          return
        }

        const entryPath = vscode.workspace
          .asRelativePath(document.uri, false)
          .replaceAll('\\', '/')

        // Re-bundle while the last-built entry or its imports change
        if (
          entryPath === lastBuiltEntry ||
          document.uri.fsPath
            .replaceAll('\\', '/')
            .includes(settings.outDir) === false
        ) {
          if (lastBuiltEntry == null) {
            lastBuiltEntry = entryPath
          }

          void vscode.commands.executeCommand(
            'dataverseIde.esbuild.build',
            lastBuiltEntry,
          )
        }
      },
    )

    const settingsClickCommand = vscode.commands.registerCommand(
      'dataverseIde.esbuild.settingClick',
      async (key: BuildSettingsTreeKey) => {
        const settings = getBuildSettings('')

        if (key === 'outDir') {
          const outDir = await vscode.window.showInputBox({
            title: 'esbuild: Output Directory',
            prompt: 'Relative directory inside the workspace for build output.',
            value: settings.outDir,
            ignoreFocusOut: true,
          })

          if (outDir == null || outDir.trim().length === 0) {
            return
          }

          await vscode.workspace
            .getConfiguration(CONFIG_SECTION, null)
            .update('outDir', outDir.trim(), vscode.ConfigurationTarget.Global)

          return
        }

        if (key === 'minify') {
          await vscode.workspace
            .getConfiguration(CONFIG_SECTION, null)
            .update('minify', !settings.minify, vscode.ConfigurationTarget.Global)

          return
        }

        if (key === 'watch') {
          await vscode.workspace
            .getConfiguration(CONFIG_SECTION, null)
            .update('watch', !settings.watch, vscode.ConfigurationTarget.Global)

          const changedAction = await vscode.window.showInformationMessage(
            `[esbuild] watch ${!settings.watch ? 'enabled' : 'disabled'}.`,
          )

          void changedAction

          return
        }

        const selectedFormat = await vscode.window.showQuickPick(
          [
            { label: 'esm', detail: 'ESM output (default)' },
            { label: 'iife', detail: 'Browser script (self-executing)' },
            { label: 'cjs', detail: 'CommonJS output' },
          ],
          {
            title: 'esbuild: Output Format',
            placeHolder: `Current: ${settings.format}`,
            ignoreFocusOut: true,
          },
        )

        if (selectedFormat == null) {
          return
        }

        await vscode.workspace
          .getConfiguration(CONFIG_SECTION, null)
          .update('format', selectedFormat.label as 'esm', vscode.ConfigurationTarget.Global)
      },
    )

    type SettingsTreeElement = {
      key: BuildSettingsTreeKey
      label: string
    }

    class BuildSettingsProvider
      implements vscodeType.TreeDataProvider<SettingsTreeElement>
    {
      private readonly onDidChangeEmitter =
        new vscode.EventEmitter<SettingsTreeElement | undefined>()

      readonly onDidChangeTreeData: vscodeType.Event<
        SettingsTreeElement | undefined
      > = this.onDidChangeEmitter.event

      refresh(): void {
        this.onDidChangeEmitter.fire(undefined)
      }

      async getChildren(): Promise<SettingsTreeElement[]> {
        const settings = getBuildSettings('')

        const items: {
          key: BuildSettingsTreeKey
          label: string
        }[] = [
          {
            key: 'outDir',
            label: `Output Directory: ${settings.outDir}`,
          },
          {
            key: 'minify',
            label: `Minify: ${settings.minify ? 'on' : 'off'}`,
          },
          {
            key: 'format',
            label: `Format: ${settings.format}`,
          },
          {
            key: 'watch',
            label: `Watch: ${settings.watch ? 'on (re-builds last entry on save)' : 'off'}`,
          },
        ]

        return items
      }

      getTreeItem(element: SettingsTreeElement): vscodeType.TreeItem {
        const item = new vscode.TreeItem(
          element.label,
          vscode.TreeItemCollapsibleState.None,
        )

        item.command = {
          command: 'dataverseIde.esbuild.settingClick',
          title: 'Edit esbuild setting',
          arguments: [element.key],
        }

        return item
      }
    }

    const buildSettingsProvider = new BuildSettingsProvider()

    const configChangeWatcher = vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (event.affectsConfiguration(CONFIG_SECTION)) {
          buildSettingsProvider.refresh()
        }
      },
    )

    const settingsTreeRegistration = vscode.window.registerTreeDataProvider(
      'dataverseIde.esbuild.buildSettings',
      buildSettingsProvider,
    )

    outputChannel.appendLine('[esbuild] commands and sidebar view registered.')

    return {
      dispose() {
        configChangeWatcher.dispose()
        settingsTreeRegistration.dispose?.()
        saveWatcherForWatchMode.dispose()

        buildActiveFileCommand.dispose()
        runner.dispose()
      },
    }
  },
} satisfies IdeExtension
