import type * as vscodeType from "vscode";

import { EsbuildBuildRunner, type BuildOutputFile, type EntryPoint } from "./buildRunner.js";

import { createWorkspaceReader, resolveWorkspaceEntry } from "./compiler.js";

import { contributeExtensionManifest } from "../api.js";

import { openExtensionReadme } from "../shared/readme.js";

import { createWatchStatus } from "../watchStatus.js";

import {
  ESBUILD_DEFAULT_CONFIG,
  configFilePath,
  configRelativePathFor,
  readEsbuildConfig,
  updateEsbuildConfig,
  type EsbuildConfig,
} from "./config.js";

import { mergeEsbuildOverride, parseEsbuildCliArgs } from "./cli.js";

import { EsbuildWatcher } from "./watcher.js";

import { ensureWorkspaceDirectory } from "../../workspace/workspaceFs.js";

import { registerTerminalCommand } from "../terminal/registry.js";

import type { ExtensionContext, IdeExtension } from "../api.js";

/*
 * Main-thread esbuild extension.
 *
 * The compiler reads source files directly from vscode.workspace.fs through
 * compiler.ts. There is no workspace-wide collection pass and no lazy
 * probe loop:
 *
 *   esbuild requests import
 *     → resolver checks the actual mounted workspace filesystem
 *     → onLoad reads only the resolved source file
 *
 * This supports local folders, OPFS workspaces, and the node_modules OPFS
 * overlay through the same filesystem provider used by the editor.
 */

const CONFIG_SECTION = "dataverseIde.esbuild";

type BuildRunOptions = {
  silent?: boolean;
  /** Per-run CLI overrides; never written back to esbuild.config.json. */
  override?: Partial<EsbuildConfig>;
};

function getAutoStartWatchSetting(vscode: typeof vscodeType): boolean {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION, null)
    .get<boolean>("autoStartWatch", false);
}

function normalizeEntryPath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^(?:\.{1,2}\/)+/, "")
    .replace(/^\/+/, "");
}

/**
 * Normalize one or more entry points: forward slashes, no relative prefixes,
 * no duplicates, and no empty values.
 */
function normalizeEntryPaths(entries: string | readonly EntryPoint[]): EntryPoint[] {
  const list = typeof entries === "string" ? [entries] : entries;
  const seen = new Set<string>();
  const normalized: EntryPoint[] = [];

  for (const entry of list) {
    if (typeof entry === "string") {
      const path = normalizeEntryPath(entry);

      if (path.length > 0 && !seen.has(path)) {
        seen.add(path);
        normalized.push(path);
      }

      continue;
    }

    const input = normalizeEntryPath(entry.in);

    if (input.length === 0) {
      continue;
    }

    const output = entry.out == null ? "" : normalizeEntryPath(entry.out);
    const key = output.length > 0 ? `${input}\0${output}` : input;

    if (!seen.has(key)) {
      seen.add(key);
      normalized.push(output.length > 0 ? { in: input, out: output } : input);
    }
  }

  return normalized;
}

function entryPaths(entries: readonly EntryPoint[]): string[] {
  return entries.map((entry) => (typeof entry === "string" ? entry : entry.in));
}

function outDirForConfig(config: EsbuildConfig): string {
  if (config.outfile != null) {
    const normalized = config.outfile.replaceAll("\\", "/");
    const slash = normalized.lastIndexOf("/");

    return slash === -1 ? "" : normalized.slice(0, slash);
  }

  return config.outdir;
}

function outputPathSegments(outputPath: string): string[] {
  return outputPath
    .replaceAll("\\", "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

/*
 * Last content successfully written per output URI. Watch rebuilds commonly
 * produce byte-identical output; remembering it avoids both a disk read and a
 * slow File System Access write on synced folders.
 */
const lastWrittenOutputs = new Map<string, Uint8Array>();

async function writeOutputs(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  outputs: BuildOutputFile[],
): Promise<{
  written: vscodeType.Uri[];
  skipped: number;
  bytes: number;
  elapsedMs: number;
  slow: { path: string; bytes: number; ms: number; ensureMs: number }[];
}> {
  const started = performance.now();
  const written: vscodeType.Uri[] = [];
  const ensuredDirectories = new Set<string>();
  const writtenDestinations = new Set<string>();
  const slow: { path: string; bytes: number; ms: number; ensureMs: number }[] = [];
  let skipped = 0;
  let bytes = 0;

  /*
   * Multi-entry builds emit several files in one pass. Refuse to continue if
   * two different outputs resolve to the same workspace path: one would
   * silently overwrite the other. This is usually a too-specific entryNames
   * template.
   */
  const destinations = new Map<string, string>();

  for (const output of outputs) {
    const segments = outputPathSegments(output.path);

    if (segments.length === 0) {
      continue;
    }

    const relativePath = segments.join("/");
    const existing = destinations.get(relativePath);

    if (existing != null && existing !== output.path) {
      throw new Error(
        `esbuild produced multiple outputs for "${relativePath}" ` +
          `(${existing} and ${output.path}). Adjust entryNames or the entry points.`,
      );
    }

    destinations.set(relativePath, output.path);
  }

  for (const output of outputs) {
    const segments = outputPathSegments(output.path);

    if (segments.length === 0) {
      continue;
    }

    const relativePath = segments.join("/");

    /* esbuild should not repeat a path, but never write the same file twice. */
    if (writtenDestinations.has(relativePath)) {
      continue;
    }

    writtenDestinations.add(relativePath);

    const outFile = vscode.Uri.joinPath(rootUri, ...segments);

    const parent = vscode.Uri.joinPath(rootUri, ...segments.slice(0, -1));

    const encoded = output.contents;

    bytes += encoded.length;

    const key = outFile.toString();
    const previous = lastWrittenOutputs.get(key);

    if (previous != null && bytesEqual(previous, encoded)) {
      /*
       * Verify the file still has the bytes we wrote. Checking existence alone
       * would leave an externally modified output in place.
       */
      try {
        const current = await vscode.workspace.fs.readFile(outFile);

        if (bytesEqual(current, encoded)) {
          skipped += 1;
          continue;
        }
      } catch {
        // Fall through and rewrite it.
      }
    }

    const parentKey = parent.toString();
    const ensureStarted = performance.now();
    let ensureMs = 0;

    if (!ensuredDirectories.has(parentKey)) {
      await ensureWorkspaceDirectory(vscode, parent);
      ensuredDirectories.add(parentKey);
      ensureMs = performance.now() - ensureStarted;
    }

    const fileStarted = performance.now();

    await vscode.workspace.fs.writeFile(outFile, encoded);

    const fileMs = performance.now() - fileStarted;

    if (fileMs >= 250 || ensureMs >= 250) {
      slow.push({
        path: segments.join("/"),
        bytes: encoded.length,
        ms: fileMs,
        ensureMs,
      });
    }

    lastWrittenOutputs.set(key, encoded);

    written.push(outFile);
  }

  return {
    written,
    skipped,
    bytes,
    elapsedMs: performance.now() - started,
    slow,
  };
}

export default {
  id: "esbuild",

  async activate(context: ExtensionContext): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context;

    let currentConfig: EsbuildConfig = ESBUILD_DEFAULT_CONFIG;
    let watcher: EsbuildWatcher | undefined;
    let watchEnabled = false;
    let lastOutputPaths: string[] = [];

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
          title: "esbuild: Build Configured Entries",
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
          command: "dataverseIde.esbuild.configureSolid",
          title: "esbuild: Solid Compiler…",
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
      readme: true,
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
          label: "$(zap) Build configured entries",
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

    let buildActive = false;
    let pendingBuild:
      | {
          entries: EntryPoint[];
          options?: BuildRunOptions;
        }
      | undefined;

    /*
     * Single-flight coordinator. Manual builds, watch-triggered builds and the
     * initial watch build all funnel through here: only one build/write runs at
     * a time, and requests that arrive mid-build collapse into one follow-up
     * build using the latest entry set. Without this, overlapping builds raced
     * to write the same output file through the File System Access API.
     */
    async function runBuild(
      requestedEntries: string | readonly EntryPoint[],
      options?: BuildRunOptions,
    ): Promise<boolean> {
      const entries = normalizeEntryPaths(requestedEntries);

      if (buildActive) {
        outputChannel.appendLine(`[esbuild] build queued: ${entryPaths(entries).join(", ")}`);

        pendingBuild = { entries, options };

        return true;
      }

      buildActive = true;

      try {
        let next:
          | {
              entries: EntryPoint[];
              options?: BuildRunOptions;
            }
          | undefined = { entries, options };

        let result = true;

        while (next != null) {
          pendingBuild = undefined;
          result = await performBuild(next.entries, next.options);
          next = pendingBuild;
        }

        return result;
      } finally {
        buildActive = false;
      }
    }

    async function performBuild(
      requestedEntries: readonly EntryPoint[],
      options?: BuildRunOptions,
    ): Promise<boolean> {
      const started = performance.now();

      const entries = normalizeEntryPaths(requestedEntries);
      const entryLabel = entryPaths(entries).join(", ");

      try {
        if (entries.length === 0) {
          throw new Error(
            "No entry points configured. Add at least one path to entryPoints in esbuild.config.json.",
          );
        }

        const configStarted = performance.now();

        await reloadConfigFromDisk();

        const config =
          options?.override != null
            ? mergeEsbuildOverride(currentConfig, options.override)
            : currentConfig;
        const configMs = performance.now() - configStarted;

        lastStatus = "building";
        lastMessage = `Building ${entryLabel}…`;
        notifyStatus();

        if (options?.silent !== true) {
          outputChannel.show(true);
        }

        outputChannel.appendLine(`[esbuild] Building ${entryLabel}…`);

        const entryStarted = performance.now();

        /*
         * The compiler now reads the workspace itself. Verify every entry
         * early so users receive a useful configuration error rather than
         * a lower-level esbuild resolution error.
         */
        const entryReader = createWorkspaceReader(vscode, context.workspaceRootUri);

        for (const entryPath of entryPaths(entries)) {
          const resolved = await resolveWorkspaceEntry(
            entryReader,
            entryPath,
            config.resolveExtensions,
          );

          if (resolved == null) {
            throw new Error(
              `Entry "${entryPath}" was not found in the workspace. ` +
                "Check the entryPoints setting in esbuild.config.json.",
            );
          }
        }

        const entryMs = performance.now() - entryStarted;

        const compileStarted = performance.now();

        const response = await runner.build({
          entries,
          format: config.format,
          platform: config.platform,
          charset: config.charset,
          globalName: config.globalName,
          minify: config.minify,
          minifyWhitespace: config.minifyWhitespace,
          minifyIdentifiers: config.minifyIdentifiers,
          minifySyntax: config.minifySyntax,
          sourcemap: config.sourcemap,
          sourceRoot: config.sourceRoot,
          sourcesContent: config.sourcesContent,
          target: config.target,
          treeShaking: config.treeShaking,
          ignoreAnnotations: config.ignoreAnnotations,
          keepNames: config.keepNames,
          legalComments: config.legalComments,
          lineLimit: config.lineLimit,
          drop: config.drop,
          dropLabels: config.dropLabels,
          banner: config.banner,
          footer: config.footer,
          pure: config.pure,
          mangleProps: config.mangleProps,
          reserveProps: config.reserveProps,
          jsx: config.jsx,
          jsxFactory: config.jsxFactory,
          jsxFragment: config.jsxFragment,
          jsxImportSource: config.jsxImportSource,
          jsxDev: config.jsxDev,
          jsxSideEffects: config.jsxSideEffects,
          supported: config.supported,
          bundle: config.bundle,
          splitting: config.splitting,
          external: config.external,
          alias: config.alias,
          define: config.define,
          loader: config.loader,
          inject: config.inject,
          tsconfig: config.tsconfig,
          tsconfigRaw: config.tsconfigRaw,
          conditions: config.conditions,
          mainFields: config.mainFields,
          resolveExtensions: config.resolveExtensions,
          nodePaths: config.nodePaths,
          packages: config.packages,
          outdir: config.outdir,
          outfile: config.outfile,
          outbase: config.outbase,
          entryNames: config.entryNames,
          chunkNames: config.chunkNames,
          assetNames: config.assetNames,
          publicPath: config.publicPath,
          outExtension: config.outExtension,
          allowOverwrite: config.allowOverwrite,
          solid: config.solid,
        });

        const compileMs = performance.now() - compileStarted;

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

        /*
         * If another change arrived while compiling, this output is already
         * stale. Skip the (potentially slow) write and let the queued build
         * write the final result instead.
         */
        if (options?.silent === true && pendingBuild != null) {
          outputChannel.appendLine("[esbuild] write skipped: a newer build is queued.");

          return true;
        }

        if (config.allowOverwrite !== true) {
          const inputs = new Set(response.dependencies);
          const overwritten = response.outputs.find((output) => inputs.has(output.path));

          if (overwritten != null) {
            throw new Error(
              `Refusing to overwrite input file "${overwritten.path}". ` +
                "Set allowOverwrite to true if this is intentional.",
            );
          }
        }

        const writeStarted = performance.now();

        const writeResult = await writeOutputs(vscode, context.workspaceRootUri, response.outputs);

        lastOutputPaths = response.outputs.map((output) => output.path);

        const writeMs = performance.now() - writeStarted;

        const elapsed = Math.round(performance.now() - started);

        const writtenLabel =
          writeResult.written.length > 0
            ? writeResult.written
                .map((uri) => vscode.workspace.asRelativePath(uri, false))
                .join(", ")
            : `${writeResult.skipped} unchanged file(s)`;

        const summary = `Built ${entryLabel} in ${elapsed}ms → ${writtenLabel}`;

        outputChannel.appendLine(`[esbuild] ${summary}`);
        outputChannel.appendLine(
          `[esbuild] stages: config ${Math.round(configMs)}ms, entries ${Math.round(entryMs)}ms, ` +
            `compile ${Math.round(compileMs)}ms, write ${Math.round(writeMs)}ms ` +
            `(${writeResult.written.length} written, ${writeResult.skipped} unchanged, ` +
            `${writeResult.bytes} bytes)`,
        );

        if (writeResult.slow.length > 0) {
          outputChannel.appendLine(
            `[esbuild] slow writes: ${writeResult.slow
              .map(
                (file) =>
                  `${file.path} ${file.bytes}b ` +
                  `(${Math.round(file.ensureMs)}ms ensure, ${Math.round(file.ms)}ms write)`,
              )
              .join(", ")}`,
          );
        }

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
        outDir: () => outDirForConfig(currentConfig),
        outputPaths: () => lastOutputPaths,
        entries: () => currentConfig.entryPoints,
        configPath: () => configRelativePathFor(vscode, context.workspaceRootUri),
        buildOnChange: true,
        watchFileSystem: true,
        getDependencies: () => runner.dependencies,
        build: async (entries) => {
          await runBuild(entries, {
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
        void runBuild(currentConfig.entryPoints, {
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

        await runBuild([entryPath]);
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

        await runBuild(config.entryPoints);
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

        await runBuild([picked]);
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

    const outputChannelCommand = vscode.commands.registerCommand(
      "dataverseIde.esbuild.showOutput",
      () => {
        outputChannel.show(true);
      },
    );

    const configureSolidCommand = vscode.commands.registerCommand(
      "dataverseIde.esbuild.configureSolid",
      async () => {
        const modes: {
          value: EsbuildConfig["solid"];
          label: string;
          description: string;
        }[] = [
          {
            value: "off",
            label: "off",
            description: "leave JSX/TSX to esbuild's configured JSX mode",
          },
          {
            value: "v1",
            label: "v1",
            description: "compile with babel-preset-solid (Solid 1.x)",
          },
          {
            value: "v2",
            label: "v2",
            description: "compile with @solidjs/babel-plugin (Solid 2.x)",
          },
        ];

        const picked = await vscode.window.showQuickPick(modes, {
          title: "esbuild: Solid JSX compiler",
          placeHolder: `Current: ${currentConfig.solid}`,
        });

        if (picked == null || picked.value === currentConfig.solid) {
          return;
        }

        const merged = await updateEsbuildConfig(vscode, context.workspaceRootUri, {
          solid: picked.value,
        });

        currentConfig = merged;

        await vscode.window.showInformationMessage(
          `esbuild: solid set to "${picked.value}" in esbuild.config.json.`,
        );
      },
    );

    const reloadConfigCommand = vscode.commands.registerCommand(
      "dataverseIde.esbuild.reloadConfig",
      async () => {
        await reloadConfigFromDisk();

        await vscode.window.showInformationMessage("esbuild configuration reloaded.");
      },
    );

    const ESBUILD_TERMINAL_HELP = `usage: esbuild [command] [entry...] [options]

Commands:
  esbuild [entry...]      build entries together (defaults to esbuild.config.json)
  esbuild build [entry...] same, with esbuild-style flags
  esbuild workspace       pick a workspace entry point
  esbuild watch           start watch mode
  esbuild stop            stop watch mode
  esbuild config          open esbuild.config.json
  esbuild output          show the esbuild output channel
  esbuild readme          open the esbuild README in the Extensions view

Supported esbuild flags (https://esbuild.github.io/api/):
  --bundle / --no-bundle        --minify / --no-minify
  --minify-whitespace           --minify-identifiers
  --minify-syntax               --ignore-annotations
  --sourcemap[=inline|external|both|linked]
  --sources-content / --no-sources-content
  --format=esm|iife|cjs         --platform=browser|node|neutral
  --target=...                  --charset=ascii|utf8
  --global-name=...             --legal-comments=...
  --line-limit=N                --source-root=...
  --tree-shaking / --no-tree-shaking
  --keep-names                  --splitting / --no-splitting
  --jsx=transform|preserve|automatic
  --jsx-factory=...             --jsx-fragment=...
  --jsx-import-source=...       --jsx-dev / --no-jsx-dev
  --jsx-side-effects / --no-jsx-side-effects
  --outfile=...                 --outdir=... --outbase=...
  --entry-names=...             --chunk-names=...
  --asset-names=...             --public-path=...
  --out-extension:.js=.mjs      --define:KEY=VALUE
  --external:PACKAGE            --pure:EXPRESSION
  --alias:PACKAGE=TARGET        --inject:FILE
  --drop:console|debugger       --drop-labels=LABEL,...
  --loader:.ext=LOADER          --supported:FEATURE=true|false
  --conditions=A,B              --main-fields=A,B
  --resolve-extensions=A,B      --node-paths=DIR
  --packages=bundle|external    --tsconfig=FILE
  --mangle-props=REGEX          --reserve-props=REGEX
  --banner:js=...               --banner:css=...
  --footer:js=...               --footer:css=...
`;

    const terminalCommand = registerTerminalCommand({
      name: "esbuild",
      description: "Build workspace entries with esbuild.",
      async execute(args) {
        const [first] = args;

        try {
          if (first === "help" || first === "--help" || first === "-h") {
            return { stdout: ESBUILD_TERMINAL_HELP, stderr: "", exitCode: 0 };
          }

          if (first === "watch" || first === "start") {
            await setWatchEnabled(true);

            return { stdout: "esbuild: watching.\n", stderr: "", exitCode: 0 };
          }

          if (first === "stop") {
            await setWatchEnabled(false);

            return { stdout: "esbuild: watch stopped.\n", stderr: "", exitCode: 0 };
          }

          if (first === "config") {
            await vscode.commands.executeCommand("dataverseIde.esbuild.openConfig");

            return { stdout: "", stderr: "", exitCode: 0 };
          }

          if (first === "readme" || first === "guide") {
            await openExtensionReadme(vscode, context.fullId);

            return { stdout: "", stderr: "", exitCode: 0 };
          }

          if (first === "output") {
            await vscode.commands.executeCommand("dataverseIde.esbuild.showOutput");

            return { stdout: "", stderr: "", exitCode: 0 };
          }

          if (first === "workspace") {
            await vscode.commands.executeCommand("dataverseIde.esbuild.buildWorkspace");

            return { stdout: "", stderr: "", exitCode: 0 };
          }

          const buildArgs = first === "build" ? args.slice(1) : args;
          const parsed = parseEsbuildCliArgs(buildArgs);

          if (parsed.error != null) {
            return { stdout: "", stderr: `esbuild: ${parsed.error}\n`, exitCode: 2 };
          }

          if (parsed.help) {
            return { stdout: ESBUILD_TERMINAL_HELP, stderr: "", exitCode: 0 };
          }

          const { config } = await readEsbuildConfig(vscode, context.workspaceRootUri);
          const entries = normalizeEntryPaths(
            parsed.entries.length > 0 ? parsed.entries : config.entryPoints,
          );

          if (entries.length === 0) {
            return {
              stdout: "",
              stderr: "esbuild: no entry points configured\n",
              exitCode: 1,
            };
          }

          if (await runBuild(entries, { override: parsed.override })) {
            return { stdout: `Built ${entries.join(", ")}.\n`, stderr: "", exitCode: 0 };
          }

          return {
            stdout: "",
            stderr: "esbuild: build failed (see the esbuild output channel)\n",
            exitCode: 1,
          };
        } catch (error) {
          return {
            stdout: "",
            stderr: `esbuild: ${error instanceof Error ? error.message : String(error)}\n`,
            exitCode: 1,
          };
        }
      },
    });

    outputChannel.appendLine("[esbuild] commands registered.");

    return {
      dispose() {
        pendingBuild = undefined;
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
        configureSolidCommand.dispose();
        outputChannelCommand.dispose();
        reloadConfigCommand.dispose();
        terminalCommand.dispose();

        runner.dispose();
      },
    };
  },
} satisfies IdeExtension;
