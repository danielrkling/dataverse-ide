import type * as vscodeType from "vscode";

import {
  EditorInputCapabilities,
  SimpleEditorInput,
  SimpleEditorPane,
  registerEditorPane,
} from "@codingame/monaco-vscode-api/service-override/tools/views";
import { StandaloneServices } from "@codingame/monaco-vscode-api/vscode/vs/editor/standalone/browser/standaloneServices";
import type { IEditorGroup } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorGroupsService";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";
import {
  ACTIVE_GROUP,
  SIDE_GROUP,
} from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService";
import type { EditorInput } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor/editorInput";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { IExtensionService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/extensions/common/extensions.service";

import DOMPurify from "dompurify";
import { marked } from "marked";

import { contributeExtensionManifest } from "../api.js";
import type { ExtensionContext, IdeExtension } from "../api.js";

/*
 * DOM-based Markdown preview.
 *
 * The built-in preview is a VS Code webview. Webviews need the per-webview
 * service worker, and some hosts (notably Dataverse web resources, which
 * redirect service-worker script requests) refuse to register it, leaving the
 * preview with "Could not register service worker".
 *
 * This preview renders the Markdown to HTML in-process and shows it in a
 * normal editor pane instead. There is no webview, no separate origin and no
 * service worker, so it works anywhere the workbench itself works.
 *
 * The rendered HTML is sanitized with DOMPurify and mounted inside a shadow
 * root, which keeps document styles isolated from the workbench UI. Relative
 * images are read through the workspace FileSystemProvider so they also work
 * for OPFS / File System Access workspaces.
 */

const PREVIEW_EDITOR_ID = "workbench.editors.dataverseIdeMarkdownPreview";
const PREVIEW_SCHEME = "dataverse-ide-markdown-preview";

const COMMAND_OPEN = "dataverseIde.markdown.openPreview";
const COMMAND_OPEN_TO_SIDE = "dataverseIde.markdown.openPreviewToSide";
const COMMAND_SHOW_SOURCE = "dataverseIde.markdown.showSource";
const COMMAND_TOGGLE = "dataverseIde.markdown.togglePreview";

let api: typeof vscodeType;

function previewResource(documentUri: vscodeType.Uri): URI {
  return URI.parse(`${PREVIEW_SCHEME}:/${encodeURIComponent(documentUri.toString())}`);
}

function basename(uri: vscodeType.Uri): string {
  const name = uri.path.split("/").pop();

  return name == null || name.length === 0 ? "Markdown" : name;
}

function asUri(value: unknown): vscodeType.Uri | undefined {
  if (value == null) {
    return undefined;
  }

  if (typeof value === "string") {
    try {
      return api.Uri.parse(value);
    } catch {
      return undefined;
    }
  }

  if (typeof value === "object" && "scheme" in value && "path" in value) {
    return value as vscodeType.Uri;
  }

  return undefined;
}

function mimeTypeForPath(path: string): string {
  switch (path.toLowerCase().split(".").pop()) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return btoa(binary);
}

function resolveHref(documentUri: vscodeType.Uri, href: string): vscodeType.Uri | undefined {
  const path = href.split("#")[0].split("?")[0];

  if (path.length === 0) {
    return undefined;
  }

  if (path.startsWith("/")) {
    const workspaceRoot = api.workspace.workspaceFolders?.[0]?.uri;

    return workspaceRoot == null
      ? undefined
      : api.Uri.joinPath(workspaceRoot, path.replace(/^\/+/, ""));
  }

  try {
    return api.Uri.joinPath(documentUri, path);
  } catch {
    return undefined;
  }
}

async function inlineLocalImages(
  fragment: DocumentFragment,
  documentUri: vscodeType.Uri,
): Promise<void> {
  const images = Array.from(fragment.querySelectorAll("img"));

  await Promise.all(
    images.map(async (image) => {
      image.setAttribute("loading", "lazy");
      image.setAttribute("referrerpolicy", "no-referrer");

      const src = image.getAttribute("src");

      if (src == null || src.length === 0 || /^[a-z][a-z0-9+.-]*:/i.test(src)) {
        return;
      }

      const target = resolveHref(documentUri, src);

      if (target == null) {
        return;
      }

      try {
        const bytes = await api.workspace.fs.readFile(target);
        image.setAttribute(
          "src",
          `data:${mimeTypeForPath(target.path)};base64,${bytesToBase64(bytes)}`,
        );
      } catch (error) {
        image.removeAttribute("src");
        image.setAttribute("alt", `${image.getAttribute("alt") ?? ""} (image unavailable)`);
        console.warn("[markdown] Could not read preview image:", target.toString(), error);
      }
    }),
  );
}

async function renderMarkdownHtml(text: string, documentUri: vscodeType.Uri): Promise<string> {
  const rendered = String(
    await marked.parse(text, {
      async: true,
      gfm: true,
    }),
  );

  const sanitized = DOMPurify.sanitize(rendered, {
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

  const template = document.createElement("template");
  template.innerHTML = sanitized;

  await inlineLocalImages(template.content, documentUri);

  return template.innerHTML;
}

const PREVIEW_CSS = `
:host {
  display: block;
  min-height: 100%;
  color: var(--vscode-editor-foreground);
  background: var(--vscode-editor-background);
  font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, Ubuntu, sans-serif);
  font-size: var(--vscode-font-size, 14px);
}

.markdown-body {
  box-sizing: border-box;
  max-width: 920px;
  min-height: 100%;
  margin: 0 auto;
  padding: 24px 32px 64px;
  line-height: 1.6;
  overflow-wrap: break-word;
}

.markdown-body > :first-child {
  margin-top: 0;
}

h1, h2, h3, h4, h5, h6 {
  margin: 24px 0 12px;
  font-weight: 600;
  line-height: 1.25;
}

h1 { font-size: 2em; padding-bottom: 0.3em; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); }
h2 { font-size: 1.5em; padding-bottom: 0.3em; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35)); }
h3 { font-size: 1.25em; }
h4 { font-size: 1em; }
h5 { font-size: 0.875em; }
h6 { font-size: 0.85em; color: var(--vscode-descriptionForeground); }

p, ul, ol, blockquote, pre, table {
  margin: 0 0 16px;
}

ul, ol {
  padding-left: 2em;
}

li + li {
  margin-top: 0.25em;
}

li > p {
  margin-top: 16px;
}

a {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
  cursor: pointer;
}

a:hover {
  color: var(--vscode-textLink-activeForeground);
  text-decoration: underline;
}

strong { font-weight: 600; }

code, kbd, samp {
  font-family: var(--vscode-editor-font-family, "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace);
  font-size: 0.9em;
}

:not(pre) > code {
  padding: 2px 5px;
  border-radius: 4px;
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.17));
}

pre {
  padding: 14px 16px;
  overflow: auto;
  border-radius: 6px;
  background: var(--vscode-textCodeBlock-background, rgba(128,128,128,0.17));
  line-height: 1.45;
}

pre code {
  padding: 0;
  background: transparent;
  font-size: 0.9em;
}

blockquote {
  padding: 0 1em;
  color: var(--vscode-descriptionForeground);
  border-left: 4px solid var(--vscode-textBlockQuote-border, rgba(128,128,128,0.35));
}

blockquote > :last-child {
  margin-bottom: 0;
}

hr {
  height: 0;
  margin: 24px 0;
  border: 0;
  border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
}

table {
  display: block;
  width: max-content;
  max-width: 100%;
  overflow: auto;
  border-collapse: collapse;
}

th, td {
  padding: 6px 13px;
  border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
}

th {
  font-weight: 600;
  background: var(--vscode-keybindingLabel-background, rgba(128,128,128,0.08));
}

tr:nth-child(2n) td {
  background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.04));
}

img {
  max-width: 100%;
  box-sizing: border-box;
}

del { color: var(--vscode-descriptionForeground); }

.markdown-body .task-list-item {
  list-style: none;
}

.markdown-body .task-list-item input {
  margin: 0 0.4em 0.25em -1.4em;
  vertical-align: middle;
}
`;

class MarkdownPreviewEditorInput extends SimpleEditorInput {
  static readonly ID = PREVIEW_EDITOR_ID;

  readonly documentUri: vscodeType.Uri;

  constructor(documentUri: vscodeType.Uri) {
    super(previewResource(documentUri));

    this.documentUri = documentUri;

    const name = basename(documentUri);

    this.setName(`[Preview] ${name}`);
    this.setTitle(`${name} (Preview)`);
    this.setDescription("Markdown Preview");
    this.addCapability(EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton);
  }

  get typeId(): string {
    return MarkdownPreviewEditorInput.ID;
  }
}

class MarkdownPreviewEditorPane extends SimpleEditorPane {
  private host!: HTMLElement;
  private shadow!: ShadowRoot;
  private content!: HTMLElement;
  private currentDocumentUri: vscodeType.Uri | undefined;
  private renderVersion = 0;

  constructor(group: IEditorGroup) {
    super(MarkdownPreviewEditorInput.ID, group);
  }

  initialize(): HTMLElement {
    const host = document.createElement("div");
    host.className = "dim-markdown-preview";
    host.tabIndex = 0;
    host.setAttribute("role", "document");
    host.setAttribute("aria-label", "Markdown preview");

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PREVIEW_CSS;

    const content = document.createElement("div");
    content.className = "markdown-body";

    shadow.append(style, content);
    host.addEventListener("click", this.handleClick);

    this.host = host;
    this.shadow = shadow;
    this.content = content;

    return host;
  }

  async renderInput(input: EditorInput): Promise<{ dispose(): void }> {
    if (!(input instanceof MarkdownPreviewEditorInput)) {
      return { dispose() {} };
    }

    this.currentDocumentUri = input.documentUri;

    let timer: number | undefined;
    let disposed = false;

    const render = () => {
      void this.renderDocument(input.documentUri).catch((error: unknown) => {
        if (disposed) {
          return;
        }

        console.warn("[markdown] Preview render failed:", error);
        this.content.textContent =
          error instanceof Error ? error.message : "Could not render the Markdown preview.";
      });
    };

    const subscription = api.workspace.onDidChangeTextDocument((event) => {
      if (
        event.document.uri.toString() !== input.documentUri.toString() ||
        event.contentChanges.length === 0
      ) {
        return;
      }

      if (timer != null) {
        window.clearTimeout(timer);
      }

      timer = window.setTimeout(() => {
        timer = undefined;
        render();
      }, 150);
    });

    render();

    return {
      dispose() {
        disposed = true;

        if (timer != null) {
          window.clearTimeout(timer);
          timer = undefined;
        }

        subscription.dispose();
      },
    };
  }

  async refresh(): Promise<void> {
    if (this.currentDocumentUri != null) {
      await this.renderDocument(this.currentDocumentUri);
    }
  }

  private async renderDocument(documentUri: vscodeType.Uri): Promise<void> {
    const version = ++this.renderVersion;
    const document = await api.workspace.openTextDocument(documentUri);
    const html = await renderMarkdownHtml(document.getText(), documentUri);

    if (version !== this.renderVersion) {
      return;
    }

    const scrollHost = this.host.closest(".monaco-scrollable-element") as HTMLElement | null;
    const scrollTop = scrollHost?.scrollTop ?? 0;

    this.content.innerHTML = html;

    if (scrollHost != null) {
      scrollHost.scrollTop = scrollTop;
    }
  }

  private readonly handleClick = (event: MouseEvent): void => {
    const anchor = event
      .composedPath()
      .find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement);

    if (anchor == null) {
      return;
    }

    const href = anchor.getAttribute("href");

    if (href == null || href.length === 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    void this.openLink(href);
  };

  private async openLink(href: string): Promise<void> {
    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1));
      const target = this.shadow.getElementById(id);

      target?.scrollIntoView({ behavior: "smooth", block: "start" });

      return;
    }

    if (href.startsWith("command:")) {
      try {
        const commandUri = api.Uri.parse(href);
        const query = commandUri.query;
        let args: unknown[] = [];

        if (query.length > 0) {
          try {
            const parsed = JSON.parse(decodeURIComponent(query));
            args = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            args = [decodeURIComponent(query)];
          }
        }

        await api.commands.executeCommand(commandUri.path, ...args);
      } catch (error) {
        console.warn("[markdown] Could not run preview command link:", href, error);
      }

      return;
    }

    if (/^(https?|mailto):/i.test(href)) {
      await api.env.openExternal(api.Uri.parse(href));

      return;
    }

    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      try {
        await api.commands.executeCommand("vscode.open", api.Uri.parse(href));
      } catch (error) {
        console.warn("[markdown] Could not open preview link:", href, error);
      }

      return;
    }

    const documentUri = this.currentDocumentUri;

    if (documentUri == null) {
      return;
    }

    const target = resolveHref(documentUri, href);

    if (target != null) {
      try {
        await api.commands.executeCommand("vscode.open", target);
      } catch (error) {
        console.warn("[markdown] Could not open preview link:", href, error);
      }
    }
  }
}

function editorService(): IEditorService {
  return StandaloneServices.get(IEditorService);
}

function activeMarkdownUri(): vscodeType.Uri | undefined {
  const service = editorService();
  const active = service.activeEditor;

  if (active instanceof MarkdownPreviewEditorInput) {
    return active.documentUri;
  }

  return api.window.activeTextEditor?.document.uri;
}

async function openMarkdownPreview(
  targetUri: vscodeType.Uri | undefined,
  side: boolean,
): Promise<void> {
  const target = targetUri ?? activeMarkdownUri();

  if (target == null) {
    void api.window.showInformationMessage("Open a Markdown file before opening the preview.");

    return;
  }

  const service = editorService();
  const input = new MarkdownPreviewEditorInput(target);
  const existing =
    input.resource == null ? undefined : service.findEditors(input.resource)[0]?.editor;

  await service.openEditor(
    existing ?? input,
    { pinned: true, revealIfOpened: true },
    side ? SIDE_GROUP : ACTIVE_GROUP,
  );
}

async function showMarkdownSource(): Promise<void> {
  const service = editorService();
  const active = service.activeEditor;
  const documentUri =
    active instanceof MarkdownPreviewEditorInput
      ? active.documentUri
      : api.window.activeTextEditor?.document.uri;

  if (documentUri == null) {
    return;
  }

  /*
   * If the source is already open (the usual preview-to-the-side layout),
   * reveal that tab and focus its group instead of opening a duplicate.
   */
  const existing = service.findEditors(documentUri)[0];

  if (existing != null) {
    await service.openEditor(
      existing.editor,
      { pinned: true, revealIfOpened: true },
      existing.groupId,
    );

    return;
  }

  await service.openEditor({ resource: documentUri }, ACTIVE_GROUP);
}

async function toggleMarkdownPreview(): Promise<void> {
  const service = editorService();

  if (service.activeEditor instanceof MarkdownPreviewEditorInput) {
    await showMarkdownSource();

    return;
  }

  await openMarkdownPreview(activeMarkdownUri(), false);
}

async function refreshActivePreview(): Promise<void> {
  const pane = editorService().activeEditorPane;

  if (pane instanceof MarkdownPreviewEditorPane) {
    await pane.refresh();
  }
}

function registerPreviewCommands(): vscodeType.Disposable {
  const registrations: vscodeType.Disposable[] = [
    api.commands.registerCommand(COMMAND_OPEN, (uri?: unknown) =>
      openMarkdownPreview(asUri(uri), false),
    ),
    api.commands.registerCommand(COMMAND_OPEN_TO_SIDE, (uri?: unknown) =>
      openMarkdownPreview(asUri(uri), true),
    ),
    api.commands.registerCommand(COMMAND_SHOW_SOURCE, () => showMarkdownSource()),
    api.commands.registerCommand(COMMAND_TOGGLE, () => toggleMarkdownPreview()),

    /*
     * Override the built-in webview commands. The most recently registered
     * handler wins, so this must run after the markdown-language-features
     * extension has activated (see the activation flow below).
     */
    api.commands.registerCommand("markdown.showPreview", (uri?: unknown) =>
      openMarkdownPreview(asUri(uri), false),
    ),
    api.commands.registerCommand("markdown.showPreviewToSide", (uri?: unknown) =>
      openMarkdownPreview(asUri(uri), true),
    ),
    api.commands.registerCommand("markdown.showLockedPreviewToSide", (uri?: unknown) =>
      openMarkdownPreview(asUri(uri), true),
    ),
    api.commands.registerCommand("markdown.reopenAsPreview", (uri?: unknown) =>
      openMarkdownPreview(asUri(uri), false),
    ),
    api.commands.registerCommand("markdown.togglePreview", () => toggleMarkdownPreview()),
    api.commands.registerCommand("markdown.showSource", () => showMarkdownSource()),
    api.commands.registerCommand("markdown.preview.refresh", () => refreshActivePreview()),
  ];

  return {
    dispose() {
      for (const registration of registrations) {
        registration.dispose();
      }
    },
  };
}

export default {
  id: "markdown",

  async activate(context: ExtensionContext): Promise<vscodeType.Disposable> {
    api = context.vscode;

    await contributeExtensionManifest({
      id: "markdown",
      displayName: "Dataverse IDE Markdown",
      description: "DOM-based Markdown preview that does not require webviews or service workers.",
      commands: [
        {
          command: COMMAND_OPEN,
          title: "Markdown: Open Preview (DOM)",
          icon: "$(preview)",
        },
        {
          command: COMMAND_OPEN_TO_SIDE,
          title: "Markdown: Open Preview to the Side (DOM)",
          icon: "$(open-preview)",
        },
        {
          command: COMMAND_SHOW_SOURCE,
          title: "Markdown: Show Source (DOM)",
          icon: "$(file-code)",
        },
        {
          command: COMMAND_TOGGLE,
          title: "Markdown: Toggle Preview (DOM)",
          icon: "$(preview)",
        },
      ],
      menus: [
        {
          menu: "editor/title",
          command: COMMAND_SHOW_SOURCE,
          when: `activeCustomEditorId == '${PREVIEW_EDITOR_ID}'`,
          group: "navigation@1",
        },
      ],
      keybindings: [
        {
          command: COMMAND_TOGGLE,
          key: "ctrl+shift+v",
          mac: "shift+cmd+v",
          when: "!terminalFocus && !inputFocus",
        },
      ],
    });

    const paneRegistration = registerEditorPane(
      MarkdownPreviewEditorInput.ID,
      "Markdown Preview",
      MarkdownPreviewEditorPane,
      [MarkdownPreviewEditorInput],
    );

    /*
     * The built-in markdown extension contributes the same command ids. Wait
     * for it to activate first; command handlers are a stack, and registering
     * later puts ours on top. A timeout keeps a broken language feature from
     * blocking preview registration.
     */
    try {
      const extensionService = StandaloneServices.get(IExtensionService);
      await Promise.race([
        extensionService.activateByEvent("onLanguage:markdown"),
        new Promise((resolve) => window.setTimeout(resolve, 5000)),
      ]);
    } catch (error) {
      context.outputChannel.appendLine(
        `[markdown] Could not pre-activate markdown-language-features: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const commandRegistration = registerPreviewCommands();

    context.outputChannel.appendLine("[markdown] DOM preview extension activated.");

    return {
      dispose() {
        commandRegistration.dispose();
        paneRegistration.dispose();
      },
    };
  },
} satisfies IdeExtension;
