import { hash } from "@codingame/monaco-vscode-api/vscode/vs/base/common/hash";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import type * as vscode from "vscode";

import { deleteDB } from "../util/db.js";

/*
 * VS Code stores per-workspace state in an IndexedDB database named
 * `vscode-web-state-db-<id>`, where the id is a hash of the workspace root
 * URI. Our workspace roots are `file:///<folder-name>`, so each distinct
 * workspace folder name gets its own database.
 */

const WORKSPACE_STATE_DB_PREFIX = "vscode-web-state-db-";

export function workspaceStateDatabaseName(folderUri: vscode.Uri | string): string {
  const uri = typeof folderUri === "string" ? URI.parse(folderUri) : folderUri;

  return `${WORKSPACE_STATE_DB_PREFIX}${hash(uri.toString()).toString(16)}`;
}

export function workspaceStateDatabaseNameForFolderName(name: string): string {
  return workspaceStateDatabaseName(
    URI.from({
      scheme: "file",
      path: `/${name}`,
    }),
  );
}

export async function listWorkspaceStateDatabases(): Promise<string[]> {
  if (typeof indexedDB.databases !== "function") {
    throw new Error("This browser cannot enumerate IndexedDB databases.");
  }

  const databases = await indexedDB.databases();

  return databases
    .map((database) => database.name)
    .filter(
      (name): name is string =>
        typeof name === "string" && name.startsWith(WORKSPACE_STATE_DB_PREFIX),
    )
    .sort();
}

export async function deleteWorkspaceStateDatabase(name: string): Promise<void> {
  if (!name.startsWith(WORKSPACE_STATE_DB_PREFIX)) {
    throw new Error(`Refusing to delete unexpected database "${name}".`);
  }

  await deleteDB(name);
}
