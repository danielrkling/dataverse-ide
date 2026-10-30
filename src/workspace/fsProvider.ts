import {
  createHTMLFileSystemProvider,
  OverlayFileSystemProvider,
  registerCustomProvider,
  type HTMLFileSystemProvider,
} from "@codingame/monaco-vscode-files-service-override";
import type * as vscode from "vscode";
import { OpfsOverlayProvider } from "./opfsOverlay.js";

export let provider: HTMLFileSystemProvider;
export let opfsOverlayProvider: OpfsOverlayProvider;
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
   * Mount the workspace through an OverlayFileSystemProvider so that
   * configurable top-level directories (default: node_modules) are served
   * from the browser's OPFS instead of the real folder (see opfsOverlay.ts).
   *
   * - the real folder provider is priority 1 (wins everywhere else),
   * - the OPFS overlay is priority 2 (wins for overlay dirs),
   * - the overlay composite becomes the provider for the `file` scheme.
   */
  const realFs = createHTMLFileSystemProvider();

  rootUri = await realFs.registerDirectoryHandle(dirHandle);

  opfsOverlayProvider = new OpfsOverlayProvider(dirHandle, rootUri.path);

  const overlay = new OverlayFileSystemProvider();

  const realFsDisposable = overlay.register(1, realFs);
  const opfsDisposable = overlay.register(2, opfsOverlayProvider);

  registerCustomProvider("file", overlay);

  provider = realFs;

  /*
   * Keep both handles alive for the lifetime of the workspace mount.
   */
  void [realFsDisposable, opfsDisposable];

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
