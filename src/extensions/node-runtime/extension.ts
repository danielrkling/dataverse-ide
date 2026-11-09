import type * as vscodeType from "vscode";

import { contributeExtensionManifest } from "../api.js";

import guideContent from "./GUIDE.md?raw";

import { registerGuide } from "../shared/guide.js";

import type { ExtensionContext, IdeExtension } from "../api.js";

import { createDirectNodeEngine } from "./engine.js";
import { DEFAULT_NODE_FS_CACHE, getNodeFsCacheMode, NODE_FS_CACHE_MODES } from "./fsCache.js";
import {
  DEFAULT_NODE_PERMISSION_LEVEL,
  getDefaultNodePermissionLevel,
  NODE_PERMISSION_LEVELS,
  type NodePermissionLevel,
} from "./permissions.js";

const COMMAND_RUN_FILE = "dataverseIde.nodeRuntime.runFile";
const COMMAND_RUN_FILE_WITH_PERMISSIONS = "dataverseIde.nodeRuntime.runFileWithPermissions";
const COMMAND_RUN_ENTRY = "dataverseIde.nodeRuntime.runEntry";
const COMMAND_RUN_ENTRY_WITH_PERMISSIONS = "dataverseIde.nodeRuntime.runEntryWithPermissions";

const RUNNABLE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/i;

type PermissionQuickPick = vscodeType.QuickPickItem & { level: NodePermissionLevel };

const PERMISSION_DESCRIPTIONS: Record<NodePermissionLevel, string> = {
  "read-only": "Read workspace files; block writes and network access.",
  workspace: "Read and write workspace files; block network access.",
  trusted: "Read and write workspace files and allow same-origin network access.",
};

export default {
  id: "node-runtime",

  async activate(context: ExtensionContext): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context;

    await contributeExtensionManifest({
      id: "node-runtime",
      displayName: "Dataverse IDE Node Runtime",
      description: "Run JavaScript/TypeScript files against the workspace filesystem directly.",
      commands: [
        {
          command: COMMAND_RUN_FILE,
          title: "Node: Run File",
        },
        {
          command: COMMAND_RUN_FILE_WITH_PERMISSIONS,
          title: "Node: Run File with Permissions…",
        },
        {
          command: COMMAND_RUN_ENTRY,
          title: "Node: Run Active File",
        },
        {
          command: COMMAND_RUN_ENTRY_WITH_PERMISSIONS,
          title: "Node: Run Active File with Permissions…",
        },
        {
          command: "dataverseIde.node-runtime.openGuide",
          title: "Node: How-to Guide",
        },
      ],
      configuration: {
        title: "Node Runtime",
        properties: {
          "dataverseIde.nodeRuntime.permissions": {
            type: "string",
            enum: [...NODE_PERMISSION_LEVELS],
            enumDescriptions: NODE_PERMISSION_LEVELS.map((level) => PERMISSION_DESCRIPTIONS[level]),
            default: DEFAULT_NODE_PERMISSION_LEVEL,
            scope: "window",
            description:
              "Default permission level for Node: Run File and Node: Run Active File. The per-run commands let you override it.",
          },
          "dataverseIde.nodeRuntime.fsCache": {
            type: "string",
            enum: [...NODE_FS_CACHE_MODES],
            enumDescriptions: [
              "Hydrate each path on its first synchronous fs access (default).",
              "Preload workspace files before the run; node_modules, .git, dist and .ide-build are skipped.",
            ],
            default: DEFAULT_NODE_FS_CACHE,
            scope: "window",
            description:
              "Synchronous fs cache strategy. Eager loading avoids retry restarts for scripts that read many files, at the cost of startup time and memory.",
          },
        },
      },
    });

    const guideRegistration = registerGuide({
      vscode,
      extensionId: "node-runtime",
      content: guideContent,
    });

    const engine = createDirectNodeEngine(vscode, context.workspaceRootUri, outputChannel);

    function defaultPermissionLevel(): NodePermissionLevel {
      return getDefaultNodePermissionLevel(vscode, context.workspaceRootUri);
    }

    async function pickPermissionLevel(
      defaultLevel: NodePermissionLevel,
    ): Promise<NodePermissionLevel | undefined> {
      const items: PermissionQuickPick[] = NODE_PERMISSION_LEVELS.map((level) => ({
        label:
          level === "read-only" ? "Read only" : level === "workspace" ? "Workspace" : "Trusted",
        description:
          level === defaultLevel
            ? `${PERMISSION_DESCRIPTIONS[level]} Current default.`
            : PERMISSION_DESCRIPTIONS[level],
        level,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        title: "Node: Run with Permissions",
        placeHolder: `Select a permission level (default: ${defaultLevel}).`,
        ignoreFocusOut: true,
      });

      return picked?.level;
    }

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
          title: "Node: Run File",
          placeHolder: "Select an entry file to run.",
          ignoreFocusOut: true,
        },
      );

      return quick?.path;
    }

    async function execute(entry: string, level: NodePermissionLevel): Promise<void> {
      outputChannel.show(true);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `[node] Running ${entry} (${level})…`,
          cancellable: false,
        },
        async () => {
          const exitCode = await engine.runFile(entry, level, {
            fsCache: getNodeFsCacheMode(vscode, context.workspaceRootUri),
          });

          if (exitCode !== 0) {
            await vscode.window.showErrorMessage(`[node] ${entry} exited with code ${exitCode}.`);
          }
        },
      );
    }

    async function runFile(argument: unknown, choosePermissions: boolean): Promise<void> {
      const entry =
        typeof argument === "string" ? argument.replaceAll("\\", "/") : await resolveEntry();

      if (entry == null) {
        await vscode.window.showWarningMessage("No file selected to run.");

        return;
      }

      const level = choosePermissions
        ? await pickPermissionLevel(defaultPermissionLevel())
        : defaultPermissionLevel();

      if (level == null) {
        return;
      }

      await execute(entry, level);
    }

    const runFileCommand = vscode.commands.registerCommand(COMMAND_RUN_FILE, (argument?: unknown) =>
      runFile(argument, false),
    );

    const runFileWithPermissionsCommand = vscode.commands.registerCommand(
      COMMAND_RUN_FILE_WITH_PERMISSIONS,
      (argument?: unknown) => runFile(argument, true),
    );

    const runEntryCommand = vscode.commands.registerCommand(COMMAND_RUN_ENTRY, async () => {
      await vscode.commands.executeCommand(COMMAND_RUN_FILE);
    });

    const runEntryWithPermissionsCommand = vscode.commands.registerCommand(
      COMMAND_RUN_ENTRY_WITH_PERMISSIONS,
      async () => {
        await vscode.commands.executeCommand(COMMAND_RUN_FILE_WITH_PERMISSIONS);
      },
    );

    outputChannel.appendLine(
      "[node-runtime] extension activated (direct workspace fs, async loader).",
    );

    return {
      dispose() {
        runFileCommand.dispose();
        runFileWithPermissionsCommand.dispose();
        runEntryCommand.dispose();
        runEntryWithPermissionsCommand.dispose();
        guideRegistration.dispose();
        engine.dispose();
      },
    };
  },
} satisfies IdeExtension;
