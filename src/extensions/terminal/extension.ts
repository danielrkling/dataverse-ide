import type * as vscodeType from "vscode";

import { contributeExtensionManifest } from "../api.js";

import guideContent from "./GUIDE.md?raw";

import { registerGuide } from "../shared/guide.js";

import type { ExtensionContext, IdeExtension } from "../api.js";
import type { DirectNodeEngine } from "../node-runtime/engine.js";
import { NODE_PERMISSION_LEVELS, type NodePermissionLevel } from "../node-runtime/permissions.js";

import { createShellCommands } from "./commands.js";
import { createWorkspaceShellHistory, type ShellHistory } from "./history.js";
import { createShellOutput } from "./output.js";
import { DataverseShellPty } from "./pty.js";
import { createShellFs, type ShellFs } from "./shellFs.js";

const COMMAND_NEW = "dataverseIde.terminal.new";
const COMMAND_RUN = "dataverseIde.terminal.run";
const COMMAND_GUIDE = "dataverseIde.terminal.openGuide";

const CONFIG_SECTION = "dataverseIde.terminal";
const PERMISSIONS_KEY = "permissions";
const DEFAULT_TERMINAL_PERMISSION_LEVEL: NodePermissionLevel = "workspace";

const PERMISSION_DESCRIPTIONS: Record<NodePermissionLevel, string> = {
  "read-only": "Read workspace files; shell writes are rejected.",
  workspace: "Read and write workspace files.",
  trusted: "Read and write workspace files; reserved for future network access.",
};

type TerminalResources = {
  fs: ShellFs;
  history?: ShellHistory;
  pty: DataverseShellPty;
};

function isPermissionLevel(value: unknown): value is NodePermissionLevel {
  return typeof value === "string" && (NODE_PERMISSION_LEVELS as readonly string[]).includes(value);
}

function getPermissionLevel(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): NodePermissionLevel {
  const value = vscode.workspace
    .getConfiguration(CONFIG_SECTION, rootUri)
    .get<string>(PERMISSIONS_KEY, DEFAULT_TERMINAL_PERMISSION_LEVEL);

  return isPermissionLevel(value) ? value : DEFAULT_TERMINAL_PERMISSION_LEVEL;
}

function isHistoryEnabled(vscode: typeof vscodeType, rootUri: vscodeType.Uri): boolean {
  return vscode.workspace.getConfiguration(CONFIG_SECTION, rootUri).get<boolean>("history", true);
}

export default {
  id: "terminal",

  async activate(context: ExtensionContext): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context;

    await contributeExtensionManifest({
      id: "terminal",
      displayName: "Dataverse IDE Terminal",
      description: "Browser shell backed by just-bash and the workspace filesystem.",
      commands: [
        {
          command: COMMAND_NEW,
          title: "Terminal: New Dataverse Shell",
        },
        {
          command: COMMAND_RUN,
          title: "Terminal: Run Command…",
        },
        {
          command: COMMAND_GUIDE,
          title: "Terminal: How-to Guide",
        },
      ],
      configuration: {
        title: "Terminal",
        properties: {
          [`${CONFIG_SECTION}.${PERMISSIONS_KEY}`]: {
            type: "string",
            enum: [...NODE_PERMISSION_LEVELS],
            enumDescriptions: NODE_PERMISSION_LEVELS.map((level) => PERMISSION_DESCRIPTIONS[level]),
            default: DEFAULT_TERMINAL_PERMISSION_LEVEL,
            scope: "window",
            description:
              "Filesystem access for the Dataverse shell. Applies to shell commands and to `node` runs started from the terminal.",
          },
          [`${CONFIG_SECTION}.history`]: {
            type: "boolean",
            default: true,
            scope: "window",
            description:
              "Persist shell command history in browser storage so it survives reloads and new terminals.",
          },
        },
      },
    });

    const guideRegistration = registerGuide({
      vscode,
      extensionId: "terminal",
      content: guideContent,
    });

    const resources = new Map<vscodeType.Terminal, TerminalResources>();
    const allResources = new Set<TerminalResources>();
    let enginePromise: Promise<DirectNodeEngine> | undefined;

    function getEngine(): Promise<DirectNodeEngine> {
      enginePromise ??= import("../node-runtime/engine.js").then(({ createDirectNodeEngine }) =>
        createDirectNodeEngine(vscode, context.workspaceRootUri, outputChannel),
      );

      return enginePromise;
    }

    async function createTerminal(): Promise<vscodeType.Terminal> {
      const level = getPermissionLevel(vscode, context.workspaceRootUri);
      const fs = await createShellFs({
        vscode,
        rootUri: context.workspaceRootUri,
        writable: level !== "read-only",
        directoryHandle: context.workspaceDirectoryHandle,
      });

      try {
        const output = createShellOutput();
        const history = isHistoryEnabled(vscode, context.workspaceRootUri)
          ? createWorkspaceShellHistory(context.workspaceRootUri.toString())
          : undefined;
        const commands = await createShellCommands({
          vscode,
          rootUri: context.workspaceRootUri,
          fs,
          level,
          output,
          engine: getEngine,
        });
        const pty = new DataverseShellPty({
          vscode,
          fs,
          output,
          history,
          commands,
        });
        const terminal = vscode.window.createTerminal({
          name: "Dataverse Shell",
          pty,
        });
        const entry: TerminalResources = { fs, history, pty };

        resources.set(terminal, entry);
        allResources.add(entry);

        return terminal;
      } catch (error) {
        fs.dispose();
        throw error;
      }
    }

    const closeListener = vscode.window.onDidCloseTerminal((terminal) => {
      const entry = resources.get(terminal);

      if (entry == null) {
        return;
      }

      resources.delete(terminal);
      allResources.delete(entry);
      entry.fs.dispose();
      void entry.history?.flush();
    });

    const newCommand = vscode.commands.registerCommand(COMMAND_NEW, async () => {
      try {
        const terminal = await createTerminal();

        terminal.show();
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Could not start the Dataverse shell: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });

    const runCommand = vscode.commands.registerCommand(COMMAND_RUN, async () => {
      const command = await vscode.window.showInputBox({
        title: "Terminal: Run Command",
        prompt: "Command to run in a new Dataverse shell.",
        placeHolder: "ls src",
      });

      if (command == null || command.trim().length === 0) {
        return;
      }

      try {
        const terminal = await createTerminal();

        terminal.show();
        terminal.sendText(command, true);
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Could not start the Dataverse shell: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });

    outputChannel.appendLine(
      "[terminal] extension activated (just-bash over the workspace filesystem).",
    );

    return {
      dispose() {
        newCommand.dispose();
        runCommand.dispose();
        closeListener.dispose();
        guideRegistration.dispose();

        for (const entry of allResources) {
          entry.fs.dispose();
          void entry.history?.flush();
        }

        allResources.clear();
        resources.clear();
        void enginePromise?.then((engine) => engine.dispose());
      },
    };
  },
} satisfies IdeExtension;
