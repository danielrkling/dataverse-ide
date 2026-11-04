import * as vscode from "vscode";
import {
  MenuId,
  MenuRegistry,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { contributeCommandManifest } from "../extensions/api.js";
import {
  createOpfsWorkspace,
  listRecentWorkspaces,
  saveLocalWorkspace,
  type LocalWorkspaceRecent,
  type OpfsWorkspaceRecent,
} from "./recentWorkspaces.js";
import { ensureWorkspacePermission, rootUri } from "./fsProvider.js";
import { localWorkspaceHash, opfsWorkspaceHash, setWorkspaceHash } from "./workspaceHash.js";
import {
  deleteWorkspaceStateDatabase,
  listWorkspaceStateDatabases,
  workspaceStateDatabaseName,
  workspaceStateDatabaseNameForFolderName,
} from "./workspaceStorage.js";

/*
 * In-place workspace switching via URL hash + reload.
 *
 * The hash (#/workspace/…) persists the workspace identity across the
 * reload; main.ts parses it on boot and mounts directly. Local folder
 * handles cannot be serialized, so the hash carries the recents-store
 * record id and main.ts resolves the handle from IndexedDB.
 */

const COMMAND_OPEN_LOCAL = "dataverseIde.workspace.openLocalFolder";
const COMMAND_NEW_BROWSER = "dataverseIde.workspace.newBrowserWorkspace";
const COMMAND_CHOOSE_RECENT = "dataverseIde.workspace.chooseRecent";
const COMMAND_CLEAR_STATE = "dataverseIde.workspace.clearState";

function switchTo(hash: string): void {
  setWorkspaceHash(hash);

  window.location.reload();
}

async function runEnsureWorkspacePermission(handle: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    return await ensureWorkspacePermission(handle);
  } catch {
    return false;
  }
}

export async function ensureWorkspaceSwitcher(): Promise<void> {
  await contributeCommandManifest({
    id: "workspace-switcher",
    displayName: "Dataverse IDE Workspace Switcher",
    description:
      "Switch the IDE workspace folder or browser workspace. The choice is carried in the URL hash across a page reload.",
    commands: [
      {
        command: COMMAND_OPEN_LOCAL,
        title: "Dataverse IDE: Open Local Folder…",
      },
      {
        command: COMMAND_NEW_BROWSER,
        title: "Dataverse IDE: New Browser Workspace…",
      },
      {
        command: COMMAND_CHOOSE_RECENT,
        title: "Dataverse IDE: Choose Recent Workspace…",
      },
      {
        command: COMMAND_CLEAR_STATE,
        title: "Dataverse IDE: Clear Workspace State…",
      },
    ],
  });

  vscode.commands.registerCommand(COMMAND_OPEN_LOCAL, async () => {
    const directoryHandle = await window.showDirectoryPicker({
      id: "dataverse-ide-workspace",
      mode: "readwrite",
    });

    if (!(await runEnsureWorkspacePermission(directoryHandle))) {
      void vscode.window.showErrorMessage(
        "Read/write permission was not granted for the selected folder.",
      );
      return;
    }

    const saved = await saveLocalWorkspace(directoryHandle);

    switchTo(localWorkspaceHash(saved.id));
  });

  vscode.commands.registerCommand(COMMAND_NEW_BROWSER, async () => {
    const requestedName = await vscode.window.showInputBox({
      prompt: "Name for the new browser workspace:",
      value: "dataverse-ide-workspace",
    });

    if (requestedName == null || requestedName.trim().length === 0) {
      return;
    }

    try {
      const { record: created } = await createOpfsWorkspace(requestedName.trim());

      switchTo(opfsWorkspaceHash(created.opfsDirectoryName));
      return;
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Could not create the browser workspace: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  vscode.commands.registerCommand(COMMAND_CHOOSE_RECENT, async () => {
    const records = await listRecentWorkspaces();

    if (records.length === 0) {
      void vscode.window.showInformationMessage("No recent workspaces yet.");
      return;
    }

    const picks = records.map((record) => ({
      label: record.kind === "local" ? `$(folder) ${record.name}` : `$(cloud) ${record.name}`,
      description: record.kind === "local" ? "Local folder" : "Browser workspace (OPFS)",
      record,
    }));

    const choice = await vscode.window.showQuickPick(picks, {
      title: "Choose a workspace to reopen.",
    });

    if (choice == null) {
      return;
    }

    const record = choice.record;

    if (record.kind === "opfs") {
      switchTo(opfsWorkspaceHash((record as OpfsWorkspaceRecent).opfsDirectoryName));
      return;
    }

    const local = record as LocalWorkspaceRecent;

    /*
     * Best-effort re-grant while we are inside the user gesture; if the
     * grant is not restored here, main.ts will surface the picker again
     * after the reload.
     */
    await runEnsureWorkspacePermission(local.handle);

    switchTo(localWorkspaceHash(local.id));
  });

  vscode.commands.registerCommand(COMMAND_CLEAR_STATE, async () => {
    try {
      const records = await listRecentWorkspaces();
      const current = workspaceStateDatabaseName(rootUri);
      const known = new Set([
        current,
        ...records.map((record) => workspaceStateDatabaseNameForFolderName(record.name)),
      ]);

      const databases = await listWorkspaceStateDatabases();
      const orphaned = databases.filter((name) => !known.has(name));
      const allExceptCurrent = databases.filter((name) => name !== current);

      if (allExceptCurrent.length === 0) {
        void vscode.window.showInformationMessage("There is no workspace state to clear.");
        return;
      }

      const choice = await vscode.window.showQuickPick(
        [
          {
            label: "Orphaned workspaces",
            description: `${orphaned.length} database${orphaned.length === 1 ? "" : "s"}`,
            databases: orphaned,
          },
          {
            label: "All workspaces except the current one",
            description: `${allExceptCurrent.length} database${
              allExceptCurrent.length === 1 ? "" : "s"
            }`,
            databases: allExceptCurrent,
          },
        ],
        {
          title: "Clear Workspace State",
          placeHolder: "Choose the workspace state databases to delete",
        },
      );

      if (choice == null) {
        return;
      }

      if (choice.databases.length === 0) {
        void vscode.window.showInformationMessage("There is no orphaned workspace state to clear.");
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        `Delete ${choice.databases.length} workspace state database${
          choice.databases.length === 1 ? "" : "s"
        }? This resets the affected workspaces' editor layout, open editors, and workspace settings.`,
        { modal: true },
        "Delete",
      );

      if (confirmed !== "Delete") {
        return;
      }

      let deleted = 0;
      let failed = 0;

      for (const name of choice.databases) {
        try {
          await deleteWorkspaceStateDatabase(name);
          deleted += 1;
        } catch (error) {
          failed += 1;
          console.warn(`[Dataverse IDE] Could not delete workspace state "${name}".`, error);
        }
      }

      if (failed > 0) {
        void vscode.window.showWarningMessage(
          `Cleared ${deleted} workspace state database${
            deleted === 1 ? "" : "s"
          }; ${failed} could not be deleted. Close other IDE tabs and try again.`,
        );
      } else {
        void vscode.window.showInformationMessage(
          `Cleared ${deleted} workspace state database${deleted === 1 ? "" : "s"}.`,
        );
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Could not clear workspace state: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  /*
   * Surface the commands in the File menu. This build of vscode exposes no
   * `menubar/fileMenu` manifest contribution point (`menusExtensionPoint`
   * only accepts specific menubar slots like home/edit-copy/share), so the
   * items are appended to MenuId.MenubarFileMenu directly via the
   * MenuRegistry API. Shorter titles read better in the menu; the
   * 'Dataverse IDE:' prefixed palette titles still come from the manifest.
   */
  const fileMenuEntries: { command: string; title: string; order: number }[] = [
    {
      command: COMMAND_CHOOSE_RECENT,
      title: "Open Recent Workspace…",
      order: 0,
    },
    {
      command: COMMAND_OPEN_LOCAL,
      title: "Open Workspace Folder…",
      order: 1,
    },
    {
      command: COMMAND_NEW_BROWSER,
      title: "New Browser Workspace…",
      order: 2,
    },
    {
      command: COMMAND_CLEAR_STATE,
      title: "Clear Workspace State…",
      order: 3,
    },
  ];

  for (const entry of fileMenuEntries) {
    MenuRegistry.appendMenuItem(MenuId.MenubarFileMenu, {
      command: {
        id: entry.command,
        title: entry.title,
      },
      group: "1_workspace",
      order: entry.order,
    });
  }
}

export {
  COMMAND_OPEN_LOCAL as WORKSPACE_COMMAND_OPEN_LOCAL,
  COMMAND_NEW_BROWSER as WORKSPACE_COMMAND_NEW_BROWSER,
  COMMAND_CHOOSE_RECENT as WORKSPACE_COMMAND_CHOOSE_RECENT,
};
