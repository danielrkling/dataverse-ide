import 'vscode/localExtensionHost'

// Built-in language support (grammars, themes, intellisense extensions)
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
// web-frontend language grammars
import '@codingame/monaco-vscode-xml-default-extension'
import '@codingame/monaco-vscode-less-default-extension'
import '@codingame/monaco-vscode-scss-default-extension'
import '@codingame/monaco-vscode-pug-default-extension'
// language features running real language servers in the extension host
import '@codingame/monaco-vscode-typescript-language-features-default-extension'
import '@codingame/monaco-vscode-json-language-features-default-extension'
import '@codingame/monaco-vscode-html-language-features-default-extension'
import '@codingame/monaco-vscode-css-language-features-default-extension'
// markdown preview (works fully client-side)
import '@codingame/monaco-vscode-markdown-language-features-default-extension'
// editor UX utilities
import '@codingame/monaco-vscode-emmet-default-extension'
import '@codingame/monaco-vscode-references-view-default-extension'
import '@codingame/monaco-vscode-search-result-default-extension'
import '@codingame/monaco-vscode-merge-conflict-default-extension'
import '@codingame/monaco-vscode-media-preview-default-extension'
// git-related built-ins (hosted in an environment without a real git process)
import '@codingame/monaco-vscode-git-base-default-extension'
import '@codingame/monaco-vscode-github-authentication-default-extension'

import './style.css'
import { openWorkspaceDirectory, restoreWorkspaceDirectory } from './fsProvider.js'
import { startWorkbench } from './workbench.js'

const splash = document.getElementById('splash')!
const container = document.getElementById('workbench-container')!
const status = document.getElementById('splashStatus')!

async function boot (dirHandle: FileSystemDirectoryHandle): Promise<void> {
  status.textContent = 'Mounting workspace…'
  await openWorkspaceDirectory(dirHandle)
  splash.remove()
  container.hidden = false
  await startWorkbench(container)
}

const stored = await restoreWorkspaceDirectory()
if (stored != null) {
  await boot(stored)
}
const openBtn = document.getElementById('openFolderBtn')
openBtn?.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ id: 'dataverse-ide-workspace' })
    await boot(handle)
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error)
  }
})
