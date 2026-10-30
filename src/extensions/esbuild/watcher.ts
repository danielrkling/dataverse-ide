import type * as vscodeType from "vscode";

/*
 * esbuild watch engine.
 *
 * Save events → 300ms debounce → latest-wins (if a build is running, the
 * change is queued and rebuilt after) → build of the configured entry.
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

  private readonly disposable: vscodeType.Disposable;

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

    const saveWatcher = this.vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.uri.scheme !== "file") {
        return;
      }

      if (!document.uri.path.startsWith(`${rootPath}/`)) {
        return;
      }

      if (isIgnoredPath(document.uri.path)) {
        return;
      }

      this.schedule();
    });

    this.disposable = saveWatcher;
  }

  private schedule(): void {
    if (this.debounceTimer != null) {
      window.clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = undefined;
      void this.run();
    }, DEBOUNCE_MS);
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
    if (this.debounceTimer != null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }

    this.disposable.dispose();
  }
}
