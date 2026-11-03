import type * as vscodeType from "vscode";

/*
 * Workspace I/O helpers shared by the in-house extensions.
 *
 * `vscode.workspace.fs.createDirectory()` does more than mkdir: after
 * creating the folder, the file service resolves it with metadata. If the
 * folder already exists, that resolution walks the entire directory
 * (readdir + stat for every child). Build output directories routinely hold
 * thousands of files, and the file calls in a virtual/browser workspace are
 * not free, so "make sure this folder exists" before every output write can
 * take tens of seconds.
 *
 * A stat is O(1) for a directory, so check first and only call
 * createDirectory when the folder is actually missing. Newly created
 * folders are empty, so their post-create resolution is cheap.
 */
export async function ensureWorkspaceDirectory(
  vscode: typeof vscodeType,
  directoryUri: vscodeType.Uri,
): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(directoryUri);

    return false;
  } catch {
    /*
     * Not present (or not readable as a directory). Fall through to the
     * public API, which also creates missing ancestors.
     */
  }

  await vscode.workspace.fs.createDirectory(directoryUri);

  return true;
}
