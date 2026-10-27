import type * as vscodeType from 'vscode'

import {
  contributeCommandManifest,
} from '../api.js'

import type {
  ExtensionContext,
  IdeExtension,
} from '../api.js'

import { createAlmostnodeEngine } from './engine.js'

const COMMAND_RUN_FILE = 'dataverseIde.nodeRuntime.runFile'
const COMMAND_RUN_ENTRY = 'dataverseIde.nodeRuntime.runEntry'

export default {
  id: 'node-runtime',

  async activate(
    context: ExtensionContext,
  ): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context

    await contributeCommandManifest({
      id: 'node-runtime',
      displayName: 'Dataverse IDE Node Runtime',
      description: 'Run JavaScript files in the workspace with Node semantics.',
      commands: [
        {
          command: 'dataverseIde.nodeRuntime.runFile',
          title: 'Node: Run File',
        },
        {
          command: 'dataverseIde.nodeRuntime.runEntry',
          title: 'Node: Run Active File',
        },
      ],
    })

    const engine = createAlmostnodeEngine(
      vscode,
      context.workspaceRootUri,
      outputChannel,
    )

    async function resolveEntry(): Promise<string | undefined> {
      const activeEditor = vscode.window.activeTextEditor

      if (activeEditor != null && activeEditor.document.uri.scheme === 'file') {
        const relative = vscode.workspace
          .asRelativePath(activeEditor.document.uri, false)
          .replaceAll('\\', '/')

        if (/\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(relative)) {
          return relative
        }
      }

      const quick = await vscode.window.showQuickPick(
        (await vscode.workspace.findFiles(
          '{*,src/*,scripts/*}',
          '{node_modules,.git,.ide-build}/**',
          500,
        )).filter((uri) => /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(uri.path))
          .map((uri) => ({
            label: vscode.workspace.asRelativePath(uri, false),
            path: vscode.workspace
              .asRelativePath(uri, false)
              .replaceAll('\\', '/'),
          })),
        {
          title: 'Node: Run File',
          placeHolder: 'Select an entry file to run.',
          ignoreFocusOut: true,
        },
      )

      return quick?.path
    }

    const runFileCommand = vscode.commands.registerCommand(
      COMMAND_RUN_FILE,
      async (argument?: string) => {
        const entry =
          typeof argument === 'string'
            ? argument.replaceAll('\\', '/')
            : await resolveEntry()

        if (entry == null) {
          await vscode.window.showWarningMessage(
            'No file selected to run.',
          )

          return
        }

        outputChannel.show(true)

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `[node] Running ${entry}…`,
            cancellable: false,
          },
          async () => {
            const exitCode = await engine.runFile(entry)

            if (exitCode !== 0) {
              await vscode.window.showErrorMessage(
                `[node] ${entry} exited with code ${exitCode}.`,
              )
            }
          },
        )
      },
    )

    const runEntryCommand = vscode.commands.registerCommand(
      COMMAND_RUN_ENTRY,
      async () => {
        await vscode.commands.executeCommand(COMMAND_RUN_FILE)
      },
    )

    outputChannel.appendLine(
      '[node-runtime] extension activated (almostnode engine, same-origin main thread).',
    )

    return {
      dispose() {
        runFileCommand.dispose()
        runEntryCommand.dispose()
        engine.dispose()
      },
    }
  },
} satisfies IdeExtension
