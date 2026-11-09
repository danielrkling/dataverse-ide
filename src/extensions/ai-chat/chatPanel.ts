import {
  ViewContainerLocation,
  registerCustomView,
} from "@codingame/monaco-vscode-api/service-override/tools/views";
import type * as vscodeType from "vscode";

import { PANEL_GLYPHS, createPanelIcon } from "../panels.js";
import { ChatSurface } from "./chatView.js";
import type { ChatController } from "./controller.js";

/*
 * Sidebar surface. Uses the same registerCustomView helper as the other
 * in-house panels, so the chat gets a real activity-bar container and a
 * full-height DOM pane.
 */

export const CHAT_VIEW_ID = "dataverseIde.ai-chat";

export type ChatPanelOptions = {
  controller: ChatController;
  getModelLabel: () => string;
  openSettings: () => void;
  openInEditor: () => void;
};

export function registerChatPanel(options: ChatPanelOptions): vscodeType.Disposable {
  return registerCustomView({
    id: CHAT_VIEW_ID,
    name: "AI Chat",
    icon: createPanelIcon(PANEL_GLYPHS.chat),
    location: ViewContainerLocation.Sidebar,
    renderBody: (container) => {
      container.style.height = "100%";
      container.style.minHeight = "0";
      container.style.width = "100%";
      container.style.overflow = "hidden";

      const surface = new ChatSurface({
        container,
        controller: options.controller,
        getModelLabel: options.getModelLabel,
        openSettings: options.openSettings,
        openInEditor: options.openInEditor,
      });

      return {
        dispose() {
          surface.dispose();
        },
      };
    },
  });
}
