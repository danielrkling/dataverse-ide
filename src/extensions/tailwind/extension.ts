import type * as vscodeType from "vscode";

import { compileTailwindCss } from "./compiler.js";

import { EsbuildBuildRunner } from "../esbuild/buildRunner.js";

import { registerConfigIntellisense } from "./configIntellisense.js";

import {
  configFilePath,
  configRelativePathFor,
  readTailwindConfig,
  updateTailwindConfig,
  type TailwindConfig,
  TAILWIND_DEFAULT_CONFIG,
} from "./config.js";

import {
  generateCandidates,
  generateVariantCandidates,
  getTailwindHoverInfo,
} from "./theme.js";

import { contributeCommandManifest } from "../api.js";

import { EsbuildWatcher } from "../esbuild/watcher.js";

import { createWatchStatus } from "../watchStatus.js";

import type { ExtensionContext, IdeExtension } from "../api.js";

/*
 * Tailwind extension:
 *
 * - IntelliSense from Tailwind v4 default-theme data
 * - workspace CSS compilation via Tailwind compile()
 * - @plugin/@config module loading through the main-thread esbuild compiler
 * - watch mode through the shared EsbuildWatcher
 */

const COMPLETION_TRIGGER_CHARACTERS = ['"', "'", " ", "-", ":", "/"];

const SUPPORTED_LANGUAGES = [
  "html",
  "php",
  "css",
  "scss",
  "less",
  "javascript",
  "typescript",
  "javascriptreact",
  "typescriptreact",
  "vue",
  "svelte",
];

const CLASS_CONTEXT_REGEX = /[^\s"'`<>;={}]*$/;

const CONFIG_SECTION = "dataverseIde.tailwind";
const AUTO_START_WATCH_KEY = "autoStartWatch";

/*
 * Detect an incomplete class/className string before the cursor.
 */
function isInsideClassStringContext(
  document: vscodeType.TextDocument,
  position: vscodeType.Position,
): boolean {
  const lineText = document.lineAt(position).text;
  const prefix = lineText.slice(0, position.character);

  const openingMatch = /(?:\bclass(?:Name)?\s*=\s*)(["'`])([^"'`\\]*)$/.exec(
    prefix,
  );

  if (openingMatch == null) {
    return false;
  }

  const quoteCharacter = openingMatch[1];
  const suffix = lineText.slice(position.character);

  /*
   * A closing quote already exists somewhere after the cursor. This still
   * means the cursor is inside the attribute value, so it is valid.
   */
  void suffix.indexOf(quoteCharacter);

  return true;
}

function computeReplacementRange(
  vscode: typeof vscodeType,
  document: vscodeType.TextDocument,
  position: vscodeType.Position,
): vscodeType.Range {
  const lineText = document.lineAt(position).text;
  const linePrefix = lineText.slice(0, position.character);

  const match = CLASS_CONTEXT_REGEX.exec(linePrefix);

  const startCharacter = position.character - (match?.[0].length ?? 0);

  return new vscode.Range(
    new vscode.Position(position.line, startCharacter),
    position,
  );
}

function getAutoStartWatchSetting(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): boolean {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION, rootUri)
    .get<boolean>(AUTO_START_WATCH_KEY, false);
}

export default {
  id: "tailwind",

  async activate(context: ExtensionContext): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context;

    /*
     * Main-thread esbuild compiler. It reads @plugin modules directly through
     * the mounted workspace filesystem, including the node_modules overlay.
     */
    const pluginRunner = new EsbuildBuildRunner(
      vscode,
      context.workspaceRootUri,
      outputChannel,
    );

    const candidateData = generateCandidates();

    const candidateItems: vscodeType.CompletionItem[] = candidateData.map(
      (candidate) => {
        const item = new vscode.CompletionItem(
          candidate.className,
          vscode.CompletionItemKind.EnumMember,
        );

        item.detail = `Tailwind v4 · ${candidate.className}`;

        if (candidate.documentation != null) {
          item.documentation = new vscode.MarkdownString(
            `\`${candidate.className}\`\n\n\`${candidate.documentation}\``,
          );
        }

        item.sortText = `0${candidate.className}`;

        return item;
      },
    );

    const variants = generateVariantCandidates().map((variant) => {
      const item = new vscode.CompletionItem(
        variant.prefix,
        vscode.CompletionItemKind.Keyword,
      );

      item.detail = "Tailwind v4 variant";

      item.command = {
        command: "editor.action.triggerSuggest",
        title: "Suggest Tailwind utilities",
      };

      item.sortText = "1";

      return item;
    });

    outputChannel.appendLine(
      `[tailwind] ${candidateData.length} utility candidates from default theme.`,
    );

    const completionProviderDisposable =
      vscode.languages.registerCompletionItemProvider(
        SUPPORTED_LANGUAGES,
        {
          provideCompletionItems(document, position) {
            if (!isInsideClassStringContext(document, position)) {
              return undefined;
            }

            const wordRange = computeReplacementRange(vscode, document, position);
            const word = document.getText(wordRange);

            const alreadyHasVariant = word.includes(":");

            const items: vscodeType.CompletionItem[] = [
              ...candidateItems,
            ];

            if (!alreadyHasVariant) {
              items.push(...variants);
            }

            return new vscode.CompletionList(items, false);
          },
        },
        ...COMPLETION_TRIGGER_CHARACTERS,
      );

    const hoverProviderDisposable = vscode.languages.registerHoverProvider(
      SUPPORTED_LANGUAGES,
      {
        provideHover(document, position) {
          const wordRange = document.getWordRangeAtPosition(
            position,
            /[A-Za-z0-9_:./[\]<>()%#-]+/,
          );

          if (wordRange == null) {
            return undefined;
          }

          const className = document.getText(wordRange);
          const markdown = getTailwindHoverInfo(className);

          if (markdown == null) {
            return undefined;
          }

          return new vscode.Hover(
            new vscode.MarkdownString(`**${className}**\n\n${markdown}`),
            wordRange,
          );
        },
      },
    );

    outputChannel.appendLine("[tailwind] providers registered.");

    await contributeCommandManifest({
      id: "tailwind",
      displayName: "Dataverse IDE Tailwind",
      description: "Tailwind v4 IntelliSense and workspace CSS compilation.",
      commands: [
        {
          command: "dataverseIde.tailwind.compileCss",
          title: "Tailwind: Compile CSS From Workspace",
        },
        {
          command: "dataverseIde.tailwind.startWatch",
          title: "Tailwind: Start Watch",
        },
        {
          command: "dataverseIde.tailwind.stopWatch",
          title: "Tailwind: Stop Watch",
        },
        {
          command: "dataverseIde.tailwind.toggleWatch",
          title: "Tailwind: Toggle Watch",
        },
        {
          command: "dataverseIde.tailwind.openConfig",
          title: "Tailwind: Open tailwind.config.json",
        },
        {
          command: "dataverseIde.tailwind.showOutput",
          title: "Tailwind: Show Output",
        },
      ],
      configuration: {
        title: "Dataverse IDE Tailwind",
        properties: {
          "dataverseIde.tailwind.configPath": {
            type: "string",
            default: "tailwind.config.json",
            scope: "window",
            description:
              "Workspace-relative path of the Tailwind CSS build settings file. Example: config/tailwind.config.json.",
          },

          "dataverseIde.tailwind.autoStartWatch": {
            type: "boolean",
            default: false,
            markdownDescription:
              "Start Tailwind watch automatically when the workspace opens.",
          },
        },
      },
    });

    let currentConfig: TailwindConfig = TAILWIND_DEFAULT_CONFIG;
    let watcher: EsbuildWatcher | undefined;
    let watchEnabled = false;

    let lastStatus: "idle" | "building" | "ok" | "error" = "idle";
    let lastMessage = "No compile run yet.";

    /*
     * Signature from the most recent successful compile. It includes CSS
     * input, bundled plugin text, and workspace candidate classes.
     */
    let lastSignature: string | undefined;

    const watchStatus = createWatchStatus(vscode, {
      id: "tailwind",
      label: "tailwind",
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
      openConfig: () => {
        void vscode.commands.executeCommand("dataverseIde.tailwind.openConfig");
      },
      showOutput: () => {
        void vscode.commands.executeCommand("dataverseIde.tailwind.showOutput");
      },
      extraItems: () => [
        {
          label: "$(zap) Compile CSS",
          run: () => {
            void vscode.commands.executeCommand(
              "dataverseIde.tailwind.compileCss",
            );
          },
        },
      ],
    });

    const diagnostics = vscode.languages.createDiagnosticCollection("tailwind");

    const configIntellisenseDisposable = registerConfigIntellisense(vscode, {
      getConfigPath: () =>
        configRelativePathFor(vscode, context.workspaceRootUri),
    });

    function firstLine(text: string): string {
      return text.split("\n", 1)[0] ?? text;
    }

    function notifyStatus(): void {
      watchStatus.update();
    }

    async function reloadConfigFromDisk(): Promise<void> {
      const loaded = await readTailwindConfig(
        vscode,
        context.workspaceRootUri,
      );

      currentConfig = loaded.config;

      notifyStatus();
    }

    async function runCompile(
      options?: {
        silent?: boolean;
      },
    ): Promise<boolean> {
      const started = Date.now();

      try {
        await reloadConfigFromDisk();

        lastStatus = "building";
        lastMessage = `Compiling ${currentConfig.output}…`;
        notifyStatus();

        if (options?.silent !== true) {
          outputChannel.show(true);
        }

        outputChannel.appendLine(
          `[tailwind] Compiling ${currentConfig.input || 'default input (@import "tailwindcss")'
          }…`,
        );

        const result = await compileTailwindCss(
          vscode,
          context.workspaceRootUri,
          {
            input: currentConfig.input,
            pluginRunner,
            minify: currentConfig.minify,
            outputChannel,
          },
        );

        if (result.signature === lastSignature) {
          const elapsed = Date.now() - started;

          const summary =
            `Up to date: ${currentConfig.output} · ` +
            `${result.candidateCount} candidates · ${elapsed}ms`;

          outputChannel.appendLine(`[tailwind] ${summary}`);

          lastStatus = "ok";
          lastMessage = summary;
          notifyStatus();

          return true;
        }

        const outputParts = currentConfig.output
          .replaceAll("\\", "/")
          .split("/")
          .filter((part) => part.length > 0);

        const outputUri = vscode.Uri.joinPath(
          context.workspaceRootUri,
          ...outputParts,
        );

        const parentParts = outputParts.slice(0, -1);

        await vscode.workspace.fs.createDirectory(
          parentParts.length > 0
            ? vscode.Uri.joinPath(context.workspaceRootUri, ...parentParts)
            : context.workspaceRootUri,
        );

        await vscode.workspace.fs.writeFile(
          outputUri,
          new TextEncoder().encode(result.css),
        );

        lastSignature = result.signature;
        diagnostics.clear();

        const elapsed = Date.now() - started;

        const summary =
          `Compiled ${result.candidateCount} candidates in ${elapsed}ms → ` +
          `${vscode.workspace.asRelativePath(outputUri, false)} ` +
          `(${result.css.length} bytes)`;

        outputChannel.appendLine(`[tailwind] ${summary}`);

        if (options?.silent !== true) {
          outputChannel.show(true);
        }

        lastStatus = "ok";
        lastMessage = summary;
        notifyStatus();

        return true;
      } catch (error) {
        console.error("[tailwind] compile error:", error);

        const message = error instanceof Error ? error.message : String(error);

        outputChannel.appendLine(`[tailwind] ${firstLine(message)}`);
        outputChannel.show(true);

        if (currentConfig.input.trim().length > 0) {
          const inputUri = vscode.Uri.joinPath(
            context.workspaceRootUri,
            ...currentConfig.input
              .replaceAll("\\", "/")
              .split("/")
              .filter((part) => part.length > 0),
          );

          diagnostics.set(inputUri, [
            new vscode.Diagnostic(
              new vscode.Range(0, 0, 0, 1),
              message,
              vscode.DiagnosticSeverity.Error,
            ),
          ]);
        }

        lastStatus = "error";
        lastMessage = firstLine(message);
        notifyStatus();

        if (options?.silent !== true) {
          await vscode.window.showErrorMessage(
            `[tailwind] Compile failed: ${message}`,
          );
        }

        return false;
      }
    }

    const compileCommand = vscode.commands.registerCommand(
      "dataverseIde.tailwind.compileCss",
      async () => {
        await runCompile();
      },
    );

    function ensureWatcher(): EsbuildWatcher {
      if (watcher != null) {
        return watcher;
      }

      watcher = new EsbuildWatcher(vscode, context.workspaceRootUri, {
        configPath: () =>
          configRelativePathFor(vscode, context.workspaceRootUri),

        outDir: () => {
          const output = currentConfig.output.replaceAll("\\", "/");
          const slashIndex = output.lastIndexOf("/");

          return slashIndex === -1 ? "" : output.slice(0, slashIndex);
        },

        entry: () => currentConfig.input,

        build: async () => {
          await runCompile({
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
         * Generate initial CSS output immediately rather than waiting for
         * an editor save.
         */
        void runCompile({
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

    setWatchRuntimeEnabled(
      getAutoStartWatchSetting(vscode, context.workspaceRootUri),
    );

    const watchSettingListener = vscode.workspace.onDidChangeConfiguration(
      (event) => {
        if (
          event.affectsConfiguration(
            `${CONFIG_SECTION}.${AUTO_START_WATCH_KEY}`,
            context.workspaceRootUri,
          )
        ) {
          setWatchRuntimeEnabled(
            getAutoStartWatchSetting(vscode, context.workspaceRootUri),
          );
        }
      },
    );

    const startWatchCommand = vscode.commands.registerCommand(
      "dataverseIde.tailwind.startWatch",
      () => setWatchEnabled(true),
    );

    const stopWatchCommand = vscode.commands.registerCommand(
      "dataverseIde.tailwind.stopWatch",
      () => setWatchEnabled(false),
    );

    const toggleWatchCommand = vscode.commands.registerCommand(
      "dataverseIde.tailwind.toggleWatch",
      () => setWatchEnabled(!watchEnabled),
    );

    const openConfigCommand = vscode.commands.registerCommand(
      "dataverseIde.tailwind.openConfig",
      async () => {
        const uri = configFilePath(vscode, context.workspaceRootUri);

        try {
          await vscode.workspace.fs.stat(uri);
        } catch {
          await updateTailwindConfig(
            vscode,
            context.workspaceRootUri,
            {
              /*
               * The runtime default is blank, but a newly scaffolded config should
               * point users toward the conventional editable stylesheet.
               */
              input: "src/tailwind.css",
            },
          );
        }

        await vscode.window.showTextDocument(uri);
      },
    );

    const showOutputCommand = vscode.commands.registerCommand(
      "dataverseIde.tailwind.showOutput",
      () => {
        outputChannel.show(true);
      },
    );

    await reloadConfigFromDisk();

    outputChannel.appendLine("[tailwind] commands registered.");

    return {
      dispose() {
        watcher?.dispose();
        watchStatus.dispose();
        pluginRunner.dispose();
        watchSettingListener.dispose();
        diagnostics.dispose();
        configIntellisenseDisposable.dispose();

        compileCommand.dispose();
        startWatchCommand.dispose();
        stopWatchCommand.dispose();
        toggleWatchCommand.dispose();
        openConfigCommand.dispose();
        showOutputCommand.dispose();

        completionProviderDisposable.dispose();
        hoverProviderDisposable.dispose();
      },
    };
  },
} satisfies IdeExtension;