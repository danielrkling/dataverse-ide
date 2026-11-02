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

  private readonly disposables: vscodeType.Disposable[];

  constructor(
    private readonly vscode: typeof vscodeType,
    private readonly rootUri: vscodeType.Uri,
    private readonly options: {
      outDir: () => string;
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

      return false;
    };

    const isWorkspaceDocument = (document: vscodeType.TextDocument): boolean =>
      document.uri.scheme === "file" &&
      !document.isUntitled &&
      document.uri.path.startsWith(`${rootPath}/`) &&
      !isIgnoredPath(document.uri.path);

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

      if (!isWorkspaceDocument(event.document)) {
        return;
      }

      this.schedule(this.options.changeDebounceMs ?? DEBOUNCE_MS);
    });

    const saveWatcher = this.vscode.workspace.onDidSaveTextDocument((document) => {
      if (!isWorkspaceDocument(document)) {
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

    this.disposables = [changeWatcher, saveWatcher];
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
  }
}
