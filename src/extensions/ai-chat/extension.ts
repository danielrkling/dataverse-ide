import type * as vscodeType from "vscode";

import { getService } from "@codingame/monaco-vscode-api";
import { IViewsService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/views/common/viewsService.service";

import { contributeExtensionManifest } from "../api.js";
import { guideCommandId, registerGuide } from "../shared/guide.js";

import { CHAT_VIEW_ID, registerChatPanel } from "./chatPanel.js";
import { openChatEditor, registerChatEditor } from "./chatEditor.js";
import { createChatCompletion, isLocalEndpoint } from "./client.js";
import { ChatController } from "./controller.js";
import {
  CONFIG_SECTION,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_AGENT_STEPS,
  DEFAULT_MAX_CONTEXT_CHARACTERS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_TEMPERATURE,
  MAX_INPUT_TOKENS,
  modelIds,
  readAiChatSettings,
} from "./settings.js";

import guideContent from "./GUIDE.md?raw";

import type { ExtensionContext, IdeExtension } from "../api.js";

/*
 * AI chat extension.
 *
 * The chat UI is owned by this extension: a custom sidebar view and a custom
 * editor tab, both rendering the same conversation from ChatController. The
 * agent loop and workspace tools live in harness.ts/tools.ts, and sessions are
 * persisted in the shared `dataverse-ide` IndexedDB database.
 *
 * No VS Code Chat/Copilot services are involved.
 */

const EXTENSION_ID = "ai-chat";
const SECRET_API_KEY = "apiKey";

const COMMAND_OPEN_CHAT = "dataverseIde.aiChat.open";
const COMMAND_OPEN_CHAT_EDITOR = "dataverseIde.aiChat.openEditor";
const COMMAND_NEW_CHAT = "dataverseIde.aiChat.newChat";
const COMMAND_SET_API_KEY = "dataverseIde.aiChat.setApiKey";
const COMMAND_CLEAR_API_KEY = "dataverseIde.aiChat.clearApiKey";
const COMMAND_DIAGNOSE = "dataverseIde.aiChat.diagnose";
const COMMAND_TEST_CONNECTION = "dataverseIde.aiChat.testConnection";

async function readStoredApiKey(context: ExtensionContext): Promise<string | undefined> {
  const stored = await context.secrets.get(SECRET_API_KEY);
  const trimmed = stored?.trim();

  return trimmed != null && trimmed.length > 0 ? trimmed : undefined;
}

async function promptForApiKey(context: ExtensionContext): Promise<string | undefined> {
  const value = await context.vscode.window.showInputBox({
    title: "Dataverse AI: API key",
    prompt:
      "Stored in the browser's encrypted secret storage. Use the key for your " +
      "OpenAI-compatible endpoint (or leave empty for a local endpoint).",
    placeHolder: "sk-...",
    password: true,
    ignoreFocusOut: true,
  });

  if (value == null) {
    return undefined;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    await context.secrets.remove(SECRET_API_KEY);
    return "";
  }

  await context.secrets.set(SECRET_API_KEY, trimmed);
  context.outputChannel.appendLine("[ai-chat] API key saved.");

  return trimmed;
}

async function requireApiKey(
  context: ExtensionContext,
  settings: ReturnType<typeof readAiChatSettings>,
): Promise<string> {
  const existing = await readStoredApiKey(context);

  if (existing != null) {
    return existing;
  }

  /*
   * Local OpenAI-compatible servers (Ollama, LM Studio, ...) frequently run
   * without auth. Don't block them with a pointless prompt.
   */
  if (isLocalEndpoint(settings.baseUrl)) {
    return "";
  }

  const entered = await promptForApiKey(context);

  if (entered == null) {
    throw new Error("No API key configured. Run 'AI Chat: Set API Key' and try again.");
  }

  return entered;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(invalid URL)";
  }
}

async function revealChat(): Promise<void> {
  const views = await getService(IViewsService);

  await views.openViewContainer(CHAT_VIEW_ID, true);
}

export default {
  id: EXTENSION_ID,

  async activate(context: ExtensionContext): Promise<vscodeType.Disposable | void> {
    const { vscode, workspaceRootUri, outputChannel } = context;

    outputChannel.appendLine("[ai-chat] activating.");

    const guideRegistration = registerGuide({
      vscode,
      extensionId: EXTENSION_ID,
      content: guideContent,
    });

    await contributeExtensionManifest({
      id: EXTENSION_ID,
      displayName: "Dataverse IDE AI Chat",
      description:
        "Workspace agent with a sidebar view and editor tab, powered by any OpenAI-compatible endpoint.",
      commands: [
        {
          command: COMMAND_OPEN_CHAT,
          title: "AI Chat: Open Chat",
        },
        {
          command: COMMAND_OPEN_CHAT_EDITOR,
          title: "AI Chat: Open Chat in Editor",
        },
        {
          command: COMMAND_NEW_CHAT,
          title: "AI Chat: New Chat",
        },
        {
          command: COMMAND_SET_API_KEY,
          title: "AI Chat: Set API Key",
        },
        {
          command: COMMAND_CLEAR_API_KEY,
          title: "AI Chat: Clear API Key",
        },
        {
          command: COMMAND_DIAGNOSE,
          title: "AI Chat: Diagnose",
        },
        {
          command: COMMAND_TEST_CONNECTION,
          title: "AI Chat: Test Connection",
        },
        {
          command: guideCommandId(EXTENSION_ID),
          title: "AI Chat: How-to Guide",
        },
      ],
      keybindings: [
        {
          command: COMMAND_OPEN_CHAT,
          key: "ctrl+alt+i",
          mac: "ctrl+alt+i",
        },
        {
          command: COMMAND_OPEN_CHAT_EDITOR,
          key: "ctrl+alt+shift+i",
          mac: "ctrl+alt+shift+i",
        },
      ],
      configuration: {
        title: "Dataverse IDE AI Chat",
        properties: {
          [`${CONFIG_SECTION}.baseUrl`]: {
            type: "string",
            default: DEFAULT_BASE_URL,
            scope: "window",
            markdownDescription:
              "Base URL of an OpenAI-compatible API, for example " +
              "`https://api.openai.com/v1`, `https://openrouter.ai/api/v1`, or " +
              "`http://localhost:11434/v1` for Ollama. The URL must allow CORS from the IDE origin.",
          },
          [`${CONFIG_SECTION}.apiVersion`]: {
            type: "string",
            default: "",
            scope: "window",
            markdownDescription:
              "Optional Azure OpenAI `api-version` query parameter. When set, the key is sent " +
              "in the `api-key` header instead of `Authorization: Bearer`.",
          },
          [`${CONFIG_SECTION}.proxyUrl`]: {
            type: "string",
            default: "",
            scope: "window",
            markdownDescription:
              "Optional pass-through proxy URL, for example a Power Automate HTTP flow. " +
              "Requests are sent as `{ url, method, headers, body }` and the proxy must return " +
              "the upstream JSON response. When set, responses are non-streaming.",
          },
          [`${CONFIG_SECTION}.model`]: {
            type: "string",
            default: DEFAULT_MODEL,
            scope: "window",
            markdownDescription:
              "Model id (or a comma-separated list of ids) sent to the endpoint.",
          },
          [`${CONFIG_SECTION}.systemPrompt`]: {
            type: "string",
            default: DEFAULT_SYSTEM_PROMPT,
            scope: "window",
            markdownDescription: "System prompt prepended to every request.",
          },
          [`${CONFIG_SECTION}.environmentContext`]: {
            type: "string",
            default: "",
            scope: "window",
            markdownDescription:
              "Optional description of the environment the agent is working in, for example " +
              "`React + Vite app; source in src/; builds to dist/; uses Tailwind and pnpm`. " +
              "Appended to the system prompt with the workspace root.",
          },
          [`${CONFIG_SECTION}.maxTokens`]: {
            type: "number",
            default: DEFAULT_MAX_TOKENS,
            minimum: 0,
            maximum: MAX_INPUT_TOKENS,
            scope: "window",
            markdownDescription:
              "Maximum output tokens (`max_tokens`). Set to 0 to omit the parameter.",
          },
          [`${CONFIG_SECTION}.temperature`]: {
            type: "number",
            default: DEFAULT_TEMPERATURE,
            minimum: 0,
            maximum: 2,
            scope: "window",
            markdownDescription: "Sampling temperature (0-2).",
          },
          [`${CONFIG_SECTION}.includeActiveEditor`]: {
            type: "boolean",
            default: true,
            scope: "window",
            markdownDescription:
              "Include the active editor (or its selection) as context with each chat request.",
          },
          [`${CONFIG_SECTION}.maxContextCharacters`]: {
            type: "number",
            default: DEFAULT_MAX_CONTEXT_CHARACTERS,
            minimum: 0,
            scope: "window",
            markdownDescription:
              "Maximum characters of workspace context added to a request. Set to 0 to disable context.",
          },
          [`${CONFIG_SECTION}.enableWorkspaceTools`]: {
            type: "boolean",
            default: true,
            scope: "window",
            markdownDescription:
              "Let the agent read, search, write, move, and delete workspace files using tools. " +
              "Uses non-streaming requests while enabled.",
          },
          [`${CONFIG_SECTION}.maxAgentSteps`]: {
            type: "number",
            default: DEFAULT_MAX_AGENT_STEPS,
            minimum: 1,
            maximum: 60,
            scope: "window",
            markdownDescription:
              "Maximum model/tool turns per chat request when workspace tools are enabled (1-60).",
          },
          [`${CONFIG_SECTION}.confirmWrites`]: {
            type: "boolean",
            default: true,
            scope: "window",
            markdownDescription:
              "Ask for confirmation before a tool writes, moves, or deletes workspace files.",
          },
        },
      },
    });

    outputChannel.appendLine("[ai-chat] manifest contributions registered.");

    const getSettings = () => readAiChatSettings(vscode, workspaceRootUri);
    const controller = new ChatController({
      vscode,
      workspaceRootUri,
      outputChannel,
      getSettings,
      getApiKey: () => requireApiKey(context, getSettings()),
    });

    await controller.init();

    const getModelLabel = () => modelIds(getSettings())[0] ?? getSettings().model;
    const openSettings = () => {
      void vscode.commands
        .executeCommand("workbench.action.openSettings", CONFIG_SECTION)
        .then(undefined, (error: unknown) => {
          outputChannel.appendLine(`[ai-chat] Could not open settings: ${String(error)}`);
        });
    };
    const openEditor = () => {
      void openChatEditor().catch((error: unknown) => {
        outputChannel.appendLine(`[ai-chat] Could not open the chat editor: ${String(error)}`);
      });
    };

    const panel = registerChatPanel({
      controller,
      getModelLabel,
      openSettings,
      openInEditor: openEditor,
    });
    const editorRegistration = registerChatEditor({
      controller,
      getModelLabel,
      openSettings,
    });

    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

    statusBar.name = "Dataverse AI";
    statusBar.text = "$(sparkle) Dataverse AI";
    statusBar.tooltip = "Open the Dataverse AI chat";
    statusBar.command = COMMAND_OPEN_CHAT;

    const openChatCommand = vscode.commands.registerCommand(COMMAND_OPEN_CHAT, async () => {
      try {
        await revealChat();
      } catch (error) {
        outputChannel.appendLine(`[ai-chat] Could not reveal the chat view: ${String(error)}`);
        await vscode.commands.executeCommand("workbench.action.focusSideBar");
      }
    });

    const openChatEditorCommand = vscode.commands.registerCommand(
      COMMAND_OPEN_CHAT_EDITOR,
      openEditor,
    );

    const newChatCommand = vscode.commands.registerCommand(COMMAND_NEW_CHAT, async () => {
      await controller.newChat();
      await vscode.commands.executeCommand(COMMAND_OPEN_CHAT);
    });

    statusBar.show();

    const setApiKey = vscode.commands.registerCommand(COMMAND_SET_API_KEY, async () => {
      const key = await promptForApiKey(context);

      if (key == null) {
        return;
      }

      controller.refresh();
      await vscode.window.showInformationMessage(
        key.length > 0
          ? "Dataverse AI: API key saved."
          : "Dataverse AI: API key cleared; requests will be sent without authorization.",
      );
    });

    const clearApiKey = vscode.commands.registerCommand(COMMAND_CLEAR_API_KEY, async () => {
      await context.secrets.remove(SECRET_API_KEY);
      controller.refresh();
      await vscode.window.showInformationMessage("Dataverse AI: API key cleared.");
    });

    const diagnose = vscode.commands.registerCommand(COMMAND_DIAGNOSE, async () => {
      const settings = getSettings();
      const key = await context.secrets.get(SECRET_API_KEY);
      const state = controller.getState();
      const lines = [
        `chat surfaces: sidebar + editor`,
        `active session: ${state.session.id} (${state.session.messages.length} messages)`,
        `saved sessions: ${state.history.length}`,
        `base URL: ${hostLabel(settings.baseUrl)}`,
        `proxy: ${settings.proxyUrl.length > 0 ? "set" : "none"}`,
        `model: ${settings.model}`,
        `environment context: ${settings.environmentContext.length > 0 ? "set" : "none"}`,
        `API key: ${key != null && key.trim().length > 0 ? "stored" : "not set"}`,
        `workspace tools: ${settings.enableWorkspaceTools}`,
        `max agent steps: ${settings.maxAgentSteps}`,
        `workspace: ${workspaceRootUri.toString()}`,
        `chat storage: dataverse-ide / chats`,
      ];

      for (const line of lines) {
        outputChannel.appendLine(`[ai-chat] ${line}`);
      }

      outputChannel.show(true);
      await vscode.window.showInformationMessage(
        `Dataverse AI: sidebar + editor, ${state.history.length} saved chat(s), ` +
          `tools=${settings.enableWorkspaceTools}, ` +
          `key=${key != null && key.trim().length > 0 ? "stored" : "not set"}. ` +
          "Details in Output → Dataverse IDE: ai-chat.",
      );
    });

    const testConnection = vscode.commands.registerCommand(COMMAND_TEST_CONNECTION, async () => {
      const settings = getSettings();

      try {
        const apiKey = await requireApiKey(context, settings);
        const model = modelIds(settings)[0] ?? settings.model;

        outputChannel.appendLine(
          `[ai-chat] Test connection -> ${settings.proxyUrl.trim() ? "proxy" : hostLabel(settings.baseUrl)} ` +
            `(model=${model}).`,
        );

        const message = await createChatCompletion({
          baseUrl: settings.baseUrl,
          apiVersion: settings.apiVersion,
          proxyUrl: settings.proxyUrl,
          apiKey,
          model,
          messages: [{ role: "user", content: "Reply with exactly: OK" }],
          temperature: 0,
          maxTokens: 16,
        });
        const text = message.content?.trim() ?? "";

        outputChannel.appendLine(
          `[ai-chat] Test connection response: ${text.length > 0 ? text : "(empty)"}.`,
        );
        await vscode.window.showInformationMessage(
          `Dataverse AI test: ${text.length > 0 ? text : "(empty response)"}`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        outputChannel.appendLine(`[ai-chat] Test connection failed: ${message}`);
        await vscode.window.showErrorMessage(`Dataverse AI test failed: ${message}`);
      }
    });

    const configurationWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        controller.refresh();
      }
    });

    outputChannel.appendLine("[ai-chat] extension activated.");

    return {
      dispose() {
        configurationWatcher.dispose();
        statusBar.dispose();
        openChatCommand.dispose();
        openChatEditorCommand.dispose();
        newChatCommand.dispose();
        setApiKey.dispose();
        clearApiKey.dispose();
        diagnose.dispose();
        testConnection.dispose();
        editorRegistration.dispose();
        panel.dispose();
        controller.dispose();
        guideRegistration.dispose();
      },
    };
  },
} satisfies IdeExtension;
