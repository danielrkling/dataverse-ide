/*
 * Persistence and UI model for a chat conversation.
 *
 * Messages keep the rendered Markdown text plus the tool calls made while
 * producing it, so a chat can be restored from IndexedDB without replaying
 * the model.
 */

export type ChatRole = "user" | "assistant";

export type ToolCallStatus = "running" | "ok" | "error" | "declined";

export type StoredToolCall = {
  id: string;
  name: string;
  arguments: string;
  result?: string;
  /** Short human-readable outcome shown in the transcript. */
  summary?: string;
  status: ToolCallStatus;
};

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  toolCalls?: StoredToolCall[];
  error?: string;
  /** True when the agent stopped because it hit maxAgentSteps. */
  incomplete?: boolean;
};

export type ChatSession = {
  id: string;
  title: string;
  /** Workspace root URI used to scope history. */
  workspace: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};

export type ChatStatus =
  | { kind: "idle" }
  | {
      kind: "working";
      label: string;
    };

export type ChatEvent =
  | { type: "session" }
  | { type: "history" }
  | { type: "delta"; messageId: string; content: string }
  | { type: "status"; status: ChatStatus };

let idCounter = 0;

export function createId(prefix: string): string {
  idCounter += 1;

  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  return `${prefix}-${random}-${idCounter}`;
}

export function createSession(workspace: string): ChatSession {
  const now = Date.now();

  return {
    id: createId("chat"),
    title: "New chat",
    workspace,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

export function titleFromPrompt(prompt: string): string {
  const singleLine = prompt.replace(/\s+/g, " ").trim();

  if (singleLine.length === 0) {
    return "New chat";
  }

  return singleLine.length > 60 ? `${singleLine.slice(0, 57)}…` : singleLine;
}
