import 'vscode/localExtensionHost'

// Built-in language support
import '@codingame/monaco-vscode-theme-defaults-default-extension'
import '@codingame/monaco-vscode-theme-modern-icons-default-extension'
import '@codingame/monaco-vscode-theme-seti-default-extension'

import '@codingame/monaco-vscode-typescript-basics-default-extension'
import '@codingame/monaco-vscode-javascript-default-extension'
import '@codingame/monaco-vscode-json-default-extension'
import '@codingame/monaco-vscode-html-default-extension'
import '@codingame/monaco-vscode-css-default-extension'
import '@codingame/monaco-vscode-markdown-basics-default-extension'

import '@codingame/monaco-vscode-configuration-editing-default-extension'
import '@codingame/monaco-vscode-log-default-extension'
import '@codingame/monaco-vscode-npm-default-extension'

import '@codingame/monaco-vscode-xml-default-extension'
import '@codingame/monaco-vscode-less-default-extension'
import '@codingame/monaco-vscode-scss-default-extension'
import '@codingame/monaco-vscode-pug-default-extension'

import '@codingame/monaco-vscode-typescript-language-features-default-extension'
import '@codingame/monaco-vscode-json-language-features-default-extension'
import '@codingame/monaco-vscode-html-language-features-default-extension'
import '@codingame/monaco-vscode-css-language-features-default-extension'
import '@codingame/monaco-vscode-markdown-language-features-default-extension'

import '@codingame/monaco-vscode-emmet-default-extension'
import '@codingame/monaco-vscode-references-view-default-extension'
import '@codingame/monaco-vscode-search-result-default-extension'
import '@codingame/monaco-vscode-merge-conflict-default-extension'
import '@codingame/monaco-vscode-media-preview-default-extension'

import './style.css'

import {
  ensureWorkspacePermission,
  openWorkspaceDirectory,
  restoreWorkspaceDirectory,
} from './fsProvider.js'

import { startWorkbench } from './workbench.js'

const splash = document.getElementById('splash')!
const container = document.getElementById('workbench-container')!
const status = document.getElementById('splashStatus')!

const openPreviousFolderButton =
  document.getElementById('openPreviousFolderBtn') as HTMLButtonElement

const chooseFolderButton =
  document.getElementById('chooseFolderBtn') as HTMLButtonElement

let storedHandle: FileSystemDirectoryHandle | undefined

async function boot (
  directoryHandle: FileSystemDirectoryHandle,
): Promise<void> {
  status.textContent = 'Verifying folder permission…'

  const permitted = await ensureWorkspacePermission(directoryHandle)

  if (!permitted) {
    status.textContent =
      'Read/write permission was not granted for the selected folder.'

    return
  }

  status.textContent = 'Mounting workspace…'

  await openWorkspaceDirectory(directoryHandle)

  splash.remove()
  container.hidden = false

  await startWorkbench(container)
}

async function chooseNewFolder (): Promise<void> {
  try {
    const directoryHandle = await window.showDirectoryPicker({
      id: 'dataverse-ide-workspace',
      mode: 'readwrite',
    })

    await boot(directoryHandle)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      status.textContent = 'Folder selection cancelled.'
      return
    }

    status.textContent =
      error instanceof Error
        ? error.message
        : String(error)
  }
}

async function openPreviousFolder (): Promise<void> {
  if (storedHandle == null) {
    await chooseNewFolder()
    return
  }

  try {
    await boot(storedHandle)
  } catch (error) {
    status.textContent =
      error instanceof Error
        ? error.message
        : String(error)
  }
}

/*
 * Restore only the handle reference. Do not open it automatically.
 */
storedHandle = await restoreWorkspaceDirectory()

if (storedHandle != null) {
  const permission = await storedHandle.queryPermission({
    mode: 'readwrite',
  })

  openPreviousFolderButton.hidden = false

  if (permission === 'granted') {
    status.textContent =
      'A previously authorized folder is available. Choose an action to continue.'
  } else {
    status.textContent =
      'A previous folder is available but requires permission before opening.'
  }
} else {
  status.textContent = 'Choose a local folder to open in Dataverse IDE.'
}

openPreviousFolderButton.addEventListener('click', () => {
  void openPreviousFolder()
})

chooseFolderButton.addEventListener('click', () => {
  void chooseNewFolder()
})