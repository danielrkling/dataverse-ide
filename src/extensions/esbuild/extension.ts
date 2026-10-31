import type * as vscodeType from "vscode";

import { EsbuildBuildRunner, type BuildOutputFile } from "./buildRunner.js";

import { contributeExtensionManifest } from "../api.js";

import { createWatchStatus } from "../watchStatus.js";

import {
  ESBUILD_DEFAULT_CONFIG,
  configFilePath,
  configRelativePathFor,
  readEsbuildConfig,
  updateEsbuildConfig,
  type EsbuildConfig,
} from "./config.js";

import { EsbuildWatcher } from "./watcher.js";

import type { ExtensionContext, IdeExtension } from "../api.js";

/*
 * Main-thread esbuild extension.
 *
 * The compiler reads source files directly from vscode.workspace.fs through
 * compiler.ts. There is no workspace-wide collection pass and no lazy
 * needFiles/probe loop:
 *
 *   esbuild requests import
 *     → resolver checks the actual mounted workspace filesystem
 *     → onLoad reads only the resolved source file
 *
 * This supports local folders, OPFS workspaces, and the node_modules OPFS
 * overlay through the same filesystem provider used by the editor.
 */

const CONFIG_SECTION = "dataverseIde.esbuild";

function getAutoStartWatchSetting(vscode: typeof vscodeType): boolean {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION, null)
    .get<boolean>("autoStartWatch", false);
}

function outputPathSegments(outputPath: string): string[] {
  const normalized = outputPath.replaceAll("\\", "/");

  /*
   * esbuild is called with outdir "out"; keep everything after it so source
   * maps, legal-comment files, CSS output, and code-split chunks all land
   * beside the JavaScript instead of overwriting each other.
   */
  const relative = normalized.startsWith("out/")
    ? normalized.slice("out/".length)
    : (normalized.split("/").pop() ?? normalized);

  return relative
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

async function writeOutputs(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  outDir: string,
  outputs: BuildOutputFile[],
): Promise<vscodeType.Uri[]> {
  const written: vscodeType.Uri[] = [];

  for (const output of outputs) {
    const segments = outputPathSegments(output.path);

    if (segments.length === 0) {
      continue;
    }

    const outFile = vscode.Uri.joinPath(rootUri, outDir, ...segments);

    const parent = vscode.Uri.joinPath(rootUri, outDir, ...segments.slice(0, -1));

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

export default {
  id: "esbuild",

  async activate(context: ExtensionContext): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context;

    let currentConfig: EsbuildConfig = ESBUILD_DEFAULT_CONFIG;
    let watcher: EsbuildWatcher | undefined;
    let watchEnabled = false;

    let lastStatus: "idle" | "building" | "ok" | "error" = "idle";
    let lastMessage = "No build run yet.";

    async function reloadConfigFromDisk(): Promise<void> {
      const loaded = await readEsbuildConfig(vscode, context.workspaceRootUri);

      currentConfig = loaded.config;

      notifyStatus();
    }

    await contributeExtensionManifest({
      id: "esbuild",
      displayName: "Dataverse IDE esbuild",
      description: "esbuild-wasm bundling for workspace files.",
      commands: [
        {
          command: "dataverseIde.esbuild.build",
          title: "esbuild: Build Current File",
        },
        {
          command: "dataverseIde.esbuild.buildActiveFile",
          title: "esbuild: Build Active File…",
        },
        {
          command: "dataverseIde.esbuild.buildWorkspace",
          title: "esbuild: Build Workspace…",
        },
        {
          command: "dataverseIde.esbuild.buildConfigured",
          title: "esbuild: Build Configured Entry",
        },
        {
          command: "dataverseIde.esbuild.startWatch",
          title: "esbuild: Start Watch",
        },
        {
          command: "dataverseIde.esbuild.stopWatch",
          title: "esbuild: Stop Watch",
        },
        {
          command: "dataverseIde.esbuild.toggleWatch",
          title: "esbuild: Toggle Watch",
        },
        {
          command: "dataverseIde.esbuild.openConfig",
          title: "esbuild: Open esbuild.config.json",
        },
        {
          command: "dataverseIde.esbuild.configureTaggedJsx",
          title: "esbuild: Tagged JSX Transform…",
        },
        {
          command: "dataverseIde.esbuild.showOutput",
          title: "esbuild: Show Output",
        },
        {
          command: "dataverseIde.esbuild.reloadConfig",
          title: "esbuild: Reload Config",
        },
      ],
      configuration: {
        title: "esbuild",
        properties: {
          "dataverseIde.esbuild.configPath": {
            type: "string",
            default: "esbuild.config.json",
            scope: "window",
            description:
              "Workspace-relative path of the esbuild build settings file. Example: config/esbuild.config.json.",
          },

          "dataverseIde.esbuild.autoStartWatch": {
            type: "boolean",
            default: false,
            scope: "window",
            description:
              "Automatically start esbuild watch mode on activation. Watch state is runtime-only; changing this setting does not persist to esbuild.config.json.",
          },

          /*
           * Kept for backward compatibility with existing workspace settings.
           * Main-thread direct filesystem builds no longer perform a large
           * node_modules collection pass, so this setting has no effect.
           */
          "dataverseIde.esbuild.logCollection": {
            type: "boolean",
            default: false,
            scope: "window",
            description:
              "Legacy setting. Main-thread esbuild reads only files reached by the active dependency graph.",
          },
        },
      },
    });

    const runner = new EsbuildBuildRunner(vscode, context.workspaceRootUri, outputChannel);

    outputChannel.appendLine(
      "[esbuild] extension activated (main-thread compiler, direct workspace filesystem reads).",
    );

    const watchStatus = createWatchStatus(vscode, {
      id: "esbuild",
      label: "esbuild",
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
        void vscode.commands.executeCommand("dataverseIde.esbuild.openConfig");
      },
      extraItems: () => [
        {
          label: "$(zap) Build configured entry",
          run: () => {
            void vscode.commands.executeCommand("dataverseIde.esbuild.buildConfigured");
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
        event.affectsConfiguration("dataverseIde.esbuild.autoStartWatch", context.workspaceRootUri)
      ) {
        void setWatchEnabled(getAutoStartWatchSetting(vscode));
      }
    });

    async function runBuild(
      requestedEntryPath: string,
      options?: {
        silent?: boolean;
      },
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

        outputChannel.appendLine(`[esbuild] Building ${entryPath}…`);

        /*
         * The compiler now reads the workspace itself. Verify the entry
         * early so users receive a useful configuration error rather than
         * a lower-level esbuild resolution error.
         */
        if (!(await workspaceFileExists(vscode, context.workspaceRootUri, entryPath))) {
          throw new Error(
            `Entry "${entryPath}" was not found in the workspace. ` +
              "Check the entry setting in esbuild.config.json.",
          );
        }

        const response = await runner.build({
          entry: entryPath,
          format: currentConfig.format,
          platform: currentConfig.platform,
          charset: currentConfig.charset,
          globalName: currentConfig.globalName,
          minify: currentConfig.minify,
          sourcemap: currentConfig.sourcemap,
          sourceRoot: currentConfig.sourceRoot,
          sourcesContent: currentConfig.sourcesContent,
          target: currentConfig.target,
          treeShaking: currentConfig.treeShaking,
          keepNames: currentConfig.keepNames,
          legalComments: currentConfig.legalComments,
          lineLimit: currentConfig.lineLimit,
          drop: currentConfig.drop,
          banner: currentConfig.banner,
          footer: currentConfig.footer,
          pure: currentConfig.pure,
          jsx: currentConfig.jsx,
          jsxFactory: currentConfig.jsxFactory,
          jsxFragment: currentConfig.jsxFragment,
          jsxImportSource: currentConfig.jsxImportSource,
          jsxDev: currentConfig.jsxDev,
          jsxSideEffects: currentConfig.jsxSideEffects,
          bundle: currentConfig.bundle,
          splitting: currentConfig.splitting,
          external: currentConfig.external,
          define: currentConfig.define,
          entryNames: currentConfig.entryNames,
          chunkNames: currentConfig.chunkNames,
          outExtension: currentConfig.outExtension,
          taggedJsx: currentConfig.taggedJsx,
        });

        if (!response.ok) {
          outputChannel.appendLine(`[esbuild] ${response.error}`);
          outputChannel.show(true);

          lastStatus = "error";
          lastMessage = firstLine(response.error);
          notifyStatus();

          return false;
        }

        for (const warning of response.warnings) {
          outputChannel.appendLine(`[esbuild] warning: ${warning}`);
        }

        if (response.outputs.length === 0) {
          outputChannel.appendLine("[esbuild] Build produced no output.");

          lastStatus = "error";
          lastMessage = "Build produced no output.";
          notifyStatus();

          return false;
        }

        const writtenUris = await writeOutputs(
          vscode,
          context.workspaceRootUri,
          currentConfig.outdir,
          response.outputs,
        );

        const elapsed = Date.now() - started;

        const summary =
          `Built ${entryPath} in ${elapsed}ms → ` +
          writtenUris.map((uri) => vscode.workspace.asRelativePath(uri, false)).join(", ");

        outputChannel.appendLine(`[esbuild] ${summary}`);

        if (options?.silent !== true) {
          outputChannel.show(true);
        }

        lastStatus = "ok";
        lastMessage = summary;
        notifyStatus();

        return true;
      } catch (error) {
        console.error("[esbuild] build error:", error);

        const message = error instanceof Error ? error.message : String(error);

        outputChannel.appendLine(`[esbuild] ${message}`);
        outputChannel.show(true);

        lastStatus = "error";
        lastMessage = message;
        notifyStatus();

        if (options?.silent !== true) {
          await vscode.window.showErrorMessage(`[esbuild] Build failed: ${message}`);
        }

        return false;
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
          await runBuild(entry, {
            silent: true,
          });
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
         * Initial watch build ensures output exists even before the first
         * saved editor change.
         */
        void runBuild(currentConfig.entryPoints[0], {
          silent: true,
        });
      } else {
        watcher?.dispose();
        watcher = undefined;
      }

      notifyStatus();
    }

    async function setWatchEnabled(enabled: boolean): Promise<void> {
      setWatchRuntimeEnabled(enabled);
    }

    const buildActiveFileCommand = vscode.commands.registerCommand(
      "dataverseIde.esbuild.build",
      async (arg?: string | unknown) => {
        let entryPath: string;

        if (typeof arg === "string" && arg.trim().length > 0) {
          entryPath = arg;
        } else {
          const activeEditor = vscode.window.activeTextEditor;

          if (activeEditor == null) {
            await vscode.window.showWarningMessage(
              "[esbuild] Open a file in the editor to build it.",
            );

            return;
          }

          if (activeEditor.document.uri.scheme !== "file") {
            await vscode.window.showWarningMessage("[esbuild] Only workspace files can be built.");

            return;
          }

          entryPath = vscode.workspace
            .asRelativePath(activeEditor.document.uri, false)
            .replaceAll("\\", "/");
        }

        await runBuild(entryPath);
      },
    );

    /*
     * Retained alias for integrations that call the old explicit command ID.
     */
    const buildActiveFileAliasCommand = vscode.commands.registerCommand(
      "dataverseIde.esbuild.buildActiveFile",
      async () => {
        await vscode.commands.executeCommand("dataverseIde.esbuild.build");
      },
    );

    const startWatchCommand = vscode.commands.registerCommand(
      "dataverseIde.esbuild.startWatch",
      () => setWatchEnabled(true),
    );

    const stopWatchCommand = vscode.commands.registerCommand("dataverseIde.esbuild.stopWatch", () =>
      setWatchEnabled(false),
    );

    const toggleWatchCommand = vscode.commands.registerCommand(
      "dataverseIde.esbuild.toggleWatch",
      () => setWatchEnabled(!watchEnabled),
    );

    const buildConfiguredEntryCommand = vscode.commands.registerCommand(
      "dataverseIde.esbuild.buildConfigured",
      async () => {
        const { config } = await readEsbuildConfig(vscode, context.workspaceRootUri);

        currentConfig = config;

        await runBuild(config.entryPoints[0]);
      },
    );

    let lastWorkspaceEntry: string | undefined;

    const buildWorkspaceCommand = vscode.commands.registerCommand(
      "dataverseIde.esbuild.buildWorkspace",
      async () => {
        const uris = await vscode.workspace.findFiles(
          "**/*.{ts,tsx,js,jsx,mts,cts}",
          "{**/node_modules/**,**/.ide-build/**,**/.git/**,**/dist/**}",
          200,
        );

        if (uris.length === 0) {
          await vscode.window.showWarningMessage(
            "[esbuild] No buildable source files found in the workspace.",
          );

          return;
        }

        const items = uris
          .map((uri) => vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/"))
          .sort((left, right) => left.localeCompare(right));

        if (lastWorkspaceEntry != null) {
          const index = items.indexOf(lastWorkspaceEntry);

          if (index > 0) {
            items.splice(index, 1);
            items.unshift(lastWorkspaceEntry);
          }
        }

        const picked = await vscode.window.showQuickPick(items, {
          title: "esbuild: Build Workspace…",
          placeHolder:
            lastWorkspaceEntry != null
              ? `Pick an entry point (last built: ${lastWorkspaceEntry})`
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
      "dataverseIde.esbuild.openConfig",
      async () => {
        const uri = configFilePath(vscode, context.workspaceRootUri);

        try {
          await vscode.workspace.fs.stat(uri);
        } catch {
          await updateEsbuildConfig(vscode, context.workspaceRootUri, {});
        }

        await vscode.window.showTextDocument(uri);
      },
    );

    const configureTaggedJsxCommand = vscode.commands.registerCommand(
      "dataverseIde.esbuild.configureTaggedJsx",
      async () => {
        const modes: {
          value: EsbuildConfig["taggedJsx"];
          label: string;
        }[] = [
          {
            value: "off",
            label: "off — no conversion; build sources as written",
          },
          {
            value: "toJsx",
            label: "toJsx — tagged templates (html`…`) become JSX before build",
          },
          {
            value: "toTagged",
            label: "toTagged — JSX becomes tagged templates in build output",
          },
        ];

        const picked = await vscode.window.showQuickPick(modes, {
          title: "esbuild: Tagged JSX transform (@tagged-jsx/transform)",
          placeHolder: `Current: ${currentConfig.taggedJsx}`,
        });

        if (picked == null || picked.value === currentConfig.taggedJsx) {
          return;
        }

        const merged = await updateEsbuildConfig(vscode, context.workspaceRootUri, {
          taggedJsx: picked.value,
        });

        currentConfig = merged;

        await vscode.window.showInformationMessage(
          `esbuild: taggedJsx set to "${picked.value}" in esbuild.config.json.`,
        );
      },
    );

    const outputChannelCommand = vscode.commands.registerCommand(
      "dataverseIde.esbuild.showOutput",
      () => {
        outputChannel.show(true);
      },
    );

    const reloadConfigCommand = vscode.commands.registerCommand(
      "dataverseIde.esbuild.reloadConfig",
      async () => {
        await reloadConfigFromDisk();

        await vscode.window.showInformationMessage("esbuild configuration reloaded.");
      },
    );

    outputChannel.appendLine("[esbuild] commands registered.");

    return {
      dispose() {
        watcher?.dispose();
        watchSettingListener.dispose();
        watchStatus.dispose();

        buildActiveFileCommand.dispose();
        buildActiveFileAliasCommand.dispose();
        buildConfiguredEntryCommand.dispose();
        buildWorkspaceCommand.dispose();

        startWatchCommand.dispose();
        stopWatchCommand.dispose();
        toggleWatchCommand.dispose();

        openConfigCommand.dispose();
        configureTaggedJsxCommand.dispose();
        outputChannelCommand.dispose();
        reloadConfigCommand.dispose();

        runner.dispose();
      },
    };
  },
} satisfies IdeExtension;
