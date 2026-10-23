import {
  initialize,
  IWorkbenchConstructionOptions,
  LogLevel
} from '@codingame/monaco-vscode-api'
import getWorkbenchServiceOverride from '@codingame/monaco-vscode-workbench-service-override'
import getQuickAccessServiceOverride from '@codingame/monaco-vscode-quickaccess-service-override'
import getConfigurationServiceOverride from '@codingame/monaco-vscode-configuration-service-override'
import getDialogsServiceOverride from '@codingame/monaco-vscode-dialogs-service-override'
import getEnvironmentServiceOverride from '@codingame/monaco-vscode-environment-service-override'
import getExplorerServiceOverride from '@codingame/monaco-vscode-explorer-service-override'
import getExtensionServiceOverride from '@codingame/monaco-vscode-extensions-service-override'
import getKeybindingsServiceOverride from '@codingame/monaco-vscode-keybindings-service-override'
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override'
import getLocalizationServiceOverride from '@codingame/monaco-vscode-localization-service-override'
import getLogServiceOverride from '@codingame/monaco-vscode-log-service-override'
import getMarkersServiceOverride from '@codingame/monaco-vscode-markers-service-override'
import getModelServiceOverride from '@codingame/monaco-vscode-model-service-override'
import getNotificationServiceOverride from '@codingame/monaco-vscode-notifications-service-override'
import getOutlineServiceOverride from '@codingame/monaco-vscode-outline-service-override'
import getOutputServiceOverride from '@codingame/monaco-vscode-output-service-override'
import getPreferencesServiceOverride from '@codingame/monaco-vscode-preferences-service-override'
import getSearchServiceOverride from '@codingame/monaco-vscode-search-service-override'
import getSnippetServiceOverride from '@codingame/monaco-vscode-snippets-service-override'
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override'
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override'
import getStorageServiceOverride from '@codingame/monaco-vscode-storage-service-override'
import * as vscode from 'vscode'
import { rootUri } from './fsProvider.js'
import getBulkEditServiceOverride from '@codingame/monaco-vscode-bulk-edit-service-override'
import getWorkspaceTrustServiceOverride from '@codingame/monaco-vscode-workspace-trust-service-override'
import getViewsServiceOverride from '@codingame/monaco-vscode-views-service-override'
import getEmmetServiceOverride from '@codingame/monaco-vscode-emmet-service-override'
import getSecretStorageServiceOverride from '@codingame/monaco-vscode-secret-storage-service-override'
import getTerminalServiceOverride from '@codingame/monaco-vscode-terminal-service-override'
import getSCMServiceOverride from '@codingame/monaco-vscode-scm-service-override'
import getDebugServiceOverride from '@codingame/monaco-vscode-debug-service-override'

// The extension host (and other vscode service workers) run in web workers.
// Vite bundles them here via `?worker&url` so the URL is fully resolved at
// build time - passing the `extensionHostWorkerMain` label to the sandboxed
// web worker extension host iframe works out of the box in production,
// where optimized deps' `import.meta.url`-based resolution breaks
import editorWorkerUrl from 'monaco-editor/esm/vs/editor/editor.worker.js?worker&url'
import extensionHostWorkerUrl from '@codingame/monaco-vscode-api/workers/extensionHost.worker?worker&url'
import textMateWorkerUrl from '@codingame/monaco-vscode-textmate-service-override/worker?worker&url'
import localFileSearchWorkerUrl from '@codingame/monaco-vscode-search-service-override/worker?worker&url'

const workerUrls: Partial<Record<string, string>> = {
  editorWorkerService: editorWorkerUrl,
  extensionHostWorkerMain: extensionHostWorkerUrl,
  TextMateWorker: textMateWorkerUrl,
  LocalFileSearchWorker: localFileSearchWorkerUrl
}

window.MonacoEnvironment = {
  getWorkerUrl (_workerId, label) {
    const url = workerUrls[label]
    if (url == null) {
      throw new Error(`Worker ${label} not found`)
    }
    return url
  },
  getWorkerOptions (_workerId, _label) {
    return { type: 'module' }
  },
  getWorker (_workerId, label) {
    const url = workerUrls[label]
    if (url == null) {
      throw new Error(`Worker ${label} not found`)
    }
    return new Worker(url, { type: 'module' })
  }
}

export async function startWorkbench (container: HTMLElement): Promise<void> {
  // Like the demo: on localhost, run the web worker extension host in a sandboxed
  // iframe under a wildcard subdomain (localhost subdomains resolve for free).
  // It is required by the typescript-language-features extension (tsserver forks
  // nested workers, which are only supported there).
  const extensionHostLocation = new URL('.', import.meta.url)
  extensionHostLocation.pathname = ''
  let iframeAlternateDomain: string | undefined
  if (extensionHostLocation.hostname.startsWith('localhost') && extensionHostLocation.protocol === 'http:') {
    extensionHostLocation.hostname = `{{uuid}}.${extensionHostLocation.hostname}`
    iframeAlternateDomain = extensionHostLocation.href
  }

  const constructOptions: IWorkbenchConstructionOptions = {
    windowIndicator: {
      label: 'Dataverse IDE',
      tooltip: '',
      command: ''
    },
    developmentOptions: {
      logLevel: LogLevel.Error
    },
    configurationDefaults: {
      'workbench.colorTheme': 'Default Dark Modern',
      'workbench.iconTheme': 'vs-seti',
      'window.title': 'Dataverse IDE${separator}${dirty}${activeEditorShort}'
    },
    workspaceProvider: {
      trusted: true,
      async open () {
        window.open(window.location.href)
        return true
      },
      workspace: {
        folderUri: rootUri
      }
    }
  }

  await initialize(
    {
      ...getLogServiceOverride(),
      ...getExtensionServiceOverride({
        // Required by the typescript-language-features extension (tsserver forks
        // nested workers, only supported in the web worker extension host iframe)
        enableWorkerExtensionHost: true,
        iframeAlternateDomain
      }),
      ...getModelServiceOverride(),
      ...getNotificationServiceOverride(),
      ...getDialogsServiceOverride(),

      ...getKeybindingsServiceOverride(),
      ...getConfigurationServiceOverride(),
      ...getPreferencesServiceOverride(),

      ...getTextmateServiceOverride(),
      ...getThemeServiceOverride(),
      ...getLanguagesServiceOverride(),
      ...getSnippetServiceOverride(),

      ...getStorageServiceOverride(),
      ...getEnvironmentServiceOverride(),
      ...getBulkEditServiceOverride(),
      ...getWorkspaceTrustServiceOverride(),
      ...getViewsServiceOverride(),
      ...getEmmetServiceOverride(),
      ...getSecretStorageServiceOverride(),

      // heavy: features that expect a real backend (pty/git/debug adapter/
      // LLM endpoints) - present for completeness, mostly inert in-browser
      ...getTerminalServiceOverride(),
      ...getSCMServiceOverride(),
      ...getDebugServiceOverride(),

      ...getLocalizationServiceOverride({
        async clearLocale() {
          const url = new URL(window.location.href)
          url.searchParams.delete('locale')
          window.history.pushState(null, '', url.toString())
        },
        async setLocale(id) {
          const url = new URL(window.location.href)
          url.searchParams.set('locale', id)
          window.history.pushState(null, '', url.toString())
        },
        availableLanguages: []
      }),

      // editor-centric UI
      ...getExplorerServiceOverride(),
      ...getSearchServiceOverride(),
      ...getMarkersServiceOverride(),
      ...getOutputServiceOverride(),
      ...getOutlineServiceOverride(),

      ...getWorkbenchServiceOverride(),

      ...getQuickAccessServiceOverride({
        isKeybindingConfigurationVisible: () => true,
        shouldUseGlobalPicker: () => true
      })
    },
    container,
    constructOptions,
    {
      // Otherwise, VSCode detects the first open workspace folder as home dir
      userHome: vscode.Uri.file('/')
    }
  )
}
