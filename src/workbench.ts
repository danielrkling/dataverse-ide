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
// import getViewsServiceOverride from '@codingame/monaco-vscode-views-service-override'
import getEmmetServiceOverride from '@codingame/monaco-vscode-emmet-service-override'
import getSecretStorageServiceOverride from '@codingame/monaco-vscode-secret-storage-service-override'
// import getTerminalServiceOverride from '@codingame/monaco-vscode-terminal-service-override'
import getSCMServiceOverride from '@codingame/monaco-vscode-scm-service-override'
// import getDebugServiceOverride from '@codingame/monaco-vscode-debug-service-override'

// The extension host (and other vscode service workers) run in web workers.
// Vite bundles them here via `?worker&url` so the URL is fully resolved at
// build time - passing the `extensionHostWorkerMain` label to the sandboxed
// web worker extension host iframe works out of the box in production,
// where optimized deps' `import.meta.url`-based resolution breaks
import editorWorkerUrl from 'monaco-editor/esm/vs/editor/editor.worker.js?worker&url'
import extensionHostWorkerUrl from '@codingame/monaco-vscode-api/workers/extensionHost.worker?worker&url'
import textMateWorkerUrl from '@codingame/monaco-vscode-textmate-service-override/worker?worker&url'
import localFileSearchWorkerUrl from '@codingame/monaco-vscode-search-service-override/worker?worker&url'
import outputLinkComputerWorkerUrl from '@codingame/monaco-vscode-output-service-override/worker?worker&url'
import outputLinkDetectionWorkerUrl from '@codingame/monaco-vscode-output-service-override/worker?worker&url'

import {
  installDataverseGitExtension,
} from './git/dataverseGitExtension.js'

import {
  workspaceDirectoryHandle,
} from './fsProvider.js'

import {
  installDataverseUploadExtension,
} from './dataverse/dataverseUploadExtension.js'

const workerUrls: Record<string, string> = {
  editorWorkerService: editorWorkerUrl,
  extensionHostWorkerMain: extensionHostWorkerUrl,

  // Different monaco-vscode-api services/releases use different casing.
  textMateWorker: textMateWorkerUrl,
  TextMateWorker: textMateWorkerUrl,

  outputLinkComputer: outputLinkComputerWorkerUrl,
  LocalFileSearchWorker: localFileSearchWorkerUrl,
  OutputLinkDetectionWorker: outputLinkDetectionWorkerUrl,
}

function resolveWorkerUrl(workerUrl: string): string {
  /*
   * With Vite base: "./", worker URLs may be emitted as relative paths such
   * as "./assets/editor.worker-<hash>.js".
   *
   * Resolve relative to the actual Dataverse web-resource document location:
   * /WebResources/vs_code/dist/index.html
   */
  return new URL(workerUrl, document.baseURI).href
}

async function verifyWorker(
  workerName: string,
  workerUrl: string,
): Promise<void> {
  const resolvedUrl = resolveWorkerUrl(workerUrl);

  console.info(
    `[Dataverse IDE] Testing ${workerName} worker:`,
    resolvedUrl,
  );

  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(resolvedUrl, {
      type: "module",
      name: `dataverse-ide-test-${workerName}`,
    });

    const timeout = window.setTimeout(() => {
      worker.terminate();

      console.info(
        `[Dataverse IDE] ${workerName} worker loaded without a startup error.`,
      );

      resolve();
    }, 1000);

    worker.addEventListener(
      "error",
      (event) => {
        window.clearTimeout(timeout);
        worker.terminate();

        reject(
          new Error(
            `${workerName} worker failed: ${event.message || "unknown error"}`,
          ),
        );
      },
      { once: true },
    );

    worker.addEventListener(
      "messageerror",
      () => {
        window.clearTimeout(timeout);
        worker.terminate();

        reject(
          new Error(
            `${workerName} worker emitted a message deserialization error.`,
          ),
        );
      },
      { once: true },
    );
  });
}

window.MonacoEnvironment = {
  getWorkerUrl(_workerId, label) {
    const workerUrl = workerUrls[label];

    if (workerUrl == null) {
      console.error(
        `[Dataverse IDE] Monaco requested an unmapped worker URL: "${label}"`,
      );

      throw new Error(
        `[Dataverse IDE] Worker URL for "${label}" is not configured.`,
      );
    }

    const resolvedUrl = resolveWorkerUrl(workerUrl);

    console.info(
      `[Dataverse IDE] Monaco requested worker URL "${label}":`,
      resolvedUrl,
    );

    return resolvedUrl;
  },

  getWorkerOptions() {
    return {
      type: 'module',
    }
  },

  getWorker(_workerId, label) {
    const workerUrl = workerUrls[label]

    if (workerUrl == null) {
      console.error(
        `[Dataverse IDE] Monaco requested an unmapped worker: "${label}"`,
      )

      throw new Error(
        `[Dataverse IDE] Worker "${label}" is not configured.`,
      )
    }

    const resolvedUrl = resolveWorkerUrl(workerUrl)

    console.info(
      `[Dataverse IDE] Monaco requested worker "${label}":`,
      resolvedUrl,
    )

    const worker = new Worker(resolvedUrl, {
      type: 'module',
      name: `dataverse-ide-${label}`,
    })

    worker.addEventListener('error', (event) => {
      console.error(
        `[Dataverse IDE] Worker "${label}" failed after creation.`,
        {
          url: resolvedUrl,
          message: event.message,
          filename: event.filename,
          line: event.lineno,
          column: event.colno,
          error: event.error,
          event,
        },
      )
    })

    return worker
  },
}

function installDocumentAutoSave(
  delayMs = 1000,
): vscode.Disposable {
  const timers = new Map<string, number>();

  function clearTimer(uri: vscode.Uri): void {
    const key = uri.toString();
    const timer = timers.get(key);

    if (timer != null) {
      window.clearTimeout(timer);
      timers.delete(key);
    }
  }

  const changeSubscription =
    vscode.workspace.onDidChangeTextDocument((event) => {
      const document = event.document;

      /*
       * Ignore non-file resources:
       * - output channels
       * - extension documents
       * - virtual typings
       * - untitled editors
       */
      if (document.uri.scheme !== 'file' || document.isUntitled) {
        return;
      }

      /*
       * Only autosave files that belong to the currently opened workspace.
       */
      if (vscode.workspace.getWorkspaceFolder(document.uri) == null) {
        return;
      }

      /*
       * Ignore metadata-only change events.
       */
      if (event.contentChanges.length === 0 || !document.isDirty) {
        return;
      }

      clearTimer(document.uri);

      const timer = window.setTimeout(() => {
        timers.delete(document.uri.toString());

        void (async () => {
          /*
           * The document might have been manually saved, closed, or changed
           * again while this timer waited.
           */
          if (!document.isDirty) {
            return;
          }

          try {
            const saved = await document.save();

            console.info(
              '[Dataverse IDE] Autosave attempted:',
              {
                file: document.uri.fsPath,
                saved,
              },
            );
          } catch (error) {
            console.error(
              '[Dataverse IDE] Autosave failed:',
              document.uri.toString(),
              error,
            );
          }
        })();
      }, delayMs);

      timers.set(document.uri.toString(), timer);
    });

  const saveSubscription =
    vscode.workspace.onDidSaveTextDocument((document) => {
      clearTimer(document.uri);
    });

  const closeSubscription =
    vscode.workspace.onDidCloseTextDocument((document) => {
      clearTimer(document.uri);
    });

  return new vscode.Disposable(() => {
    changeSubscription.dispose();
    saveSubscription.dispose();
    closeSubscription.dispose();

    for (const timer of timers.values()) {
      window.clearTimeout(timer);
    }

    timers.clear();
  });
}

export async function startWorkbench(
  container: HTMLElement,
): Promise<void> {
  console.table({
    origin: window.location.origin,
    crossOriginIsolated: window.crossOriginIsolated,
    sharedArrayBufferAvailable:
      typeof SharedArrayBuffer !== "undefined",
  });

  // await Promise.all([
  //   verifyWorker("editor", editorWorkerUrl),
  //   verifyWorker("extension-host", extensionHostWorkerUrl),
  //   verifyWorker("textmate", textMateWorkerUrl),
  //   verifyWorker("search", localFileSearchWorkerUrl),
  //   verifyWorker("output-link-computer", outputLinkComputerWorkerUrl),
  // ]);

  // Existing startWorkbench code follows...
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
      'window.title': 'Dataverse IDE${separator}${dirty}${activeEditorShort}',

      /*
      * Write dirty editor buffers through the File System Access API provider.
      */
      'files.autoSave': 'afterDelay',
      'files.autoSaveDelay': 1000,

      /*
       * Optional editor hygiene.
       */
      'files.trimTrailingWhitespace': true,
      'files.insertFinalNewline': true,

      /*
       * Avoid remote SchemaStore CORS noise in Dataverse.
       */
      'json.schemaDownload.enable': false,
    },
    workspaceProvider: {
      trusted: true,
      async open() {
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
      // ...getViewsServiceOverride(),
      ...getEmmetServiceOverride(),
      ...getSecretStorageServiceOverride(),

      // heavy: features that expect a real backend (pty/git/debug adapter/
      // LLM endpoints) - present for completeness, mostly inert in-browser
      // ...getTerminalServiceOverride(),
      ...getSCMServiceOverride(),
      // ...getDebugServiceOverride(),

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

  console.table({
    filesAutoSave:
      vscode.workspace
        .getConfiguration('files')
        .get<string>('autoSave'),

    filesAutoSaveDelay:
      vscode.workspace
        .getConfiguration('files')
        .get<number>('autoSaveDelay'),
  });

  const autoSaveDisposable = installDocumentAutoSave(1000);

  const gitScmController = await installDataverseGitExtension(
    workspaceDirectoryHandle,
    rootUri,
  )

  const dataverseUploadController =
  await installDataverseUploadExtension(rootUri)

  window.addEventListener(
    'beforeunload',
    () => {
      autoSaveDisposable.dispose();
      gitScmController.dispose(),
      dataverseUploadController.dispose()
    },
    { once: true },
  );
}
