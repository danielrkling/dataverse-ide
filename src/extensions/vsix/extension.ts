import type * as vscodeType from "vscode";

import { getService } from "@codingame/monaco-vscode-api";
import {
  MenuId,
  MenuRegistry,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import { IWorkbenchExtensionManagementService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/extensionManagement/common/extensionManagement.service";

import { contributeExtensionManifest } from "../api.js";

import guideContent from "./GUIDE.md?raw";

import { registerGuide } from "../shared/guide.js";
import { saveAllBeforeReload } from "../../workspace/saveAll.js";

import {
  activeVsixIds,
  installVsixFromBytes,
  listInstalledVsix,
  uninstallVsix,
  type InstalledVsix,
} from "./installer.js";

import type { ExtensionContext, IdeExtension } from "../api.js";

const COMMAND_INSTALL = "dataverseIde.vsix.install";
const COMMAND_INSTALL_URL = "dataverseIde.vsix.installFromUrl";
const COMMAND_UNINSTALL = "dataverseIde.vsix.uninstall";
const COMMAND_LIST = "dataverseIde.vsix.list";

const MAX_VSIX_BYTES = 64 * 1024 * 1024;

function parseVsixUrl(value: string): URL | undefined {
  try {
    const url = new URL(value.trim());

    return url.protocol === "https:" || url.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function fileNameFromUrl(value: string): string {
  try {
    const name = decodeURIComponent(new URL(value).pathname.split("/").at(-1) ?? "");

    return name.endsWith(".vsix") ? name : "extension.vsix";
  } catch {
    return "extension.vsix";
  }
}

type PickedFile = {
  fileName: string;
  data: Uint8Array;
};

/*
 * The workbench file dialog cannot browse arbitrary OS files in this web
 * build (the `file` provider is scoped to the workspace). A hidden file input
 * is the portable way to pick a .vsix directly from the user's machine.
 */
function pickVsixFile(): Promise<PickedFile | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".vsix,application/octet-stream";
    input.style.display = "none";

    let settled = false;

    const finish = (result: PickedFile | undefined): void => {
      if (settled) {
        return;
      }

      settled = true;
      input.remove();
      window.removeEventListener("focus", onFocus);
      resolve(result);
    };

    const onFocus = (): void => {
      // Chrome fires "cancel"; other browsers only refocus the window.
      window.setTimeout(() => {
        if (input.files == null || input.files.length === 0) {
          finish(undefined);
        }
      }, 350);
    };

    input.addEventListener("change", () => {
      const file = input.files?.[0];

      if (file == null) {
        finish(undefined);
        return;
      }

      void file
        .arrayBuffer()
        .then((buffer) => finish({ fileName: file.name, data: new Uint8Array(buffer) }))
        .catch(() => finish(undefined));
    });

    input.addEventListener("cancel", () => finish(undefined));
    window.addEventListener("focus", onFocus, { once: true });

    document.body.append(input);
    input.click();
  });
}

async function offerReload(vscode: typeof vscodeType, message: string): Promise<void> {
  const choice = await vscode.window.showInformationMessage(message, "Reload");

  if (choice === "Reload" && (await saveAllBeforeReload(vscode))) {
    location.reload();
  }
}

async function installPicked(
  vscode: typeof vscodeType,
  output: vscodeType.OutputChannel,
  picked: PickedFile,
): Promise<void> {
  try {
    const installed = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Installing ${picked.fileName}…`,
      },
      async (progress) => {
        progress.report({ message: "Validating extension…" });

        const result = await installVsixFromBytes(picked.data, picked.fileName);

        progress.report({ message: "Registered extension." });

        return result;
      },
    );

    output.appendLine(`Installed ${installed.id}@${installed.version} from ${installed.fileName}.`);

    await offerReload(
      vscode,
      `Installed ${installed.displayName} ${installed.version}. Reload to make it available in the Extensions view.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    output.appendLine(`Failed to install ${picked.fileName}: ${message}`);

    if (error instanceof Error && error.stack != null) {
      output.appendLine(error.stack);
    }

    await vscode.window.showErrorMessage(`Could not install VSIX: ${message}`);
  }
}

async function installCommand(
  vscode: typeof vscodeType,
  output: vscodeType.OutputChannel,
): Promise<void> {
  const picked = await pickVsixFile();

  if (picked == null) {
    return;
  }

  await installPicked(vscode, output, picked);
}

async function promptVsixUrl(
  vscode: typeof vscodeType,
  initialUrl?: string,
): Promise<string | undefined> {
  if (initialUrl != null) {
    const parsed = parseVsixUrl(initialUrl);

    if (parsed == null) {
      await vscode.window.showErrorMessage("The recommended VSIX URL is invalid.");

      return;
    }

    return parsed.toString();
  }

  const value = await vscode.window.showInputBox({
    title: "Install VSIX from URL",
    prompt: "Enter a direct http(s) URL to a web-compatible .vsix file.",
    placeHolder: "https://open-vsx.org/api/…/file/….vsix",
    validateInput: (input) => {
      if (input.trim().length === 0) {
        return "Enter a URL.";
      }

      return parseVsixUrl(input) == null ? "Enter an http(s) URL to a .vsix file." : undefined;
    },
  });

  if (value == null) {
    return;
  }

  return parseVsixUrl(value)?.toString();
}

async function downloadVsix(vscode: typeof vscodeType, url: string): Promise<PickedFile> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Downloading VSIX…",
    },
    async (progress) => {
      progress.report({ message: url });

      const response = await fetch(url, { redirect: "follow" });

      if (!response.ok) {
        throw new Error(`Download failed: HTTP ${response.status} ${response.statusText}`);
      }

      const declaredLength = Number(response.headers.get("content-length") ?? "");

      if (Number.isFinite(declaredLength) && declaredLength > MAX_VSIX_BYTES) {
        throw new Error("The VSIX is larger than the 64 MiB limit.");
      }

      const data = new Uint8Array(await response.arrayBuffer());

      if (data.byteLength > MAX_VSIX_BYTES) {
        throw new Error("The VSIX is larger than the 64 MiB limit.");
      }

      return {
        fileName: fileNameFromUrl(response.url || url),
        data,
      };
    },
  );
}

async function installFromUrlCommand(
  vscode: typeof vscodeType,
  output: vscodeType.OutputChannel,
  initialUrl?: string,
): Promise<void> {
  const url = await promptVsixUrl(vscode, initialUrl);

  if (url == null) {
    return;
  }

  try {
    const picked = await downloadVsix(vscode, url);

    output.appendLine(`Downloaded ${picked.fileName} from ${url}.`);

    await installPicked(vscode, output, picked);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    output.appendLine(`Failed to download ${url}: ${message}`);

    if (error instanceof Error && error.stack != null) {
      output.appendLine(error.stack);
    }

    await vscode.window.showErrorMessage(`Could not download VSIX: ${message}`);
  }
}

function pickItem(vscode: typeof vscodeType, extension: InstalledVsix): vscodeType.QuickPickItem {
  return {
    label: extension.displayName,
    description: `${extension.version} · ${extension.id}`,
    detail: extension.fileName,
  };
}

async function uninstallCommand(
  vscode: typeof vscodeType,
  output: vscodeType.OutputChannel,
): Promise<void> {
  const installed = await listInstalledVsix();

  if (installed.length === 0) {
    await vscode.window.showInformationMessage("No VSIX extensions are installed.");
    return;
  }

  const items = installed.map((extension) => pickItem(vscode, extension));
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select a VSIX extension to uninstall",
    title: "Uninstall VSIX Extension",
  });

  if (picked == null) {
    return;
  }

  const extension = installed[items.indexOf(picked)];

  if (extension == null) {
    return;
  }

  const confirmation = await vscode.window.showWarningMessage(
    `Uninstall ${extension.displayName} ${extension.version}?`,
    { modal: true },
    "Uninstall",
  );

  if (confirmation !== "Uninstall") {
    return;
  }

  const removed = await uninstallVsix(extension.id);

  if (!removed) {
    await vscode.window.showWarningMessage(`"${extension.id}" is no longer installed.`);
    return;
  }

  output.appendLine(`Uninstalled ${extension.id}@${extension.version}.`);

  await offerReload(vscode, `Uninstalled ${extension.displayName}. Reload to finish removing it.`);
}

async function listCommand(vscode: typeof vscodeType): Promise<void> {
  const installed = await listInstalledVsix();

  if (installed.length === 0) {
    await vscode.window.showInformationMessage("No VSIX extensions are installed.");
    return;
  }

  const picked = await vscode.window.showQuickPick(
    installed.map((extension) => pickItem(vscode, extension)),
    {
      placeHolder: "Installed VSIX extensions",
      title: "VSIX Extensions",
    },
  );

  if (picked != null) {
    await vscode.window.showInformationMessage(picked.description ?? picked.label);
  }
}

export default {
  id: "vsix",

  async activate(context: ExtensionContext): Promise<vscodeType.Disposable> {
    const { vscode, outputChannel } = context;

    await contributeExtensionManifest({
      id: "vsix",
      displayName: "Dataverse IDE VSIX Installer",
      description: "Install and manage browser extensions from .vsix files.",
      commands: [
        {
          command: COMMAND_INSTALL,
          title: "VSIX: Install Extension from File…",
        },
        {
          command: COMMAND_INSTALL_URL,
          title: "VSIX: Install Extension from URL…",
        },
        {
          command: COMMAND_UNINSTALL,
          title: "VSIX: Uninstall Extension…",
        },
        {
          command: COMMAND_LIST,
          title: "VSIX: Show Installed Extensions",
        },
        {
          command: "dataverseIde.vsix.openGuide",
          title: "VSIX: How-to Guide",
        },
      ],
    });

    /*
     * Mirror the desktop "Install from VSIX…" entry in the Extensions view
     * container title. The built-in action is hidden on web because it is
     * gated on a local/remote extension management server.
     */
    const guideRegistration = registerGuide({
      vscode,
      extensionId: "vsix",
      content: guideContent,
    });

    const menuDisposable = MenuRegistry.appendMenuItem(MenuId.ViewContainerTitle, {
      command: {
        id: COMMAND_INSTALL,
        title: "Install from VSIX…",
      },
      when: ContextKeyExpr.equals("viewContainer", "workbench.view.extensions"),
      group: "3_install",
      order: 1,
    });

    /*
     * VSIX extensions are registered as user-facing built-ins rather than
     * profile entries. If the Extensions view still manages to raise an
     * uninstall event for one, clean up the persisted package too so it does
     * not come back on reload.
     */
    const managementListener = await getService(IWorkbenchExtensionManagementService)
      .then((service) =>
        service.onDidUninstallExtension((event) => {
          const id = event.identifier.id.toLowerCase();

          if (activeVsixIds().includes(id)) {
            void uninstallVsix(id);
          }
        }),
      )
      .catch((error: unknown) => {
        console.warn("[Dataverse IDE] VSIX uninstall cleanup is unavailable.", error);

        return vscode.Disposable.from();
      });

    return vscode.Disposable.from(
      vscode.commands.registerCommand(COMMAND_INSTALL, () => installCommand(vscode, outputChannel)),
      vscode.commands.registerCommand(COMMAND_INSTALL_URL, (initialUrl?: string) =>
        installFromUrlCommand(vscode, outputChannel, initialUrl),
      ),
      vscode.commands.registerCommand(COMMAND_UNINSTALL, () =>
        uninstallCommand(vscode, outputChannel),
      ),
      vscode.commands.registerCommand(COMMAND_LIST, () => listCommand(vscode)),
      menuDisposable,
      managementListener,
      guideRegistration,
    );
  },
} satisfies IdeExtension;
