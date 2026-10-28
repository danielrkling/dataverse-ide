import type * as vscodeType from 'vscode'

import {
  contributeExtensionManifest,
} from '../api.js'

import {
  createPanelIcon,
  PANEL_GLYPHS,
  registerExtensionPanel,
} from '../panels.js'

import type {
  ExtensionContext,
  IdeExtension,
} from '../api.js'

/*
 * Template extension (ported from dataverse-dev-tools' `template`/`inject`
 * command): replace {{path}} placeholders in a file with the contents of
 * the referenced workspace files and write the result.
 *
 *   index.template.html:  <script src="{{dist/app.js}}"></script>
 *   → output:             <script src>"...contents of dist/app.js..."</script>
 *
 * Placeholder paths are workspace-relative (slash separated), resolved
 * with the same extension/index fallbacks as esbuild imports. Replacements
 * happen in template order (concurrency 1 in dev-tools) so the first
 * missing file fails deterministically.
 */

const COMMAND_TEMPLATE = 'dataverseIde.template.inject'

const COMMAND_WATCH_ACTIVE = 'dataverseIde.template.watchActive'

const COMMAND_START_WATCH = 'dataverseIde.template.startWatch'
const COMMAND_STOP_WATCH = 'dataverseIde.template.stopWatch'
const COMMAND_TOGGLE_WATCH = 'dataverseIde.template.toggleWatch'

const COMMAND_SHOW_OUTPUT = 'dataverseIde.template.showOutput'

/*
 * Watch preference lives in the workspace/user setting
 * `dataverseIde.template.autoStartWatch` (same model as the esbuild and
 * tailwind extensions). It only controls whether watch starts at activation;
 * Start/Stop/Toggle at runtime is in-memory and never writes settings.
 */
const CONFIG_SECTION = 'dataverseIde.template'

const AUTO_START_WATCH_KEY = 'autoStartWatch'

const OUTPUT_DIR_KEY = 'outputDir'

const DEFAULT_OUTPUT_DIR = 'dist'

function getAutoStartWatchSetting(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): boolean {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION, rootUri)
    .get<boolean>(AUTO_START_WATCH_KEY, false)
}

function getOutputDirSetting(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): string {
  const value = vscode.workspace
    .getConfiguration(CONFIG_SECTION, rootUri)
    .get<string>(OUTPUT_DIR_KEY, DEFAULT_OUTPUT_DIR)

  const normalized = value
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')

  return normalized.length > 0 ? normalized : DEFAULT_OUTPUT_DIR
}

/**
 * Default output path for a template under the configured output directory:
 * `index.template.html` → `dist/index.html`. The `.template` marker is
 * stripped; templates without the marker keep their name.
 */
function suggestOutputPath(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  templateUri: vscodeType.Uri,
): string {
  const outputDir = getOutputDirSetting(vscode, rootUri)

  const templateBaseName = templateUri.path.split('/').pop() ?? 'output'

  const suggestedName =
    /\.template\.[^./]+$/i.test(templateBaseName)
      ? templateBaseName.replace(/\.template(?=\.[^./]+$)/i, '')
      : templateBaseName

  return `${outputDir}/${suggestedName}`
}

const WATCH_DEBOUNCE_MS = 300

const PLACEHOLDER_PATTERN = /\{\{(.+?)\}\}/g

const RESOLVABLE_EXTENSIONS = [
  '',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json',
  '.html', '.htm', '.txt', '.md', '.svg', '.xml',
]

const INDEX_TRAILS = ['/index.ts', '/index.js', '/index.html']

const DECODER = new TextDecoder()

export default {
  id: 'template',

  async activate(
    context: ExtensionContext,
  ): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context

    await contributeExtensionManifest({
      id: 'template',
      displayName: 'Dataverse IDE Template',
      description: 'Inject workspace files into templates via {{path}} placeholders.',
      commands: [
        {
          command: COMMAND_TEMPLATE,
          title: 'Template: Inject Files ({{path}} placeholders)',
        },
        {
          command: COMMAND_WATCH_ACTIVE,
          title: 'Template: Watch Active File',
        },
        {
          command: COMMAND_START_WATCH,
          title: 'Template: Start Watch',
        },
        {
          command: COMMAND_STOP_WATCH,
          title: 'Template: Stop Watch',
        },
        {
          command: COMMAND_TOGGLE_WATCH,
          title: 'Template: Toggle Watch',
        },
      ],
      configuration: {
        title: 'Dataverse IDE Template',
        properties: {
          'dataverseIde.template.autoStartWatch': {
            type: 'boolean',
            default: false,
            markdownDescription:
              'Start template watch automatically when the workspace opens.',
          },
          'dataverseIde.template.outputDir': {
            type: 'string',
            default: DEFAULT_OUTPUT_DIR,
            markdownDescription:
              'Default output folder (workspace-relative) for injected templates, e.g. `dist`.',
          },
        },
      },
    })

    async function readWorkspaceText(
      path: string,
    ): Promise<{ text: string; resolvedPath: string } | undefined> {
      const normalized = path
        .trim()
        .replaceAll('\\', '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')

      if (normalized.length === 0) {
        return undefined
      }

      const candidates: string[] = [normalized]

      for (const extension of RESOLVABLE_EXTENSIONS.slice(1)) {
        candidates.push(`${normalized}${extension}`)
      }

      for (const trail of INDEX_TRAILS) {
        candidates.push(`${normalized}${trail}`)
      }

      for (const candidate of candidates) {
        try {
          const bytes = await vscode.workspace.fs.readFile(
            vscode.Uri.joinPath(context.workspaceRootUri, ...candidate.split('/')),
          )

          return {
            text: DECODER.decode(bytes),
            resolvedPath: candidate,
          }
        } catch {
          // try the next candidate
        }
      }

      return undefined
    }

    async function pickFile(title: string): Promise<vscodeType.Uri | undefined> {
      const files = await vscode.workspace.findFiles(
        '**/*',
        '{**/.git/**,**/node_modules/**,**/.ide-build/**,**/dist/**}',
        2000,
      )

      if (files.length === 0) {
        await vscode.window.showWarningMessage(
          'Template: the workspace has no files to pick from.',
        )

        return undefined
      }

      const items = files
        .map((uri) => ({
          label: vscode.workspace.asRelativePath(uri, false),
          uri,
        }))
        .sort((left, right) => left.label.localeCompare(right.label))

      const selection = await vscode.window.showQuickPick(items, {
        title,
        placeHolder: 'Select a file',
        ignoreFocusOut: true,
      })

      return selection?.uri
    }

    /** Creates the output's parent folder (e.g. a not-yet-existing dist). */
    async function ensureParentDirectory(
      uri: vscodeType.Uri,
    ): Promise<void> {
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.joinPath(uri, '..'),
      )
    }

    /*
     * Watch state. Every successful injection registers a template → output
     * pair. Each pair records the workspace-relative paths it depends on
     * (the template itself plus the files its placeholders resolved to,
     * e.g. {{dist/app}} → dist/app.ts); saving any of them re-runs that
     * pair (and its siblings in the debounce batch).
     */
    type WatchPair = {
      templateUri: vscodeType.Uri
      templatePath: string
      /** Workspace-relative output path; the Uri is (re)built on each run. */
      outputPath: string
      watchedPaths: Set<string>
    }

    let watchEnabled = false
    let watchTimer: number | undefined
    let watchBusy = false

    /*
     * Set true when a rebuild is requested while another one is running so
     * the tail of runWatch's loop schedules another pass.
     */
    let watchPending = false

    let watchPairs: WatchPair[] = []

    /** Pairs triggered by saves in the current debounce window. */
    let pendingPairs: WatchPair[] = []

    let lastStatus: 'idle' | 'injecting' | 'ok' | 'error' = 'idle'
    let lastMessage = 'No injection run yet.'

    function upsertWatchPair(
      templateUri: vscodeType.Uri,
      outputPath: string,
      watchedPaths: Set<string>,
    ): void {
      const templatePath = vscode.workspace
        .asRelativePath(templateUri, false)
        .replaceAll('\\', '/')

      const existing = watchPairs.find(
        (pair) => pair.templatePath === templatePath,
      )

      if (existing != null) {
        existing.outputPath = outputPath
        existing.watchedPaths = watchedPaths
        return
      }

      watchPairs.push({
        templateUri,
        templatePath,
        outputPath,
        watchedPaths,
      })
    }

    const watchStatusItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100,
    )

    watchStatusItem.name = 'template Watch'
    watchStatusItem.command = COMMAND_TOGGLE_WATCH

    function firstLine(text: string): string {
      return text.split('\n', 1)[0] ?? text
    }

    function notifyStatus(): void {
      updateWatchStatusItem()
    }

    function updateWatchStatusItem(): void {
      if (!watchEnabled) {
        watchStatusItem.hide()
        return
      }

      if (lastStatus === 'injecting') {
        watchStatusItem.text = '$(sync~spin) template: Injecting'
        watchStatusItem.tooltip =
          `${lastMessage}\n\nClick to stop template watch.`
      } else if (lastStatus === 'error') {
        watchStatusItem.text = '$(warning) template: Watch error'
        watchStatusItem.tooltip =
          `${lastMessage}\n\nWatch remains active. Click to stop watching.`
      } else {
        watchStatusItem.text = '$(eye) template: Watching'
        watchStatusItem.tooltip =
          `${lastMessage}\n\nClick to stop template watch.`
      }

      watchStatusItem.show()
    }

    async function inject(
      templateUri: vscodeType.Uri,
      outputUri: vscodeType.Uri,
      options?: { silent?: boolean },
    ): Promise<boolean> {
      const started = Date.now()

      const templatePath = vscode.workspace
        .asRelativePath(templateUri, false)
        .replaceAll('\\', '/')

      const outputPath = vscode.workspace
        .asRelativePath(outputUri, false)
        .replaceAll('\\', '/')

      try {
        if (outputPath === templatePath) {
          throw new Error(
            `Output cannot be the template file itself (${templatePath}).`,
          )
        }

        lastStatus = 'injecting'
        lastMessage = `Injecting ${templatePath} → ${outputPath}…`
        notifyStatus()

        outputChannel.appendLine(`[template] Injecting ${templatePath}…`)

        const templateBytes = await vscode.workspace.fs.readFile(templateUri)
        const template = DECODER.decode(templateBytes)

        const matches = [...template.matchAll(PLACEHOLDER_PATTERN)]

        if (matches.length === 0) {
          /*
           * No placeholders: still write the copy so the command behaves
           * like dev-tools' template (a straight file transform).
           */
          await ensureParentDirectory(outputUri)

          await vscode.workspace.fs.writeFile(
            outputUri,
            new TextEncoder().encode(template),
          )

          upsertWatchPair(
            templateUri,
            outputPath,
            new Set([templatePath]),
          )

          const elapsed = Date.now() - started

          const summary =
            `No {{...}} placeholders in ${templatePath}; copied to ${outputPath} in ${elapsed}ms.`

          outputChannel.appendLine(`[template] ${summary}`)

          lastStatus = 'ok'
          lastMessage = summary
          notifyStatus()

          if (options?.silent !== true) {
            await vscode.window.showTextDocument(outputUri)
          }

          return true
        }

        /*
         * Resolve in template order; the first missing file fails with a
         * clear message and nothing is written.
         */
        const replacements: { placeholder: string; path: string; value: string }[] = []

        const resolvedPaths: string[] = [templatePath]

        for (const match of matches) {
          const path = match[1].trim()

          const resolved = await readWorkspaceText(path)

          if (resolved == null) {
            throw new Error(
              `Placeholder {{${path}}} could not be resolved from the workspace (referenced in ${templatePath}).`,
            )
          }

          resolvedPaths.push(resolved.resolvedPath)

          replacements.push({
            placeholder: match[0],
            path,
            value: resolved.text,
          })
        }

        /*
         * Function form: literal replacement - "$&" style sequences in
         * the injected content must not be interpreted.
         */
        let result = template

        for (const { placeholder, value } of replacements) {
          result = result.replace(placeholder, () => value)
        }

        await ensureParentDirectory(outputUri)

        await vscode.workspace.fs.writeFile(
          outputUri,
          new TextEncoder().encode(result),
        )

        upsertWatchPair(
          templateUri,
          outputPath,
          new Set(resolvedPaths),
        )

        const elapsed = Date.now() - started

        const summary =
          `Injected ${replacements.length} placeholder(s) from ${templatePath} into ${outputPath} in ${elapsed}ms.`

        outputChannel.appendLine(`[template] ${summary}`)

        lastStatus = 'ok'
        lastMessage = summary
        notifyStatus()

        if (options?.silent !== true) {
          await vscode.window.showTextDocument(outputUri)

          await vscode.window.showInformationMessage(
            `Template: injected ${replacements.length} file(s) into ${outputPath}.`,
          )
        }

        return true
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error)

        outputChannel.appendLine(`[template] ${message}`)

        lastStatus = 'error'
        lastMessage = firstLine(message)
        notifyStatus()

        if (options?.silent !== true) {
          outputChannel.show(true)

          await vscode.window.showErrorMessage(
            `Template: ${message}`,
          )
        }

        return false
      }
    }

    const templateCommand = vscode.commands.registerCommand(
      COMMAND_TEMPLATE,
      async () => {
        /*
         * Template source: the active editor when it holds a text document,
         * a quick pick otherwise.
         */
        let templateUri: vscodeType.Uri | undefined

        const activeEditor = vscode.window.activeTextEditor

        if (
          activeEditor != null &&
          activeEditor.document.uri.scheme === 'file'
        ) {
          templateUri = activeEditor.document.uri
        } else {
          templateUri = await pickFile('Template: select the template file')
        }

        if (templateUri == null) {
          return
        }

        /*
         * Output: an editable path pre-filled with
         * `<outputDir>/<template name>` (the `.template` marker stripped,
         * so index.template.html → dist/index.html). The file and its
         * folder are created on write.
         */
        const templatePath = vscode.workspace
          .asRelativePath(templateUri, false)
          .replaceAll('\\', '/')

        const outputInput = await vscode.window.showInputBox({
          title: 'Template: output file (its content is overwritten)',
          value: suggestOutputPath(
            vscode,
            context.workspaceRootUri,
            templateUri,
          ),
          placeHolder: 'Workspace-relative path, defaults under dist/',
          prompt: 'The output file must be different from the template file.',
          ignoreFocusOut: true,
        })

        if (outputInput == null) {
          return
        }

        const outputPath = outputInput
          .trim()
          .replaceAll('\\', '/')
          .replace(/^\.\//, '')
          .replace(/^\/+/, '')
          .replace(/\/+$/, '')

        if (outputPath.length === 0) {
          return
        }

        if (outputPath === templatePath) {
          await vscode.window.showErrorMessage(
            'Template: the output cannot be the template file itself.',
          )

          return
        }

        const outputUri = vscode.Uri.joinPath(
          context.workspaceRootUri,
          ...outputPath.split('/'),
        )

        await inject(templateUri, outputUri)
      },
    )

    function setWatchEnabled(enabled: boolean): void {
      if (enabled === watchEnabled) {
        return
      }

      watchEnabled = enabled

      if (!enabled && watchTimer != null) {
        window.clearTimeout(watchTimer)
        watchTimer = undefined
      }

      outputChannel.appendLine(
        `[template] watch ${enabled ? 'started' : 'stopped'}.`,
      )

      notifyStatus()
    }

    function scheduleWatch(): void {
      if (watchTimer != null) {
        window.clearTimeout(watchTimer)
      }

      watchTimer = window.setTimeout(() => {
        watchTimer = undefined
        void runWatch()
      }, WATCH_DEBOUNCE_MS)
    }

    async function runWatch(): Promise<void> {
      if (watchBusy) {
        /*
         * A run is in flight: the save watcher will pick the new trigger up
         * when the current batch finishes (pendingPairs is re-checked).
         */
        return
      }

      watchBusy = true

      try {
        do {
          watchPending = false

          const batch = pendingPairs
          pendingPairs = []

          /*
           * Dedupe and keep workspace order stable, then re-inject each
           * triggered pair once. Siblings which resolved into the batch
           * (a shared source file changed) naturally collapse here.
           */
          const seen = new Set<string>()

          for (const pair of batch) {
            if (seen.has(pair.templatePath)) {
              continue
            }

            seen.add(pair.templatePath)

            const outputUri = vscode.Uri.joinPath(
              context.workspaceRootUri,
              ...pair.outputPath.split('/'),
            )

            await inject(pair.templateUri, outputUri, { silent: true })
          }
        } while (pendingPairs.length > 0)
      } finally {
        watchBusy = false
      }
    }

    const saveWatcher = vscode.workspace.onDidSaveTextDocument(
      (document) => {
        if (!watchEnabled || watchPairs.length === 0) {
          return
        }

        if (document.uri.scheme !== 'file') {
          return
        }

        const relativePath = vscode.workspace
          .asRelativePath(document.uri, false)
          .replaceAll('\\', '/')

        const triggered = watchPairs.filter((pair) =>
          pair.watchedPaths.has(relativePath),
        )

        if (triggered.length === 0) {
          return
        }

        pendingPairs = triggered

        scheduleWatch()
      },
    )

    const startWatchCommand = vscode.commands.registerCommand(
      COMMAND_START_WATCH,
      () => setWatchEnabled(true),
    )

    const stopWatchCommand = vscode.commands.registerCommand(
      COMMAND_STOP_WATCH,
      () => setWatchEnabled(false),
    )

    const toggleWatchCommand = vscode.commands.registerCommand(
      COMMAND_TOGGLE_WATCH,
      () => setWatchEnabled(!watchEnabled),
    )

    /*
     * One-click: take the active file as the template, use the default
     * `<outputDir>/<name>` output without prompting, register the pair,
     * inject immediately, and turn watch on.
     */
    const watchActiveCommand = vscode.commands.registerCommand(
      COMMAND_WATCH_ACTIVE,
      async () => {
        const activeEditor = vscode.window.activeTextEditor

        if (activeEditor == null || activeEditor.document.uri.scheme !== 'file') {
          await vscode.window.showWarningMessage(
            'Template: open a workspace file in the editor to watch it.',
          )

          return
        }

        const templateUri = activeEditor.document.uri

        const outputPath = suggestOutputPath(
          vscode,
          context.workspaceRootUri,
          templateUri,
        )

        const templatePath = vscode.workspace
          .asRelativePath(templateUri, false)
          .replaceAll('\\', '/')

        if (outputPath === templatePath) {
          await vscode.window.showErrorMessage(
            'Template: the output cannot be the template file itself.',
          )

          return
        }

        const outputUri = vscode.Uri.joinPath(
          context.workspaceRootUri,
          ...outputPath.split('/'),
        )

        setWatchEnabled(true)

        await inject(templateUri, outputUri)
      },
    )

    const showOutputCommand = vscode.commands.registerCommand(
      COMMAND_SHOW_OUTPUT,
      () => {
        outputChannel.show(true)
      },
    )

    const templatePanel = registerExtensionPanel(vscode, {
      extensionId: 'template',
      title: 'template',
      icon: createPanelIcon(PANEL_GLYPHS.box),
      description:
        'Inject workspace files into templates via {{path}} placeholders. Settings are stored in the dataverseIde.template configuration.',
      workspaceRootUri: context.workspaceRootUri,
      settings: [
        {
          type: 'string',
          key: OUTPUT_DIR_KEY,
          label: 'Output directory',
          default: DEFAULT_OUTPUT_DIR,
          placeholder: DEFAULT_OUTPUT_DIR,
          description:
            'Workspace-relative default output folder for injected templates.',
        },
        {
          type: 'boolean',
          key: AUTO_START_WATCH_KEY,
          label: 'Auto-start watch',
          default: false,
          description: 'Start watch automatically when the workspace opens.',
        },
      ],
      actions: [
        {
          label: 'Inject Now',
          command: COMMAND_TEMPLATE,
          primary: true,
        },
        {
          label: 'Watch Active File',
          command: COMMAND_WATCH_ACTIVE,
        },
        {
          label: 'Start Watch',
          command: COMMAND_START_WATCH,
        },
        {
          label: 'Stop Watch',
          command: COMMAND_STOP_WATCH,
        },
        {
          label: 'Show Output',
          command: COMMAND_SHOW_OUTPUT,
        },
      ],
    })

    /*
     * Autostart from the setting at activation; live changes to the setting
     * start/stop the runtime too, so editing it in the settings UI takes
     * effect immediately. Until a template → output pair has been picked
     * once (via the inject command), watch is enabled but idle.
     */
    setWatchEnabled(
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
          setWatchEnabled(
            getAutoStartWatchSetting(vscode, context.workspaceRootUri),
          )
        }
      },
    )

    outputChannel.appendLine('[template] extension activated.')

    return {
      dispose() {
        if (watchTimer != null) {
          window.clearTimeout(watchTimer)
          watchTimer = undefined
        }

        saveWatcher.dispose()
        watchStatusItem.dispose()
        watchSettingListener.dispose()

        templateCommand.dispose()
        watchActiveCommand.dispose()
        startWatchCommand.dispose()
        stopWatchCommand.dispose()
        toggleWatchCommand.dispose()
        showOutputCommand.dispose()
        templatePanel.dispose()
      },
    }
  },
} satisfies IdeExtension
