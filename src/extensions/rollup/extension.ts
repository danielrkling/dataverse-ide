import type * as vscodeType from "vscode";

import { contributeCommandManifest } from "../api.js";

import { createWatchStatus } from "../watchStatus.js";

import { EsbuildWatcher } from "../esbuild/watcher.js";

import { bundle, type BundleOutputFile } from "./bundleCore.js";

import { transformForBundler } from "../esbuild/compiler.js";

import { createWorkspaceReader } from "./workspaceResolver.js";

import {
  ROLLUP_DEFAULT_CONFIG,
  configFilePath,
  configRelativePathFor,
  readRollupConfig,
  updateRollupConfig,
  type RollupConfig,
} from "./config.js";

import type { ExtensionContext, IdeExtension } from "../api.js";

/*
 * Main-thread rollup extension.
 *
 * Rollup reads source files directly from vscode.workspace.fs through
 * workspaceResolver.ts. There is no worker, no workspace-wide collection
 * pass and no lazy needFiles probe loop:
 *
 *   rollup requests import
 *     → resolver checks the actual mounted workspace filesystem
 *     → load reads only the resolved source file
 *
 * This supports local folders, OPFS workspaces, and the node_modules OPFS
 * overlay through the same filesystem provider used by the editor.
 */

const OUTPUT_DIRECTORY = "dist";

const CONFIG_SECTION = "dataverseIde.rollup";

function getAutoStartWatchSetting(vscode: typeof vscodeType): boolean {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION, null)
    .get<boolean>("autoStartWatch", false);
}

async function writeOutputs(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  outDir: string,
  entryPath: string,
  outputs: BundleOutputFile[],
): Promise<vscodeType.Uri[]> {
  const written: vscodeType.Uri[] = [];
  const outDirUri = vscode.Uri.joinPath(rootUri, ...outDir.split("/").filter(Boolean));

  await vscode.workspace.fs.createDirectory(outDirUri);

  for (const output of outputs) {
    /*
     * Prefer the bundler-provided file name; it preserves dynamic import
     * chunk names. Fall back to the entry base name when an output path is
     * unusable.
     */
    let relativeOutput = output.path
      .replaceAll("\\", "/")
      .replace(/^\/+/, "")
      .split("/")
      .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
      .join("/");

    if (relativeOutput.length === 0) {
      const baseName =
        entryPath
          .split("/")
          .pop()
          ?.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i, "") ?? "bundle";

      relativeOutput = `${baseName}${output.path.endsWith(".css") ? ".css" : ".js"}`;
    }

    const outFile = vscode.Uri.joinPath(outDirUri, ...relativeOutput.split("/"));
    const parent = vscode.Uri.joinPath(outDirUri, ...relativeOutput.split("/").slice(0, -1));

    await vscode.workspace.fs.createDirectory(parent);
    await vscode.workspace.fs.writeFile(outFile, new TextEncoder().encode(output.text));

    written.push(outFile);
  }

  return written;
}

async function workspaceFileExists(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  relativePath: string,
): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(
      vscode.Uri.joinPath(
        rootUri,
        ...relativePath.split("/").filter((segment) => segment.length > 0),
      ),
    );

    return true;
  } catch {
    return false;
  }
}

async function resolveCurrentFile(vscode: typeof vscodeType): Promise<
  | {
      document: vscodeType.TextDocument;
      relativePath: string;
    }
  | undefined
> {
  const activeEditor = vscode.window.activeTextEditor;

  if (activeEditor == null || activeEditor.document.uri.scheme !== "file") {
    return undefined;
  }

  const document = activeEditor.document;
  const relativePath = vscode.workspace.asRelativePath(document.uri, false).replaceAll("\\", "/");

  return { document, relativePath };
}

export default {
  id: "rollup",

  async activate(context: ExtensionContext): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context;

    let currentConfig: RollupConfig = ROLLUP_DEFAULT_CONFIG;
    let watcher: EsbuildWatcher | undefined;
    let watchEnabled = false;

    let lastStatus: "idle" | "building" | "ok" | "error" = "idle";
    let lastMessage = "No build run yet.";

    async function reloadConfigFromDisk(): Promise<void> {
      const loaded = await readRollupConfig(vscode, context.workspaceRootUri);

      currentConfig = loaded.config;

      notifyStatus();
    }

    await contributeCommandManifest({
      id: "rollup",
      displayName: "Dataverse IDE Rollup (browser)",
      description:
        "Rollup bundling on the main thread with esbuild-wasm transform/minify (TS/JSX).",
      commands: [
        {
          command: "dataverseIde.rollup.transform",
          title: "rollup: Transform Current File (TS/JSX → JS)",
        },
        {
          command: "dataverseIde.rollup.minify",
          title: "rollup: Minify Current File",
        },
        {
          command: "dataverseIde.rollup.build",
          title: "rollup: Build Current File",
        },
        {
          command: "dataverseIde.rollup.buildWorkspace",
          title: "rollup: Build Workspace…",
        },
        {
          command: "dataverseIde.rollup.buildConfigured",
          title: "rollup: Build Configured Entry",
        },
        {
          command: "dataverseIde.rollup.startWatch",
          title: "rollup: Start Watch",
        },
        {
          command: "dataverseIde.rollup.stopWatch",
          title: "rollup: Stop Watch",
        },
        {
          command: "dataverseIde.rollup.toggleWatch",
          title: "rollup: Toggle Watch",
        },
        {
          command: "dataverseIde.rollup.openConfig",
          title: "rollup: Open rollup.config.json",
        },
        {
          command: "dataverseIde.rollup.reloadConfig",
          title: "rollup: Reload Config",
        },
        {
          command: "dataverseIde.rollup.showOutput",
          title: "rollup: Show Output",
        },
      ],
      configuration: {
        title: "rollup",
        properties: {
          "dataverseIde.rollup.configPath": {
            type: "string",
            default: "rollup.config.json",
            scope: "window",
            description:
              "Workspace-relative path of the rollup build settings file. Example: config/rollup.config.json.",
          },

          "dataverseIde.rollup.autoStartWatch": {
            type: "boolean",
            default: false,
            scope: "window",
            description:
              "Automatically start rollup watch mode on activation. Watch state is runtime-only; changing this setting does not persist to rollup.config.json.",
          },
        },
      },
    });

    outputChannel.appendLine(
      "[rollup] extension activated (main-thread bundler, direct workspace filesystem reads).",
    );

    const watchStatus = createWatchStatus(vscode, {
      id: "rollup",
      label: "rollup",
      busyLabel: "Building",
      isRunning: () => watchEnabled,
      isBusy: () => lastStatus === "building",
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
        void vscode.commands.executeCommand("dataverseIde.rollup.openConfig");
      },
      extraItems: () => [
        {
          label: "$(zap) Build now (configured)",
          run: () => {
            void vscode.commands.executeCommand("dataverseIde.rollup.buildConfigured");
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

    await reloadConfigFromDisk();

    setWatchRuntimeEnabled(getAutoStartWatchSetting(vscode));

    const watchSettingListener = vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("dataverseIde.rollup.autoStartWatch", context.workspaceRootUri)
      ) {
        void setWatchEnabled(getAutoStartWatchSetting(vscode));
      }
    });

    async function runBuild(
      requestedEntryPath: string,
      options?: { silent?: boolean },
    ): Promise<boolean> {
      const started = Date.now();

      const entryPath = requestedEntryPath.replaceAll("\\", "/").replace(/^(?:\.{1,2}\/)+/, "");

      try {
        await reloadConfigFromDisk();

        lastStatus = "building";
        lastMessage = `Building ${entryPath}…`;
        notifyStatus();

        if (options?.silent !== true) {
          outputChannel.show(true);
        }

        outputChannel.appendLine(`[rollup] Building ${entryPath}…`);

        if (!(await workspaceFileExists(vscode, context.workspaceRootUri, entryPath))) {
          throw new Error(
            `Entry "${entryPath}" was not found in the workspace. ` +
              "Check the entry setting in rollup.config.json.",
          );
        }

        /*
         * New reader per build: caches duplicate reads during this build but
         * cannot return stale content after a workspace file changes.
         */
        const response = await bundle({
          entry: entryPath,
          workspace: createWorkspaceReader(vscode, context.workspaceRootUri),
          format: currentConfig.format,
          minify: currentConfig.minify,
          sourcemap: currentConfig.sourcemap,
          external: currentConfig.external,
          define: currentConfig.define,
        });

        if (!response.ok) {
          outputChannel.appendLine(`[rollup] ${response.error}`);
          outputChannel.show(true);

          lastStatus = "error";
          lastMessage = firstLine(response.error);
          notifyStatus();

          return false;
        }

        for (const warning of response.warnings) {
          outputChannel.appendLine(`[rollup] warning: ${warning}`);
        }

        if (response.outputs.length === 0) {
          outputChannel.appendLine("[rollup] Build produced no output.");

          lastStatus = "error";
          lastMessage = "Build produced no output.";
          notifyStatus();

          return false;
        }

        const writtenUris = await writeOutputs(
          vscode,
          context.workspaceRootUri,
          currentConfig.outdir,
          entryPath,
          response.outputs,
        );

        const elapsed = Date.now() - started;

        const summary = `Built ${entryPath} in ${elapsed}ms → ${writtenUris
          .map((uri) => vscode.workspace.asRelativePath(uri, false))
          .join(", ")}`;

        outputChannel.appendLine(`[rollup] ${summary}`);

        if (options?.silent !== true) {
          outputChannel.show(true);
        }

        lastStatus = "ok";
        lastMessage = summary;
        notifyStatus();

        return true;
      } catch (error) {
        console.error("[rollup] build error:", error);

        const message = error instanceof Error ? error.message : String(error);

        outputChannel.appendLine(`[rollup] ${message}`);
        outputChannel.show(true);

        lastStatus = "error";
        lastMessage = message;
        notifyStatus();

        if (options?.silent !== true) {
          await vscode.window.showErrorMessage(`[rollup] Build failed: ${message}`);
        }

        return false;
      }
    }

    async function withCurrentFile(operation: "transform" | "minify"): Promise<void> {
      const current = await resolveCurrentFile(vscode);

      if (current == null) {
        await vscode.window.showWarningMessage(
          "[rollup] Open a workspace file in the editor first.",
        );

        return;
      }

      const { document, relativePath } = current;

      try {
        const started = Date.now();

        outputChannel.show(true);
        outputChannel.appendLine(`[rollup] ${operation}: ${relativePath}…`);

        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `[rollup] ${operation} ${relativePath}…`,
            cancellable: false,
          },
          async () => {
            const result = await transformForBundler({
              filename: relativePath,
              source: document.getText(),
              minify: operation === "minify",
              ...(operation === "transform" ? { format: "esm" as const } : {}),
            });

            return result.code;
          },
        );

        const baseName =
          relativePath
            .split("/")
            .pop()
            ?.replace(/\.[^.]+$/, "") ?? "output";

        const extension = operation === "minify" ? ".min.js" : ".mjs";

        const outFile = vscode.Uri.joinPath(
          context.workspaceRootUri,
          OUTPUT_DIRECTORY,
          `${baseName}${extension}`,
        );

        await vscode.workspace.fs.createDirectory(
          vscode.Uri.joinPath(context.workspaceRootUri, OUTPUT_DIRECTORY),
        );

        await vscode.workspace.fs.writeFile(outFile, new TextEncoder().encode(result));

        const elapsed = Date.now() - started;

        outputChannel.appendLine(
          `[rollup] ${operation} finished in ${elapsed}ms -> ${vscode.workspace.asRelativePath(outFile, false)}`,
        );

        await vscode.window.showInformationMessage(
          `[rollup] ${operation} finished in ${elapsed}ms.`,
        );
      } catch (error) {
        console.error("[rollup] operation error:", error);

        const message = error instanceof Error ? error.message : String(error);

        outputChannel.appendLine(`[rollup] ${message}`);
        outputChannel.show(true);

        await vscode.window.showErrorMessage(`[rollup] ${operation} failed: ${message}`);
      }
    }

    function ensureWatcher(): EsbuildWatcher {
      if (watcher != null) {
        return watcher;
      }

      watcher = new EsbuildWatcher(vscode, context.workspaceRootUri, {
        outDir: () => currentConfig.outdir,
        entry: () => currentConfig.entryPoints[0],
        configPath: () => configRelativePathFor(vscode, context.workspaceRootUri),
        build: async (entry) => {
          await runBuild(entry, { silent: true });
        },
      });

      return watcher;
    }

    function setWatchRuntimeEnabled(enabled: boolean): void {
      if (enabled === watchEnabled) {
        return;
      }

      watchEnabled = enabled;

      if (enabled) {
        ensureWatcher();

        /*
         * Start-of-watch initial run: build the configured entry once so
         * the output directory exists before any subsequent save-driven
         * rebuild.
         */
        void runBuild(currentConfig.entryPoints[0], { silent: true });
      } else {
        watcher?.dispose();
        watcher = undefined;
      }

      notifyStatus();
    }

    async function setWatchEnabled(enabled: boolean): Promise<void> {
      /*
       * Watch state is runtime-only; toggles do not touch
       * rollup.config.json. Persistence (autostart) is the autoStartWatch
       * setting.
       */
      setWatchRuntimeEnabled(enabled);
    }

    const buildCommand = vscode.commands.registerCommand("dataverseIde.rollup.build", async () => {
      const activeEditor = vscode.window.activeTextEditor;

      if (activeEditor == null) {
        await vscode.window.showWarningMessage("[rollup] Open a file in the editor to build it.");

        return;
      }

      if (activeEditor.document.uri.scheme !== "file") {
        await vscode.window.showWarningMessage("[rollup] Only workspace files can be built.");

        return;
      }

      await runBuild(vscode.workspace.asRelativePath(activeEditor.document.uri, false));
    });

    const transformCommand = vscode.commands.registerCommand(
      "dataverseIde.rollup.transform",
      async () => {
        await withCurrentFile("transform");
      },
    );

    const minifyCommand = vscode.commands.registerCommand(
      "dataverseIde.rollup.minify",
      async () => {
        await withCurrentFile("minify");
      },
    );

    const startWatchCommand = vscode.commands.registerCommand(
      "dataverseIde.rollup.startWatch",
      () => setWatchEnabled(true),
    );

    const stopWatchCommand = vscode.commands.registerCommand("dataverseIde.rollup.stopWatch", () =>
      setWatchEnabled(false),
    );

    const toggleWatchCommand = vscode.commands.registerCommand(
      "dataverseIde.rollup.toggleWatch",
      () => setWatchEnabled(!watchEnabled),
    );

    const buildConfiguredEntryCommand = vscode.commands.registerCommand(
      "dataverseIde.rollup.buildConfigured",
      async () => {
        const { config } = await readRollupConfig(vscode, context.workspaceRootUri);

        currentConfig = config;

        await runBuild(config.entryPoints[0]);
      },
    );

    let lastWorkspaceEntry: string | undefined;

    const buildWorkspaceCommand = vscode.commands.registerCommand(
      "dataverseIde.rollup.buildWorkspace",
      async () => {
        const uris = await vscode.workspace.findFiles(
          "**/*.{ts,tsx,js,jsx,mts,cts}",
          "{**/node_modules/**,**/.ide-build/**,**/.git/**,**/dist/**}",
          200,
        );

        if (uris.length === 0) {
          await vscode.window.showWarningMessage(
            "[rollup] No buildable source files found in the workspace.",
          );

          return;
        }

        const items = uris
          .map((uri) => vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/"))
          .sort((a, b) => a.localeCompare(b));

        if (lastWorkspaceEntry != null) {
          const index = items.indexOf(lastWorkspaceEntry);

          if (index > 0) {
            items.splice(index, 1);
            items.unshift(lastWorkspaceEntry);
          }
        }

        const picked = await vscode.window.showQuickPick(items, {
          title: "rollup: Build Workspace…",
          placeHolder:
            lastWorkspaceEntry != null
              ? `Pick a file to bundle as the entry point (last built: ${lastWorkspaceEntry})`
              : "Pick a file to bundle as the entry point",
        });

        if (picked == null) {
          return;
        }

        lastWorkspaceEntry = picked;

        await runBuild(picked);
      },
    );

    const openConfigCommand = vscode.commands.registerCommand(
      "dataverseIde.rollup.openConfig",
      async () => {
        const uri = configFilePath(vscode, context.workspaceRootUri);

        try {
          await vscode.workspace.fs.stat(uri);
        } catch {
          /*
           * Scaffold the file with the merged defaults on first open so the
           * editor shows something meaningful to edit.
           */
          await updateRollupConfig(vscode, context.workspaceRootUri, {});
        }

        await vscode.window.showTextDocument(uri);
      },
    );

    const outputChannelCommand = vscode.commands.registerCommand(
      "dataverseIde.rollup.showOutput",
      () => {
        outputChannel.show(true);
      },
    );

    const reloadConfigCommand = vscode.commands.registerCommand(
      "dataverseIde.rollup.reloadConfig",
      async () => {
        await reloadConfigFromDisk();

        await vscode.window.showInformationMessage("rollup configuration reloaded.");
      },
    );

    outputChannel.appendLine(
      "[rollup] commands registered: transform, minify, build, watch, config.",
    );

    return {
      dispose() {
        watcher?.dispose();
        watchSettingListener.dispose();
        watchStatus.dispose();

        transformCommand.dispose();
        minifyCommand.dispose();
        buildCommand.dispose();
        buildWorkspaceCommand.dispose();
        buildConfiguredEntryCommand.dispose();
        startWatchCommand.dispose();
        stopWatchCommand.dispose();
        toggleWatchCommand.dispose();
        openConfigCommand.dispose();
        reloadConfigCommand.dispose();
        outputChannelCommand.dispose();
      },
    };
  },
} satisfies IdeExtension;
