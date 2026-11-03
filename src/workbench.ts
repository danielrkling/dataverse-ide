import { initialize, IWorkbenchConstructionOptions, LogLevel } from "@codingame/monaco-vscode-api";
import { registerAssets } from "@codingame/monaco-vscode-api/assets";
import getWorkbenchServiceOverride from "@codingame/monaco-vscode-workbench-service-override";
import getQuickAccessServiceOverride from "@codingame/monaco-vscode-quickaccess-service-override";
import getConfigurationServiceOverride from "@codingame/monaco-vscode-configuration-service-override";
import getDialogsServiceOverride from "@codingame/monaco-vscode-dialogs-service-override";
import getEnvironmentServiceOverride from "@codingame/monaco-vscode-environment-service-override";
import getExplorerServiceOverride from "@codingame/monaco-vscode-explorer-service-override";
import getExtensionServiceOverride from "@codingame/monaco-vscode-extensions-service-override";
import getExtensionGalleryServiceOverride from "@codingame/monaco-vscode-extension-gallery-service-override";
import getKeybindingsServiceOverride from "@codingame/monaco-vscode-keybindings-service-override";
import getLanguagesServiceOverride from "@codingame/monaco-vscode-languages-service-override";
import getLocalizationServiceOverride from "@codingame/monaco-vscode-localization-service-override";
import getLogServiceOverride from "@codingame/monaco-vscode-log-service-override";
import getMarkersServiceOverride from "@codingame/monaco-vscode-markers-service-override";
import getModelServiceOverride from "@codingame/monaco-vscode-model-service-override";
import getNotificationServiceOverride from "@codingame/monaco-vscode-notifications-service-override";
import getOutlineServiceOverride from "@codingame/monaco-vscode-outline-service-override";
import getOutputServiceOverride from "@codingame/monaco-vscode-output-service-override";
import getPreferencesServiceOverride from "@codingame/monaco-vscode-preferences-service-override";
import getSearchServiceOverride from "@codingame/monaco-vscode-search-service-override";
import getSnippetServiceOverride from "@codingame/monaco-vscode-snippets-service-override";
import getTextmateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import getStorageServiceOverride from "@codingame/monaco-vscode-storage-service-override";
import * as vscode from "vscode";
import { rootUri } from "./workspace/fsProvider.js";
import getBulkEditServiceOverride from "@codingame/monaco-vscode-bulk-edit-service-override";
import getWorkspaceTrustServiceOverride from "@codingame/monaco-vscode-workspace-trust-service-override";
// NOTE: do not enable getViewsServiceOverride() here - see the service list
// below; it conflicts with the workbench override's own part rendering.
import getEmmetServiceOverride from "@codingame/monaco-vscode-emmet-service-override";
import getSecretStorageServiceOverride from "@codingame/monaco-vscode-secret-storage-service-override";
// import getTerminalServiceOverride from '@codingame/monaco-vscode-terminal-service-override'
import getSCMServiceOverride from "@codingame/monaco-vscode-scm-service-override";
// import getDebugServiceOverride from '@codingame/monaco-vscode-debug-service-override'

// The extension host (and other vscode service workers) run in web workers.
// Vite bundles them here via `?worker&url` so the URL is fully resolved at
// build time - passing the `extensionHostWorkerMain` label to the sandboxed
// web worker extension host iframe works out of the box in production,
// where optimized deps' `import.meta.url`-based resolution breaks
import editorWorkerUrl from "monaco-editor/esm/vs/editor/editor.worker.js?worker&url";
import extensionHostWorkerUrl from "@codingame/monaco-vscode-api/workers/extensionHost.worker?worker&url";
import textMateWorkerUrl from "@codingame/monaco-vscode-textmate-service-override/worker?worker&url";
import localFileSearchWorkerUrl from "@codingame/monaco-vscode-search-service-override/worker?worker&url";
import outputLinkComputerWorkerUrl from "@codingame/monaco-vscode-output-service-override/worker?worker&url";
import outputLinkDetectionWorkerUrl from "@codingame/monaco-vscode-output-service-override/worker?worker&url";

import { activateExtensions, registerExtensionPlaceholders } from "./extensions/registry.js";
import { restoreInstalledVsixExtensions } from "./extensions/vsix/installer.js";
import { registerConfigJsonSchemas } from "./extensions/shared/configJsonSchemas.js";
import { CommandsRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/commands/common/commands";

import { workspaceDirectoryHandle } from "./workspace/fsProvider.js";

import { ensureOverlayDirsSetting } from "./workspace/opfsOverlay.js";
import { ensureWorkspaceSwitcher } from "./workspace/workspaceSwitcher.js";
import { getModuleWorkerBlobUrl } from "./util/moduleWorker.js";

const workerUrls: Record<string, string> = {
  editorWorkerService: editorWorkerUrl,
  extensionHostWorkerMain: extensionHostWorkerUrl,

  // Different monaco-vscode-api services/releases use different casing.
  textMateWorker: textMateWorkerUrl,
  TextMateWorker: textMateWorkerUrl,

  outputLinkComputer: outputLinkComputerWorkerUrl,
  LocalFileSearchWorker: localFileSearchWorkerUrl,
  OutputLinkDetectionWorker: outputLinkDetectionWorkerUrl,
};

/*
 * The extension host runs inside a sandboxed iframe. A blob URL created by
 * the parent document cannot be reliably imported in that iframe, so keep
 * its entrypoint as the real same-origin deployed URL.
 */
const DIRECT_WORKER_LABELS = new Set(["extensionHostWorkerMain"]);

const workerBootstrapUrls = new Map<string, string>();

function preloadWorkerBlobs(): void {
  for (const [label, workerUrl] of Object.entries(workerUrls)) {
    if (DIRECT_WORKER_LABELS.has(label)) {
      continue;
    }

    const resolvedUrl = resolveWorkerUrl(workerUrl);

    const blobUrl = getModuleWorkerBlobUrl(resolvedUrl);

    workerBootstrapUrls.set(label, blobUrl);

    console.info(`[Dataverse IDE] Preloaded worker bootstrap "${label}" from blob URL.`);
  }
}

function resolveConfiguredWorkerUrl(label: string): string {
  const workerUrl = workerUrls[label];

  if (workerUrl == null) {
    throw new Error(`[Dataverse IDE] Worker "${label}" is not configured.`);
  }

  /*
   * Extension host: direct deployed URL, required by its sandboxed iframe.
   * Other workers: blob bootstrap importing their deployed URL.
   */
  return workerBootstrapUrls.get(label) ?? resolveWorkerUrl(workerUrl);
}

function resolveWorkerUrl(workerUrl: string): string {
  /*
   * With Vite base: "./", worker URLs may be emitted as relative paths such
   * as "./assets/editor.worker-<hash>.js".
   *
   * Resolve relative to the actual Dataverse web-resource document location:
   * /WebResources/vs_code/dist/index.html
   */
  return new URL(workerUrl, document.baseURI).href;
}

async function verifyWorker(workerName: string, workerUrl: string): Promise<void> {
  const resolvedUrl = resolveWorkerUrl(workerUrl);

  console.info(`[Dataverse IDE] Testing ${workerName} worker:`, resolvedUrl);

  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(resolvedUrl, {
      type: "module",
      name: `dataverse-ide-test-${workerName}`,
    });

    const timeout = window.setTimeout(() => {
      worker.terminate();

      console.info(`[Dataverse IDE] ${workerName} worker loaded without a startup error.`);

      resolve();
    }, 1000);

    worker.addEventListener(
      "error",
      (event) => {
        window.clearTimeout(timeout);
        worker.terminate();

        reject(new Error(`${workerName} worker failed: ${event.message || "unknown error"}`));
      },
      { once: true },
    );

    worker.addEventListener(
      "messageerror",
      () => {
        window.clearTimeout(timeout);
        worker.terminate();

        reject(new Error(`${workerName} worker emitted a message deserialization error.`));
      },
      { once: true },
    );
  });
}

window.MonacoEnvironment = {
  getWorkerUrl(_workerId, label) {
    const resolvedUrl = resolveConfiguredWorkerUrl(label);

    console.info(`[Dataverse IDE] Monaco requested worker URL "${label}":`, resolvedUrl);

    return resolvedUrl;
  },

  getWorkerOptions() {
    return {
      type: "module",
    };
  },

  getWorker(_workerId, label) {
    const resolvedUrl = resolveConfiguredWorkerUrl(label);

    console.info(`[Dataverse IDE] Monaco requested worker "${label}":`, resolvedUrl);

    const worker = new Worker(resolvedUrl, {
      type: "module",
      name: `dataverse-ide-${label}`,
    });

    worker.addEventListener("error", (event) => {
      console.error(`[Dataverse IDE] Worker "${label}" failed after creation.`, {
        url: resolvedUrl,
        message: event.message,
        filename: event.filename,
        line: event.lineno,
        column: event.colno,
        error: event.error,
        event,
      });
    });

    return worker;
  },
};

/*
 * The built-in Extensions manager handles "Manage Extension" for real
 * extensions. Components registered through the shared default API report
 * the internal `nullExtensionDescription` id, which the manager cannot find,
 * so answer those with a message instead of an "extension not found" error.
 */
function registerExtensionManageGuard(): vscode.Disposable {
  const manage = CommandsRegistry.getCommand("_extensions.manage");

  const guard = CommandsRegistry.registerCommand(
    "_extensions.manage",
    (accessor, extensionId?: unknown) => {
      if (
        manage == null ||
        typeof extensionId !== "string" ||
        extensionId.length === 0 ||
        extensionId === "nullExtensionDescription"
      ) {
        void vscode.window.showInformationMessage(
          "This component is built into Dataverse IDE, so there is no extension to manage.",
        );
        return;
      }

      return manage.handler(accessor, extensionId);
    },
  );

  return new vscode.Disposable(() => guard.dispose());
}

function installDocumentAutoSave(delayMs = 1000): vscode.Disposable {
  const timers = new Map<string, number>();

  function clearTimer(uri: vscode.Uri): void {
    const key = uri.toString();
    const timer = timers.get(key);

    if (timer != null) {
      window.clearTimeout(timer);
      timers.delete(key);
    }
  }

  const changeSubscription = vscode.workspace.onDidChangeTextDocument((event) => {
    const document = event.document;

    /*
     * Ignore non-file resources:
     * - output channels
     * - extension documents
     * - virtual typings
     * - untitled editors
     */
    if (document.uri.scheme !== "file" || document.isUntitled) {
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

          console.info("[Dataverse IDE] Autosave attempted:", {
            file: document.uri.fsPath,
            saved,
          });
        } catch (error) {
          console.error("[Dataverse IDE] Autosave failed:", document.uri.toString(), error);
        }
      })();
    }, delayMs);

    timers.set(document.uri.toString(), timer);
  });

  const saveSubscription = vscode.workspace.onDidSaveTextDocument((document) => {
    clearTimer(document.uri);
  });

  const closeSubscription = vscode.workspace.onDidCloseTextDocument((document) => {
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

/*
 * The workbench renders the top-left title bar app icon with the
 * `--product-icon` CSS variable (falling back to the stock VS Code logo).
 * Resolve the URL at runtime so the icon also works when the built app is
 * served from a sub-path (e.g. a Dataverse web resource).
 */
function applyProductIcon(): void {
  const iconUrl = new URL("./icons/dataverse-ide.svg", document.baseURI).href;

  document.documentElement.style.setProperty("--product-icon", `url("${iconUrl}")`);
}

/*
 * The workbench normally registers the stock webview pre assets (hashed
 * assets under /assets/, with a query string appended to the service-worker
 * URL). Dataverse redirects that query-stringed URL and service-worker
 * scripts may not follow redirects, so vite.config.ts emits patched copies
 * under a stable /webview/ folder. Point the webview host at those instead.
 */
function registerWebviewAssets(): void {
  const base = new URL("./webview/", document.baseURI);

  registerAssets({
    "vs/workbench/contrib/webview/browser/pre/index.html": new URL("index.html", base).href,
    "vs/workbench/contrib/webview/browser/pre/fake.html": new URL("fake.html", base).href,
    "vs/workbench/contrib/webview/browser/pre/service-worker.js": new URL("service-worker.js", base)
      .href,
  });
}

export async function startWorkbench(container: HTMLElement): Promise<void> {
  applyProductIcon();

  preloadWorkerBlobs();

  /*
   * Register minimal manifests before the workbench starts so the built-in
   * Extensions view can list (and enable/disable) the in-house extensions.
   * The full manifests replace them during activation.
   */
  registerExtensionPlaceholders();

  /*
   * Restore VSIX extensions from IndexedDB before the workbench initializes:
   * registerExtension only contributes to the built-in list in this phase,
   * which is what the Extensions view scans.
   */
  await restoreInstalledVsixExtensions();

  console.info("[Dataverse IDE] Starting workbench services.");

  // Existing startWorkbench code follows...
  // Like the demo: on localhost, run the web worker extension host in a sandboxed
  // iframe under a wildcard subdomain (localhost subdomains resolve for free).
  // It is required by the typescript-language-features extension (tsserver forks
  // nested workers, which are only supported there).
  const extensionHostLocation = new URL(".", import.meta.url);
  extensionHostLocation.pathname = "";
  let iframeAlternateDomain: string | undefined;
  if (
    extensionHostLocation.hostname.startsWith("localhost") &&
    extensionHostLocation.protocol === "http:"
  ) {
    extensionHostLocation.hostname = `{{uuid}}.${extensionHostLocation.hostname}`;
    iframeAlternateDomain = extensionHostLocation.href;
  }

  const constructOptions: IWorkbenchConstructionOptions = {
    windowIndicator: {
      label: "Dataverse IDE",
      tooltip: "",
      command: "",
    },
    developmentOptions: {
      logLevel: LogLevel.Error,
    },
    configurationDefaults: {
      "workbench.colorTheme": "Default Dark Modern",
      "workbench.iconTheme": "vs-seti",
      "window.title": "Dataverse IDE${separator}${dirty}${activeEditorShort}",

      /*
       * The web workbench defaults to the compact menu (hamburger in the
       * activity bar). "classic" puts File / Edit / Selection / ... across the
       * title bar instead.
       */
      "window.menuBarVisibility": "classic",

      /*
       * Write dirty editor buffers through the File System Access API provider.
       */
      "files.autoSave": "afterDelay",
      "files.autoSaveDelay": 1000,

      /*
       * Optional editor hygiene.
       */
      "files.trimTrailingWhitespace": true,
      "files.insertFinalNewline": true,

      /*
       * Avoid remote SchemaStore CORS noise in Dataverse.
       */
      "json.schemaDownload.enable": false,
    },
    workspaceProvider: {
      trusted: true,
      async open() {
        window.open(window.location.href);
        return true;
      },
      workspace: {
        folderUri: rootUri,
      },
    },
  };

  registerWebviewAssets();

  await initialize(
    {
      ...getLogServiceOverride(),
      ...getExtensionServiceOverride({
        // Required by the typescript-language-features extension (tsserver forks
        // nested workers, only supported in the web worker extension host iframe)
        enableWorkerExtensionHost: true,
        iframeAlternateDomain,
      }),
      /*
       * The built-in Extensions view / extension manager. This package brings
       * the workbench's extension management services and imports the
       * Extensions contribution, which registers the view and the internal
       * `_extensions.manage` command.
       */
      ...getExtensionGalleryServiceOverride({ webOnly: true }),
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
      // getViewsServiceOverride() must NOT be added on top of the workbench
      // override: it would render all parts a second time into a hidden div
      // and replace IEditorGroupsService/IEditorService, breaking views
      // (explorer/search). View infrastructure (IViewsService, view
      // containers) already comes with the workbench override.
      ...getEmmetServiceOverride(),
      ...getSecretStorageServiceOverride(),

      // heavy: features that expect a real backend (pty/git/debug adapter/
      // LLM endpoints) - present for completeness, mostly inert in-browser
      // ...getTerminalServiceOverride(),
      ...getSCMServiceOverride(),
      // ...getDebugServiceOverride(),

      ...getLocalizationServiceOverride({
        async clearLocale() {
          const url = new URL(window.location.href);
          url.searchParams.delete("locale");
          window.history.pushState(null, "", url.toString());
        },
        async setLocale(id) {
          const url = new URL(window.location.href);
          url.searchParams.set("locale", id);
          window.history.pushState(null, "", url.toString());
        },
        availableLanguages: [],
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
        shouldUseGlobalPicker: () => true,
      }),
    },
    container,
    constructOptions,
    {
      // Otherwise, VSCode detects the first open workspace folder as home dir
      userHome: vscode.Uri.file("/"),
    },
  );

  /*
   * Register the generated JSON Schemas as a virtual extension contribution
   * so the built-in JSON language features validate/complete the config files.
   */
  const configSchemasDisposable = registerConfigJsonSchemas();

  console.info("[Dataverse IDE] Workbench services ready; activating extensions.");

  /*
   * Let the built-in manager handle real extensions, but not the internal
   * default-API id used by our own status bar items and notifications.
   */
  const extensionManageGuard = registerExtensionManageGuard();

  /*
   * Contribute dataverseIde.overlayDirs (which top-level workspace
   * directories are persisted in OPFS, default ['node_modules']).
   */
  await ensureOverlayDirsSetting();

  /*
   * Workspace switching commands (hash + reload flow; see workspaceHash.ts).
   */
  await ensureWorkspaceSwitcher();

  const autoSaveDisposable = installDocumentAutoSave(1000);

  const extensionsDisposable = await activateExtensions({
    vscode,
    workspaceRootUri: rootUri,
    workspaceDirectoryHandle,
  });

  window.addEventListener(
    "beforeunload",
    () => {
      autoSaveDisposable.dispose();
      configSchemasDisposable.dispose();
      extensionManageGuard.dispose();
      extensionsDisposable.dispose();
    },
    { once: true },
  );
}
