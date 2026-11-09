import { ExtensionHostKind, registerExtension } from "@codingame/monaco-vscode-api/extensions";

import type * as vscodeType from "vscode";

import {
  configFilePath,
  readDataverseConfig,
  updateDataverseConfig,
  type DataverseConfig,
} from "./config.js";

import { configFilePathFor, type ConfigPathOptions } from "../shared/configPath.js";

import { DataverseWebResourceClient, type DataverseWebResource } from "./webResourceClient.js";
import { DataverseMetadataClient } from "./metadataClient.js";
import {
  DATAVERSE_SCHEMA_FILE_NAME,
  DATAVERSE_SCHEMA_PATH_SETTING,
  parseDataverseSchema,
  resolveDataverseSchema,
  type ResolvedSchema,
} from "./schema.js";
import { buildSchemaPlan, formatSchemaPlan, type SchemaPlan } from "./schemaPlan.js";
import { applySchemaPlan } from "./provisioner.js";

import guideContent from "./GUIDE.md?raw";

import { registerGuide } from "../shared/guide.js";
import { createGlobMatcher, scanGlob } from "../shared/glob.js";

import { registerDataverseTerminalCommands } from "./terminal.js";

export type DataverseUploadController = {
  dispose: () => void;
};

type UploadSettings = DataverseConfig;

type UploadSummary = {
  files: number;
  uploaded: number;
  failures: string[];
};

const SCHEMA_PATH_OPTIONS: ConfigPathOptions = {
  section: "dataverseIde.dataverse",
  defaultPath: DATAVERSE_SCHEMA_FILE_NAME,
  settingKey: DATAVERSE_SCHEMA_PATH_SETTING,
};

const DEFAULT_INCLUDE_PATTERN = "**/*";

/*
 * `vscode.workspace.findFiles()` is backed by the browser search provider in
 * this build. Its file search ignores the include glob (and the search
 * folder), so it returns every cached workspace file regardless of the
 * dataverse.config.json "files" option. Walk the upload root through
 * workspace.fs and apply the configured globs ourselves so uploads and watch
 * mode honour `files`/`exclude`.
 */
const MAX_SCANNED_DIRECTORIES = 20000;

/* VCS/internal folders are never web resources, even for the default pattern. */
const SKIPPED_DIRECTORY_NAMES = new Set([".git", ".ide-build"]);

function normalizeGlobPattern(pattern: string): string {
  const normalized = pattern
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "");

  /* Upload globs are relative to uploadRoot; never let them escape it. */
  return normalized.split("/").includes("..") ? "" : normalized;
}

function configuredGlobPatterns(patterns: string[], fallback?: string): string[] {
  const normalized = patterns.map(normalizeGlobPattern).filter((pattern) => pattern.length > 0);

  if (normalized.length > 0) {
    return normalized;
  }

  return fallback == null ? [] : [fallback];
}

function createUploadPatternMatcher(settings: UploadSettings): (relativePath: string) => boolean {
  const includeMatchers = configuredGlobPatterns(settings.files, DEFAULT_INCLUDE_PATTERN).map(
    (pattern) => createGlobMatcher(pattern),
  );

  const excludeMatchers = configuredGlobPatterns(settings.exclude).map((pattern) =>
    createGlobMatcher(pattern),
  );

  return (relativePath: string): boolean =>
    includeMatchers.some((matches) => matches(relativePath)) &&
    !excludeMatchers.some((matches) => matches(relativePath));
}

// Longest literal directory prefix of a glob. Traversal starts there, so a
// pattern rooted at a subfolder only scans that subfolder.
function globTraversalBaseSegments(pattern: string): string[] {
  const scanned = scanGlob(pattern);
  const segments = (scanned.isGlob ? scanned.base : pattern.split("/").slice(0, -1).join("/"))
    .split("/")
    .filter((segment) => segment.length > 0);

  return segments;
}

async function getConfiguredUploadFiles(
  vscode: typeof vscodeType,
  workspaceRootUri: vscodeType.Uri,
  settings: UploadSettings,
): Promise<vscodeType.Uri[]> {
  const uploadRootUri =
    settings.uploadRoot.length === 0
      ? workspaceRootUri
      : vscode.Uri.joinPath(workspaceRootUri, ...settings.uploadRoot.split("/"));

  const includePatterns = configuredGlobPatterns(settings.files, DEFAULT_INCLUDE_PATTERN);

  /*
   * Dependencies are not web resources. Skip node_modules unless a configured
   * pattern names it explicitly.
   */
  const skipNodeModules = !includePatterns.some((pattern) =>
    pattern.split("/").includes("node_modules"),
  );

  const shouldSkipDirectory = (name: string): boolean => {
    const lowerName = name.toLowerCase();

    return (
      SKIPPED_DIRECTORY_NAMES.has(lowerName) || (lowerName === "node_modules" && skipNodeModules)
    );
  };

  const matchesConfiguredPatterns = createUploadPatternMatcher(settings);

  const matched = new Map<string, vscodeType.Uri>();
  const visitedDirectories = new Set<string>();
  let scannedDirectories = 0;

  for (const pattern of includePatterns) {
    const baseUri = vscode.Uri.joinPath(uploadRootUri, ...globTraversalBaseSegments(pattern));
    const pending: vscodeType.Uri[] = [baseUri];

    while (pending.length > 0 && scannedDirectories < MAX_SCANNED_DIRECTORIES) {
      const current = pending.pop()!;
      const key = current.toString();

      if (visitedDirectories.has(key)) {
        continue;
      }

      visitedDirectories.add(key);
      scannedDirectories++;

      let entries: Array<[string, vscodeType.FileType]>;

      try {
        entries = await vscode.workspace.fs.readDirectory(current);
      } catch {
        continue;
      }

      for (const [name, type] of entries) {
        const childUri = vscode.Uri.joinPath(current, name);

        if ((type & vscode.FileType.Directory) !== 0) {
          if (!shouldSkipDirectory(name)) {
            pending.push(childUri);
          }

          continue;
        }

        if ((type & vscode.FileType.File) === 0) {
          continue;
        }

        const relativePath = getRelativePath(uploadRootUri, childUri);

        if (matchesConfiguredPatterns(relativePath)) {
          matched.set(childUri.toString(), childUri);
        }
      }
    }
  }

  return [...matched.values()].sort((left, right) =>
    getRelativePath(uploadRootUri, left).localeCompare(getRelativePath(uploadRootUri, right)),
  );
}

async function getSettings(
  vscode: typeof vscodeType,
  workspaceRootUri: vscodeType.Uri,
): Promise<UploadSettings> {
  const settings = (await readDataverseConfig(vscode, workspaceRootUri)).config;

  const prefix = settings.prefix;

  if (prefix.length === 0) {
    throw new Error('Set "prefix" in dataverse.config.json before uploading.');
  }

  if (prefix.length < 3 || prefix.indexOf("_") < 2 || prefix.endsWith("/")) {
    throw new Error(
      '"prefix" in dataverse.config.json must contain an underscore somewhere after its first two characters. Example: dv_ide.',
    );
  }

  if (
    settings.uploadRoot === ".." ||
    settings.uploadRoot.startsWith("../") ||
    settings.uploadRoot.includes("/../")
  ) {
    throw new Error('"uploadRoot" in dataverse.config.json cannot contain path traversal values.');
  }

  return settings;
}

function buildWebResourceName(settings: UploadSettings, relativePath: string): string {
  const normalizedPath = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");

  return `${settings.prefix}/${normalizedPath}`;
}

function getRelativePath(rootUri: vscodeType.Uri, resourceUri: vscodeType.Uri): string {
  const rootPath = rootUri.path.replace(/\/+$/, "");
  const resourcePath = resourceUri.path;

  if (!resourcePath.startsWith(`${rootPath}/`)) {
    throw new Error(`"${resourceUri.path}" is outside configured upload root "${rootUri.path}".`);
  }

  return resourcePath.slice(rootPath.length + 1);
}

async function collectFiles(
  vscode: typeof vscodeType,
  uri: vscodeType.Uri,
): Promise<vscodeType.Uri[]> {
  const stat = await vscode.workspace.fs.stat(uri);

  if ((stat.type & vscode.FileType.File) !== 0) {
    return [uri];
  }

  if ((stat.type & vscode.FileType.Directory) === 0) {
    return [];
  }

  const files: vscodeType.Uri[] = [];
  const entries = await vscode.workspace.fs.readDirectory(uri);

  for (const [name, type] of entries) {
    const childUri = vscode.Uri.joinPath(uri, name);

    if ((type & vscode.FileType.File) !== 0) {
      files.push(childUri);
      continue;
    }

    if ((type & vscode.FileType.Directory) !== 0) {
      files.push(...(await collectFiles(vscode, childUri)));
    }
  }

  return files;
}

function toUris(value: unknown): vscodeType.Uri[] {
  if (Array.isArray(value)) {
    return value.filter(
      (candidate): candidate is vscodeType.Uri =>
        typeof candidate === "object" &&
        candidate != null &&
        "scheme" in candidate &&
        "path" in candidate,
    );
  }

  if (typeof value === "object" && value != null && "scheme" in value && "path" in value) {
    return [value as vscodeType.Uri];
  }

  return [];
}

export async function installDataverseUploadExtension(
  workspaceRootUri: vscodeType.Uri,
): Promise<DataverseUploadController> {
  const { getApi } = registerExtension(
    {
      name: "dataverse-web-resource-upload",
      publisher: "dataverse",
      version: "0.1.0",
      engines: {
        vscode: "*",
      },
      displayName: "Dataverse Web Resource Upload",
      description: "Uploads local workspace files to Dataverse web resources.",

      contributes: {
        configuration: {
          title: "Dataverse Web Resources",

          properties: {
            "dataverseIde.dataverse.configPath": {
              type: "string",
              default: "dataverse.config.json",
              scope: "window",
              description:
                "Workspace-relative path of the dataverse upload settings file. Example: config/dataverse.config.json.",
            },

            "dataverseIde.dataverse.watchDebounceMs": {
              type: "number",
              default: 300,
              minimum: 100,
              scope: "window",
              description:
                "Milliseconds to wait before batching file changes for Dataverse watch upload.",
            },

            "dataverseIde.dataverse.schemaPath": {
              type: "string",
              default: DATAVERSE_SCHEMA_FILE_NAME,
              scope: "window",
              description:
                "Workspace-relative path of the Dataverse schema provisioning file. Example: config/dataverse.schema.json.",
            },

            "dataverseIde.user.name": {
              type: "string",
              default: "",
              description:
                "IDE user identity full name (populated automatically at startup and by Dataverse: Load User Identity).",
            },

            "dataverseIde.user.email": {
              type: "string",
              default: "",
              description:
                "IDE user identity email address (populated automatically at startup and by Dataverse: Load User Identity).",
            },
          },
        },

        commands: [
          {
            command: "dataverseIde.dataverse.uploadConfiguredFiles",
            title: "Dataverse: Upload Configured Web Resource Folder",
          },
          {
            command: "dataverseIde.dataverse.uploadSelection",
            title: "Dataverse: Upload Selected Files or Folders",
          },
          {
            command: "dataverseIde.dataverse.uploadActiveFile",
            title: "Dataverse: Upload Active File",
          },
          {
            command: "dataverseIde.dataverse.previewSelection",
            title: "Dataverse: Preview Selected HTML Web Resource",
          },
          {
            command: "dataverseIde.dataverse.startWatch",
            title: "Dataverse: Start Watch Upload",
          },
          {
            command: "dataverseIde.dataverse.stopWatch",
            title: "Dataverse: Stop Watch Upload",
          },
          {
            command: "dataverseIde.dataverse.loadUserIdentity",
            title: "Dataverse: Load User Identity",
          },
          {
            command: "dataverseIde.dataverse.openSchema",
            title: "Dataverse: Open dataverse.schema.json",
          },
          {
            command: "dataverseIde.dataverse.previewSchema",
            title: "Dataverse: Preview Schema Plan",
          },
          {
            command: "dataverseIde.dataverse.provisionSchema",
            title: "Dataverse: Provision Schema (Create Only)",
          },
          {
            command: "dataverseIde.dataverse.publishSchema",
            title: "Dataverse: Publish Schema Tables",
          },
          {
            command: "dataverseIde.dataverse.openConfig",
            title: "Dataverse: Open dataverse.config.json",
          },
          {
            command: "dataverseIde.dataverse.openGuide",
            title: "Dataverse: How-to Guide",
          },
        ],

        menus: {
          commandPalette: [
            {
              command: "dataverseIde.dataverse.uploadConfiguredFiles",
            },
            {
              command: "dataverseIde.dataverse.uploadSelection",
            },
            {
              command: "dataverseIde.dataverse.uploadActiveFile",
            },
            {
              command: "dataverseIde.dataverse.previewSelection",
            },
            {
              command: "dataverseIde.dataverse.startWatch",
            },
            {
              command: "dataverseIde.dataverse.stopWatch",
            },
            {
              command: "dataverseIde.dataverse.openSchema",
            },
            {
              command: "dataverseIde.dataverse.previewSchema",
            },
            {
              command: "dataverseIde.dataverse.provisionSchema",
            },
            {
              command: "dataverseIde.dataverse.publishSchema",
            },
            {
              command: "dataverseIde.dataverse.openConfig",
            },
            {
              command: "dataverseIde.dataverse.openGuide",
            },
          ],

          "explorer/context": [
            {
              command: "dataverseIde.dataverse.uploadSelection",
              group: "navigation@50",
            },
            {
              command: "dataverseIde.dataverse.previewSelection",
              when: "resourceExtname == .html || resourceExtname == .htm",
              group: "navigation@51",
            },
          ],

          "editor/title": [
            {
              command: "dataverseIde.dataverse.previewSelection",
              when: "resourceExtname == .html || resourceExtname == .htm",
              group: "navigation@50",
            },
          ],
        },
      },
    },
    ExtensionHostKind.LocalProcess,
  );

  const vscode = await getApi();

  const output = vscode.window.createOutputChannel("Dataverse");

  let fileWatcher: vscodeType.FileSystemWatcher | undefined;
  let saveWatcher: vscodeType.Disposable | undefined;
  let watchTimer: number | undefined;
  let watchUploadInProgress = false;
  let watchRefreshQueued = false;

  /*
   * A Map preserves the URI associated with each changed file while preventing
   * duplicate upload requests during a rapid Vite build.
   */
  const pendingWatchFiles = new Map<string, vscodeType.Uri>();

  /*
   * Publishing is slow (often 20s+) and expensive on the Dataverse server.
   * Watch mode queues uploaded resources and coalesces bursts into one publish
   * after a short idle period instead of blocking every upload batch.
   */
  const PUBLISH_DEBOUNCE_MS = 1500;
  const pendingPublishResources = new Map<string, DataverseWebResource>();
  let publishTimer: number | undefined;
  let publishInProgress = false;
  let manualPublishInProgress = false;
  let publishQueued = false;
  let lastWatchDetail = "";

  const watchStatus = createWatchStatus(vscode, {
    id: "dataverse",
    label: "dataverse",
    busyLabel: () => (publishInProgress || manualPublishInProgress ? "Publishing…" : "Uploading…"),
    isRunning: () => fileWatcher != null,
    isBusy: () => watchUploadInProgress || publishInProgress || manualPublishInProgress,
    detail: () => lastWatchDetail,
    start: () => {
      startWatchUpload();
    },
    stop: () => {
      if (fileWatcher == null) {
        return;
      }

      stopWatchUpload();

      output.appendLine("[watch] Stopped (status bar).");
    },
    showOutput: () => {
      output.show(true);
    },
    openConfig: () => {
      void vscode.commands.executeCommand("dataverseIde.dataverse.openConfig");
    },
    extraItems: () => [
      {
        label: "$(cloud-upload) Upload configured files",
        run: () => {
          void vscode.commands.executeCommand("dataverseIde.dataverse.uploadConfiguredFiles");
        },
      },
    ],
  });

  function createWebResourceClient(settings: UploadSettings): DataverseWebResourceClient {
    return new DataverseWebResourceClient({
      apiBaseUrl: settings.apiBaseUrl,
      solutionUniqueName: settings.solution,
    });
  }

  function schemaFilePath(): vscodeType.Uri {
    return configFilePathFor(vscode, workspaceRootUri, SCHEMA_PATH_OPTIONS);
  }

  async function readSchema(): Promise<{ schema: ResolvedSchema; settings: DataverseConfig }> {
    const settings = (await readDataverseConfig(vscode, workspaceRootUri)).config;

    let text: string;

    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(schemaFilePath()));
    } catch {
      throw new Error(
        `No ${DATAVERSE_SCHEMA_FILE_NAME} found. Run "Dataverse: Open dataverse.schema.json" to create one.`,
      );
    }

    const document = parseDataverseSchema(text);

    const schema = resolveDataverseSchema(document, {
      prefix: document.prefix?.trim() || settings.prefix,
      solution: document.solution?.trim() || settings.solution,
    });

    return { schema, settings };
  }

  function createMetadataClient(
    settings: DataverseConfig,
    schema: ResolvedSchema,
  ): DataverseMetadataClient {
    return new DataverseMetadataClient({
      apiBaseUrl: settings.apiBaseUrl,
      solutionUniqueName: schema.solution,
    });
  }

  function apiBaseUrl(settings: DataverseConfig): string {
    return settings.apiBaseUrl?.trim().replace(/\/+$/, "") || window.location.origin;
  }

  async function showSchemaPlan(
    plan: SchemaPlan,
    schema: ResolvedSchema,
    settings: DataverseConfig,
  ): Promise<void> {
    const content = formatSchemaPlan(plan, {
      apiBaseUrl: apiBaseUrl(settings),
      solution: schema.solution,
      prefix: schema.prefix,
    });

    output.appendLine("");
    output.appendLine(content);
    output.show(true);

    try {
      const document = await vscode.workspace.openTextDocument({
        content,
        language: "markdown",
      });

      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      output.appendLine(
        `Unable to open the plan preview: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function publishResources(
    client: DataverseWebResourceClient,
    resources: DataverseWebResource[],
    label: string,
  ): Promise<number> {
    output.appendLine(`${label} ${resources.length} web resource(s)...`);

    const startedAt = Date.now();

    await client.publishWebResources(resources);

    const elapsedMs = Date.now() - startedAt;

    output.appendLine(`Publish completed in ${elapsedMs} ms.`);

    return elapsedMs;
  }

  function enqueueBackgroundPublish(resources: DataverseWebResource[]): void {
    for (const resource of resources) {
      pendingPublishResources.set(resource.webresourceid, resource);
    }

    if (pendingPublishResources.size === 0) {
      return;
    }

    if (publishTimer != null) {
      window.clearTimeout(publishTimer);
    }

    publishTimer = window.setTimeout(() => {
      publishTimer = undefined;

      void flushBackgroundPublish();
    }, PUBLISH_DEBOUNCE_MS);
  }

  async function flushBackgroundPublish(): Promise<void> {
    if (publishInProgress || manualPublishInProgress) {
      publishQueued = true;
      return;
    }

    if (pendingPublishResources.size === 0) {
      return;
    }

    publishInProgress = true;
    lastWatchDetail = `Publishing ${pendingPublishResources.size} web resource(s). Dataverse can take 20+ seconds…`;

    const resources = [...pendingPublishResources.values()];
    pendingPublishResources.clear();
    let failed = false;

    try {
      watchStatus.update();

      const settings = await getSettings(vscode, workspaceRootUri);

      if (!settings.publishAfterUpload) {
        output.appendLine("[watch] publishAfterUpload is disabled; skipping publish.");
        lastWatchDetail = "Publish skipped: publishAfterUpload is disabled.";

        return;
      }

      const elapsedMs = await publishResources(
        createWebResourceClient(settings),
        resources,
        "[watch] Publishing",
      );

      lastWatchDetail = `Published ${resources.length} web resource(s) in ${(
        elapsedMs / 1000
      ).toFixed(1)}s.`;
    } catch (error) {
      failed = true;

      const message = error instanceof Error ? error.message : String(error);

      lastWatchDetail = `Publish failed: ${message}`;

      output.appendLine(`[watch] Publish failed: ${message}`);

      void vscode.window.showErrorMessage(
        `Dataverse publish failed: ${message}. It will be retried with the next watch upload.`,
      );
    } finally {
      publishInProgress = false;
      watchStatus.update();

      /*
       * Keep failed resources for the next upload trigger instead of retrying
       * in a tight loop. New changes made during the publish are picked up by
       * the normal debounce path.
       */
      if (failed) {
        for (const resource of resources) {
          pendingPublishResources.set(resource.webresourceid, resource);
        }

        publishQueued = false;
      } else if (publishQueued || pendingPublishResources.size > 0) {
        publishQueued = false;

        enqueueBackgroundPublish([]);
      }
    }
  }

  async function uploadFiles(
    selectedUris: vscodeType.Uri[],
    options: {
      backgroundPublish?: boolean;
      clearOutput?: boolean;
      showProgress?: boolean;
      silent?: boolean;
    } = {},
  ): Promise<UploadSummary> {
    const settings = await getSettings(vscode, workspaceRootUri);

    const uploadRootUri =
      settings.uploadRoot.length === 0
        ? workspaceRootUri
        : vscode.Uri.joinPath(workspaceRootUri, ...settings.uploadRoot.split("/"));

    const files = [
      ...new Map(
        (await Promise.all(selectedUris.map((uri) => collectFiles(vscode, uri))))
          .flat()
          .map((uri) => [uri.toString(), uri]),
      ).values(),
    ];

    if (files.length === 0) {
      if (options.silent !== true) {
        void vscode.window.showWarningMessage("No files were selected for Dataverse upload.");
      }

      return { files: 0, uploaded: 0, failures: [] };
    }

    const client = createWebResourceClient(settings);

    const uploaded: DataverseWebResource[] = [];
    const failures: string[] = [];

    if (options.clearOutput !== false) {
      output.clear();
    }

    output.show(true);

    const uploadBatch = async (
      progress?: vscodeType.Progress<{ message?: string; increment?: number }>,
    ): Promise<void> => {
      for (let index = 0; index < files.length; index += 1) {
        const fileUri = files[index];

        try {
          const relativePath = getRelativePath(uploadRootUri, fileUri);

          const resourceName = buildWebResourceName(settings, relativePath);

          progress?.report({
            increment: 100 / files.length,
            message: `${index + 1}/${files.length}: ${relativePath}`,
          });

          output.appendLine(`Uploading ${relativePath} -> ${resourceName}`);

          const content = await vscode.workspace.fs.readFile(fileUri);

          const resource = await client.uploadWebResource(resourceName, content);

          uploaded.push(resource);

          output.appendLine(`  Success: ${resource.webresourceid}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);

          failures.push(`${fileUri.path}: ${message}`);

          output.appendLine(`  Failed: ${fileUri.path}`);
          output.appendLine(`  ${message}`);
        }
      }
    };

    if (options.showProgress === false) {
      await uploadBatch();
    } else {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Uploading Dataverse web resources",
          cancellable: false,
        },
        uploadBatch,
      );
    }

    if (failures.length > 0) {
      void vscode.window.showErrorMessage(
        `${failures.length} of ${files.length} Dataverse web resource upload(s) failed. See Output for details.`,
      );

      return { files: files.length, uploaded: uploaded.length, failures };
    }

    let publishMessage = settings.publishAfterUpload
      ? " Uploaded and published."
      : " Uploaded but not published.";

    /*
     * Do not publish a partial deployment. The user can correct failed files
     * and retry the same operation.
     *
     * Watch mode queues the IDs and publishes once after a short idle period:
     * a build often saves several files in a burst, and one PublishXml call is
     * much cheaper than one publish per file/batch.
     */
    if (uploaded.length > 0 && settings.publishAfterUpload) {
      if (options.backgroundPublish === true) {
        enqueueBackgroundPublish(uploaded);

        output.appendLine(`Queued ${uploaded.length} web resource(s) for publishing.`);

        publishMessage = " Uploaded; publishing in the background.";
      } else {
        manualPublishInProgress = true;
        lastWatchDetail = `Publishing ${uploaded.length} web resource(s). Dataverse can take 20+ seconds…`;
        watchStatus.update();

        try {
          const elapsedMs = await publishResources(client, uploaded, "Publishing");

          lastWatchDetail = `Published ${uploaded.length} web resource(s) in ${(
            elapsedMs / 1000
          ).toFixed(1)}s.`;
        } catch (error) {
          lastWatchDetail = `Publish failed: ${
            error instanceof Error ? error.message : String(error)
          }`;

          throw error;
        } finally {
          manualPublishInProgress = false;
          watchStatus.update();

          if (publishQueued || pendingPublishResources.size > 0) {
            publishQueued = false;

            enqueueBackgroundPublish([]);
          }
        }
      }
    }

    if (options.silent !== true) {
      void vscode.window.showInformationMessage(
        `${uploaded.length} Dataverse web resource(s) uploaded.${publishMessage}`,
      );
    }

    return { files: files.length, uploaded: uploaded.length, failures };
  }

  function getUploadRootUri(settings: UploadSettings): vscodeType.Uri {
    if (settings.uploadRoot.length === 0) {
      return workspaceRootUri;
    }

    return vscode.Uri.joinPath(workspaceRootUri, ...settings.uploadRoot.split("/"));
  }

  function isWithinFolder(uri: vscodeType.Uri, folderUri: vscodeType.Uri): boolean {
    if (uri.scheme !== folderUri.scheme) {
      return false;
    }

    const folderPath = folderUri.path.replace(/\/+$/, "");

    return uri.path === folderPath || uri.path.startsWith(`${folderPath}/`);
  }

  /** Watch debounce is runtime tuning: extension setting, not the config file. */
  function getWatchDebounceMs(): number {
    const value = vscode.workspace
      .getConfiguration("dataverseIde.dataverse", workspaceRootUri)
      .get<number>("watchDebounceMs", 300);

    return Number.isFinite(value) ? Math.max(100, value) : 300;
  }

  function scheduleWatchUpload(uri: vscodeType.Uri): void {
    pendingWatchFiles.set(uri.toString(), uri);

    if (watchTimer != null) {
      window.clearTimeout(watchTimer);
    }

    watchTimer = window.setTimeout(() => {
      watchTimer = undefined;

      void flushWatchUpload();
    }, getWatchDebounceMs());
  }

  async function flushWatchUpload(): Promise<void> {
    if (watchUploadInProgress) {
      watchRefreshQueued = true;
      return;
    }

    if (pendingWatchFiles.size === 0) {
      return;
    }

    watchUploadInProgress = true;

    /*
     * Snapshot and clear first. File changes that occur during upload populate
     * a new batch and are processed afterward.
     */
    const changedFiles = new Map(pendingWatchFiles);
    pendingWatchFiles.clear();

    lastWatchDetail = `Uploading ${changedFiles.size} changed file(s)…`;

    try {
      watchStatus.update();

      output.appendLine(`[watch] Processing ${changedFiles.size} changed file(s).`);

      const settings = await getSettings(vscode, workspaceRootUri);

      /*
       * Match each changed URI directly against dataverse.config.json
       * "files"/"exclude" instead of re-scanning the workspace and comparing
       * URI strings. The scan can race the file write and is much slower for
       * large build outputs.
       *
       * Deletions are removed from pendingWatchFiles by onDidDelete, which
       * intentionally matches the "do not delete remote resources"
       * requirement.
       */
      const uploadRootUri = getUploadRootUri(settings);
      const matchesConfiguredPatterns = createUploadPatternMatcher(settings);

      const filesToUpload = [...changedFiles.values()].filter((uri) => {
        if (!isWithinFolder(uri, uploadRootUri)) {
          return false;
        }

        try {
          return matchesConfiguredPatterns(getRelativePath(uploadRootUri, uri));
        } catch {
          return false;
        }
      });

      if (filesToUpload.length === 0) {
        const changedPaths = [...changedFiles.values()].slice(0, 10).map((uri) => {
          try {
            return getRelativePath(uploadRootUri, uri);
          } catch {
            return uri.path;
          }
        });

        output.appendLine(
          `[watch] No changed files matched configured upload patterns: ${changedPaths.join(", ")}`,
        );

        lastWatchDetail = `No changed files matched the configured upload patterns: ${changedPaths.join(", ")}`;

        return;
      }

      output.appendLine(`[watch] Uploading ${filesToUpload.length} changed file(s).`);

      lastWatchDetail = `Uploading ${filesToUpload.length} changed file(s)…`;

      await uploadFiles(filesToUpload, {
        backgroundPublish: true,
        clearOutput: false,
        showProgress: false,
        silent: true,
      });

      output.appendLine(`[watch] Completed upload of ${filesToUpload.length} file(s).`);

      lastWatchDetail = `Uploaded ${filesToUpload.length} file(s).`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      lastWatchDetail = `Watch upload failed: ${message}`;

      console.error("[Dataverse IDE] Watch upload failed.", error);

      output.appendLine(`[watch] Failed: ${message}`);

      void vscode.window.showErrorMessage(`Dataverse watch upload failed: ${message}`);
    } finally {
      watchUploadInProgress = false;
      watchStatus.update();

      /*
       * Process files changed while the previous batch was uploading.
       */
      if (watchRefreshQueued || pendingWatchFiles.size > 0) {
        watchRefreshQueued = false;

        void flushWatchUpload();
      }
    }
  }

  function stopWatchUpload(): void {
    if (watchTimer != null) {
      window.clearTimeout(watchTimer);
      watchTimer = undefined;
    }

    pendingWatchFiles.clear();

    saveWatcher?.dispose();
    saveWatcher = undefined;

    fileWatcher?.dispose();
    fileWatcher = undefined;

    lastWatchDetail = "Watch stopped.";

    watchStatus.update();
  }

  function startWatchUpload(): void {
    if (fileWatcher != null) {
      void vscode.window.showInformationMessage("Dataverse watch upload is already running.");

      return;
    }

    void (async () => {
      try {
        const settings = await getSettings(vscode, workspaceRootUri);

        const uploadRootUri = getUploadRootUri(settings);

        /*
         * Watch the configured upload root broadly. The flush operation applies
         * the configured include/exclude globs to each changed path.
         */
        fileWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(uploadRootUri, "**/*"),
        );

        lastWatchDetail = `Watching ${uploadRootUri.path}.`;

        watchStatus.update();

        fileWatcher.onDidCreate((uri) => {
          output.appendLine(`[watch] Created: ${uri.path}`);
          void scheduleWatchUpload(uri);
        });

        fileWatcher.onDidChange((uri) => {
          output.appendLine(`[watch] Changed: ${uri.path}`);
          void scheduleWatchUpload(uri);
        });

        /*
         * Do not delete remote web resources. Remove any queued request for a file
         * that was deleted before its debounce period elapsed.
         */
        fileWatcher.onDidDelete((uri) => {
          output.appendLine(`[watch] Deleted locally; remote retained: ${uri.path}`);

          pendingWatchFiles.delete(uri.toString());
        });

        /*
         * Browser file watchers depend on the experimental FileSystemObserver
         * API. Fall back to save notifications (manual save and autosave) so
         * watch upload still works when the watcher is unavailable. The
         * pending map deduplicates when both paths report the same write.
         */
        saveWatcher = vscode.workspace.onDidSaveTextDocument((document) => {
          if (fileWatcher == null || !isWithinFolder(document.uri, uploadRootUri)) {
            return;
          }

          output.appendLine(`[watch] Saved: ${document.uri.path}`);
          void scheduleWatchUpload(document.uri);
        });

        output.appendLine(`[watch] Started for ${uploadRootUri.path}`);

        output.appendLine(
          `[watch] Patterns: files=[${settings.files.join(", ")}] exclude=[${settings.exclude.join(
            ", ",
          )}]`,
        );

        /*
         * Start-of-watch initial upload: run every configured file
         * through the normal debounced watch pipeline once, so the
         * remote state matches local at watch start.
         */
        const configuredFiles = await getConfiguredUploadFiles(vscode, workspaceRootUri, settings);

        output.appendLine(`[watch] Initial upload: ${configuredFiles.length} configured file(s).`);

        for (const uri of configuredFiles) {
          await scheduleWatchUpload(uri);
        }

        void vscode.window.showInformationMessage(
          `Dataverse watch upload started for "${settings.uploadRoot || "."}".`,
        );
      } catch (error) {
        stopWatchUpload();

        output.appendLine(
          `[watch] Failed to start: ${error instanceof Error ? error.message : String(error)}`,
        );

        await vscode.window.showErrorMessage(
          error instanceof Error
            ? `Unable to start Dataverse watch upload: ${error.message}`
            : "Unable to start Dataverse watch upload.",
        );
      }
    })();
  }

  const startWatchCommand = vscode.commands.registerCommand(
    "dataverseIde.dataverse.startWatch",
    async () => {
      try {
        startWatchUpload();
      } catch (error) {
        await vscode.window.showErrorMessage(
          error instanceof Error
            ? `Unable to start Dataverse watch upload: ${error.message}`
            : "Unable to start Dataverse watch upload.",
        );
      }
    },
  );

  const stopWatchCommand = vscode.commands.registerCommand(
    "dataverseIde.dataverse.stopWatch",
    async () => {
      if (fileWatcher == null) {
        await vscode.window.showInformationMessage("Dataverse watch upload is not running.");

        return;
      }

      stopWatchUpload();

      output.appendLine("[watch] Stopped.");

      await vscode.window.showInformationMessage("Dataverse watch upload stopped.");
    },
  );

  const openConfigCommand = vscode.commands.registerCommand(
    "dataverseIde.dataverse.openConfig",
    async () => {
      const uri = configFilePath(vscode, workspaceRootUri);

      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        /*
         * Scaffold the file with the defaults on first open so the editor
         * shows something meaningful to edit.
         */
        await updateDataverseConfig(vscode, workspaceRootUri, {});
      }

      await vscode.window.showTextDocument(uri);
    },
  );

  const openSchemaCommand = vscode.commands.registerCommand(
    "dataverseIde.dataverse.openSchema",
    async () => {
      const uri = schemaFilePath();

      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        /*
         * Scaffold an empty schema. It cannot create anything until the user
         * adds tables, so opening the file is always safe.
         */
        const template = `${JSON.stringify({ tables: [] }, null, 2)}\n`;

        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(template));
      }

      await vscode.window.showTextDocument(uri);
    },
  );

  const previewSchemaCommand = vscode.commands.registerCommand(
    "dataverseIde.dataverse.previewSchema",
    async () => {
      try {
        const { schema, settings } = await readSchema();
        const client = createMetadataClient(settings, schema);

        const plan = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Dataverse: reading schema metadata…",
            cancellable: false,
          },
          () => buildSchemaPlan(schema, client),
        );

        await showSchemaPlan(plan, schema, settings);

        if (plan.conflicts > 0) {
          await vscode.window.showWarningMessage(
            `Dataverse schema plan has ${plan.conflicts} conflict(s); provisioning is blocked until they are resolved.`,
          );
        }
      } catch (error) {
        await vscode.window.showErrorMessage(
          error instanceof Error
            ? `Dataverse schema plan failed: ${error.message}`
            : "Dataverse schema plan failed.",
        );
      }
    },
  );

  const provisionSchemaCommand = vscode.commands.registerCommand(
    "dataverseIde.dataverse.provisionSchema",
    async () => {
      try {
        const { schema, settings } = await readSchema();
        const client = createMetadataClient(settings, schema);

        const plan = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Dataverse: reading schema metadata…",
            cancellable: false,
          },
          () => buildSchemaPlan(schema, client),
        );

        await showSchemaPlan(plan, schema, settings);

        if (plan.conflicts > 0) {
          await vscode.window.showErrorMessage(
            `Dataverse schema has ${plan.conflicts} conflict(s). Delete the existing table or column in Dataverse, or change dataverse.schema.json, then run provisioning again.`,
          );

          return;
        }

        const creates = plan.tableCreates + plan.columnCreates + plan.lookupCreates;

        if (creates === 0) {
          await vscode.window.showInformationMessage(
            "Dataverse schema is already up to date; nothing to create.",
          );

          return;
        }

        const confirmation = await vscode.window.showWarningMessage(
          `Create ${creates} new component(s) in ${apiBaseUrl(settings)}? This only creates; existing tables and columns are never updated or deleted.`,
          { modal: true },
          "Provision",
        );

        if (confirmation !== "Provision") {
          return;
        }

        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Dataverse: provisioning schema",
            cancellable: false,
          },
          async (progress) =>
            applySchemaPlan(client, schema, plan, (message) => {
              output.appendLine(message);
              progress.report({ message });
            }),
        );

        const created =
          result.createdTables.length +
          result.createdColumns.length +
          result.createdRelationships.length;

        if (result.failures.length > 0) {
          output.appendLine("");
          output.appendLine("Failures:");

          for (const failure of result.failures) {
            output.appendLine(`- ${failure.item}: ${failure.message}`);
          }

          await vscode.window.showErrorMessage(
            `Dataverse schema provisioning created ${created} component(s) but ${result.failures.length} item(s) failed. See Output. Re-run to finish; already-created items are skipped.`,
          );

          return;
        }

        if (created === 0) {
          await vscode.window.showInformationMessage(
            "Dataverse schema provisioning finished; nothing new was created.",
          );

          return;
        }

        const published = result.publishedEntities.length;
        const publishMessage =
          published > 0 ? ` Published ${published} table(s).` : " Nothing was published.";

        await vscode.window.showInformationMessage(
          `Dataverse schema provisioned: ${result.createdTables.length} table(s), ${result.createdColumns.length} column(s), ${result.createdRelationships.length} lookup(s).${publishMessage}`,
        );
      } catch (error) {
        await vscode.window.showErrorMessage(
          error instanceof Error
            ? `Dataverse schema provisioning failed: ${error.message}`
            : "Dataverse schema provisioning failed.",
        );
      }
    },
  );

  const publishSchemaCommand = vscode.commands.registerCommand(
    "dataverseIde.dataverse.publishSchema",
    async () => {
      try {
        const { schema, settings } = await readSchema();

        if (schema.tables.length === 0) {
          await vscode.window.showInformationMessage(
            "dataverse.schema.json declares no tables; nothing to publish.",
          );

          return;
        }

        const confirmation = await vscode.window.showWarningMessage(
          `Publish ${schema.tables.length} table(s) in ${apiBaseUrl(settings)}? Publishing can take 20+ seconds.`,
          { modal: true },
          "Publish",
        );

        if (confirmation !== "Publish") {
          return;
        }

        const client = createMetadataClient(settings, schema);
        const logicalNames = schema.tables.map((table) => table.logicalName);

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Dataverse: publishing schema tables",
            cancellable: false,
          },
          async (progress) => {
            progress.report({ message: "Dataverse can take 20+ seconds…" });
            await client.publishEntities(logicalNames);
          },
        );

        await vscode.window.showInformationMessage(
          `Published ${logicalNames.length} Dataverse table(s).`,
        );
      } catch (error) {
        await vscode.window.showErrorMessage(
          error instanceof Error
            ? `Dataverse schema publish failed: ${error.message}`
            : "Dataverse schema publish failed.",
        );
      }
    },
  );

  const uploadConfiguredFilesCommand = vscode.commands.registerCommand(
    "dataverseIde.dataverse.uploadConfiguredFiles",
    async () => {
      try {
        const settings = await getSettings(vscode, workspaceRootUri);

        const files = await getConfiguredUploadFiles(vscode, workspaceRootUri, settings);

        return await uploadFiles(files);
      } catch (error) {
        await vscode.window.showErrorMessage(
          error instanceof Error
            ? `Dataverse upload failed: ${error.message}`
            : "Dataverse upload failed.",
        );

        return {
          files: 0,
          uploaded: 0,
          failures: [error instanceof Error ? error.message : "Dataverse upload failed."],
        };
      }
    },
  );

  const uploadSelectionCommand = vscode.commands.registerCommand(
    "dataverseIde.dataverse.uploadSelection",
    async (selection: unknown) => {
      const uris = toUris(selection);

      if (uris.length === 0) {
        await vscode.window.showWarningMessage(
          "Select one or more files or folders in Explorer first.",
        );

        return;
      }

      try {
        return await uploadFiles(uris);
      } catch (error) {
        await vscode.window.showErrorMessage(
          error instanceof Error
            ? `Dataverse upload failed: ${error.message}`
            : "Dataverse upload failed.",
        );

        return {
          files: 0,
          uploaded: 0,
          failures: [error instanceof Error ? error.message : "Dataverse upload failed."],
        };
      }
    },
  );

  const uploadActiveFileCommand = vscode.commands.registerCommand(
    "dataverseIde.dataverse.uploadActiveFile",
    async () => {
      const document = vscode.window.activeTextEditor?.document;

      if (document == null || document.uri.scheme !== "file") {
        await vscode.window.showWarningMessage(
          "Open a workspace file before using Dataverse: Upload Active File.",
        );

        return;
      }

      try {
        await document.save();

        return await uploadFiles([document.uri]);
      } catch (error) {
        await vscode.window.showErrorMessage(
          error instanceof Error
            ? `Dataverse upload failed: ${error.message}`
            : "Dataverse upload failed.",
        );

        return {
          files: 0,
          uploaded: 0,
          failures: [error instanceof Error ? error.message : "Dataverse upload failed."],
        };
      }
    },
  );

  const previewSelectionCommand = vscode.commands.registerCommand(
    "dataverseIde.dataverse.previewSelection",
    async (selection: unknown) => {
      const selectedUris = toUris(selection);

      const selectedUri = selectedUris[0] ?? vscode.window.activeTextEditor?.document.uri;

      if (selectedUri == null) {
        await vscode.window.showWarningMessage("Select or open an HTML file before previewing.");

        return;
      }

      const extension = selectedUri.path.split(".").at(-1)?.toLowerCase();

      if (extension !== "html" && extension !== "htm") {
        await vscode.window.showWarningMessage(
          "Dataverse preview is available only for HTML web resources.",
        );

        return;
      }

      try {
        const settings = await getSettings(vscode, workspaceRootUri);

        const uploadRootUri =
          settings.uploadRoot.length === 0
            ? workspaceRootUri
            : vscode.Uri.joinPath(workspaceRootUri, ...settings.uploadRoot.split("/"));

        const relativePath = getRelativePath(uploadRootUri, selectedUri);

        const webResourceName = buildWebResourceName(settings, relativePath);

        const dataverseOrigin = settings.apiBaseUrl?.replace(/\/+$/, "") || window.location.origin;

        const encodedName = webResourceName
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/");

        const previewUrl = `${dataverseOrigin}/WebResources/${encodedName}`;

        const previewWindow = window.open(previewUrl, "_blank", "noopener");

        if (previewWindow == null) {
          await vscode.window.showWarningMessage("The browser blocked the preview popup.");
        }
      } catch (error) {
        await vscode.window.showErrorMessage(
          error instanceof Error
            ? `Unable to preview web resource: ${error.message}`
            : "Unable to preview web resource.",
        );
      }
    },
  );

  const terminalCommand = registerDataverseTerminalCommands(vscode, workspaceRootUri);

  return {
    dispose() {
      stopWatchUpload();

      if (publishTimer != null) {
        window.clearTimeout(publishTimer);
        publishTimer = undefined;
      }

      pendingPublishResources.clear();

      terminalCommand.dispose();
      uploadConfiguredFilesCommand.dispose();
      uploadSelectionCommand.dispose();
      uploadActiveFileCommand.dispose();
      previewSelectionCommand.dispose();
      startWatchCommand.dispose();
      stopWatchCommand.dispose();
      openConfigCommand.dispose();
      openSchemaCommand.dispose();
      previewSchemaCommand.dispose();
      provisionSchemaCommand.dispose();
      publishSchemaCommand.dispose();

      watchStatus.dispose();

      output.dispose();
    },
  };
}

import type { ExtensionContext, IdeExtension } from "../api.js";

import { contributeExtensionManifest } from "../api.js";

import * as vscodeTypeBottom from "vscode";

import { createWatchStatus } from "../watchStatus.js";

/*
 * Registry adapter: the original install function is preserved for direct
 * callers, but the extension registry activates features through `default`.
 */

export default {
  id: "dataverse",

  async activate(context: ExtensionContext): Promise<vscodeType.Disposable | void> {
    const vscodeBottom: typeof vscodeTypeBottom = context.vscode;

    /*
     * Register the guide before the workspace guard: the guide explains that
     * uploads need a local folder, so it should still open in an OPFS
     * workspace where activation stops below.
     */
    const guideRegistration = registerGuide({
      vscode: vscodeBottom,
      extensionId: "dataverse",
      content: guideContent,
    });

    const handle = context.workspaceDirectoryHandle;

    if (handle == null) {
      throw new Error(
        "The dataverse extension currently requires a local workspace directory handle.",
      );
    }

    await contributeExtensionManifest({
      id: "dataverse",
      displayName: "Dataverse IDE Dataverse",
      description: "Web resource upload, schema provisioning, and settings management.",
      commands: [],
    });

    /*
     * Identity: WhoAmI + systemusers -> git commit author + IDE user.
     * Written to dataverseIde.git.authorName/authorEmail (git extension
     * reads those to skip the prompts) and dataverseIde.user.*.
     *
     * Activation loads this silently so commits use the signed-in user
     * without a manual step. The command reruns it with UI feedback when
     * the user wants to refresh a changed name or email.
     */
    async function loadUserIdentity(options: { silent?: boolean } = {}): Promise<void> {
      const silent = options.silent === true;

      try {
        const client = new DataverseWebResourceClient({
          apiBaseUrl: (await readDataverseConfig(vscodeBottom, context.workspaceRootUri)).config
            .apiBaseUrl,
        });

        const user = silent
          ? await client.getCurrentUser()
          : await vscodeBottom.window.withProgress(
              {
                location: vscodeBottom.ProgressLocation.Notification,
                title: "Dataverse: loading user identity…",
                cancellable: false,
              },
              () => client.getCurrentUser(),
            );

        if (user.fullName.length === 0 || user.email.length === 0) {
          if (!silent) {
            await vscodeBottom.window.showWarningMessage(
              "Dataverse: the user record has no full name or email; identity not applied.",
            );
          }

          return;
        }

        /*
         * Identity is user-scoped (global): it describes the signed-in
         * person, not the project, so it follows the user across
         * workspaces.
         */
        const gitConfig = vscodeBottom.workspace.getConfiguration(
          "dataverseIde.git",
          context.workspaceRootUri,
        );

        const userConfig = vscodeBottom.workspace.getConfiguration(
          "dataverseIde.user",
          context.workspaceRootUri,
        );

        /*
         * Skip unchanged values so repeated startup loads do not fire
         * configuration change events for every affected extension.
         */
        async function apply(
          config: vscodeType.WorkspaceConfiguration,
          key: string,
          value: string,
        ): Promise<void> {
          if (config.get<string>(key, "").trim() === value) {
            return;
          }

          await config.update(key, value, vscodeBottom.ConfigurationTarget.Global);
        }

        await apply(gitConfig, "authorName", user.fullName);
        await apply(gitConfig, "authorEmail", user.email);
        await apply(userConfig, "name", user.fullName);
        await apply(userConfig, "email", user.email);

        if (!silent) {
          await vscodeBottom.window.showInformationMessage(
            `Dataverse: identity applied — ${user.fullName} <${user.email}>. Git commits now use this author automatically.`,
          );
        }
      } catch (error) {
        /*
         * Startup runs outside a Dataverse org or before sign-in in many
         * deployments; that is expected, so only log it. An explicit
         * command still reports failures to the user.
         */
        if (silent) {
          console.debug("[Dataverse IDE] User identity was not loaded on startup:", error);

          return;
        }

        const message = error instanceof Error ? error.message : String(error);

        await vscodeBottom.window.showErrorMessage(
          `Dataverse: loading user identity failed: ${message}`,
        );
      }
    }

    const loadUserIdentityCommand = vscodeBottom.commands.registerCommand(
      "dataverseIde.dataverse.loadUserIdentity",
      () => loadUserIdentity(),
    );

    await installDataverseUploadExtension(context.workspaceRootUri);

    void loadUserIdentity({ silent: true });

    return guideRegistration;
  },
} satisfies IdeExtension;
