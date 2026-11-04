import type * as vscodeType from "vscode";

import { contributeExtensionManifest } from "../api.js";
import { registerGuide } from "../shared/guide.js";
import { createWatchStatus } from "../watchStatus.js";

import guideContent from "./GUIDE.md?raw";
import {
  captureDirtyDocuments,
  dirtyDocumentText,
  type DirtyDocumentSnapshot,
} from "../shared/liveDocuments.js";

import { bundleHtml } from "./bundler.js";

import {
  configFilePath,
  configRelativePathFor,
  defaultOutputPath,
  HTML_DEFAULT_CONFIG,
  readHtmlConfig,
  updateHtmlConfig,
  type HtmlConfig,
  type HtmlEntry,
} from "./config.js";

import { ensureWorkspaceDirectory } from "../../workspace/workspaceFs.js";

import type { ExtensionContext, IdeExtension } from "../api.js";

/*
 * HTML bundler extension.
 *
 * Reads an HTML entry, inlines every local dependency it can find (scripts,
 * stylesheets and their @imports/url()s, SVG and image assets, media
 * posters), and writes the self-contained document under `outdir`.
 *
 * Watch mode uses a pair model: each bundle records the workspace files it
 * touched, and changing (or saving) any of them rebuilds that entry from the
 * live editor buffer. Saving the config file reloads it and rebuilds every
 * known entry. A workspace file watcher also picks up dependencies written by
 * other tools, so watch mode does not depend on the editor's save events.
 */

const CONFIG_SECTION = "dataverseIde.html";

const AUTO_START_WATCH_KEY = "autoStartWatch";

const COMMAND_BUNDLE = "dataverseIde.html.bundle";
const COMMAND_BUNDLE_WORKSPACE = "dataverseIde.html.bundleWorkspace";
const COMMAND_BUNDLE_CONFIGURED = "dataverseIde.html.bundleConfigured";
const COMMAND_START_WATCH = "dataverseIde.html.startWatch";
const COMMAND_STOP_WATCH = "dataverseIde.html.stopWatch";
const COMMAND_TOGGLE_WATCH = "dataverseIde.html.toggleWatch";
const COMMAND_OPEN_CONFIG = "dataverseIde.html.openConfig";
const COMMAND_SHOW_OUTPUT = "dataverseIde.html.showOutput";
const COMMAND_RELOAD_CONFIG = "dataverseIde.html.reloadConfig";

const WATCH_DEBOUNCE_MS = 300;

const DECODER = new TextDecoder();

function getAutoStartWatchSetting(vscode: typeof vscodeType, rootUri: vscodeType.Uri): boolean {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION, rootUri)
    .get<boolean>(AUTO_START_WATCH_KEY, false);
}

function normalizeWorkspacePath(value: string): string {
  const segments: string[] = [];

  for (const segment of value.trim().replaceAll("\\", "/").split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }

    if (segment === "..") {
      if (segments.length === 0) {
        return "";
      }

      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return segments.join("/");
}

function uriFor(vscode: typeof vscodeType, rootUri: vscodeType.Uri, path: string): vscodeType.Uri {
  return vscode.Uri.joinPath(rootUri, ...path.split("/").filter((segment) => segment.length > 0));
}

async function ensureParentDirectory(
  vscode: typeof vscodeType,
  uri: vscodeType.Uri,
): Promise<boolean> {
  const separatorIndex = uri.path.lastIndexOf("/");

  if (separatorIndex <= 0) {
    return false;
  }

  const parentUri = vscode.Uri.from({
    scheme: uri.scheme,
    authority: uri.authority,
    path: uri.path.slice(0, separatorIndex),
  });

  return ensureWorkspaceDirectory(vscode, parentUri);
}

type WatchPair = {
  entry: HtmlEntry;
  outputPath: string;
  dependencies: Set<string>;
  /**
   * Dependency path → editor version used by the last successful build.
   * Autosave after a change-triggered build writes the same bytes to disk;
   * the save handler consults this map so it does not rebuild them twice
   * (the same dedupe the shared esbuild/tailwind watcher performs).
   */
  builtVersions: Map<string, number>;
  /** True when the pair comes from html.config.json (removed on config sync). */
  configured: boolean;
};

export default {
  id: "html",

  async activate(context: ExtensionContext): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context;

    await contributeExtensionManifest({
      id: "html",
      displayName: "Dataverse IDE HTML",
      description: "Inline local scripts, stylesheets, SVGs and assets into self-contained HTML.",
      commands: [
        {
          command: COMMAND_BUNDLE,
          title: "HTML: Bundle Current File",
        },
        {
          command: COMMAND_BUNDLE_WORKSPACE,
          title: "HTML: Bundle Workspace…",
        },
        {
          command: COMMAND_BUNDLE_CONFIGURED,
          title: "HTML: Bundle Configured Entries",
        },
        {
          command: COMMAND_START_WATCH,
          title: "HTML: Start Watch",
        },
        {
          command: COMMAND_STOP_WATCH,
          title: "HTML: Stop Watch",
        },
        {
          command: COMMAND_TOGGLE_WATCH,
          title: "HTML: Toggle Watch",
        },
        {
          command: COMMAND_OPEN_CONFIG,
          title: "HTML: Open html.config.json",
        },
        {
          command: COMMAND_SHOW_OUTPUT,
          title: "HTML: Show Output",
        },
        {
          command: COMMAND_RELOAD_CONFIG,
          title: "HTML: Reload Config",
        },
        {
          command: "dataverseIde.html.openGuide",
          title: "HTML: How-to Guide",
        },
      ],
      configuration: {
        title: "Dataverse IDE HTML",
        properties: {
          "dataverseIde.html.configPath": {
            type: "string",
            default: "html.config.json",
            scope: "window",
            description:
              "Workspace-relative path of the HTML bundler settings file. Example: config/html.config.json.",
          },

          "dataverseIde.html.autoStartWatch": {
            type: "boolean",
            default: false,
            markdownDescription: "Start HTML bundler watch automatically when the workspace opens.",
          },
        },
      },
    });

    const guideRegistration = registerGuide({
      vscode,
      extensionId: "html",
      content: guideContent,
    });

    let currentConfig: HtmlConfig = { ...HTML_DEFAULT_CONFIG };

    let watchEnabled = false;
    let watchTimer: number | undefined;
    let watchBusy = false;
    let watchPending = false;
    let fileSystemWatcher: vscodeType.FileSystemWatcher | undefined;

    const watchPairs = new Map<string, WatchPair>();

    /*
     * Last HTML successfully written per output URI. Watch rebuilds often
     * produce identical output (especially when a dependency changed but the
     * inlined result did not). Writing it again costs a full File System
     * Access commit, so skip it when the file still exists.
     */
    const lastWrittenHtml = new Map<string, string>();

    let pendingInputs: string[] = [];

    let lastStatus: "idle" | "bundling" | "ok" | "error" = "idle";
    let lastMessage = "No bundle run yet.";

    const watchStatus = createWatchStatus(vscode, {
      id: "html",
      label: "html",
      busyLabel: "Bundling",
      isRunning: () => watchEnabled,
      isBusy: () => lastStatus === "bundling",
      isError: () => lastStatus === "error",
      detail: () => lastMessage,
      start: () => {
        void setWatchEnabled(true);
      },
      stop: () => {
        void setWatchEnabled(false);
      },
      showOutput: () => {
        outputChannel.show(true);
      },
      openConfig: () => {
        void vscode.commands.executeCommand(COMMAND_OPEN_CONFIG);
      },
      extraItems: () => [
        {
          label: "$(archive) Bundle configured entries",
          run: () => {
            void vscode.commands.executeCommand(COMMAND_BUNDLE_CONFIGURED);
          },
        },
      ],
    });

    function firstLine(text: string): string {
      return text.split("\n", 1)[0] ?? text;
    }

    function notifyStatus(): void {
      watchStatus.update();
    }

    async function reloadConfigFromDisk(): Promise<void> {
      const loaded = await readHtmlConfig(vscode, context.workspaceRootUri);

      currentConfig = loaded.config;

      notifyStatus();
    }

    function configRelativePath(): string {
      return configRelativePathFor(vscode, context.workspaceRootUri);
    }

    function getOrCreatePair(entry: HtmlEntry): WatchPair {
      const existing = watchPairs.get(entry.input);

      if (existing != null) {
        existing.entry = entry;
        return existing;
      }

      const pair: WatchPair = {
        entry,
        outputPath: "",
        dependencies: new Set([entry.input, configRelativePath()]),
        builtVersions: new Map(),
        configured: false,
      };

      watchPairs.set(entry.input, pair);

      return pair;
    }

    function syncConfiguredPairs(entries: HtmlEntry[]): void {
      const inputs = new Set(entries.map((entry) => entry.input));

      for (const [input, pair] of watchPairs) {
        if (pair.configured && !inputs.has(input)) {
          watchPairs.delete(input);
        }
      }

      for (const entry of entries) {
        getOrCreatePair(entry).configured = true;
      }
    }

    let dirtyDocuments: DirtyDocumentSnapshot = new Map();

    /*
     * Per-bundle I/O counters. HTML bundles can inline many files, so the
     * total time is dominated by either the reads or the single output write;
     * logging both separately makes that distinction obvious.
     */
    let bundleFileReads = 0;
    let bundleReadMs = 0;
    let bundleReadBytes = 0;

    async function readWorkspaceDiskBytes(path: string): Promise<Uint8Array | undefined> {
      const started = performance.now();

      try {
        const bytes = await vscode.workspace.fs.readFile(
          uriFor(vscode, context.workspaceRootUri, path),
        );

        bundleFileReads += 1;
        bundleReadBytes += bytes.length;

        return bytes;
      } catch {
        bundleFileReads += 1;

        return undefined;
      } finally {
        bundleReadMs += performance.now() - started;
      }
    }

    async function readWorkspaceText(path: string): Promise<string | undefined> {
      const live = dirtyDocumentText(dirtyDocuments, path);

      if (live != null) {
        return live;
      }

      const bytes = await readWorkspaceDiskBytes(path);

      return bytes != null ? DECODER.decode(bytes) : undefined;
    }

    async function readWorkspaceBytes(path: string): Promise<Uint8Array | undefined> {
      const live = dirtyDocumentText(dirtyDocuments, path);

      if (live != null) {
        return new TextEncoder().encode(live);
      }

      return readWorkspaceDiskBytes(path);
    }

    async function runBundle(
      requestedEntry: HtmlEntry,
      explicitOutput?: string,
      options?: { silent?: boolean },
    ): Promise<boolean> {
      const started = Date.now();

      bundleFileReads = 0;
      bundleReadMs = 0;
      bundleReadBytes = 0;

      const inputPath = normalizeWorkspacePath(requestedEntry.input);

      try {
        dirtyDocuments = captureDirtyDocuments(vscode, context.workspaceRootUri);

        /*
         * Remember the editor versions this build reads from dirty buffers.
         * The save that follows an autosave writes identical bytes and should
         * not rebuild the same entry again.
         */
        const dirtyVersions = new Map<string, number>();

        for (const document of vscode.workspace.textDocuments) {
          if (document.uri.scheme !== "file" || document.isUntitled || !document.isDirty) {
            continue;
          }

          const relativePath = workspaceRelativePath(document.uri);

          if (relativePath != null) {
            dirtyVersions.set(relativePath, document.version);
          }
        }

        await reloadConfigFromDisk();

        const outputPath = normalizeWorkspacePath(
          explicitOutput ??
            requestedEntry.output ??
            defaultOutputPath(inputPath, currentConfig.outdir),
        );

        if (inputPath.length === 0) {
          throw new Error("The HTML entry path is empty.");
        }

        if (outputPath.length === 0) {
          throw new Error("The HTML output path is empty.");
        }

        if (outputPath === inputPath) {
          throw new Error(`The output cannot be the input file itself (${inputPath}).`);
        }

        lastStatus = "bundling";
        lastMessage = `Bundling ${inputPath} → ${outputPath}…`;
        notifyStatus();

        outputChannel.appendLine(`[html] Bundling ${inputPath}…`);

        if (options?.silent !== true) {
          outputChannel.show(true);
        }

        const inputUri = uriFor(vscode, context.workspaceRootUri, inputPath);

        const entryStarted = performance.now();
        let sourceBytes: Uint8Array;

        try {
          sourceBytes =
            (await readWorkspaceBytes(inputPath)) ?? (await vscode.workspace.fs.readFile(inputUri));
        } catch {
          throw new Error(
            `Entry "${inputPath}" was not found in the workspace. ` +
              "Check the entryPoints setting in html.config.json.",
          );
        }

        const entryMs = performance.now() - entryStarted;

        bundleFileReads = 0;
        bundleReadMs = 0;
        bundleReadBytes = 0;

        const entry: HtmlEntry = {
          input: inputPath,
          ...(requestedEntry.output != null ? { output: requestedEntry.output } : {}),
        };

        const pair = getOrCreatePair(entry);

        pair.outputPath = outputPath;
        pair.dependencies = new Set([inputPath, configRelativePath()]);

        const bundleStarted = performance.now();
        const result = await bundleHtml({
          path: inputPath,
          html: DECODER.decode(sourceBytes),
          options: {
            inlineScripts: currentConfig.inlineScripts,
            inlineStyles: currentConfig.inlineStyles,
            inlineSvg: currentConfig.inlineSvg,
            inlineImages: currentConfig.inlineImages,
            inlineFonts: currentConfig.inlineFonts,
            inlineCssUrls: currentConfig.inlineCssUrls,
            maxInlineBytes: currentConfig.maxInlineBytes,
            minify: currentConfig.minify,
            removeComments: currentConfig.removeComments,
            external: currentConfig.external,
          },
          readText: readWorkspaceText,
          readBytes: readWorkspaceBytes,
          onDependency: (path) => {
            pair.dependencies.add(path);
          },
        });

        const bundleMs = performance.now() - bundleStarted;

        for (const warning of result.warnings) {
          outputChannel.appendLine(`[html] warning: ${warning}`);
        }

        const outputUri = uriFor(vscode, context.workspaceRootUri, outputPath);

        /*
         * Same guard as the esbuild writer: if another watch-triggered bundle
         * for this entry is already queued, this result is stale. The next
         * loop iteration will write the newer result, so don't spend a slow
         * File System Access commit on this one.
         */
        if (options?.silent === true && pendingInputs.includes(inputPath)) {
          outputChannel.appendLine(
            `[html] write skipped: a newer bundle is queued (${outputPath}).`,
          );

          return true;
        }

        const encoded = new TextEncoder().encode(result.html);
        const outputKey = outputUri.toString();

        let writeSkipped = false;

        if (lastWrittenHtml.get(outputKey) === result.html) {
          try {
            await vscode.workspace.fs.stat(outputUri);
            writeSkipped = true;
          } catch {
            // The file was deleted externally; write it again.
          }
        }

        let ensureMs = 0;
        let directoryCreated = false;
        let writeMs = 0;

        if (!writeSkipped) {
          const ensureStarted = performance.now();
          directoryCreated = await ensureParentDirectory(vscode, outputUri);
          ensureMs = performance.now() - ensureStarted;

          const writeStarted = performance.now();
          await vscode.workspace.fs.writeFile(outputUri, encoded);
          writeMs = performance.now() - writeStarted;

          lastWrittenHtml.set(outputKey, result.html);
        }

        pair.builtVersions.clear();

        for (const dependency of pair.dependencies) {
          const version = dirtyVersions.get(dependency);

          if (version != null) {
            pair.builtVersions.set(dependency, version);
          }
        }

        const elapsed = Date.now() - started;

        const summary =
          `Bundled ${inputPath} in ${elapsed}ms → ${outputPath} ` +
          `(${result.dependencies.length} inlined file(s), ${result.html.length} bytes)` +
          (result.warnings.length > 0 ? `, ${result.warnings.length} warning(s)` : "");

        outputChannel.appendLine(`[html] ${summary}`);
        outputChannel.appendLine(
          `[html] stages: entry ${Math.round(entryMs)}ms, bundle ${Math.round(bundleMs)}ms, ` +
            `ensure ${Math.round(ensureMs)}ms${directoryCreated ? " (created)" : ""}, ` +
            `write ${Math.round(writeMs)}ms${writeSkipped ? " (unchanged)" : ""} ` +
            `(${bundleFileReads} reads ${Math.round(bundleReadMs)}ms, ` +
            `${bundleReadBytes} bytes read; ${encoded.length} bytes output)`,
        );

        if (options?.silent !== true) {
          outputChannel.show(true);
        }

        lastStatus = "ok";
        lastMessage = summary;
        notifyStatus();

        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        outputChannel.appendLine(`[html] ${message}`);

        lastStatus = "error";
        lastMessage = firstLine(message);
        notifyStatus();

        if (options?.silent !== true) {
          outputChannel.show(true);

          await vscode.window.showErrorMessage(`HTML: ${message}`);
        }

        return false;
      }
    }

    async function bundleConfigured(options?: {
      silent?: boolean;
    }): Promise<{ bundled: number; failed: string[] }> {
      await reloadConfigFromDisk();
      syncConfiguredPairs(currentConfig.entryPoints);

      const failed: string[] = [];
      let bundled = 0;

      for (const entry of currentConfig.entryPoints) {
        const ok = await runBundle(entry, undefined, {
          silent: options?.silent !== false,
        });

        if (ok) {
          bundled += 1;
        } else {
          failed.push(entry.input);
        }
      }

      return { bundled, failed };
    }

    /** Workspace-relative, slash-normalized path for a workspace document/URI. */
    function workspaceRelativePath(uri: vscodeType.Uri): string | undefined {
      if (uri.scheme !== "file") {
        return undefined;
      }

      const rootPath = context.workspaceRootUri.path.replace(/\/+$/, "");
      const uriPath = uri.path.replace(/\/+$/, "");

      if (rootPath.length > 0 && uriPath !== rootPath && !uriPath.startsWith(`${rootPath}/`)) {
        return undefined;
      }

      /*
       * Derive the path from the URI instead of asRelativePath(): the pair
       * dependency set stores workspace-relative paths produced by the
       * bundler, and this keeps both sides in exactly the same form.
       */
      const relativePath = (rootPath.length > 0 ? uriPath.slice(rootPath.length) : uriPath)
        .replace(/^\/+/, "")
        .replaceAll("\\", "/");

      return relativePath.length > 0 ? relativePath : undefined;
    }

    /**
     * Queue the entries whose dependency graph contains `relativePath`.
     *
     * Editor changes and saves arrive without touching the filesystem yet
     * (autosave/unsaved buffers), while the file watcher covers dependencies
     * written by tools outside the editor. Both funnel through here so watch
     * does not depend on a manual Ctrl+S.
     */
    function queueChangedPath(
      relativePath: string,
      options?: { reloadConfig?: boolean; savedDocument?: vscodeType.TextDocument },
    ): void {
      if (relativePath === configRelativePath()) {
        /*
         * Reload only after a save (or an external write): reloading while
         * the config buffer is mid-edit would replace it with stale/invalid
         * JSON on every keystroke.
         */
        if (options?.reloadConfig !== true) {
          return;
        }

        void (async () => {
          await reloadConfigFromDisk();
          syncConfiguredPairs(currentConfig.entryPoints);
          queueAllPairs();
          scheduleWatch();
        })();

        return;
      }

      const savedDocument = options?.savedDocument;

      const triggered = [...watchPairs.values()].filter((pair) => {
        /*
         * Never rebuild an entry because its own output changed; that would
         * loop. Outputs from *other* pairs or tools may legitimately be
         * dependencies (for example an esbuild bundle under the same
         * `dist/` folder that this document inlines).
         */
        if (pair.outputPath.length > 0 && pair.outputPath === relativePath) {
          return false;
        }

        if (!pair.dependencies.has(relativePath)) {
          return false;
        }

        /*
         * A change-triggered build already used this exact editor version;
         * the following autosave writes identical bytes to disk.
         */
        return (
          savedDocument == null || pair.builtVersions.get(relativePath) !== savedDocument.version
        );
      });

      if (triggered.length === 0) {
        return;
      }

      for (const pair of triggered) {
        if (!pendingInputs.includes(pair.entry.input)) {
          pendingInputs.push(pair.entry.input);
        }
      }

      watchPending = true;
      scheduleWatch();
    }

    function ensureFileSystemWatcher(): void {
      if (fileSystemWatcher != null) {
        return;
      }

      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(context.workspaceRootUri, "**/*"),
      );

      const onFileEvent = (uri: vscodeType.Uri): void => {
        if (!watchEnabled) {
          return;
        }

        /*
         * Files open in an editor are already covered by the change/save
         * listeners. Handling the filesystem event as well would rebuild
         * twice (once for the edit, again for autosave).
         */
        if (
          vscode.workspace.textDocuments.some(
            (document) => document.uri.toString() === uri.toString(),
          )
        ) {
          return;
        }

        const relativePath = workspaceRelativePath(uri);

        if (relativePath != null) {
          queueChangedPath(relativePath, { reloadConfig: true });
        }
      };

      watcher.onDidChange(onFileEvent);
      watcher.onDidCreate(onFileEvent);
      watcher.onDidDelete(onFileEvent);

      fileSystemWatcher = watcher;
    }

    function disposeFileSystemWatcher(): void {
      fileSystemWatcher?.dispose();
      fileSystemWatcher = undefined;
    }

    function scheduleWatch(): void {
      if (watchTimer != null) {
        window.clearTimeout(watchTimer);
      }

      watchTimer = window.setTimeout(() => {
        watchTimer = undefined;
        void runWatch();
      }, WATCH_DEBOUNCE_MS);
    }

    async function runWatch(): Promise<void> {
      if (watchBusy || !watchEnabled) {
        return;
      }

      watchBusy = true;

      try {
        do {
          watchPending = false;

          const batch = pendingInputs;
          pendingInputs = [];

          const seen = new Set<string>();

          for (const input of batch) {
            if (seen.has(input) || !watchEnabled) {
              continue;
            }

            seen.add(input);

            const pair = watchPairs.get(input);

            if (pair == null) {
              continue;
            }

            await runBundle(pair.entry, undefined, { silent: true });
          }
        } while (watchPending && watchEnabled);
      } finally {
        watchBusy = false;

        /*
         * A save that lands just after the loop's last pending check must not
         * be lost: drain it on the next tick.
         */
        if (watchEnabled && pendingInputs.length > 0) {
          scheduleWatch();
        }
      }
    }

    function queueAllPairs(): void {
      for (const pair of watchPairs.values()) {
        if (!pendingInputs.includes(pair.entry.input)) {
          pendingInputs.push(pair.entry.input);
        }
      }
    }

    function setWatchEnabled(enabled: boolean): void {
      if (enabled === watchEnabled) {
        return;
      }

      watchEnabled = enabled;

      if (!enabled && watchTimer != null) {
        window.clearTimeout(watchTimer);
        watchTimer = undefined;
      }

      outputChannel.appendLine(`[html] watch ${enabled ? "started" : "stopped"}.`);

      if (enabled) {
        ensureFileSystemWatcher();

        void (async () => {
          await reloadConfigFromDisk();
          syncConfiguredPairs(currentConfig.entryPoints);

          queueAllPairs();

          await runWatch();
        })();
      } else {
        disposeFileSystemWatcher();
        pendingInputs = [];

        for (const pair of watchPairs.values()) {
          pair.builtVersions.clear();
        }
      }

      notifyStatus();
    }

    const bundleCommand = vscode.commands.registerCommand(
      COMMAND_BUNDLE,
      async (arg?: string | unknown) => {
        let inputPath: string | undefined;

        if (typeof arg === "string" && arg.trim().length > 0) {
          inputPath = normalizeWorkspacePath(arg);
        } else {
          const activeEditor = vscode.window.activeTextEditor;

          if (activeEditor == null || activeEditor.document.uri.scheme !== "file") {
            await vscode.window.showWarningMessage(
              "HTML: open an HTML file in the editor to bundle it.",
            );

            return;
          }

          inputPath = normalizeWorkspacePath(
            vscode.workspace.asRelativePath(activeEditor.document.uri, false),
          );
        }

        if (inputPath == null || !/\.html?$/i.test(inputPath)) {
          await vscode.window.showWarningMessage(
            "HTML: the active file is not an .html/.htm file.",
          );

          return;
        }

        await runBundle({ input: inputPath });
      },
    );

    const bundleWorkspaceCommand = vscode.commands.registerCommand(
      COMMAND_BUNDLE_WORKSPACE,
      async () => {
        const uris = await vscode.workspace.findFiles(
          "**/*.{html,htm}",
          "{**/node_modules/**,**/.ide-build/**,**/.git/**,**/dist/**}",
          200,
        );

        if (uris.length === 0) {
          await vscode.window.showWarningMessage(
            "HTML: no .html/.htm files found in the workspace.",
          );

          return;
        }

        const items = uris
          .map((uri) => vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/"))
          .sort((left, right) => left.localeCompare(right));

        const picked = await vscode.window.showQuickPick(items, {
          title: "HTML: Bundle Workspace…",
          placeHolder: "Pick an HTML entry file to bundle",
        });

        if (picked == null) {
          return;
        }

        await runBundle({ input: picked });
      },
    );

    const bundleConfiguredCommand = vscode.commands.registerCommand(
      COMMAND_BUNDLE_CONFIGURED,
      async () => {
        const { bundled, failed } = await bundleConfigured();

        if (failed.length > 0) {
          outputChannel.show(true);

          await vscode.window.showErrorMessage(
            `HTML: bundled ${bundled} of ${bundled + failed.length} configured entry(ies); ` +
              `${failed.length} failed (see Output): ${failed.join(", ")}.`,
          );

          return;
        }

        await vscode.window.showInformationMessage(
          `HTML: bundled ${bundled} configured entry(ies).`,
        );
      },
    );

    const startWatchCommand = vscode.commands.registerCommand(COMMAND_START_WATCH, () =>
      setWatchEnabled(true),
    );

    const stopWatchCommand = vscode.commands.registerCommand(COMMAND_STOP_WATCH, () =>
      setWatchEnabled(false),
    );

    const toggleWatchCommand = vscode.commands.registerCommand(COMMAND_TOGGLE_WATCH, () =>
      setWatchEnabled(!watchEnabled),
    );

    const openConfigCommand = vscode.commands.registerCommand(COMMAND_OPEN_CONFIG, async () => {
      const uri = configFilePath(vscode, context.workspaceRootUri);

      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        await updateHtmlConfig(vscode, context.workspaceRootUri, {});
      }

      await vscode.window.showTextDocument(uri);
    });

    const showOutputCommand = vscode.commands.registerCommand(COMMAND_SHOW_OUTPUT, () => {
      outputChannel.show(true);
    });

    const reloadConfigCommand = vscode.commands.registerCommand(COMMAND_RELOAD_CONFIG, async () => {
      await reloadConfigFromDisk();

      await vscode.window.showInformationMessage("HTML: configuration reloaded.");
    });

    /*
     * Rebuild while the user types (debounced) instead of waiting for a save.
     * runBundle() snapshots dirty editor buffers, so the rebuild sees the
     * current text. Saving still triggers a rebuild for files that were
     * changed outside the editor.
     */
    const changeWatcher = vscode.workspace.onDidChangeTextDocument((event) => {
      if (!watchEnabled || event.contentChanges.length === 0) {
        return;
      }

      const relativePath = workspaceRelativePath(event.document.uri);

      if (relativePath != null) {
        queueChangedPath(relativePath);
      }
    });

    const saveWatcher = vscode.workspace.onDidSaveTextDocument((document) => {
      if (!watchEnabled) {
        return;
      }

      const relativePath = workspaceRelativePath(document.uri);

      if (relativePath != null) {
        queueChangedPath(relativePath, { reloadConfig: true, savedDocument: document });
      }
    });

    await reloadConfigFromDisk();

    setWatchEnabled(getAutoStartWatchSetting(vscode, context.workspaceRootUri));

    const watchSettingListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(
          `${CONFIG_SECTION}.${AUTO_START_WATCH_KEY}`,
          context.workspaceRootUri,
        )
      ) {
        setWatchEnabled(getAutoStartWatchSetting(vscode, context.workspaceRootUri));
      }
    });

    outputChannel.appendLine("[html] extension activated.");

    return {
      dispose() {
        if (watchTimer != null) {
          window.clearTimeout(watchTimer);
          watchTimer = undefined;
        }

        watchEnabled = false;

        disposeFileSystemWatcher();
        changeWatcher.dispose();
        saveWatcher.dispose();
        watchStatus.dispose();
        watchSettingListener.dispose();

        bundleCommand.dispose();
        bundleWorkspaceCommand.dispose();
        bundleConfiguredCommand.dispose();

        startWatchCommand.dispose();
        stopWatchCommand.dispose();
        toggleWatchCommand.dispose();

        openConfigCommand.dispose();
        showOutputCommand.dispose();
        reloadConfigCommand.dispose();

        guideRegistration.dispose();
      },
    };
  },
} satisfies IdeExtension;
