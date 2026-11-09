import {
  EditorInputCapabilities,
  SimpleEditorInput,
  SimpleEditorPane,
  registerEditorPane,
} from "@codingame/monaco-vscode-api/service-override/tools/views";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { StandaloneServices } from "@codingame/monaco-vscode-api/vscode/vs/editor/standalone/browser/standaloneServices";
import type { IEditorGroup } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorGroupsService";
import { IEditorService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService.service";
import type * as vscodeType from "vscode";

import { ChatSurface } from "./chatView.js";
import type { ChatController } from "./controller.js";

/*
 * Full-width editor-tab surface for the same conversation as the sidebar.
 * Both mount a ChatSurface over the shared ChatController, so they mirror
 * each other live.
 */

export const CHAT_EDITOR_ID = "workbench.editors.dataverseIdeAiChat";

const CHAT_RESOURCE = URI.parse("dataverse-ide-chat:/Chat");

type EditorRuntime = {
  controller: ChatController;
  getModelLabel: () => string;
  openSettings: () => void;
};

let runtime: EditorRuntime | undefined;

class ChatEditorInput extends SimpleEditorInput {
  static readonly ID = CHAT_EDITOR_ID;

  constructor() {
    super(CHAT_RESOURCE);

    this.setName("Dataverse AI");
    this.setTitle("Dataverse AI Chat");
    this.setDescription("Workspace agent");
    this.addCapability(EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton);
  }

  get typeId(): string {
    return ChatEditorInput.ID;
  }
}

class ChatEditorPane extends SimpleEditorPane {
  private host: HTMLElement | undefined;

  constructor(group: IEditorGroup) {
    super(ChatEditorInput.ID, group);
  }

  initialize(): HTMLElement {
    const host = document.createElement("div");
    host.style.display = "flex";
    host.style.height = "100%";
    host.style.minHeight = "0";
    host.style.width = "100%";
    host.tabIndex = 0;
    host.setAttribute("aria-label", "Dataverse AI chat");

    this.host = host;

    return host;
  }

  async renderInput(): Promise<{ dispose(): void }> {
    const current = runtime;

    if (current == null || this.host == null) {
      return { dispose() {} };
    }

    const surface = new ChatSurface({
      container: this.host,
      controller: current.controller,
      getModelLabel: current.getModelLabel,
      openSettings: current.openSettings,
    });

    surface.focusInput();

    return {
      dispose() {
        surface.dispose();
      },
    };
  }
}

export function registerChatEditor(options: EditorRuntime): vscodeType.Disposable {
  runtime = options;

  return registerEditorPane(ChatEditorInput.ID, "Dataverse AI Chat", ChatEditorPane, [
    ChatEditorInput,
  ]);
}

export async function openChatEditor(): Promise<void> {
  const editorService = StandaloneServices.get(IEditorService);
  const existing = editorService.findEditors(CHAT_RESOURCE)[0]?.editor;

  await editorService.openEditor(existing ?? new ChatEditorInput(), {
    pinned: true,
    revealIfOpened: true,
  });
}
