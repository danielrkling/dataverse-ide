import type * as vscodeType from 'vscode'

import {
  compileTailwindCss,
} from './compiler.js'

import { EsbuildBuildRunner } from '../esbuild/buildRunner.js'

import {
  registerConfigIntellisense,
} from './configIntellisense.js'

import {
  configFilePath,
  readTailwindConfig,
  updateTailwindConfig,
  type TailwindConfig,
  TAILWIND_DEFAULT_CONFIG,
} from './config.js'

import {
  generateCandidates,
  generateVariantCandidates,
  getTailwindHoverInfo,
} from './theme.js'

import {
  contributeCommandManifest,
} from '../api.js'

import { EsbuildWatcher } from '../esbuild/watcher.js'

import type {
  ExtensionContext,
  IdeExtension,
} from '../api.js'

/*
 * Tailwind extension: editor IntelliSense over Tailwind v4 utilities plus
 * workspace CSS compilation/watch built on the real tailwindcss compile()
 * API (see compiler.ts).
 *
 * - Class-name completions in HTML/CSS/JS/TS/JSX/TSX from the default theme
 *   data (plain JS; no WASM scanner involved).
 * - Variant prefixes (hover:, md:, dark:, ...) suggested at the start of a
 *   class context.
 * - Hovers show resolved theme values.
 * - Compile/watch commands driven by tailwind.config.json, with a watch
 *   status bar item mirroring the esbuild extension.
 */

const COMPLETION_TRIGGER_CHARACTERS = ['"', "'", ' ', '-', ':', '/']

const SUPPORTED_LANGUAGES = [
  'html',
  'php',
  'css',
  'scss',
  'less',
  'javascript',
  'typescript',
  'javascriptreact',
  'typescriptreact',
  'vue',
  'svelte',
]

const CLASS_CONTEXT_REGEX =
  /[^\s"'`<>;={}]*$/

/*
 * Detect "inside a class-name string" by scanning the line prefix before the
 * cursor:
 *   - html/vue/svelte: class="…" | class='…' | class=`…`
 *   - js/ts(react): className="…" | className={`…`}
 * The cursor must be inside a currently-open quote of the right pair.
 */
function isInsideClassStringContext(
  document: vscodeType.TextDocument,
  position: vscodeType.Position,
): boolean {
  const lineText = document.lineAt(position).text
  const prefix = lineText.slice(0, position.character)

  const openingMatch =
    /(?:\bclass(?:Name)?\s*=\s*)(["'`])([^"'`\\]*)$/.exec(prefix)

  if (openingMatch == null) {
    return false
  }

  const quoteCharacter = openingMatch[1]

  const suffix = lineText.slice(position.character)

  const closingIndex = suffix.indexOf(quoteCharacter)

  const cursorInsideQuotes = closingIndex === -1

  return cursorInsideQuotes
}

function computeReplacementRange(
  vscode: typeof vscodeType,
  document: vscodeType.TextDocument,
  position: vscodeType.Position,
): vscodeType.Range {
  const lineText = document.lineAt(position).text
  const startLine = lineText.slice(0, position.character)

  const match = CLASS_CONTEXT_REGEX.exec(startLine)

  const startCharacter = position.character - (match?.[0].length ?? 0)

  return new vscode.Range(
    new vscode.Position(position.line, startCharacter),
    position,
  )
}

/*
 * Watch preference lives in the workspace/user setting
 * `dataverseIde.tailwind.autoStartWatch` (not tailwind.config.json). It only
 * controls whether watch starts at activation; Start/Stop/Toggle at runtime
 * is in-memory and never writes settings or project files.
 */
const CONFIG_SECTION = 'dataverseIde.tailwind'

const AUTO_START_WATCH_KEY = 'autoStartWatch'

function getAutoStartWatchSetting(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): boolean {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION, rootUri)
    .get<boolean>(AUTO_START_WATCH_KEY, false)
}

export default {
  id: 'tailwind',

  async activate(
    context: ExtensionContext,
  ): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context

    /*
     * Shared esbuild-wasm runner, used to bundle @plugin modules for the
     * tailwind compiler (see compiler.ts).
     */
    const pluginRunner = new EsbuildBuildRunner(outputChannel)

    const candidateData = generateCandidates()

    const candidateItems: vscodeType.CompletionItem[] =
      candidateData.map((candidate) => {
        const item = new vscode.CompletionItem(
          candidate.className,
          vscode.CompletionItemKind.EnumMember,
        )

        item.detail = `Tailwind v4 · ${candidate.className}`

        if (candidate.documentation != null) {
          item.documentation = new vscode.MarkdownString(
            `\`${candidate.className}\`\n\n\`${candidate.documentation}\``,
          )
        }

        item.sortText = `0${candidate.className}`

        return item
      })

    const variants = generateVariantCandidates().map((variant) => {
      const item = new vscode.CompletionItem(
        variant.prefix,
        vscode.CompletionItemKind.Keyword,
      )

      item.detail = 'Tailwind v4 variant'

      item.command = {
        command: 'editor.action.triggerSuggest',
        title: 'Suggest variants',
      }

      item.sortText = '1'

      return item
    })

    outputChannel.appendLine(
      `[tailwind] ${candidateData.length} utility candidates from default theme.`,
    )

    const completionProviderDisposable =
      vscode.languages.registerCompletionItemProvider(
        SUPPORTED_LANGUAGES,
        {
          provideCompletionItems(document, position) {
            const wordRange = computeReplacementRange(
              vscode,
              document,
              position,
            )

            const word = document.getText(wordRange)

            /*
             * Only offer completions inside class-name string contexts:
             * after class=/className= inside an opened quote (", ', `).
             * Elsewhere the provider stays silent.
             */
            if (!isInsideClassStringContext(document, position)) {
              return undefined
            }

            /*
             * The workbench filters items against the typed text, so we hand
             * back the full candidate list. Variant suggestions are excluded
             * once a variant is already present (they'd be noise there).
             */
            const alreadyHasVariant = word.includes(':')

            const items: vscodeType.CompletionItem[] = [
              ...candidateItems,
            ]

            if (!alreadyHasVariant) {
              items.push(...variants)
            }

            return new vscode.CompletionList(items, false)
          },
        },
        ...COMPLETION_TRIGGER_CHARACTERS,
      )

    const hoverProviderDisposable = vscode.languages.registerHoverProvider(
      SUPPORTED_LANGUAGES,
      {
        provideHover(document, position) {
          const wordRange = document.getWordRangeAtPosition(
            position,
            /[A-Za-z0-9_:./[\]<>()%#-]+/,
          )

          if (wordRange == null) {
            return undefined
          }

          const className = document.getText(wordRange)

          const markdown = getTailwindHoverInfo(className)

          if (markdown == null) {
            return undefined
          }

          return new vscode.Hover(
            new vscode.MarkdownString(`**${className}**\n\n${markdown}`),
            wordRange,
          )
        },
      },
    )

    outputChannel.appendLine('[tailwind] providers registered.')

    await contributeCommandManifest({
      id: 'tailwind',
      displayName: 'Dataverse IDE Tailwind',
      description: 'Tailwind v4 IntelliSense + workspace CSS compilation.',
      commands: [
        {
          command: 'dataverseIde.tailwind.compileCss',
          title: 'Tailwind: Compile CSS From Workspace',
        },
        {
          command: 'dataverseIde.tailwind.startWatch',
          title: 'Tailwind: Start Watch',
        },
        {
          command: 'dataverseIde.tailwind.stopWatch',
          title: 'Tailwind: Stop Watch',
        },
        {
          command: 'dataverseIde.tailwind.toggleWatch',
          title: 'Tailwind: Toggle Watch',
        },
        {
          command: 'dataverseIde.tailwind.openConfig',
          title: 'Tailwind: Open tailwind.config.json',
        },
      ],
      configuration: {
        title: 'Dataverse IDE Tailwind',
        properties: {
          'dataverseIde.tailwind.autoStartWatch': {
            type: 'boolean',
            default: false,
            markdownDescription:
              'Start tailwind watch automatically when the workspace opens.',
          },
        },
      },
    })

    /*
     * Config-driven compile/watch. All settings come from
     * tailwind.config.json; there is no vscode-settings fallback.
     */
    let currentConfig: TailwindConfig = TAILWIND_DEFAULT_CONFIG
    let watcher: EsbuildWatcher | undefined
    let watchEnabled = false

    let lastStatus: 'idle' | 'building' | 'ok' | 'error' = 'idle'
    let lastMessage = 'No compile run yet.'
    let lastFinishedAt: number | undefined

    /*
     * Signature of the last successful build (input css + candidate set).
     * When a save doesn't change the inputs, the rebuild is skipped.
     */
    let lastSignature: string | undefined

    const watchStatusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    )

    watchStatusItem.name = 'Tailwind Watch'
    watchStatusItem.command = 'dataverseIde.tailwind.toggleWatch'

    /*
     * Compile errors surface on the input stylesheet in the Problems panel;
     * cleared on the next successful compile.
     */
    const diagnostics = vscode.languages.createDiagnosticCollection('tailwind')

    const configIntellisenseDisposable = registerConfigIntellisense(vscode)

    function firstLine(text: string): string {
      return text.split('\n', 1)[0] ?? text
    }

    function updateWatchStatusItem(): void {
      if (!watchEnabled) {
        watchStatusItem.hide()
        return
      }

      if (lastStatus === 'building') {
        watchStatusItem.text = '$(sync~spin) tailwind: Building'
        watchStatusItem.tooltip =
          `${lastMessage}\n\nClick to stop tailwind watch.`
      } else if (lastStatus === 'error') {
        watchStatusItem.text = '$(warning) tailwind: Watch error'
        watchStatusItem.tooltip =
          `${lastMessage}\n\nWatch remains active. Click to stop watching.`
      } else {
        watchStatusItem.text = '$(eye) tailwind: Watching'
        watchStatusItem.tooltip =
          `${lastMessage}\n\nClick to stop tailwind watch.`
      }

      watchStatusItem.show()
    }

    async function reloadConfigFromDisk(): Promise<void> {
      const loaded = await readTailwindConfig(
        vscode,
        context.workspaceRootUri,
      )

      currentConfig = loaded.config

      updateWatchStatusItem()
    }

    async function runCompile(
      options?: { silent?: boolean },
    ): Promise<boolean> {
      const started = Date.now()

      try {
        await reloadConfigFromDisk()

        lastStatus = 'building'
        lastMessage = `Compiling ${currentConfig.output}…`
        updateWatchStatusItem()

        if (options?.silent !== true) {
          outputChannel.show(true)
        }

        outputChannel.appendLine(
          `[tailwind] Compiling ${currentConfig.input ?? 'default input (@import "tailwindcss")'}…`,
        )

        const result = await compileTailwindCss(
          vscode,
          context.workspaceRootUri,
          {
            input: currentConfig.input,
            pluginRunner,
            minify: currentConfig.minify,
          },
        )

        if (result.signature === lastSignature) {
          const elapsed = Date.now() - started

          const upToDate =
            `Up to date: ${currentConfig.output} · ${result.candidateCount} candidates · ${elapsed}ms`

          outputChannel.appendLine(`[tailwind] ${upToDate}`)

          lastStatus = 'ok'
          lastMessage = upToDate
          lastFinishedAt = Date.now()
          updateWatchStatusItem()

          return true
        }

        const outFile = vscode.Uri.joinPath(
          context.workspaceRootUri,
          ...currentConfig.output.split('/'),
        )

        const parentDirectory = currentConfig.output.includes('/')
          ? vscode.Uri.joinPath(
              context.workspaceRootUri,
              ...currentConfig.output.split('/').slice(0, -1),
            )
          : context.workspaceRootUri

        await vscode.workspace.fs.createDirectory(parentDirectory)

        await vscode.workspace.fs.writeFile(
          outFile,
          new TextEncoder().encode(result.css),
        )

        lastSignature = result.signature
        diagnostics.clear()

        const elapsed = Date.now() - started

        const summary =
          `Compiled ${result.candidateCount} candidates in ${elapsed}ms → ${vscode.workspace.asRelativePath(outFile, false)} (${result.css.length} bytes)`

        outputChannel.appendLine(`[tailwind] ${summary}`)

        if (options?.silent !== true) {
          outputChannel.show(true)
        }

        lastStatus = 'ok'
        lastMessage = summary
        lastFinishedAt = Date.now()
        updateWatchStatusItem()

        return true
      } catch (error) {
        console.error('[tailwind] compile error:', error)

        const message =
          error instanceof Error ? error.message : String(error)

        outputChannel.appendLine(`[tailwind] ${firstLine(message)}`)
        outputChannel.show(true)

        if (currentConfig.input != null) {
          diagnostics.set(
            vscode.Uri.joinPath(
              context.workspaceRootUri,
              ...currentConfig.input.split('/'),
            ),
            [
              new vscode.Diagnostic(
                new vscode.Range(0, 0, 0, 1),
                message,
                vscode.DiagnosticSeverity.Error,
              ),
            ],
          )
        }

        lastStatus = 'error'
        lastMessage = firstLine(message)
        lastFinishedAt = Date.now()
        updateWatchStatusItem()

        if (options?.silent !== true) {
          await vscode.window.showErrorMessage(
            `[tailwind] Compile failed: ${message}`,
          )
        }

        return false
      }
    }

    const compileCommand = vscode.commands.registerCommand(
      'dataverseIde.tailwind.compileCss',
      async () => {
        await runCompile()
      },
    )

    /*
     * Watch lifecycle. The watcher reads the live config (output path)
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
          configFileName: 'tailwind.config.json',
          outDir: () => {
            const output = currentConfig.output
            const slashIndex = output.lastIndexOf('/')

            return slashIndex === -1 ? '' : output.slice(0, slashIndex)
          },
          entry: () => currentConfig.input ?? '',
          build: async () => {
            await runCompile({ silent: true })
          },
        },
      )

      return watcher
    }

    function setWatchRuntimeEnabled(enabled: boolean): void {
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

      updateWatchStatusItem()
    }

    async function setWatchEnabled(enabled: boolean): Promise<void> {
      /*
       * Runtime-only. The autoStartWatch setting is not touched here — it is
       * just the autostart preference.
       */
      setWatchRuntimeEnabled(enabled)
    }

    /*
     * Autostart from the setting at activation; live changes to the setting
     * start/stop the runtime too, so editing it in the settings UI takes
     * effect immediately.
     */
    setWatchRuntimeEnabled(
      getAutoStartWatchSetting(vscode, context.workspaceRootUri),
    )

    const watchSettingListener = vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (
          event.affectsConfiguration(
            `${CONFIG_SECTION}.${AUTO_START_WATCH_KEY}`,
            context.workspaceRootUri,
          )
        ) {
          setWatchRuntimeEnabled(
            getAutoStartWatchSetting(vscode, context.workspaceRootUri),
          )
        }
      },
    )

    const startWatchCommand = vscode.commands.registerCommand(
      'dataverseIde.tailwind.startWatch',
      () => setWatchEnabled(true),
    )

    const stopWatchCommand = vscode.commands.registerCommand(
      'dataverseIde.tailwind.stopWatch',
      () => setWatchEnabled(false),
    )

    const toggleWatchCommand = vscode.commands.registerCommand(
      'dataverseIde.tailwind.toggleWatch',
      () => setWatchEnabled(!watchEnabled),
    )

    const openConfigCommand = vscode.commands.registerCommand(
      'dataverseIde.tailwind.openConfig',
      async () => {
        const uri = configFilePath(vscode, context.workspaceRootUri)

        try {
          await vscode.workspace.fs.stat(uri)
        } catch {
          /*
           * Scaffold the file with the merged defaults on first open so the
           * editor shows something meaningful to edit.
           */
          await updateTailwindConfig(vscode, context.workspaceRootUri, {})
        }

        await vscode.window.showTextDocument(uri)
      },
    )

    /*
     * Load the config file (or defaults when absent) once at activation so
     * the watcher starts from the real project settings.
     */
    await reloadConfigFromDisk()

    outputChannel.appendLine('[tailwind] commands registered.')

    return {
      dispose() {
        watcher?.dispose()
        watchStatusItem.dispose()
        pluginRunner.dispose()
        watchSettingListener.dispose()
        diagnostics.dispose()
        configIntellisenseDisposable.dispose()

        startWatchCommand.dispose()
        stopWatchCommand.dispose()
        toggleWatchCommand.dispose()
        openConfigCommand.dispose()

        compileCommand.dispose()
        completionProviderDisposable.dispose()
        hoverProviderDisposable.dispose()
      },
    }
  },
} satisfies IdeExtension
