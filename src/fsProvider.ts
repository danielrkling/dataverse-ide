import {
  registerHTMLFileSystemProvider
} from '@codingame/monaco-vscode-files-service-override'
import type * as vscode from 'vscode'
import { openDB } from './db.js'

const DB_NAME = 'dataverse-ide'
const STORE = 'handles'
const KEY = 'workspace-dir'

export let provider: ReturnType<typeof registerHTMLFileSystemProvider>
export let rootUri: vscode.Uri

/**
 * Open (or restore) a user-picked directory through the File System Access API
 * and mount it as the `file://` filesystem provider of the workbench.
 * Returns the workspace folder URI.
 */
export async function openWorkspaceDirectory (dirHandle?: FileSystemDirectoryHandle): Promise<vscode.Uri> {
  if (dirHandle == null) {
    dirHandle = await window.showDirectoryPicker({ id: 'dataverse-ide-workspace' })
  }

  // Wrap the idb call too - Safari has no showDirectoryPicker anyway
  await put(dirHandle)

  // registerHTMLFileSystemProvider() creates an HTMLFileSystemProvider
  // (File System Access API backed, handles persisted in IndexedDB)
  // and mounts it as the provider of the `file` scheme
  provider = registerHTMLFileSystemProvider()
  rootUri = await provider.registerDirectoryHandle(dirHandle)

  return rootUri
}

export async function restoreWorkspaceDirectory (): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    const handle = (await get()) as FileSystemDirectoryHandle | undefined
    if (handle == null) {
      return undefined
    }
    if ((await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
        return undefined
      }
    }
    return handle
  } catch {
    // Safari `<17` and Firefox have no File System Access API
    return undefined
  }
}

async function get (): Promise<unknown> {
  return openDB(DB_NAME, STORE).then(db => db.get(STORE, KEY))
}

async function put (handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDB(DB_NAME, STORE)
  await db.put(STORE, handle, KEY)
}
