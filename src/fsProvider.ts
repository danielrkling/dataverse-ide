import {
  registerHTMLFileSystemProvider,
} from '@codingame/monaco-vscode-files-service-override'
import type * as vscode from 'vscode'


export let provider: ReturnType<typeof registerHTMLFileSystemProvider>
export let rootUri: vscode.Uri

/*
 * Native browser File System Access API handle.
 *
 * This is what the isomorphic-git filesystem adapter will use to read
 * .git/HEAD, .git/index, refs, objects, and working-tree files.
 */
export let workspaceDirectoryHandle: FileSystemDirectoryHandle

export async function openWorkspaceDirectory(
  dirHandle?: FileSystemDirectoryHandle,
): Promise<vscode.Uri> {
  if (dirHandle == null) {
    dirHandle = await window.showDirectoryPicker({
      id: 'dataverse-ide-workspace',
      mode: 'readwrite',
    })
  }

  workspaceDirectoryHandle = dirHandle

  provider = registerHTMLFileSystemProvider()

  rootUri = await provider.registerDirectoryHandle(dirHandle)

  return rootUri
}



export async function ensureWorkspacePermission(
  handle: FileSystemDirectoryHandle,
): Promise<boolean> {
  const options: FileSystemHandlePermissionDescriptor = {
    mode: 'readwrite',
  }

  try {
    const currentPermission = await handle.queryPermission(options)

    if (currentPermission === 'granted') {
      return true
    }

    /*
     * Call only from a user click handler.
     */
    return (
      await handle.requestPermission(options)
    ) === 'granted'
  } catch {
    return false
  }
}

