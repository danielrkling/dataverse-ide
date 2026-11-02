import type * as vscodeType from "vscode";

/*
 * esbuild watch engine.
 *
 * Dirty editor buffer changes → 300ms debounce → latest-wins (if a build is
 * running, the change is queued and rebuilt after) → build of the configured
 * entry. Saves are still watched so external/tool saves trigger a build.
 *
 * Change and save events are deduplicated per document version: typing starts
 * a build from the live buffer, and the autosave that follows for the same
 * version does not trigger a second identical build.
 *
 * When `watchFileSystem` is enabled, writes made outside the editor (another
 * tool, a generated dependency, etc.) also trigger a build. Open documents
 * are excluded from that path because change/save events already cover them.
 *
 * `getDependencies` narrows every trigger to the last successful build's
 * graph, so editing an unrelated workspace file does not rebuild the bundle.
 *
 * Echo guard: file saves caused by the build itself (outputs written under
 * outDir, plus the config file) are filtered out so watch does not rebuild
 * forever from its own writes.
 */

const DEBOUNCE_MS = 300;

export type WatchEvent = {
  /** Relative path of the changed file, workspace-slash-normalized. */
  path: string;
};

export class EsbuildWatcher {
  private debounceTimer: number | undefined;

  private building = false;

  private pending = false;

  /** Document URI → buffer version used by the most recent build attempt. */
  private builtVersions = new Map<string, number>();

  private dependencyRef: readonly string[] | undefined;

  private dependencySet: Set<string> | undefined;

  private readonly disposables: vscodeType.Disposable[];

  constructor(
    private readonly vscode: typeof vscodeType,
    private readonly rootUri: vscodeType.Uri,
    private readonly options: {
      outDir: () => string;
      /** Exact output files to ignore in addition to `outDir`. */
      outputPaths?: () => string[];
      entry: () => string;
      build: (entry: string) => Promise<void>;
      /**
       * Workspace-relative config file to ignore (may include
       * subdirectories; honors the dataverseIde.<tool>.configPath setting).
       */
      configPath: () => string;

      /**
       * Rebuild as the user types (debounced) instead of waiting for a save.
       * Only enable this for build paths whose readers overlay dirty editor
       * buffers; otherwise the rebuild sees the previous saved content.
       * Defaults to false.
       */
      buildOnChange?: boolean;

      /**
       * Debounce for dirty-buffer changes when buildOnChange is enabled.
       * Defaults to DEBOUNCE_MS. Scanners that walk the whole workspace
       * (Tailwind) use a longer delay than graph-based bundlers.
       */
      changeDebounceMs?: number;

      /**
       * Also rebuild when workspace files are written outside the editor
       * (another tool, a generated dependency, etc.). Uses the browser file
       * watcher where available; when the platform lacks FileSystemObserver
       * this is inert and editor change/save events remain the trigger.
       * Defaults to false.
       */
      watchFileSystem?: boolean;

      /**
       * Current workspace-relative dependency graph. When provided and
       * non-empty, external filesystem events outside this set are ignored;
       * unrelated project files no longer trigger a rebuild. The getter is
       * read lazily so queued builds can update the graph without racing
       * the watcher.
       */
      getDependencies?: () => readonly string[] | undefined;
    },
  ) {
    const rootPath = rootUri.path.replace(/\/+$/, "");

    const isIgnoredPath = (fsPath: string): boolean => {
      const normalized = fsPath.replaceAll("\\", "/");

      const outDir = this.options.outDir().replaceAll("\\", "/").replace(/^\/+/, "");
      const configPath = `${rootPath}/${this.options.configPath().replaceAll("\\", "/").replace(/^\/+/, "")}`;

      if (normalized === configPath) {
        return true;
      }

      if (outDir.length > 0) {
        const outDirAbsolute = `${rootPath}/${outDir.replace(/^\/+/, "")}`;

        if (normalized === outDirAbsolute || normalized.startsWith(`${outDirAbsolute}/`)) {
          return true;
        }
      }

      for (const outputPath of this.options.outputPaths?.() ?? []) {
        const normalizedOutput = outputPath.replaceAll("\\", "/").replace(/^\/+/, "");

        if (normalizedOutput.length > 0 && normalized === `${rootPath}/${normalizedOutput}`) {
          return true;
        }
      }

      return false;
    };

    const isWorkspaceDocument = (document: vscodeType.TextDocument): boolean =>
      document.uri.scheme === "file" &&
      !document.isUntitled &&
      document.uri.path.startsWith(`${rootPath}/`) &&
      !isIgnoredPath(document.uri.path);

    /*
     * With a known dependency graph, unrelated workspace edits are ignored.
     * An empty graph (before the first successful build) accepts everything
     * so watch can recover from a failed initial build.
     */
    const isRelevantPath = (path: string): boolean => {
      this.refreshDependencies();

      if (this.dependencySet == null || this.dependencySet.size === 0) {
        return true;
      }

      const relativePath = (rootPath.length > 0 ? path.slice(rootPath.length) : path).replace(
        /^\/+/,
        "",
      );

      return this.dependencySet.has(relativePath);
    };

    const changeWatcher = this.vscode.workspace.onDidChangeTextDocument((event) => {
      if (this.options.buildOnChange !== true) {
        return;
      }

      /*
       * Only dirty, content-changing events matter. A build can use the live
       * buffer, so waiting for save is unnecessary.
       */
      if (event.contentChanges.length === 0 || !event.document.isDirty) {
        return;
      }

      if (!isWorkspaceDocument(event.document) || !isRelevantPath(event.document.uri.path)) {
        return;
      }

      this.schedule(this.options.changeDebounceMs ?? DEBOUNCE_MS);
    });

    const saveWatcher = this.vscode.workspace.onDidSaveTextDocument((document) => {
      if (!isWorkspaceDocument(document) || !isRelevantPath(document.uri.path)) {
        return;
      }

      /*
       * The buffer version was already built from the live document; don't
       * rebuild just because autosave wrote the same bytes to disk.
       */
      if (this.wasVersionBuilt(document)) {
        this.clearDebounce();
        return;
      }

      this.schedule();
    });

    const disposables: vscodeType.Disposable[] = [changeWatcher, saveWatcher];

    if (this.options.watchFileSystem === true) {
      const fileSystemWatcher = this.vscode.workspace.createFileSystemWatcher(
        new this.vscode.RelativePattern(rootUri, "**/*"),
      );

      const onFileEvent = (uri: vscodeType.Uri): void => {
        if (
          uri.scheme !== "file" ||
          !uri.path.startsWith(`${rootPath}/`) ||
          isIgnoredPath(uri.path)
        ) {
          return;
        }

        if (!isRelevantPath(uri.path)) {
          return;
        }

        /*
         * Open documents are already covered by the change/save listeners;
         * handling their filesystem writes too would rebuild twice.
         */
        if (
          this.vscode.workspace.textDocuments.some(
            (document) => document.uri.toString() === uri.toString(),
          )
        ) {
          return;
        }

        this.schedule(this.options.changeDebounceMs ?? DEBOUNCE_MS);
      };

      fileSystemWatcher.onDidChange(onFileEvent);
      fileSystemWatcher.onDidCreate(onFileEvent);
      fileSystemWatcher.onDidDelete(onFileEvent);

      disposables.push(fileSystemWatcher);
    }

    this.disposables = disposables;
  }

  private refreshDependencies(): void {
    const dependencies = this.options.getDependencies?.();

    if (dependencies == null) {
      this.dependencyRef = undefined;
      this.dependencySet = undefined;
      return;
    }

    if (dependencies !== this.dependencyRef) {
      this.dependencyRef = dependencies;
      this.dependencySet = new Set(
        dependencies.map((path) => path.replaceAll("\\", "/").replace(/^\/+/, "")),
      );
    }
  }

  private wasVersionBuilt(document: vscodeType.TextDocument): boolean {
    if (this.options.buildOnChange !== true) {
      return false;
    }

    const key = document.uri.toString();
    const builtVersion = this.builtVersions.get(key);

    if (builtVersion == null) {
      return false;
    }

    if (builtVersion === document.version) {
      /*
       * The document is no longer dirty after a save. Drop the entry so a
       * later unrelated change with a reused version cannot be skipped.
       */
      if (!document.isDirty) {
        this.builtVersions.delete(key);
      }

      return true;
    }

    this.builtVersions.delete(key);

    return false;
  }

  private rememberBuiltVersions(): void {
    if (this.options.buildOnChange !== true) {
      this.builtVersions.clear();
      return;
    }

    const versions = new Map<string, number>();

    for (const document of this.vscode.workspace.textDocuments) {
      if (document.uri.scheme !== "file" || document.isUntitled || !document.isDirty) {
        continue;
      }

      versions.set(document.uri.toString(), document.version);
    }

    this.builtVersions = versions;
  }

  private clearDebounce(): void {
    if (this.debounceTimer != null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }

  private schedule(delayMs: number = DEBOUNCE_MS): void {
    this.clearDebounce();

    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = undefined;
      void this.run();
    }, delayMs);
  }

  private async run(): Promise<void> {
    if (this.building) {
      /*
       * A build is in flight: mark a pending rebuild (latest-wins) instead
       * of stacking concurrent builds.
       */
      this.pending = true;
      return;
    }

    this.building = true;

    try {
      do {
        this.pending = false;
        this.rememberBuiltVersions();
        await this.options.build(this.options.entry());
      } while (this.pending);
    } finally {
      this.building = false;
    }
  }

  /** Whether a build is currently executing or pending. */
  get busy(): boolean {
    return this.building || this.pending;
  }

  dispose(): void {
    this.clearDebounce();

    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    this.builtVersions.clear();
    this.dependencyRef = undefined;
    this.dependencySet = undefined;
  }
}
