import type * as vscodeType from "vscode";

import { createChatCompletion, streamChatCompletion } from "./client.js";
import { runAgent, type AgentEvent } from "./harness.js";
import {
  MAX_HISTORY_CHARACTERS,
  MAX_HISTORY_TURNS,
  modelIds,
  type AiChatSettings,
} from "./settings.js";
import { deleteChatSession, listChatSessions, loadChatSession, saveChatSession } from "./store.js";
import { WORKSPACE_TOOL_PROMPT, WORKSPACE_TOOLS, executeWorkspaceTool } from "./tools.js";
import {
  createId,
  createSession,
  titleFromPrompt,
  type ChatEvent,
  type ChatMessage,
  type ChatSession,
  type ChatStatus,
  type StoredToolCall,
} from "./types.js";

/*
 * Owns the active conversation. Both UI surfaces (sidebar view and editor
 * tab) subscribe to the same controller, so they always show the same chat.
 */

export type ChatControllerHost = {
  vscode: typeof vscodeType;
  workspaceRootUri: vscodeType.Uri;
  outputChannel: vscodeType.OutputChannel;
  getSettings: () => AiChatSettings;
  getApiKey: () => Promise<string>;
};

type HistoryTurn = {
  role: "user" | "assistant";
  text: string;
};

const SAVE_DEBOUNCE_MS = 300;
const MAX_STORED_TOOL_RESULT = 4000;
const MAX_STORED_TOOL_ARGUMENTS = 2000;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function trimHistory(turns: HistoryTurn[]): HistoryTurn[] {
  const recent = turns.slice(-MAX_HISTORY_TURNS);
  let characters = 0;
  const result: HistoryTurn[] = [];

  for (const turn of recent.reverse()) {
    if (characters + turn.text.length > MAX_HISTORY_CHARACTERS) {
      break;
    }

    characters += turn.text.length;
    result.push(turn);
  }

  return result.reverse();
}

export class ChatController {
  readonly workspace: string;

  private session: ChatSession;
  private history: ChatSession[] = [];
  private status: ChatStatus = { kind: "idle" };
  private listeners = new Set<(event: ChatEvent) => void>();
  private activeRun: AbortController | undefined;
  private saveTimer: number | undefined;
  private disposed = false;

  constructor(private readonly host: ChatControllerHost) {
    this.workspace = host.workspaceRootUri.toString();
    this.session = createSession(this.workspace);
  }

  getState(): { session: ChatSession; history: ChatSession[]; status: ChatStatus } {
    return { session: this.session, history: this.history, status: this.status };
  }

  onEvent(listener: (event: ChatEvent) => void): { dispose(): void } {
    this.listeners.add(listener);

    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** Re-render surfaces after settings change (the model label lives there). */
  refresh(): void {
    this.emit({ type: "session" });
  }

  async init(): Promise<void> {
    await this.refreshHistory();

    /*
     * Restore the most recent conversation so a reload does not lose the
     * chat. If there is no history, start with a fresh session.
     */
    const latest = this.history[0];

    if (latest != null && latest.messages.length > 0) {
      this.session = latest;
    }
  }

  async newChat(): Promise<void> {
    if (this.status.kind === "working") {
      this.stop();
    }

    await this.saveNow();

    this.session = createSession(this.workspace);
    this.emit({ type: "session" });
  }

  async loadChat(id: string): Promise<void> {
    if (id === this.session.id) {
      this.emit({ type: "session" });
      return;
    }

    if (this.status.kind === "working") {
      this.stop();
    }

    await this.saveNow();

    const loaded = await loadChatSession(id);

    if (loaded == null || loaded.workspace !== this.workspace) {
      this.host.outputChannel.appendLine(`[ai-chat] Chat ${id} was not found.`);
      return;
    }

    this.session = loaded;
    this.emit({ type: "session" });
  }

  async deleteChat(id: string): Promise<void> {
    if (id === this.session.id) {
      this.stop();
    }

    await deleteChatSession(id);

    if (id === this.session.id) {
      this.session = createSession(this.workspace);
      this.emit({ type: "session" });
    }

    await this.refreshHistory();
  }

  stop(): void {
    this.activeRun?.abort();
  }

  send(text: string): void {
    if (this.status.kind === "working") {
      return;
    }

    const prompt = text.trim();

    if (prompt.length === 0) {
      return;
    }

    void this.run(prompt);
  }

  private async run(prompt: string): Promise<void> {
    const settings = this.host.getSettings();
    const now = Date.now();
    const turnsEnd = this.session.messages.length;

    const userMessage: ChatMessage = {
      id: createId("msg"),
      role: "user",
      content: prompt,
      createdAt: now,
    };

    this.session.messages.push(userMessage);

    if (this.session.title === "New chat") {
      this.session.title = titleFromPrompt(prompt);
    }

    const assistantMessage: ChatMessage = {
      id: createId("msg"),
      role: "assistant",
      content: "",
      createdAt: now + 1,
    };

    this.session.messages.push(assistantMessage);
    this.session.updatedAt = Date.now();
    this.emit({ type: "session" });

    const runController = new AbortController();
    this.activeRun = runController;
    this.setStatus({ kind: "working", label: "Thinking…" });
    this.scheduleSave();

    try {
      const apiKey = await this.host.getApiKey();

      if (runController.signal.aborted) {
        return;
      }

      const turns = this.historyTurns(turnsEnd);
      const contextText = await this.activeEditorContext(settings);
      const promptWithContext = [prompt, contextText]
        .filter((part) => part.length > 0)
        .join("\n\n");

      this.host.outputChannel.appendLine(
        `[ai-chat] Request received (tools=${settings.enableWorkspaceTools}, ` +
          `proxy=${settings.proxyUrl.length > 0 ? "yes" : "no"}, ` +
          `model=${modelIds(settings)[0] ?? settings.model}, turns=${turns.length}).`,
      );

      const result = await runAgent({
        settings: {
          ...settings,
          model: modelIds(settings)[0] ?? settings.model,
        },
        apiKey,
        turns,
        prompt: promptWithContext,
        tools: WORKSPACE_TOOLS,
        toolPrompt: WORKSPACE_TOOL_PROMPT,
        signal: runController.signal,
        executeTool: (call) =>
          executeWorkspaceTool(this.host.vscode, this.host.workspaceRootUri, settings, call),
        onEvent: (event) => this.handleAgentEvent(assistantMessage, event),
        onLog: (line) => this.host.outputChannel.appendLine(line),
        runCompletion: createChatCompletion,
        streamCompletion: streamChatCompletion,
      });

      if (result.incomplete != null) {
        assistantMessage.incomplete = true;
        this.host.outputChannel.appendLine(`[ai-chat] ${result.incomplete}`);
      }

      if (
        assistantMessage.content.trim().length === 0 &&
        (assistantMessage.toolCalls == null || assistantMessage.toolCalls.length === 0) &&
        assistantMessage.error == null
      ) {
        assistantMessage.error = "The model returned an empty response.";
      }
    } catch (error) {
      if (runController.signal.aborted || isAbortError(error)) {
        if (assistantMessage.content.trim().length === 0) {
          assistantMessage.content = "_Stopped._";
        } else {
          assistantMessage.content += "\n\n_Stopped._";
        }
      } else {
        const message = error instanceof Error ? error.message : String(error);

        assistantMessage.error = message;
        this.host.outputChannel.appendLine(`[ai-chat] ${message}`);
      }
    } finally {
      if (this.activeRun === runController) {
        this.activeRun = undefined;
      }

      this.session.updatedAt = Date.now();
      this.setStatus({ kind: "idle" });
      this.emit({ type: "session" });
      await this.saveNow();
    }
  }

  private handleAgentEvent(message: ChatMessage, event: AgentEvent): void {
    switch (event.type) {
      case "status":
        this.setStatus({ kind: "working", label: event.text });
        break;

      case "delta":
        message.content += event.text;
        this.emit({ type: "delta", messageId: message.id, content: message.content });
        break;

      case "tool-start": {
        const call: StoredToolCall = {
          id: event.call.id,
          name: event.call.function.name,
          arguments: clip(event.call.function.arguments, MAX_STORED_TOOL_ARGUMENTS),
          status: "running",
        };

        message.toolCalls = [...(message.toolCalls ?? []), call];
        this.emit({ type: "session" });
        break;
      }

      case "tool-end": {
        const call = message.toolCalls?.find((entry) => entry.id === event.call.id);

        if (call != null) {
          call.result = clip(event.result.content, MAX_STORED_TOOL_RESULT);
          call.summary = event.result.summary;
          call.status = event.result.declined ? "declined" : event.result.ok ? "ok" : "error";
        }

        this.emit({ type: "session" });
        break;
      }
    }
  }

  private historyTurns(end: number): HistoryTurn[] {
    const turns: HistoryTurn[] = [];

    for (const message of this.session.messages.slice(0, end)) {
      if (message.role === "user") {
        turns.push({ role: "user", text: message.content });
      } else if (message.content.trim().length > 0) {
        turns.push({ role: "assistant", text: message.content });
      }
    }

    return trimHistory(turns);
  }

  private async activeEditorContext(settings: AiChatSettings): Promise<string> {
    if (!settings.includeActiveEditor || settings.maxContextCharacters <= 0) {
      return "";
    }

    const { vscode } = this.host;
    const editor = vscode.window.activeTextEditor;

    if (editor == null) {
      return "";
    }

    const document = editor.document;
    const selection = editor.selection;
    const selected = selection.isEmpty ? "" : document.getText(selection);
    const text = selected.length > 0 ? selected : document.getText();
    const budget = settings.maxContextCharacters;
    const clipped = text.length > budget ? `${text.slice(0, budget)}\n… (truncated)` : text;
    const path = vscode.workspace.asRelativePath(document.uri, false);
    const range = selection.isEmpty
      ? "whole file"
      : `lines ${selection.start.line + 1}-${selection.end.line + 1}`;

    return (
      `Context: active file \`${path}\` (${range})\n` +
      `\`\`\`${document.languageId}\n${clipped}\n\`\`\``
    );
  }

  private setStatus(status: ChatStatus): void {
    this.status = status;
    this.emit({ type: "status", status });
  }

  private emit(event: ChatEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.host.outputChannel.appendLine(`[ai-chat] Chat view listener failed: ${String(error)}`);
      }
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer != null) {
      window.clearTimeout(this.saveTimer);
    }

    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = undefined;
      void this.saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

  private async saveNow(): Promise<void> {
    if (this.disposed) {
      return;
    }

    /*
     * Do not persist an empty placeholder conversation created by a failed
     * send; it would add noise to the history list.
     */
    if (this.session.messages.length === 0) {
      return;
    }

    this.session.updatedAt = Date.now();

    try {
      await saveChatSession(this.session);
      await this.refreshHistory();
    } catch (error) {
      this.host.outputChannel.appendLine(`[ai-chat] Could not save chat: ${String(error)}`);
    }
  }

  private async refreshHistory(): Promise<void> {
    try {
      this.history = await listChatSessions(this.workspace);
    } catch (error) {
      this.host.outputChannel.appendLine(`[ai-chat] Could not read chat history: ${String(error)}`);
      this.history = [];
    }

    this.emit({ type: "history" });
  }

  dispose(): void {
    this.disposed = true;
    this.activeRun?.abort();
    this.activeRun = undefined;

    if (this.saveTimer != null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }

    this.listeners.clear();
  }
}
