import { FileChangeType } from "@codingame/monaco-vscode-files-service-override";
import type * as vscodeType from "vscode";

import { rootUri, workspaceFileSystemProvider } from "./fsProvider.js";

/*
 * Direct workspace I/O for extensions running on the main thread.
 *
 * `vscode.workspace.fs` goes through the local extension host RPC and
 * IFileService before reaching the workspace provider. For build output that
 * is a lot of overhead per file. These helpers call the provider directly,
 * which is the same provider IFileService would use, and then publish the
 * resulting change events so `createFileSystemWatcher` subscribers see the
 * writes exactly as they would for a normal `vscode.workspace.fs` write.
 *
 * They fall back to the public API for URIs outside the mounted workspace or
 * before the workspace has been opened.
 */

const WRITE_OPTIONS = {
  create: true,
  overwrite: true,
  unlock: false,
  atomic: false,
} as const;

export type WorkspaceFileWrite = {
  uri: vscodeType.Uri;
  /** True when the file did not exist before this write. */
  created: boolean;
};

function isInsideWorkspace(uri: vscodeType.Uri): boolean {
  if (rootUri == null || uri.scheme !== "file") {
    return false;
  }

  const rootPath = rootUri.path.replace(/\/+$/, "");

  return uri.path === rootPath || uri.path.startsWith(`${rootPath}/`);
}

/**
 * Writes a workspace file through the provider.
 *
 * Returns whether the file was created, or undefined when the public API was
 * used because the provider is unavailable or the URI is outside the
 * workspace. Only the fast path needs `notifyWorkspaceFilesChanged()`.
 */
export async function writeWorkspaceFile(
  vscode: typeof vscodeType,
  uri: vscodeType.Uri,
  content: Uint8Array,
): Promise<boolean | undefined> {
  const provider = workspaceFileSystemProvider;

  if (provider == null || !isInsideWorkspace(uri)) {
    await vscode.workspace.fs.writeFile(uri, content);

    return undefined;
  }

  let created = false;

  try {
    await provider.stat(uri);
  } catch {
    created = true;
  }

  await provider.writeFile(uri, content, WRITE_OPTIONS);

  return created;
}

export async function statWorkspaceFile(
  vscode: typeof vscodeType,
  uri: vscodeType.Uri,
): Promise<unknown> {
  const provider = workspaceFileSystemProvider;

  if (provider != null && isInsideWorkspace(uri)) {
    return provider.stat(uri);
  }

  return vscode.workspace.fs.stat(uri);
}

/**
 * Creates a workspace directory and any missing ancestors through the fast
 * provider path. Both workspace providers treat an existing directory as a
 * successful mkdir.
 */
export async function ensureWorkspaceDirectory(
  vscode: typeof vscodeType,
  directoryUri: vscodeType.Uri,
): Promise<void> {
  const provider = workspaceFileSystemProvider;

  if (provider == null || !isInsideWorkspace(directoryUri)) {
    await vscode.workspace.fs.createDirectory(directoryUri);

    return;
  }

  const rootPath = rootUri.path.replace(/\/+$/, "");

  if (directoryUri.path === rootPath) {
    return;
  }

  const relative = directoryUri.path.slice(rootPath.length + 1);

  let current = rootUri;

  for (const segment of relative.split("/").filter((part) => part.length > 0)) {
    current = vscode.Uri.joinPath(current, segment);

    await provider.mkdir(current);
  }
}

/**
 * Publishes change events for fast-path writes.
 *
 * Call once after a batch of writes so watchers run after the whole build
 * output is on disk, not halfway through it.
 */
export function notifyWorkspaceFilesChanged(changes: readonly WorkspaceFileWrite[]): void {
  const provider = workspaceFileSystemProvider;

  if (provider == null || changes.length === 0) {
    return;
  }

  provider.notifyFileChanges(
    changes.map((change) => ({
      resource: change.uri,
      type: change.created ? FileChangeType.ADDED : FileChangeType.UPDATED,
    })),
  );
}
