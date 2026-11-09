import type * as vscodeType from "vscode";

/*
 * Settings shared by the chat surfaces (sidebar + editor tab) and the agent
 * harness. Values come from the regular VS Code configuration service, so
 * they can be edited in the Settings UI, the JSON settings file, or the
 * commands contributed by the extension.
 */

export const CONFIG_SECTION = "dataverseIde.ai-chat";

export const DEFAULT_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_MODEL = "gpt-4o-mini";
export const DEFAULT_SYSTEM_PROMPT =
  "You are Dataverse AI, the built-in coding agent in Dataverse IDE, a browser-based " +
  "VS Code-compatible IDE for Microsoft Dataverse web resources and Power Platform projects. " +
  "Be concise and practical. Use Markdown, and put code in fenced blocks with a language tag. " +
  "Prefer using the workspace tools to inspect real files instead of guessing. " +
  "If you are unsure or need more context, say so instead of inventing an answer.";

export const DEFAULT_MAX_TOKENS = 4096;
export const DEFAULT_TEMPERATURE = 0.2;
export const DEFAULT_MAX_CONTEXT_CHARACTERS = 12000;
export const DEFAULT_MAX_AGENT_STEPS = 10;
export const MAX_INPUT_TOKENS = 128000;
export const MAX_TOOL_FILE_BYTES = 256 * 1024;

export const MAX_HISTORY_TURNS = 20;
export const MAX_HISTORY_CHARACTERS = 24000;

export type AiChatSettings = {
  baseUrl: string;
  apiVersion: string;
  proxyUrl: string;
  model: string;
  systemPrompt: string;
  maxTokens: number;
  temperature: number;
  includeActiveEditor: boolean;
  maxContextCharacters: number;
  enableWorkspaceTools: boolean;
  maxAgentSteps: number;
  confirmWrites: boolean;
};

function numberSetting(
  config: vscodeType.WorkspaceConfiguration,
  key: string,
  fallback: number,
): number {
  const value = config.get<number>(key, fallback);

  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringSetting(
  config: vscodeType.WorkspaceConfiguration,
  key: string,
  fallback: string,
): string {
  const value = config.get<string>(key, fallback);

  return typeof value === "string" ? value.trim() : fallback;
}

export function readAiChatSettings(
  vscode: typeof vscodeType,
  workspaceRootUri?: vscodeType.Uri,
): AiChatSettings {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, workspaceRootUri ?? null);

  return {
    baseUrl: stringSetting(config, "baseUrl", DEFAULT_BASE_URL) || DEFAULT_BASE_URL,
    apiVersion: stringSetting(config, "apiVersion", ""),
    proxyUrl: stringSetting(config, "proxyUrl", ""),
    model: stringSetting(config, "model", DEFAULT_MODEL) || DEFAULT_MODEL,
    systemPrompt: stringSetting(config, "systemPrompt", DEFAULT_SYSTEM_PROMPT),
    maxTokens: numberSetting(config, "maxTokens", DEFAULT_MAX_TOKENS),
    temperature: Math.min(
      2,
      Math.max(0, numberSetting(config, "temperature", DEFAULT_TEMPERATURE)),
    ),
    includeActiveEditor: config.get<boolean>("includeActiveEditor", true),
    maxContextCharacters: Math.max(
      0,
      numberSetting(config, "maxContextCharacters", DEFAULT_MAX_CONTEXT_CHARACTERS),
    ),
    enableWorkspaceTools: config.get<boolean>("enableWorkspaceTools", true),
    maxAgentSteps: Math.min(
      60,
      Math.max(1, Math.round(numberSetting(config, "maxAgentSteps", DEFAULT_MAX_AGENT_STEPS))),
    ),
    confirmWrites: config.get<boolean>("confirmWrites", true),
  };
}

export function modelIds(settings: Pick<AiChatSettings, "model">): string[] {
  const ids = settings.model
    .split(/[,;\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return Array.from(new Set(ids));
}
