import type * as vscodeType from "vscode";

import { contributeCommandManifest } from "../api.js";

import type { ExtensionContext, IdeExtension } from "../api.js";

import { createDirectNodeEngine } from "./engine.js";

const COMMAND_RUN_FILE = "dataverseIde.nodeRuntimeV2.runFile";
const COMMAND_RUN_ENTRY = "dataverseIde.nodeRuntimeV2.runEntry";

const RUNNABLE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

export default {
  id: "node-runtime-v2",

  async activate(context: ExtensionContext): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context;

    await contributeCommandManifest({
      id: "node-runtime-v2",
      displayName: "Dataverse IDE Node Runtime (Direct FS)",
      description: "Run JavaScript/TypeScript files against the workspace filesystem directly.",
      commands: [
        {
          command: COMMAND_RUN_FILE,
          title: "Node (direct): Run File",
        },
        {
          command: COMMAND_RUN_ENTRY,
          title: "Node (direct): Run Active File",
        },
      ],
    });

    const engine = createDirectNodeEngine(vscode, context.workspaceRootUri, outputChannel);

    async function resolveEntry(): Promise<string | undefined> {
      const activeEditor = vscode.window.activeTextEditor;

      if (activeEditor != null && activeEditor.document.uri.scheme === "file") {
        const relative = vscode.workspace
          .asRelativePath(activeEditor.document.uri, false)
          .replaceAll("\\", "/");

        if (RUNNABLE_FILE.test(relative)) {
          return relative;
        }
      }

      const quick = await vscode.window.showQuickPick(
        (
          await vscode.workspace.findFiles(
            "{*,src/*,scripts/*}",
            "{node_modules,.git,.ide-build,dist}/**",
            500,
          )
        )
          .filter((uri) => RUNNABLE_FILE.test(uri.path))
          .map((uri) => ({
            label: vscode.workspace.asRelativePath(uri, false),
            path: vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/"),
          })),
        {
          title: "Node (direct): Run File",
          placeHolder: "Select an entry file to run.",
          ignoreFocusOut: true,
        },
      );

      return quick?.path;
    }

    const runFileCommand = vscode.commands.registerCommand(
      COMMAND_RUN_FILE,
      async (argument?: string) => {
        const entry =
          typeof argument === "string" ? argument.replaceAll("\\", "/") : await resolveEntry();

        if (entry == null) {
          await vscode.window.showWarningMessage("No file selected to run.");

          return;
        }

        outputChannel.show(true);

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `[node] Running ${entry}…`,
            cancellable: false,
          },
          async () => {
            const exitCode = await engine.runFile(entry);

            if (exitCode !== 0) {
              await vscode.window.showErrorMessage(`[node] ${entry} exited with code ${exitCode}.`);
            }
          },
        );
      },
    );

    const runEntryCommand = vscode.commands.registerCommand(COMMAND_RUN_ENTRY, async () => {
      await vscode.commands.executeCommand(COMMAND_RUN_FILE);
    });

    outputChannel.appendLine(
      "[node-runtime-v2] extension activated (direct workspace fs, async loader).",
    );

    return {
      dispose() {
        runFileCommand.dispose();
        runEntryCommand.dispose();
        engine.dispose();
      },
    };
  },
} satisfies IdeExtension;
