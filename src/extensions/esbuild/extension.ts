import type * as vscodeType from "vscode";

import { EsbuildBuildRunner } from "./buildRunner.js";

import type { BuildRunnerResponse } from "./buildRunner.js";

import type { BuildOutputFile } from "./worker.js";

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
 * esbuild-wasm extension.
 *
 * The wasm compiler runs in a dedicated web worker (worker.ts); the main
 * thread collects workspace sources into an in-memory file map and sends a
 * build request. Bare imports (npm packages) are externalized - install
 * them into the workspace first (npm extension) or bundle later with
 * rolldown.
 */

const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|css|json)$/i;

const MAX_COLLECTED_FILES = 8000;

/*
 * Lazy two-pass resolution: initial collection loads only package.json
 * manifests from node_modules (cheap, and exactly what bare-import
 * resolution starts from). When the resolver needs a package file it does
 * not have, the worker returns needFiles and runBuild reads just those
 * paths from the workspace and retries. This avoids slurping up to
 * MAX_COLLECTED_NODE_MODULES_FILES files per build.
 */
const MAX_COLLECTED_PACKAGE_MANIFESTS = 5000;

/*
 * Safety bound for lazy rounds (each round tops the map up with the files
 * the resolver missed the previous round).
 */
const MAX_LAZY_ROUNDS = 12;

const EXCLUDE_PATTERN = "{**/.git/**,**/.ide-build/**,**/dist/**,**/out/**,**/node_modules/**}";

type BuildRequest = {
  id: number;
  type: "build";
  entry: string;
  files: Record<string, string>;
};

type BuildResponse =
  | {
      id: number;
      ok: true;
      outputs: BuildOutputFile[];
      warnings: string[];
    }
  | {
      id: number;
      ok: false;
      error: string;
    };

const CONFIG_SECTION = "dataverseIde.esbuild";

function getAutoStartWatchSetting(vscode: typeof vscodeType): boolean {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION, null)
    .get<boolean>("autoStartWatch", false);
}

function isBuildResponse(value: unknown): value is BuildResponse {
  return typeof value === "object" && value != null && "id" in value && "ok" in value;
}

async function collectWorkspaceSources(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): Promise<{ files: Record<string, string>; debugLines: string[] }> {
  const rootPath = rootUri.path.replace(/\/+$/, "");

  const collect = async (
    pattern: vscodeType.GlobPattern,
    exclude: string,
    cap: number,
  ): Promise<vscodeType.Uri[]> => vscode.workspace.findFiles(pattern, exclude, cap);

  const sourceUris = await collect("**/*", EXCLUDE_PATTERN, MAX_COLLECTED_FILES);

  const nodeModulesManifestUris = await collect(
    "node_modules/**/package.json",
    "{**/.git/**}",
    MAX_COLLECTED_PACKAGE_MANIFESTS,
  );

  /*
   * Collection diagnostics: report how much was found up front.
   */
  const nodeModulesDebugInfo = [
    `[esbuild] findFiles("node_modules/**/package.json") returned ${nodeModulesManifestUris.length} manifest(s).`,
  ];

  const uris = [...sourceUris, ...nodeModulesManifestUris];

  const files: Record<string, string> = {};

  for (const uri of uris) {
    if (!SOURCE_EXTENSIONS.test(uri.path)) {
      continue;
    }

    let relativePath = uri.path.slice(rootPath.length).replace(/^\//, "");

    if (relativePath.length === 0) {
      continue;
    }

    // Normalize Windows-style drive artifacts if any
    relativePath = relativePath.replaceAll("\\", "/");

    // Only collect text; binary assets inside node_modules (wasm, images)
    // are skipped - esbuild loaders cannot consume them via the map anyway
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);

      files[relativePath] = new TextDecoder().decode(bytes);
    } catch (error) {
      console.warn("[esbuild] skipping unreadable file:", relativePath, error);
    }
  }

  const collectedNodeModules = Object.keys(files).filter((key) =>
    key.startsWith("node_modules/"),
  ).length;

  const debugLines = [
    ...nodeModulesDebugInfo,
    `[esbuild] file map: ${Object.keys(files).length} entries (node_modules: ${collectedNodeModules}).`,
  ];

  return { files, debugLines };
}

async function writeOutputs(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  outDir: string,
  entryPath: string,
  outputs: BuildOutputFile[],
): Promise<vscodeType.Uri[]> {
  const written: vscodeType.Uri[] = [];

  for (const output of outputs) {
    const baseName =
      entryPath
        .split("/")
        .pop()
        ?.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i, "") ?? "bundle";

    const suffix = output.path.endsWith(".css") ? ".css" : ".js";

    const outFile = vscode.Uri.joinPath(rootUri, outDir, `${baseName}${suffix}`);

    const parent = vscode.Uri.joinPath(rootUri, outDir);

    await vscode.workspace.fs.createDirectory(parent);

    await vscode.workspace.fs.writeFile(outFile, new TextEncoder().encode(output.text));

    written.push(outFile);
  }

  return written;
}

export default {
  id: "esbuild",

  async activate(context: ExtensionContext): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context;

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

          "dataverseIde.esbuild.logCollection": {
            type: "boolean",
            default: true,
            scope: "window",
            description:
              "Log node_modules collection details (findFiles counts, extensions, dropped files) to the esbuild output channel for every build.",
          },
        },
      },
    });

    const runner = new EsbuildBuildRunner(outputChannel);

    outputChannel.appendLine("[esbuild] extension activated.");

    /*
     * Config-file driven build. All settings come from esbuild.config.json
     * (esbuild/config.ts); there is no vscode-settings fallback.
     */
    let currentConfig: EsbuildConfig = ESBUILD_DEFAULT_CONFIG;
    let watcher: EsbuildWatcher | undefined;
    let watchEnabled = false;

    let lastStatus: "idle" | "building" | "ok" | "error" = "idle";
    let lastMessage = "No build run yet.";
    let lastFinishedAt: number | undefined;

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
          label: "$(zap) Build now (configured)",
          run: () => {
            void vscode.commands.executeCommand("dataverseIde.esbuild.buildConfigured");
          },
        },
      ],
    });

    const statusListeners = new Set<() => void>();

    function firstLine(text: string): string {
      return text.split("\n", 1)[0] ?? text;
    }

    function notifyStatus(): void {
      watchStatus.update();

      for (const listener of statusListeners) {
        listener();
      }
    }

    /*
     * Load the config file (or defaults when absent) once at activation so
     * the panel and watcher start from the real project settings.
     */
    await reloadConfigFromDisk();

    /*
     * Watch is runtime-only. Autostart comes from the workspace/user setting
     * dataverseIde.esbuild.autoStartWatch.
     */
    setWatchRuntimeEnabled(getAutoStartWatchSetting(vscode));

    const watchSettingListener = vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (
        event.affectsConfiguration("dataverseIde.esbuild.autoStartWatch", context.workspaceRootUri)
      ) {
        setWatchEnabled(getAutoStartWatchSetting(vscode));
      }
    });

    async function runBuild(entryPath: string, options?: { silent?: boolean }): Promise<boolean> {
      const started = Date.now();

      /*
       * Canonicalize the entry the same way the config reader does: the
       * collected files map keys carry no './' prefix and store only forward
       * slashes.
       */
      entryPath = entryPath.replaceAll("\\", "/").replace(/^(?:\.{1,2}\/)+/, "");

      try {
        await reloadConfigFromDisk();

        lastStatus = "building";
        lastMessage = `Building ${entryPath}…`;
        notifyStatus();

        if (options?.silent !== true) {
          outputChannel.show(true);
        }

        outputChannel.appendLine(`[esbuild] Building ${entryPath}…`);

        const { files, debugLines } = await collectWorkspaceSources(
          vscode,
          context.workspaceRootUri,
        );

        for (const line of debugLines) {
          outputChannel.appendLine(line);
        }

        /*
         * Collection diagnostics: when bundling npm packages goes wrong we
         * need to know whether the package actually landed in the map (npm
         * install writes it, but the collector caps node_modules files).
         */
        const collectedNodeModules = Object.keys(files).filter((key) =>
          key.startsWith("node_modules/"),
        ).length;

        outputChannel.appendLine(
          `[esbuild] collected ${Object.keys(files).length} files from the workspace ` +
            `(node_modules: ${collectedNodeModules}).`,
        );

        if (files[entryPath] == null) {
          const nearby = Object.keys(files)
            .filter(
              (key) =>
                key.startsWith(entryPath.replace(/\.[^./]+$/, "")) ||
                key.startsWith(`${entryPath}.`),
            )
            .slice(0, 5);

          throw new Error(
            `Entry ${entryPath} was not collected from the workspace ` +
              `(collected source files: ${Object.keys(files).length - collectedNodeModules}).` +
              (nearby.length > 0
                ? ` Nearby: ${nearby.join(", ")}.`
                : " Check the entry setting in esbuild.config.json."),
          );
        }

        const absentPaths = new Set<string>();

        /*
         * Lazy two-pass resolution: the first response may be a probe round
         * listing concrete paths (package files) the resolver needed; read
         * those from the workspace and retry. Repeat until the resolver
         * stops requesting files, marking truly-absent paths so later
         * rounds finalize (unresolved → warning + external) instead of
         * re-probing them forever.
         */
        let round = 0;
        let response: BuildRunnerResponse | undefined;

        for (;;) {
          round++;

          response = await runner.build({
            entry: entryPath,
            files,
            format: currentConfig.format,
            minify: currentConfig.minify,
            sourcemap: currentConfig.sourcemap,
            target: currentConfig.target,
            bundle: currentConfig.bundle,
            external: currentConfig.external,
            define: currentConfig.define,
            absentPaths: [...absentPaths],
          });

          if (!response.ok) {
            break;
          }

          const requested = response.needFiles ?? [];

          if (requested.length === 0 || round >= MAX_LAZY_ROUNDS) {
            break;
          }

          let added = 0;
          const readFailed: string[] = [];

          for (const relativePath of requested) {
            try {
              const fileUri = vscode.Uri.joinPath(
                context.workspaceRootUri,
                ...relativePath.split("/"),
              );

              const bytes = await vscode.workspace.fs.readFile(fileUri);

              files[relativePath] = new TextDecoder().decode(bytes);
              added++;
            } catch {
              /*
               * The path does not exist in the workspace. Remember that so
               * the next round finalizes (warning + external) rather than
               * re-requesting the same paths forever.
               */
              absentPaths.add(relativePath);
              if (readFailed.length < 8) {
                readFailed.push(relativePath);
              }
            }
          }

          outputChannel.appendLine(
            `[esbuild] lazy resolution round ${round}: read ${added} of ${requested.length} requested file(s).` +
              ` requested: ${requested.slice(0, 6).join(" | ")}` +
              (readFailed.length > 0 ? ` | unreadable: ${readFailed.join(", ")}…` : ""),
          );
        }

        if (response == null) {
          return false;
        }

        if (!response.ok) {
          outputChannel.appendLine(response.error);
          outputChannel.show(true);

          lastStatus = "error";
          lastMessage = firstLine(response.error);
          lastFinishedAt = Date.now();
          notifyStatus();

          return false;
        }

        if ((response.needFiles ?? []).length > 0) {
          /*
           * The lazy round cap ran out while the resolver still missed
           * files (import cycles probing distinct paths, or a pathological
           * package layout).
           */
          const stillMissing = (response.needFiles ?? []).slice(0, 5).join(", ");

          outputChannel.appendLine(
            `[esbuild] lazy file resolution exceeded ${MAX_LAZY_ROUNDS} rounds; still missing: ${stillMissing}${(response.needFiles ?? []).length > 5 ? "…" : ""}`,
          );

          lastStatus = "error";
          lastMessage = `${MAX_LAZY_ROUNDS} lazy resolution rounds exceeded; still missing ${stillMissing}`;
          lastFinishedAt = Date.now();
          notifyStatus();

          return false;
        }

        for (const warning of response.warnings) {
          outputChannel.appendLine(`[esbuild] warning: ${warning}`);
        }

        /*
         * Npm-package diagnostics: inspect the collected map whenever a bare
         * import failed to resolve, so the output channel says WHY (not
         * installed vs not collected vs package shape).
         */
        for (const warning of response.warnings) {
          const match = /^Could not resolve npm package "([^"\s]+) imported by .*"/.exec(warning);

          if (match == null) {
            continue;
          }

          const packageName = match[1];
          const packageKey = `node_modules/${packageName}`;

          if (files[`${packageKey}/package.json`] == null) {
            outputChannel.appendLine(
              `[esbuild] diagnostic: ${packageKey}/package.json was not collected. ` +
                "The package is either not installed (npm: Install) or fell outside the node_modules collection cap.",
            );
            continue;
          }

          const collectedForPackage = Object.keys(files).filter((key) =>
            key.startsWith(`${packageKey}/`),
          );

          outputChannel.appendLine(
            `[esbuild] diagnostic: ${packageKey} has ${collectedForPackage.length} collected file(s), ` +
              `e.g. ${collectedForPackage.slice(0, 6).join(", ")}. The resolver rejected the exports map — ` +
              "check the package version/exports field.",
          );
        }

        if (response.outputs.length === 0) {
          outputChannel.appendLine("[esbuild] produced no output.");

          lastStatus = "error";
          lastMessage = "Build produced no output.";
          lastFinishedAt = Date.now();
          notifyStatus();

          return false;
        }

        const writtenUris = await writeOutputs(
          vscode,
          context.workspaceRootUri,
          currentConfig.outDir,
          entryPath,
          response.outputs,
        );

        const elapsed = Date.now() - started;

        const summary = `Built ${entryPath} in ${elapsed}ms → ${writtenUris.map((uri) => vscode.workspace.asRelativePath(uri, false)).join(", ")}`;

        outputChannel.appendLine(`[esbuild] ${summary}`);

        if (options?.silent !== true) {
          outputChannel.show(true);
        }

        lastStatus = "ok";
        lastMessage = summary;
        lastFinishedAt = Date.now();
        notifyStatus();

        return true;
      } catch (error) {
        console.error("[esbuild] build error:", error);

        const message = error instanceof Error ? error.message : String(error);

        outputChannel.appendLine(`[esbuild] ${message}`);
        outputChannel.show(true);

        lastStatus = "error";
        lastMessage = message;
        lastFinishedAt = Date.now();
        notifyStatus();

        if (options?.silent !== true) {
          await vscode.window.showErrorMessage(`[esbuild] Build failed: ${message}`);
        }

        return false;
      }
    }

    const buildActiveFileCommand = vscode.commands.registerCommand(
      "dataverseIde.esbuild.build",
      async (arg?: string | unknown) => {
        let entryPath: string;

        if (typeof arg === "string" && arg.trim().length > 0) {
          entryPath = arg.replaceAll("\\", "/");
        } else {
          const activeEditor = vscode.window.activeTextEditor;

          if (activeEditor == null) {
            await vscode.window.showWarningMessage(
              "[esbuild] Open a file in the editor to build it.",
            );

            return;
          }

          const document = activeEditor.document;

          if (document.uri.scheme !== "file") {
            await vscode.window.showWarningMessage("[esbuild] Only workspace files can be built.");

            return;
          }

          entryPath = vscode.workspace.asRelativePath(document.uri, false).replaceAll("\\", "/");
        }

        await runBuild(entryPath);
      },
    );

    /*
     * Watch lifecycle. The watcher reads the live config (entry/outDir)
     * through callbacks so config edits apply without restarting.
     */
    function ensureWatcher(): EsbuildWatcher {
      if (watcher != null) {
        return watcher;
      }

      watcher = new EsbuildWatcher(vscode, context.workspaceRootUri, {
        outDir: () => currentConfig.outDir,
        entry: () => currentConfig.entry,
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
         * rebuild (save-driven runs have no initial build otherwise).
         */
        void runBuild(currentConfig.entry, { silent: true });
      } else {
        watcher?.dispose();
        watcher = undefined;
      }

      notifyStatus();
    }

    async function setWatchEnabled(enabled: boolean): Promise<void> {
      /*
       * Watch state is runtime-only; toggles do not touch esbuild.config.json.
       * Persistence (autostart) is the dataverseIde.esbuild.autoStartWatch
       * setting.
       */
      setWatchRuntimeEnabled(enabled);
    }

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

        await runBuild(config.entry);
      },
    );

    /*
     * Remembers the last "Build Workspace…" pick for this activation (the
     * custom extension context has no workspaceState).
     */
    let lastWorkspaceEntry: string | undefined;

    const buildWorkspaceCommand = vscode.commands.registerCommand(
      "dataverseIde.esbuild.buildWorkspace",
      async () => {
        /*
         * "Build Workspace…": pick a workspace source file as the entry
         * point (node_modules, build output and VFS internals excluded) and
         * run a one-shot build against it. The last-used entry is put first.
         */
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
          .sort((a, b) => a.localeCompare(b));

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
      "dataverseIde.esbuild.openConfig",
      async () => {
        const uri = configFilePath(vscode, context.workspaceRootUri);

        try {
          await vscode.workspace.fs.stat(uri);
        } catch {
          /*
           * Scaffold the file with the merged defaults on first open so the
           * editor shows something meaningful to edit.
           */
          await updateEsbuildConfig(vscode, context.workspaceRootUri, {});
        }

        await vscode.window.showTextDocument(uri);
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

        startWatchCommand.dispose();
        stopWatchCommand.dispose();
        toggleWatchCommand.dispose();
        buildConfiguredEntryCommand.dispose();
        buildWorkspaceCommand.dispose();
        openConfigCommand.dispose();
        outputChannelCommand.dispose();
        reloadConfigCommand.dispose();

        buildActiveFileCommand.dispose();
        runner.dispose();
      },
    };
  },
} satisfies IdeExtension;
