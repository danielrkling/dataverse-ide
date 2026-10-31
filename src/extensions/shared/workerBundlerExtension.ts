import type * as vscodeType from "vscode";

import { contributeCommandManifest } from "../api.js";

import { createWatchStatus } from "../watchStatus.js";

import { EsbuildWatcher } from "../esbuild/watcher.js";

import { lazyBuild } from "../esbuild/lazyBuild.js";

import { describeWorkerError } from "./workerError.js";
import { parseJsonSafe } from "./packageResolver.js";

import type { BuildRequestInput, BuildRunnerResponse } from "../esbuild/buildRunner.js";

import type { ExtensionContext, IdeExtension } from "../api.js";

import { createModuleWorker } from "../../util/moduleWorker.js";

/*
 * Shared worker-bundler extension workflow (currently rolldown).
 *
 * The constructor takes the worker entry, config-file reader/writer, and
 * command/config namespace. The rollup extension runs on the main thread
 * and does not use this factory.
 *
 * Everything that differs between worker bundlers is injected through
 * WorkerBundlerExtensionOptions:
 *
 *   - the worker entry URL (each bundler runs in its own dedicated worker)
 *   - the config file reader/writer
 *   - the command/config namespace and log labels
 *
 * The worker protocol is shared:
 *   { id, type: 'transform' | 'minify', filename, source } -> { id, ok, result: string }
 *   { id, type: 'bundle', ...BundleCoreRequest }            -> { id, ok, result: BundleCoreResponse }
 */

/** One-off transform/minify output directory; workspace builds use the config outdir. */
const OUTPUT_DIRECTORY = "dist";

const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|css|json)$/i;

const MAX_COLLECTED_FILES = 8000;

const MAX_COLLECTED_PACKAGE_MANIFESTS = 5000;

const EXCLUDE_PATTERN = "{**/.git/**,**/.ide-build/**,**/dist/**,**/out/**,**/node_modules/**}";

/** The config keys shared by both bundlers. */
export type WorkerBundlerConfig = {
  entryPoints: string[];
  outdir: string;
  format: "esm" | "iife" | "cjs" | "umd";
  minify: boolean;
  sourcemap: boolean;
  external: string[];
  define: Record<string, string>;
  solid: "auto" | "v2" | "off";
};

export type WorkerBundlerConfigIO = {
  /** Defaults used when the config file is absent. */
  defaults: WorkerBundlerConfig;

  read: (
    vscode: typeof vscodeType,
    rootUri: vscodeType.Uri,
  ) => Promise<{ text: string | null; config: WorkerBundlerConfig }>;

  update: (
    vscode: typeof vscodeType,
    rootUri: vscodeType.Uri,
    updates: Partial<WorkerBundlerConfig>,
  ) => Promise<WorkerBundlerConfig>;

  /** Absolute URI of the config file. */
  filePath: (vscode: typeof vscodeType, rootUri: vscodeType.Uri) => vscodeType.Uri;

  /** Workspace-relative config path (watch echo guard). */
  relativePath: (vscode: typeof vscodeType, rootUri: vscodeType.Uri) => string;
};

export type WorkerBundlerExtensionOptions = {
  /** Extension id and command/config namespace, e.g. "rollup". */
  id: string;

  /** Short label used in logs and status items, e.g. "rollup". */
  label: string;

  displayName: string;
  description: string;

  /** Config file name shown in diagnostics, e.g. "rollup.config.json". */
  configFileName: string;

  /** Vite worker URL (`import workerUrl from "./worker.ts?worker&url"`). */
  workerUrl: string;

  config: WorkerBundlerConfigIO;
};

/** Bundle output shape shared by the rolldown and rollup workers. */
type BundleOutputFile = {
  path: string;
  text: string;
};

type Response =
  | {
      id: number;
      ok: true;
      result: string | BuildRunnerResponse;
    }
  | { id: number; ok: false; error: string };

/** Guard for worker responses (transform/minify results or bundle responses). */
function isResponse(value: unknown): value is Response {
  return typeof value === "object" && value != null && "ok" in value && "id" in value;
}

class WorkerBundlerRunner {
  private worker: Worker | undefined;

  /**
   * Resolved when the worker signals boot completion ({ type: 'ready' }) or
   * rejected when the worker errors before signalling - wasm/glue failures
   * happen at module scope, before any request could be answered.
   */
  private workerReady: Promise<void> | undefined;

  private nextRequestId = 1;

  constructor(
    private readonly outputChannel: vscodeType.OutputChannel,
    private readonly workerUrl: string,
    private readonly label: string,
  ) {}

  private async ensureWorker(): Promise<Worker> {
    if (this.worker == null) {
      this.worker = createModuleWorker(this.workerUrl, {
        name: `dataverse-ide-${this.label}`,
      });

      this.workerReady = new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          reject(
            new Error(`[${this.label}] worker did not signal ready within 60s (boot stalled).`),
          );
        }, 60000);

        const onWorkerBoot = (event: MessageEvent) => {
          const data = event.data as { type?: string; where?: string; error?: string } | null;

          if (data?.type === "ready") {
            window.clearTimeout(timeout);
            this.worker?.removeEventListener("message", onWorkerBoot);
            resolve();
          } else if (data?.type === "boot-error") {
            /*
             * The worker caught its own init failure (glue wasm fetch,
             * module-graph crash) and reported it with a real message.
             */
            window.clearTimeout(timeout);
            this.worker?.removeEventListener("message", onWorkerBoot);

            const detail = data.error ?? "(no detail)";
            this.outputChannel.appendLine(
              `[${this.label}] boot error in ${data.where ?? "worker"}: ${detail}`,
            );

            reject(new Error(detail));
          }
        };

        this.worker!.addEventListener("message", onWorkerBoot);

        this.worker!.onerror = (event) => {
          window.clearTimeout(timeout);
          this.worker?.removeEventListener("message", onWorkerBoot);

          this.outputChannel.appendLine(
            `[${this.label}] worker error: ${describeWorkerError(event)}`,
          );

          reject(new Error(`[${this.label}] worker failed to boot: ${describeWorkerError(event)}`));
        };
      });

      this.worker.onmessageerror = (event) => {
        this.outputChannel.appendLine(
          `[${this.label}] worker message error: ${JSON.stringify(event.data ?? null).slice(0, 400)}`,
        );
      };

      /*
       * Thread workers (wasi pthreads) post machinery messages WITHOUT a
       * request id - notably wasi-worker's onError payload. Log every
       * unaddressed message so nested-worker failures reach the output
       * channel.
       */
      this.worker.addEventListener("message", (event) => {
        const data = event.data as
          | {
              id?: unknown;
              ok?: unknown;
              type?: unknown;
              error?: unknown;
              errorOutputs?: unknown;
              where?: unknown;
            }
          | null
          | undefined;

        if (data == null || typeof data !== "object") {
          return;
        }

        if (data.id != null && data.ok != null) {
          return;
        }

        const type = typeof data.type === "string" ? data.type : "untyped";
        const detail =
          typeof data.error === "string"
            ? data.error
            : data.error instanceof Error
              ? `${data.error.message}\n${data.error.stack ?? ""}`
              : JSON.stringify(data.error ?? null);

        this.outputChannel.appendLine(
          `[${this.label}] worker [${type}]${
            typeof data.where === "string" ? ` (${data.where})` : ""
          }: ${
            detail === "null" || detail.length === 0 ? JSON.stringify(data).slice(0, 400) : detail
          }` +
            (data.errorOutputs != null
              ? ` errorOutputs: ${JSON.stringify(data.errorOutputs).slice(0, 400)}`
              : ""),
        );
      });
    }

    const worker = this.worker;

    await this.workerReady;

    return worker;
  }

  /** Transform/minify: TS/JSX -> JS, or minified output. */
  async run(request: {
    type: "transform" | "minify";
    filename: string;
    source: string;
  }): Promise<string> {
    const worker = await this.ensureWorker();
    const id = this.nextRequestId++;

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        worker.removeEventListener("message", onMessage);
        reject(new Error(`[${this.label}] operation timed out after 120s.`));
      }, 120000);

      const onMessage = (event: MessageEvent) => {
        if (!isResponse(event.data) || event.data.id !== id) {
          return;
        }

        window.clearTimeout(timeout);
        worker.removeEventListener("message", onMessage);

        if (event.data.ok) {
          resolve(event.data.result as string);
        } else {
          reject(new Error(event.data.error));
        }
      };

      worker.addEventListener("message", onMessage);

      worker.postMessage({ id, ...request });
    });
  }

  /** Full bundling through the worker (probe rounds via lazyBuild). */
  async build(input: BuildRequestInput): Promise<BuildRunnerResponse | undefined> {
    const worker = await this.ensureWorker();
    const id = this.nextRequestId++;

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        worker.removeEventListener("message", onMessage);
        reject(new Error(`[${this.label}] bundle request timed out after 120s.`));
      }, 120000);

      const onMessage = (event: MessageEvent) => {
        if (!isResponse(event.data) || event.data.id !== id) {
          return;
        }

        window.clearTimeout(timeout);
        worker.removeEventListener("message", onMessage);

        if (!event.data.ok) {
          resolve({
            ok: false,
            error: event.data.error,
          });

          return;
        }

        const result = event.data.result as BuildRunnerResponse;

        resolve(result);
      };

      worker.addEventListener("message", onMessage);

      worker.postMessage({ id, type: "bundle", ...input });
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
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

/*
 * Workspace collection: workspace sources plus node_modules package.json
 * manifests; the worker's resolver requests individual package files
 * through lazy probe rounds.
 */
async function collectWorkspaceSources(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  label: string,
): Promise<{ files: Record<string, string> }> {
  const rootPath = rootUri.path.replace(/\/+$/, "");

  const sourceUris = await vscode.workspace.findFiles("**/*", EXCLUDE_PATTERN, MAX_COLLECTED_FILES);

  const nodeModulesManifestUris = await vscode.workspace.findFiles(
    "node_modules/**/package.json",
    "{**/.git/**}",
    MAX_COLLECTED_PACKAGE_MANIFESTS,
  );

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

    relativePath = relativePath.replaceAll("\\", "/");

    /*
     * Keep only text-readable files; binary assets inside node_modules
     * cannot be consumed through the in-memory map anyway.
     */
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);

      files[relativePath] = new TextDecoder().decode(bytes);
    } catch {
      console.warn(`[${label}] skipping unreadable file:`, relativePath);
    }
  }

  return { files };
}

export function createWorkerBundlerExtension(options: WorkerBundlerExtensionOptions): IdeExtension {
  const { id, label, config: configIO } = options;
  const configSection = `dataverseIde.${id}`;

  return {
    id,

    async activate(context: ExtensionContext): Promise<vscodeType.Disposable | void> {
      const { vscode, outputChannel } = context;

      async function reloadConfigFromDisk(): Promise<void> {
        const loaded = await configIO.read(vscode, context.workspaceRootUri);

        currentConfig = loaded.config;

        notifyStatus();
      }

      await contributeCommandManifest({
        id,
        displayName: options.displayName,
        description: options.description,
        commands: [
          {
            command: `dataverseIde.${id}.transform`,
            title: `${label}: Transform Current File (TS/JSX → JS)`,
          },
          {
            command: `dataverseIde.${id}.minify`,
            title: `${label}: Minify Current File`,
          },
          {
            command: `dataverseIde.${id}.build`,
            title: `${label}: Build Current File`,
          },
          {
            command: `dataverseIde.${id}.buildWorkspace`,
            title: `${label}: Build Workspace…`,
          },
          {
            command: `dataverseIde.${id}.buildConfigured`,
            title: `${label}: Build Configured Entry`,
          },
          {
            command: `dataverseIde.${id}.startWatch`,
            title: `${label}: Start Watch`,
          },
          {
            command: `dataverseIde.${id}.stopWatch`,
            title: `${label}: Stop Watch`,
          },
          {
            command: `dataverseIde.${id}.toggleWatch`,
            title: `${label}: Toggle Watch`,
          },
          {
            command: `dataverseIde.${id}.openConfig`,
            title: `${label}: Open ${options.configFileName}`,
          },
          {
            command: `dataverseIde.${id}.reloadConfig`,
            title: `${label}: Reload Config`,
          },
          {
            command: `dataverseIde.${id}.showOutput`,
            title: `${label}: Show Output`,
          },
        ],
        configuration: {
          title: label,
          properties: {
            [`dataverseIde.${id}.configPath`]: {
              type: "string",
              default: options.configFileName,
              scope: "window",
              description: `Workspace-relative path of the ${label} build settings file. Example: config/${options.configFileName}.`,
            },

            [`dataverseIde.${id}.autoStartWatch`]: {
              type: "boolean",
              default: false,
              scope: "window",
              description:
                `Automatically start ${label} watch mode on activation. Watch state is runtime-only; ` +
                `changing this setting does not persist to ${options.configFileName}.`,
            },
          },
        },
      });

      const runner = new WorkerBundlerRunner(outputChannel, options.workerUrl, label);

      outputChannel.appendLine(`[${label}] extension activated (wasm bundler).`);

      /*
       * Config-file driven build. All settings come from the bundler's
       * config file; there is no vscode-settings fallback beyond the watch
       * autostart toggle.
       */
      let currentConfig: WorkerBundlerConfig = configIO.defaults;
      let watcher: EsbuildWatcher | undefined;
      let watchEnabled = false;

      let lastStatus: "idle" | "building" | "ok" | "error" = "idle";
      let lastMessage = "No build run yet.";
      let lastFinishedAt: number | undefined;

      const watchStatus = createWatchStatus(vscode, {
        id,
        label,
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
          void vscode.commands.executeCommand(`dataverseIde.${id}.openConfig`);
        },
        extraItems: () => [
          {
            label: "$(zap) Build now (configured)",
            run: () => {
              void vscode.commands.executeCommand(`dataverseIde.${id}.buildConfigured`);
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

      function getAutoStartWatchSetting(): boolean {
        return vscode.workspace
          .getConfiguration(configSection, null)
          .get<boolean>("autoStartWatch", false);
      }

      setWatchRuntimeEnabled(getAutoStartWatchSetting());

      const watchSettingListener = vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration(`dataverseIde.${id}.autoStartWatch`, context.workspaceRootUri)
        ) {
          setWatchEnabled(getAutoStartWatchSetting());
        }
      });

      async function runBuild(
        entryPath: string,
        buildOptions?: { silent?: boolean },
      ): Promise<boolean> {
        const started = Date.now();

        /*
         * Canonicalize the entry the same way the config reader does: the
         * collected files map keys carry no './' prefix and store only
         * forward slashes.
         */
        entryPath = entryPath.replaceAll("\\", "/").replace(/^(?:\.{1,2}\/)+/, "");

        try {
          await reloadConfigFromDisk();

          lastStatus = "building";
          lastMessage = `Building ${entryPath}…`;
          notifyStatus();

          if (buildOptions?.silent !== true) {
            outputChannel.show(true);
          }

          outputChannel.appendLine(`[${label}] Building ${entryPath}…`);

          const { files } = await collectWorkspaceSources(vscode, context.workspaceRootUri, label);

          const collectedNodeModules = Object.keys(files).filter((key) =>
            key.startsWith("node_modules/"),
          ).length;

          outputChannel.appendLine(
            `[${label}] collected ${Object.keys(files).length} files from the workspace ` +
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
                  : ` Check the entry setting in ${options.configFileName}.`),
            );
          }

          /*
           * Solid 2.0 toolchain resolution. "auto" detects a solid-js 2.x
           * install from the collected node_modules manifests; a config key
           * always wins.
           */
          let solidOption: "v2" | "off" = "off";

          if (currentConfig.solid === "v2") {
            solidOption = "v2";
          } else if (currentConfig.solid === "auto") {
            /*
             * The manifest may not be in the collected map when
             * collectPackageManifests is disabled; read this single file
             * directly so auto-detection still works on the first build.
             */
            let solidManifestText = files["node_modules/solid-js/package.json"];

            if (solidManifestText == null) {
              try {
                const manifestUri = vscode.Uri.joinPath(
                  context.workspaceRootUri,
                  "node_modules",
                  "solid-js",
                  "package.json",
                );

                solidManifestText = new TextDecoder().decode(
                  await vscode.workspace.fs.readFile(manifestUri),
                );

                files["node_modules/solid-js/package.json"] = solidManifestText;
              } catch {
                // solid-js is not installed; leave the toolchain off.
              }
            }

            const solidJsManifest = parseJsonSafe(solidManifestText ?? "");

            if (
              solidJsManifest != null &&
              typeof solidJsManifest.version === "string" &&
              solidJsManifest.version.startsWith("2.")
            ) {
              solidOption = "v2";

              outputChannel.appendLine(
                `[${label}] solid-js 2.x detected - compiling workspace .jsx/.tsx ` +
                  "with @solidjs/compiler-wasm32-wasi.",
              );
            }
          }

          const request: BuildRequestInput & {
            files: Record<string, string>;
            solid: "v2" | "off";
          } = {
            entry: entryPath,
            files,
            /*
             * BuildRequestInput's format union is the esbuild one; both
             * workers additionally support 'umd'.
             */
            format: currentConfig.format as BuildRequestInput["format"],
            minify: currentConfig.minify,
            sourcemap: currentConfig.sourcemap,
            external: currentConfig.external,
            define: currentConfig.define,
            solid: solidOption,
          };

          const response = await lazyBuild(
            vscode,
            context.workspaceRootUri,
            {
              build: (lazyRequest) => runner.build(lazyRequest) as never,
            },
            request,
            outputChannel,
            { logPrefix: label },
          );

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

          for (const warning of response.warnings) {
            outputChannel.appendLine(`[${label}] warning: ${warning}`);
          }

          /*
           * npm-package diagnostics (same wording/format as the esbuild
           * extension so downstream tooling can parse both).
           */
          for (const warning of response.warnings) {
            const match = /^Could not resolve npm package ["']([^"'\s]+) imported by .*["']/.exec(
              warning,
            );

            if (match == null) {
              continue;
            }

            const packageName = match[1];
            const packageKey = `node_modules/${packageName}`;

            if (files[`${packageKey}/package.json`] == null) {
              outputChannel.appendLine(
                `[${label}] diagnostic: ${packageKey}/package.json was not collected. ` +
                  "The package is either not installed (npm: Install) or fell outside the node_modules collection cap.",
              );
              continue;
            }

            const collectedForPackage = Object.keys(files).filter((key) =>
              key.startsWith(`${packageKey}/`),
            );

            outputChannel.appendLine(
              `[${label}] diagnostic: ${packageKey} has ${collectedForPackage.length} collected file(s). ` +
                "The resolver rejected the exports map — check the package version/exports field.",
            );
          }

          if ((response.needFiles ?? []).length > 0) {
            const stillMissing = (response.needFiles ?? []).slice(0, 5).join(", ");

            outputChannel.appendLine(
              `[${label}] lazy file resolution exceeded the round cap; still missing: ${stillMissing}`,
            );

            lastStatus = "error";
            lastMessage = `lazy resolution rounds exceeded; still missing ${stillMissing}`;
            lastFinishedAt = Date.now();
            notifyStatus();

            return false;
          }

          if (response.outputs.length === 0) {
            outputChannel.appendLine(`[${label}] produced no output.`);

            lastStatus = "error";
            lastMessage = "Build produced no output.";
            lastFinishedAt = Date.now();
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

          outputChannel.appendLine(`[${label}] ${summary}`);

          if (buildOptions?.silent !== true) {
            outputChannel.show(true);
          }

          lastStatus = "ok";
          lastMessage = summary;
          lastFinishedAt = Date.now();
          notifyStatus();

          return true;
        } catch (error) {
          console.error(`[${label}] build error:`, error);

          const message = error instanceof Error ? error.message : String(error);

          outputChannel.appendLine(`[${label}] ${message}`);
          outputChannel.show(true);

          lastStatus = "error";
          lastMessage = message;
          lastFinishedAt = Date.now();
          notifyStatus();

          if (buildOptions?.silent !== true) {
            await vscode.window.showErrorMessage(`[${label}] Build failed: ${message}`);
          }

          return false;
        }
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
           * Prefer the bundler-provided file name; it preserves dynamic
           * import chunk names. Fall back to the entry base name when an
           * output path is unusable.
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

      const buildCommand = vscode.commands.registerCommand(`dataverseIde.${id}.build`, async () => {
        const activeEditor = vscode.window.activeTextEditor;

        if (activeEditor == null) {
          await vscode.window.showWarningMessage(
            `[${label}] Open a file in the editor to build it.`,
          );

          return;
        }

        if (activeEditor.document.uri.scheme !== "file") {
          await vscode.window.showWarningMessage(`[${label}] Only workspace files can be built.`);

          return;
        }

        await runBuild(vscode.workspace.asRelativePath(activeEditor.document.uri, false));
      });

      const transformCommand = vscode.commands.registerCommand(
        `dataverseIde.${id}.transform`,
        async () => {
          await withCurrentFile("transform");
        },
      );

      const minifyCommand = vscode.commands.registerCommand(
        `dataverseIde.${id}.minify`,
        async () => {
          await withCurrentFile("minify");
        },
      );

      async function withCurrentFile(operation: "transform" | "minify"): Promise<void> {
        const current = await resolveCurrentFile(vscode);

        if (current == null) {
          await vscode.window.showWarningMessage(
            `[${label}] Open a workspace file in the editor first.`,
          );

          return;
        }

        const { document, relativePath } = current;

        try {
          const started = Date.now();

          outputChannel.show(true);
          outputChannel.appendLine(`[${label}] ${operation}: ${relativePath}…`);

          const result = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: `[${label}] ${operation} ${relativePath}…`,
              cancellable: false,
            },
            async () => {
              return runner.run({
                type: operation,
                filename: relativePath,
                source: document.getText(),
              });
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
            `[${label}] ${operation} finished in ${elapsed}ms -> ${vscode.workspace.asRelativePath(outFile, false)}`,
          );

          await vscode.window.showInformationMessage(
            `[${label}] ${operation} finished in ${elapsed}ms.`,
          );
        } catch (error) {
          console.error(`[${label}] operation error:`, error);

          const message = error instanceof Error ? error.message : String(error);

          outputChannel.appendLine(`[${label}] ${message}`);
          outputChannel.show(true);

          await vscode.window.showErrorMessage(`[${label}] ${operation} failed: ${message}`);
        }
      }

      /*
       * Watch lifecycle (shared EsbuildWatcher engine). The watcher reads
       * the live config through callbacks so config edits apply without a
       * restart.
       */
      function ensureWatcher(): EsbuildWatcher {
        if (watcher != null) {
          return watcher;
        }

        watcher = new EsbuildWatcher(vscode, context.workspaceRootUri, {
          outDir: () => currentConfig.outdir,
          entry: () => currentConfig.entryPoints[0],
          configPath: () => configIO.relativePath(vscode, context.workspaceRootUri),
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
         * Watch state is runtime-only; toggles do not touch the config
         * file. Persistence (autostart) is the autoStartWatch setting.
         */
        setWatchRuntimeEnabled(enabled);
      }

      const startWatchCommand = vscode.commands.registerCommand(
        `dataverseIde.${id}.startWatch`,
        () => setWatchEnabled(true),
      );

      const stopWatchCommand = vscode.commands.registerCommand(`dataverseIde.${id}.stopWatch`, () =>
        setWatchEnabled(false),
      );

      const toggleWatchCommand = vscode.commands.registerCommand(
        `dataverseIde.${id}.toggleWatch`,
        () => setWatchEnabled(!watchEnabled),
      );

      const buildConfiguredEntryCommand = vscode.commands.registerCommand(
        `dataverseIde.${id}.buildConfigured`,
        async () => {
          const { config } = await configIO.read(vscode, context.workspaceRootUri);

          currentConfig = config;

          await runBuild(config.entryPoints[0]);
        },
      );

      /*
       * Remembers the last 'Build Workspace…' pick for this activation.
       */
      let lastWorkspaceEntry: string | undefined;

      const buildWorkspaceCommand = vscode.commands.registerCommand(
        `dataverseIde.${id}.buildWorkspace`,
        async () => {
          const uris = await vscode.workspace.findFiles(
            "**/*.{ts,tsx,js,jsx,mts,cts}",
            "{**/node_modules/**,**/.ide-build/**,**/.git/**,**/dist/**}",
            200,
          );

          if (uris.length === 0) {
            await vscode.window.showWarningMessage(
              `[${label}] No buildable source files found in the workspace.`,
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
            title: `${label}: Build Workspace…`,
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
        `dataverseIde.${id}.openConfig`,
        async () => {
          const uri = configIO.filePath(vscode, context.workspaceRootUri);

          try {
            await vscode.workspace.fs.stat(uri);
          } catch {
            /*
             * Scaffold the file with the merged defaults on first open so
             * the editor shows something meaningful to edit.
             */
            await configIO.update(vscode, context.workspaceRootUri, {});
          }

          await vscode.window.showTextDocument(uri);
        },
      );

      const outputChannelCommand = vscode.commands.registerCommand(
        `dataverseIde.${id}.showOutput`,
        () => {
          outputChannel.show(true);
        },
      );

      const reloadConfigCommand = vscode.commands.registerCommand(
        `dataverseIde.${id}.reloadConfig`,
        async () => {
          await reloadConfigFromDisk();

          await vscode.window.showInformationMessage(`${label} configuration reloaded.`);
        },
      );

      outputChannel.appendLine(
        `[${label}] commands registered: transform, minify, build, watch, config.`,
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

          runner.dispose();
        },
      };
    },
  };
}
