import type * as vscodeType from "vscode";

import { rootUri, workspaceFileSystemProvider } from "./fsProvider.js";

/*
 * Direct workspace I/O helpers for extensions running on the main thread.
 *
 * The public `vscode.workspace.fs` API goes through the local extension host
 * RPC and IFileService. Measured in-browser, a 400 KB write that takes ~130 ms
 * through the file system provider took ~34 seconds through
 * `vscode.workspace.fs` (see the esbuild "Benchmark Workspace Writes" command).
 *
 * These helpers call the registered workspace provider directly, which is the
 * same provider IFileService would ultimately use. Writes still reach the real
 * File System Access handle (or OPFS for overlay paths), so file watchers and
 * the explorer see the result through the provider's onDidChangeFile event.
 *
 * They intentionally fall back to the public API when the workspace provider
 * has not been mounted (e.g. an extension used outside this workbench).
 */

const WRITE_OPTIONS = {
  create: true,
  overwrite: true,
  unlock: false,
  atomic: false,
} as const;

export async function writeWorkspaceFile(
  vscode: typeof vscodeType,
  uri: vscodeType.Uri,
  content: Uint8Array,
): Promise<void> {
  if (workspaceFileSystemProvider != null) {
    await workspaceFileSystemProvider.writeFile(uri, content, WRITE_OPTIONS);
    return;
  }

  await vscode.workspace.fs.writeFile(uri, content);
}

export async function statWorkspaceFile(
  vscode: typeof vscodeType,
  uri: vscodeType.Uri,
): Promise<{ size: number }> {
  if (workspaceFileSystemProvider != null) {
    return workspaceFileSystemProvider.stat(uri);
  }

  return vscode.workspace.fs.stat(uri);
}

/**
 * Creates a workspace directory and any missing ancestors through the fast
 * provider path. `mkdir` is idempotent for existing directories on both the
 * real-folder and OPFS providers.
 */
export async function ensureWorkspaceDirectory(
  vscode: typeof vscodeType,
  directoryUri: vscodeType.Uri,
): Promise<void> {
  if (workspaceFileSystemProvider == null || rootUri == null) {
    await vscode.workspace.fs.createDirectory(directoryUri);
    return;
  }

  const rootPath = rootUri.path.replace(/\/+$/, "");

  if (directoryUri.path === rootPath) {
    return;
  }

  if (!directoryUri.path.startsWith(`${rootPath}/`)) {
    await vscode.workspace.fs.createDirectory(directoryUri);
    return;
  }

  const relative = directoryUri.path.slice(rootPath.length + 1);

  let current = rootUri;

  for (const segment of relative.split("/").filter((part) => part.length > 0)) {
    current = vscode.Uri.joinPath(current, segment);

    await workspaceFileSystemProvider.mkdir(current);
  }
}
