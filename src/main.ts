import './browserPolyfills.js'
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
} from './fsProvider.js'

import {
  createOpfsWorkspace,
  listRecentWorkspaces,
  openOpfsWorkspace,
  removeRecentWorkspace,
  saveLocalWorkspace,
  supportsOpfs,
  type OpfsWorkspaceRecent,
  type RecentWorkspace,
} from './recentWorkspaces.js'

import { startWorkbench } from './workbench.js'

const splash = document.getElementById('splash')!
const container = document.getElementById('workbench-container')!
const status = document.getElementById('splashStatus')!

const chooseFolderButton =
  document.getElementById('chooseFolderBtn') as HTMLButtonElement

const newLocalFolderButton =
  document.getElementById('newLocalFolderBtn') as HTMLButtonElement

const newOpfsWorkspaceButton =
  document.getElementById('newOpfsWorkspaceBtn') as HTMLButtonElement

const refreshRecentWorkspacesButton =
  document.getElementById(
    'refreshRecentWorkspacesBtn',
  ) as HTMLButtonElement

const recentWorkspacesList =
  document.getElementById(
    'recentWorkspacesList',
  ) as HTMLUListElement

const recentWorkspacesEmpty =
  document.getElementById(
    'recentWorkspacesEmpty',
  ) as HTMLParagraphElement

function setStatus(message: string): void {
  status.textContent = message
}

function formatOpenedAt(timestamp: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(timestamp))
  } catch {
    return timestamp
  }
}

function setButtonsDisabled(disabled: boolean): void {
  chooseFolderButton.disabled = disabled
  newLocalFolderButton.disabled = disabled
  newOpfsWorkspaceButton.disabled =
    disabled || !supportsOpfs()
  refreshRecentWorkspacesButton.disabled = disabled
}

async function bootLocalWorkspace(
  directoryHandle: FileSystemDirectoryHandle,
): Promise<void> {
  setButtonsDisabled(true)
  setStatus('Verifying folder permission…')

  const permitted = await ensureWorkspacePermission(directoryHandle)

  if (!permitted) {
    setButtonsDisabled(false)

    setStatus(
      'Read/write permission was not granted for the selected folder.',
    )

    return
  }

  setStatus('Saving recent workspace…')

  await saveLocalWorkspace(directoryHandle)

  setStatus('Mounting workspace…')

  await openWorkspaceDirectory(directoryHandle)

  splash.remove()
  container.hidden = false

  await startWorkbench(container)
}

async function bootOpfsWorkspace(
  directoryHandle: FileSystemDirectoryHandle,
): Promise<void> {
  setButtonsDisabled(true)
  setStatus('Mounting browser workspace…')

  await openWorkspaceDirectory(directoryHandle)

  splash.remove()
  container.hidden = false

  await startWorkbench(container)
}

async function openLocalFolder(): Promise<void> {
  try {
    const directoryHandle = await window.showDirectoryPicker({
      id: 'dataverse-ide-workspace',
      mode: 'readwrite',
    })

    await bootLocalWorkspace(directoryHandle)
  } catch (error) {
    setButtonsDisabled(false)

    if (error instanceof DOMException && error.name === 'AbortError') {
      setStatus('Folder selection cancelled.')
      return
    }

    setStatus(
      error instanceof Error
        ? error.message
        : String(error),
    )
  }
}

async function createLocalFolder(): Promise<void> {
  try {
    const parentHandle = await window.showDirectoryPicker({
      id: 'dataverse-ide-workspace-parent',
      mode: 'readwrite',
    })

    const requestedName = window.prompt(
      'Name for the new local workspace folder:',
      'dataverse-ide-workspace',
    )

    if (requestedName == null) {
      setStatus('New local workspace cancelled.')
      return
    }

    const name = requestedName.trim()

    if (
      name.length === 0 ||
      name === '.' ||
      name === '..' ||
      name.includes('/') ||
      name.includes('\\')
    ) {
      setStatus(
        'Enter a folder name without slashes or path traversal values.',
      )

      return
    }

    setStatus('Creating local workspace folder…')

    const workspaceHandle = await parentHandle.getDirectoryHandle(
      name,
      {
        create: true,
      },
    )

    await bootLocalWorkspace(workspaceHandle)
  } catch (error) {
    setButtonsDisabled(false)

    if (error instanceof DOMException && error.name === 'AbortError') {
      setStatus('Folder selection cancelled.')
      return
    }

    setStatus(
      error instanceof Error
        ? error.message
        : String(error),
    )
  }
}

async function createBrowserWorkspace(): Promise<void> {
  if (!supportsOpfs()) {
    setStatus(
      'Origin Private File System workspaces are not supported by this browser.',
    )

    return
  }

  const requestedName = window.prompt(
    'Name for the new browser workspace:',
    'dataverse-ide-workspace',
  )

  if (requestedName == null) {
    setStatus('New browser workspace cancelled.')
    return
  }

  try {
    setButtonsDisabled(true)
    setStatus('Creating browser workspace…')

    const { handle } = await createOpfsWorkspace(requestedName)

    await bootOpfsWorkspace(handle)
  } catch (error) {
    setButtonsDisabled(false)

    setStatus(
      error instanceof Error
        ? error.message
        : String(error),
    )
  }
}

async function openRecentWorkspace(
  record: RecentWorkspace,
): Promise<void> {
  try {
    if (record.kind === 'local') {
      await bootLocalWorkspace(record.handle)
      return
    }

    setButtonsDisabled(true)
    setStatus('Opening browser workspace…')

    const handle = await openOpfsWorkspace(record as OpfsWorkspaceRecent)

    await bootOpfsWorkspace(handle)
  } catch (error) {
    setButtonsDisabled(false)

    if (
      error instanceof DOMException &&
      error.name === 'NotFoundError'
    ) {
      setStatus(
        `"${record.name}" is no longer available. It may have been cleared from browser storage.`,
      )

      return
    }

    setStatus(
      error instanceof Error
        ? error.message
        : String(error),
    )
  }
}

async function renderRecentWorkspaces(): Promise<void> {
  recentWorkspacesList.replaceChildren()

  const records = await listRecentWorkspaces()

  recentWorkspacesEmpty.hidden = records.length > 0

  for (const record of records) {
    const item = document.createElement('li')
    item.className = 'recent-workspace-item'

    const openButton = document.createElement('button')
    openButton.className = 'recent-workspace-open'
    openButton.type = 'button'

    const name = document.createElement('span')
    name.className = 'recent-workspace-name'
    name.textContent = record.name

    const meta = document.createElement('span')
    meta.className = 'recent-workspace-meta'

    const locationLabel =
      record.kind === 'local'
        ? 'Local folder'
        : 'Browser workspace (OPFS)'

    meta.textContent =
      `${locationLabel} · Opened ${formatOpenedAt(record.lastOpenedAt)}`

    openButton.append(name, meta)

    openButton.addEventListener('click', () => {
      void openRecentWorkspace(record)
    })

    const removeButton = document.createElement('button')
    removeButton.className = 'recent-workspace-remove'
    removeButton.type = 'button'
    removeButton.title = `Remove ${record.name} from recent workspaces`
    removeButton.setAttribute(
      'aria-label',
      `Remove ${record.name} from recent workspaces`,
    )
    removeButton.textContent = 'Remove'

    removeButton.addEventListener('click', (event) => {
      event.stopPropagation()

      void (async () => {
        await removeRecentWorkspace(record.id)
        await renderRecentWorkspaces()

        setStatus(
          `"${record.name}" was removed from recent workspaces.`,
        )
      })()
    })

    item.append(openButton, removeButton)

    recentWorkspacesList.append(item)
  }
}

if (!supportsOpfs()) {
  newOpfsWorkspaceButton.disabled = true
  newOpfsWorkspaceButton.title =
    'This browser does not support Origin Private File System workspaces.'
}

chooseFolderButton.addEventListener('click', () => {
  void openLocalFolder()
})

newLocalFolderButton.addEventListener('click', () => {
  void createLocalFolder()
})

newOpfsWorkspaceButton.addEventListener('click', () => {
  void createBrowserWorkspace()
})

refreshRecentWorkspacesButton.addEventListener('click', () => {
  void renderRecentWorkspaces()
})

setStatus('Choose a workspace to begin.')

void renderRecentWorkspaces()