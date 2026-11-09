import DOMPurify from "dompurify";
import { marked } from "marked";

import type { ChatController } from "./controller.js";
import type { ChatEvent, ChatMessage, ChatSession, ChatStatus, StoredToolCall } from "./types.js";

/*
 * DOM chat surface shared by the sidebar view and the editor tab.
 *
 * The surface is a pure renderer over ChatController state: it subscribes to
 * controller events and updates the transcript, composer, history drawer, and
 * status row. Both surfaces can be mounted at the same time and stay in sync.
 */

const STYLE_ID = "dataverse-ai-chat-styles";

const CHAT_CSS = `
.di-chat-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  width: 100%;
  box-sizing: border-box;
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  font-size: 13px;
}
.di-chat-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px 6px 12px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
  flex: 0 0 auto;
}
.di-chat-heading {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.di-chat-heading-title {
  font-weight: 600;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.di-chat-heading-model {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.di-chat-icon-button {
  background: transparent;
  border: 1px solid transparent;
  color: var(--vscode-icon-foreground, var(--vscode-foreground));
  border-radius: 3px;
  width: 24px;
  height: 24px;
  padding: 0;
  line-height: 20px;
  cursor: pointer;
  font-size: 14px;
  flex: 0 0 auto;
}
.di-chat-icon-button:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2));
}
.di-chat-icon-button:disabled {
  opacity: .4;
  cursor: default;
}
.di-chat-history {
  max-height: 45%;
  overflow-y: auto;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
  padding: 6px;
  flex: 0 0 auto;
}
.di-chat-history-empty {
  color: var(--vscode-descriptionForeground);
  font-size: 11px;
  padding: 6px 8px;
}
.di-chat-history-entry {
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: 3px;
  padding: 4px 6px;
  cursor: pointer;
}
.di-chat-history-entry:hover {
  background: var(--vscode-list-hoverBackground, rgba(128,128,128,.12));
}
.di-chat-history-entry.active {
  background: var(--vscode-list-activeSelectionBackground, rgba(0,120,215,.25));
  color: var(--vscode-list-activeSelectionForeground, inherit);
}
.di-chat-history-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}
.di-chat-history-title {
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.di-chat-history-time {
  font-size: 10px;
  color: var(--vscode-descriptionForeground);
}
.di-chat-history-delete {
  background: none;
  border: none;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 2px 4px;
  border-radius: 3px;
}
.di-chat-history-delete:hover {
  color: var(--vscode-errorForeground);
  background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2));
}
.di-chat-transcript {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 12px 6px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.di-chat-empty {
  margin: auto;
  max-width: 320px;
  text-align: center;
  color: var(--vscode-descriptionForeground);
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px 6px;
}
.di-chat-empty h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--vscode-foreground);
}
.di-chat-suggestion {
  background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.16));
  color: var(--vscode-button-secondaryForeground, inherit);
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
  border-radius: 4px;
  padding: 6px 8px;
  font: inherit;
  cursor: pointer;
  text-align: left;
}
.di-chat-suggestion:hover {
  background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.26));
}
.di-chat-message {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.di-chat-message-user {
  align-items: flex-end;
}
.di-chat-bubble {
  background: var(--vscode-input-background, rgba(128,128,128,.15));
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,.25));
  border-radius: 8px;
  padding: 7px 10px;
  max-width: 88%;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.45;
}
.di-chat-role {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .3px;
  text-transform: uppercase;
  color: var(--vscode-descriptionForeground);
}
.di-chat-markdown {
  line-height: 1.5;
  overflow-wrap: anywhere;
  min-width: 0;
}
.di-chat-markdown > *:first-child { margin-top: 0; }
.di-chat-markdown > *:last-child { margin-bottom: 0; }
.di-chat-markdown p { margin: 0 0 .65em; }
.di-chat-markdown h1,
.di-chat-markdown h2,
.di-chat-markdown h3,
.di-chat-markdown h4 {
  margin: .9em 0 .45em;
  line-height: 1.25;
  font-weight: 600;
}
.di-chat-markdown h1 { font-size: 1.35em; }
.di-chat-markdown h2 { font-size: 1.2em; }
.di-chat-markdown h3 { font-size: 1.08em; }
.di-chat-markdown ul,
.di-chat-markdown ol { margin: .4em 0 .7em; padding-left: 1.5em; }
.di-chat-markdown li { margin: .15em 0; }
.di-chat-markdown code {
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: .92em;
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.18));
  border-radius: 3px;
  padding: .1em .3em;
}
.di-chat-markdown pre {
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.18));
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2));
  border-radius: 4px;
  padding: 8px 10px;
  overflow-x: auto;
  margin: .5em 0 .8em;
}
.di-chat-markdown pre code {
  background: transparent;
  padding: 0;
  font-size: .92em;
  white-space: pre;
}
.di-chat-markdown blockquote {
  margin: .5em 0;
  padding: .1em 0 .1em .8em;
  border-left: 3px solid var(--vscode-textBlockQuote-border, rgba(128,128,128,.5));
  color: var(--vscode-descriptionForeground);
}
.di-chat-markdown table {
  border-collapse: collapse;
  margin: .5em 0 .8em;
  font-size: .95em;
}
.di-chat-markdown th,
.di-chat-markdown td {
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
  padding: 4px 7px;
}
.di-chat-markdown a {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
}
.di-chat-markdown a:hover { text-decoration: underline; }
.di-chat-markdown img { max-width: 100%; }
.di-chat-typing {
  color: var(--vscode-descriptionForeground);
  font-style: italic;
}
.di-chat-tool-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.di-chat-tool {
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.28));
  border-radius: 5px;
  background: var(--vscode-editorWidget-background, rgba(128,128,128,.06));
  font-size: 11px;
}
.di-chat-tool > summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  cursor: pointer;
  list-style: none;
  white-space: nowrap;
  overflow: hidden;
}
.di-chat-tool > summary::-webkit-details-marker { display: none; }
.di-chat-tool > summary::before {
  content: "▸";
  color: var(--vscode-descriptionForeground);
  font-size: 9px;
  flex: 0 0 auto;
}
.di-chat-tool[open] > summary::before { content: "▾"; }
.di-chat-tool-name {
  font-family: var(--vscode-editor-font-family, monospace);
  font-weight: 600;
  flex: 0 0 auto;
}
.di-chat-tool-summary {
  color: var(--vscode-descriptionForeground);
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.di-chat-tool[data-status="running"] .di-chat-tool-name {
  color: var(--vscode-progressBar-background, #3794ff);
}
.di-chat-tool[data-status="error"] .di-chat-tool-name {
  color: var(--vscode-errorForeground, #f14c4c);
}
.di-chat-tool[data-status="declined"] .di-chat-tool-name {
  color: var(--vscode-editorWarning-foreground, #cca700);
}
.di-chat-tool-body {
  padding: 0 8px 8px 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.di-chat-tool-label {
  color: var(--vscode-descriptionForeground);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: .3px;
}
.di-chat-tool pre {
  margin: 0;
  padding: 5px 7px;
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.16));
  border-radius: 3px;
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 11px;
}
.di-chat-error {
  border-left: 3px solid var(--vscode-errorForeground, #f14c4c);
  color: var(--vscode-errorForeground, #f14c4c);
  padding: 4px 8px;
  background: var(--vscode-inputValidation-errorBackground, rgba(241,76,76,.1));
  border-radius: 3px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.di-chat-note {
  color: var(--vscode-editorWarning-foreground, #cca700);
  font-size: 11px;
}
.di-chat-status {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 3px 12px;
  font-size: 11px;
  color: var(--vscode-descriptionForeground);
  min-height: 18px;
}
.di-chat-status[hidden] { display: none; }
.di-chat-spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--vscode-descriptionForeground);
  border-top-color: transparent;
  border-radius: 50%;
  animation: di-chat-spin .8s linear infinite;
  flex: 0 0 auto;
}
@keyframes di-chat-spin { to { transform: rotate(360deg); } }
.di-chat-composer {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-end;
  gap: 6px;
  padding: 8px 10px 10px;
  border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25));
}
.di-chat-input {
  flex: 1;
  resize: none;
  min-height: 30px;
  max-height: 168px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, rgba(128,128,128,.4));
  border-radius: 5px;
  padding: 6px 8px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.4;
  box-sizing: border-box;
}
.di-chat-input:focus {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
.di-chat-send {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border: none;
  border-radius: 4px;
  padding: 7px 11px;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  flex: 0 0 auto;
}
.di-chat-send:hover { background: var(--vscode-button-hoverBackground); }
.di-chat-send:disabled { opacity: .45; cursor: default; }
.di-chat-stop {
  background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.2));
  color: var(--vscode-button-secondaryForeground, inherit);
  border: none;
  border-radius: 4px;
  padding: 7px 11px;
  font: inherit;
  cursor: pointer;
  flex: 0 0 auto;
}
.di-chat-stop:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.3)); }
.di-chat-stop[hidden] { display: none; }
`;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID) != null) {
    return;
  }

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CHAT_CSS;
  document.head.append(style);
}

function formatTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function prettyArguments(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw || "{}"), null, 2);
  } catch {
    return raw;
  }
}

async function renderMarkdown(text: string): Promise<string> {
  try {
    const rendered = String(await marked.parse(text, { async: true, gfm: true, breaks: true }));

    return DOMPurify.sanitize(rendered, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: [
        "base",
        "button",
        "embed",
        "form",
        "iframe",
        "input",
        "link",
        "meta",
        "object",
        "script",
        "select",
        "style",
        "textarea",
      ],
      FORBID_ATTR: ["style"],
    });
  } catch {
    const pre = document.createElement("pre");
    pre.textContent = text;

    return pre.outerHTML;
  }
}

type MessageView = {
  root: HTMLElement;
  markdown?: HTMLElement;
  tools?: HTMLElement;
  error?: HTMLElement;
  note?: HTMLElement;
  toolCards: Map<string, HTMLElement>;
  content: string;
  renderToken: number;
};

export type ChatSurfaceOptions = {
  container: HTMLElement;
  controller: ChatController;
  getModelLabel: () => string;
  openSettings: () => void;
  openInEditor?: () => void;
};

export class ChatSurface {
  private readonly root: HTMLElement;
  private readonly transcript: HTMLElement;
  private readonly statusRow: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly titleElement: HTMLElement;
  private readonly modelElement: HTMLElement;
  private readonly historyPanel: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private readonly historyButton: HTMLButtonElement;

  private readonly messageViews = new Map<string, MessageView>();
  private readonly renderTimers = new Map<string, number>();
  private subscription: { dispose(): void } | undefined;
  private historyOpen = false;
  private disposed = false;

  constructor(private readonly options: ChatSurfaceOptions) {
    ensureStyles();

    const { container } = options;

    this.root = document.createElement("div");
    this.root.className = "di-chat-root";

    const header = document.createElement("div");
    header.className = "di-chat-header";

    const heading = document.createElement("div");
    heading.className = "di-chat-heading";
    this.titleElement = document.createElement("div");
    this.titleElement.className = "di-chat-heading-title";
    this.titleElement.textContent = "Dataverse AI";
    this.modelElement = document.createElement("div");
    this.modelElement.className = "di-chat-heading-model";
    heading.append(this.titleElement, this.modelElement);

    const newButton = this.iconButton("＋", "New chat");
    this.historyButton = this.iconButton("☰", "Chat history");
    const editorButton =
      options.openInEditor != null ? this.iconButton("⧉", "Open in editor tab") : undefined;
    const settingsButton = this.iconButton("⚙", "Open AI Chat settings");

    header.append(heading, newButton, this.historyButton);

    if (editorButton != null) {
      header.append(editorButton);
    }

    header.append(settingsButton);

    this.historyPanel = document.createElement("div");
    this.historyPanel.className = "di-chat-history";
    this.historyPanel.hidden = true;

    this.transcript = document.createElement("div");
    this.transcript.className = "di-chat-transcript";
    this.transcript.setAttribute("role", "log");
    this.transcript.setAttribute("aria-live", "polite");

    this.statusRow = document.createElement("div");
    this.statusRow.className = "di-chat-status";
    this.statusRow.hidden = true;

    const spinner = document.createElement("div");
    spinner.className = "di-chat-spinner";
    this.statusText = document.createElement("span");
    this.statusRow.append(spinner, this.statusText);

    const composer = document.createElement("div");
    composer.className = "di-chat-composer";

    this.input = document.createElement("textarea");
    this.input.className = "di-chat-input";
    this.input.rows = 1;
    this.input.placeholder = "Ask Dataverse AI about this workspace…";
    this.input.setAttribute("aria-label", "Chat message");

    this.sendButton = document.createElement("button");
    this.sendButton.className = "di-chat-send";
    this.sendButton.type = "button";
    this.sendButton.textContent = "Send";

    this.stopButton = document.createElement("button");
    this.stopButton.className = "di-chat-stop";
    this.stopButton.type = "button";
    this.stopButton.textContent = "Stop";
    this.stopButton.hidden = true;

    composer.append(this.input, this.stopButton, this.sendButton);
    this.root.append(header, this.historyPanel, this.transcript, this.statusRow, composer);
    container.append(this.root);

    newButton.addEventListener("click", () => {
      void this.options.controller.newChat();
      this.input.focus();
    });
    this.historyButton.addEventListener("click", () => this.toggleHistory());
    editorButton?.addEventListener("click", () => options.openInEditor?.());
    settingsButton.addEventListener("click", () => options.openSettings());

    this.sendButton.addEventListener("click", () => this.submit());
    this.stopButton.addEventListener("click", () => this.options.controller.stop());
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.submit();
      }
    });
    this.input.addEventListener("input", () => this.resizeInput());

    this.transcript.addEventListener("scroll", () => {
      /* Scrolling is handled on each render; no state needed. */
    });

    this.subscription = options.controller.onEvent((event) => this.handleEvent(event));

    this.renderAll();
    this.resizeInput();
  }

  dispose(): void {
    this.disposed = true;
    this.subscription?.dispose();

    for (const timer of this.renderTimers.values()) {
      window.clearTimeout(timer);
    }

    this.renderTimers.clear();
    this.root.remove();
  }

  focusInput(): void {
    this.input.focus();
  }

  private iconButton(label: string, title: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "di-chat-icon-button";
    button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);

    return button;
  }

  private handleEvent(event: ChatEvent): void {
    if (this.disposed) {
      return;
    }

    switch (event.type) {
      case "session":
        this.renderAll();
        break;

      case "history":
        this.renderHistory();
        break;

      case "delta":
        this.updateDelta(event.messageId, event.content);
        break;

      case "status":
        this.applyStatus(event.status);
        break;
    }
  }

  private renderAll(): void {
    const { session, history } = this.options.controller.getState();
    const scroll = this.isNearBottom();

    for (const timer of this.renderTimers.values()) {
      window.clearTimeout(timer);
    }

    this.renderTimers.clear();

    this.titleElement.textContent = session.title;
    this.modelElement.textContent = this.options.getModelLabel();

    this.transcript.replaceChildren();
    this.messageViews.clear();

    if (session.messages.length === 0) {
      this.transcript.append(this.createEmptyState());
    } else {
      for (const message of session.messages) {
        this.transcript.append(this.createMessageView(message).root);
      }
    }

    if (this.historyOpen) {
      this.renderHistory(session, history);
    }

    this.applyStatus(this.options.controller.getState().status);

    if (scroll) {
      this.scrollToBottom();
    }
  }

  private createEmptyState(): HTMLElement {
    const empty = document.createElement("div");
    empty.className = "di-chat-empty";

    const heading = document.createElement("h2");
    heading.textContent = "Ask Dataverse AI";
    const lead = document.createElement("div");
    lead.textContent =
      "Agent with workspace tools: it can read, search, edit, move, and open files.";

    empty.append(heading, lead);

    const suggestions: { label: string; prompt: string }[] = [
      {
        label: "Summarize this workspace",
        prompt: "Inspect this workspace and summarize its structure and purpose.",
      },
      {
        label: "Explain the active file",
        prompt: "Explain the file I have open, focusing on the important control flow.",
      },
      {
        label: "Find TODOs",
        prompt: "Search the workspace for TODOs and summarize them by file.",
      },
    ];

    for (const suggestion of suggestions) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "di-chat-suggestion";
      button.textContent = suggestion.label;
      button.addEventListener("click", () => {
        this.options.controller.send(suggestion.prompt);
      });
      empty.append(button);
    }

    return empty;
  }

  private createMessageView(message: ChatMessage): MessageView {
    const root = document.createElement("div");
    root.className = `di-chat-message di-chat-message-${message.role}`;

    const view: MessageView = {
      root,
      toolCards: new Map(),
      content: message.content,
      renderToken: 0,
    };

    if (message.role === "user") {
      const bubble = document.createElement("div");
      bubble.className = "di-chat-bubble";
      bubble.textContent = message.content;
      root.append(bubble);
      this.messageViews.set(message.id, view);

      return view;
    }

    const role = document.createElement("div");
    role.className = "di-chat-role";
    role.textContent = "Dataverse AI";

    const markdown = document.createElement("div");
    markdown.className = "di-chat-markdown";
    view.markdown = markdown;

    root.append(role, markdown);

    if (message.toolCalls != null && message.toolCalls.length > 0) {
      const tools = document.createElement("div");
      tools.className = "di-chat-tool-list";
      view.tools = tools;

      for (const call of message.toolCalls) {
        const card = this.createToolCard(call);
        view.toolCards.set(call.id, card);
        tools.append(card);
      }

      root.append(tools);
    }

    if (message.error != null) {
      const error = document.createElement("div");
      error.className = "di-chat-error";
      error.textContent = message.error;
      view.error = error;
      root.append(error);
    }

    if (message.incomplete) {
      const note = document.createElement("div");
      note.className = "di-chat-note";
      note.textContent = "Stopped before the model produced a final answer.";
      view.note = note;
      root.append(note);
    }

    this.messageViews.set(message.id, view);
    this.renderMessageContent(view, message.content);

    return view;
  }

  private createToolCard(call: StoredToolCall): HTMLElement {
    const details = document.createElement("details");
    details.className = "di-chat-tool";
    details.dataset.status = call.status;

    const summary = document.createElement("summary");

    const name = document.createElement("span");
    name.className = "di-chat-tool-name";
    name.textContent = call.name;

    const outcome = document.createElement("span");
    outcome.className = "di-chat-tool-summary";
    outcome.textContent = call.summary ?? (call.status === "running" ? "running…" : "");

    summary.append(name, outcome);

    const body = document.createElement("div");
    body.className = "di-chat-tool-body";

    const argsLabel = document.createElement("div");
    argsLabel.className = "di-chat-tool-label";
    argsLabel.textContent = "Arguments";
    const args = document.createElement("pre");
    args.textContent = prettyArguments(call.arguments);

    body.append(argsLabel, args);

    if (call.result != null) {
      const resultLabel = document.createElement("div");
      resultLabel.className = "di-chat-tool-label";
      resultLabel.textContent = call.status === "error" ? "Error" : "Result";
      const result = document.createElement("pre");
      result.textContent = call.result;
      body.append(resultLabel, result);
    }

    details.append(summary, body);

    return details;
  }

  private renderMessageContent(view: MessageView, content: string): void {
    view.content = content;

    if (view.markdown == null) {
      return;
    }

    const markdown = view.markdown;
    const token = ++view.renderToken;

    if (content.trim().length === 0) {
      markdown.replaceChildren();
      const typing = document.createElement("span");
      typing.className = "di-chat-typing";
      typing.textContent = "…";
      markdown.append(typing);
      return;
    }

    void renderMarkdown(content).then((html) => {
      if (this.disposed || view.renderToken !== token) {
        return;
      }

      markdown.innerHTML = html;
      markdown.querySelectorAll("a").forEach((anchor) => {
        anchor.setAttribute("target", "_blank");
        anchor.setAttribute("rel", "noopener noreferrer");
      });

      if (this.isNearBottom()) {
        this.scrollToBottom();
      }
    });
  }

  private updateDelta(messageId: string, content: string): void {
    const view = this.messageViews.get(messageId);

    if (view == null) {
      this.renderAll();
      return;
    }

    const existing = this.renderTimers.get(messageId);

    if (existing != null) {
      window.clearTimeout(existing);
    }

    const timer = window.setTimeout(() => {
      this.renderTimers.delete(messageId);
      this.renderMessageContent(view, content);
    }, 70);

    this.renderTimers.set(messageId, timer);
  }

  private renderHistory(
    session: ChatSession = this.options.controller.getState().session,
    history: ChatSession[] = this.options.controller.getState().history,
  ): void {
    this.historyPanel.replaceChildren();

    if (history.length === 0) {
      const empty = document.createElement("div");
      empty.className = "di-chat-history-empty";
      empty.textContent = "No saved chats yet.";
      this.historyPanel.append(empty);
      return;
    }

    for (const entry of history) {
      const row = document.createElement("div");
      row.className = "di-chat-history-entry";

      if (entry.id === session.id) {
        row.classList.add("active");
      }

      const main = document.createElement("div");
      main.className = "di-chat-history-main";

      const title = document.createElement("div");
      title.className = "di-chat-history-title";
      title.textContent = entry.title;

      const time = document.createElement("div");
      time.className = "di-chat-history-time";
      time.textContent = `${formatTime(entry.updatedAt)} · ${entry.messages.length} messages`;

      main.append(title, time);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "di-chat-history-delete";
      remove.title = "Delete chat";
      remove.setAttribute("aria-label", "Delete chat");
      remove.textContent = "✕";
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        void this.options.controller.deleteChat(entry.id);
      });

      row.append(main, remove);
      row.addEventListener("click", () => {
        void this.options.controller.loadChat(entry.id);
        this.historyOpen = false;
        this.historyPanel.hidden = true;
      });

      this.historyPanel.append(row);
    }
  }

  private toggleHistory(): void {
    this.historyOpen = !this.historyOpen;
    this.historyPanel.hidden = !this.historyOpen;

    if (this.historyOpen) {
      this.renderHistory();
    }
  }

  private applyStatus(status: ChatStatus): void {
    const working = status.kind === "working";

    this.statusRow.hidden = !working;
    this.statusText.textContent = working ? status.label : "";
    this.stopButton.hidden = !working;
    this.sendButton.disabled = working || this.input.value.trim().length === 0;
    this.input.disabled = working;
    this.historyButton.disabled = working;

    if (!working) {
      this.sendButton.disabled = this.input.value.trim().length === 0;
    }
  }

  private submit(): void {
    if (this.options.controller.getState().status.kind === "working") {
      return;
    }

    const value = this.input.value;

    if (value.trim().length === 0) {
      return;
    }

    this.input.value = "";
    this.resizeInput();
    this.options.controller.send(value);
  }

  private resizeInput(): void {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 168)}px`;
    this.sendButton.disabled =
      this.options.controller.getState().status.kind === "working" ||
      this.input.value.trim().length === 0;
  }

  private isNearBottom(): boolean {
    return (
      this.transcript.scrollHeight - this.transcript.scrollTop - this.transcript.clientHeight < 80
    );
  }

  private scrollToBottom(): void {
    this.transcript.scrollTop = this.transcript.scrollHeight;
  }
}
