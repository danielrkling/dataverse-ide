import {
  createHTMLFileSystemProvider,
  registerCustomProvider,
  type HTMLFileSystemProvider,
} from "@codingame/monaco-vscode-files-service-override";
import type * as vscode from "vscode";
import { OpfsOverlayProvider } from "./opfsOverlay.js";
import { WorkspaceFileSystemProvider } from "./workspaceFileSystemProvider.js";

export let provider: HTMLFileSystemProvider;
export let opfsOverlayProvider: OpfsOverlayProvider;
export let workspaceFileSystemProvider: WorkspaceFileSystemProvider;
export let rootUri: vscode.Uri;

/*
 * Native browser File System Access API handle.
 *
 * This is what the isomorphic-git filesystem adapter will use to read
 * .git/HEAD, .git/index, refs, objects, and working-tree files.
 */
export let workspaceDirectoryHandle: FileSystemDirectoryHandle;

export async function openWorkspaceDirectory(
  dirHandle?: FileSystemDirectoryHandle,
): Promise<vscode.Uri> {
  if (dirHandle == null) {
    dirHandle = await window.showDirectoryPicker({
      id: "dataverse-ide-workspace",
      mode: "readwrite",
    });
  }

  workspaceDirectoryHandle = dirHandle;

  /*
   * Mount the workspace through a path-prefix router so that configurable
   * top-level directories (default: node_modules) are served from the
   * browser's OPFS instead of the real folder (see opfsOverlay.ts).
   *
   * The router dispatches each operation to exactly one delegate:
   *
   * - paths inside an overlay dir go only to OPFS
   * - everything else goes only to the real folder provider
   *
   * (The library OverlayFileSystemProvider queries both providers for every
   * readdir, rejects overlay work for every non-overlay read, and retries a
   * missing overlay file against the real folder twice. The router makes the
   * path prefix the single dispatch decision and leaves the legacy fallback
   * to the overlay provider.)
   */
  const realFs = createHTMLFileSystemProvider();

  rootUri = await realFs.registerDirectoryHandle(dirHandle);

  opfsOverlayProvider = new OpfsOverlayProvider(dirHandle, rootUri.path);

  const workspaceFs = new WorkspaceFileSystemProvider(rootUri.path, realFs, opfsOverlayProvider);

  workspaceFileSystemProvider = workspaceFs;

  registerCustomProvider("file", workspaceFs);

  provider = realFs;

  return rootUri;
}

export async function ensureWorkspacePermission(
  handle: FileSystemDirectoryHandle,
): Promise<boolean> {
  const options: FileSystemHandlePermissionDescriptor = {
    mode: "readwrite",
  };

  try {
    const currentPermission = await handle.queryPermission(options);

    if (currentPermission === "granted") {
      return true;
    }

    /*
     * Call only from a user click handler.
     */
    return (await handle.requestPermission(options)) === "granted";
  } catch {
    return false;
  }
}
