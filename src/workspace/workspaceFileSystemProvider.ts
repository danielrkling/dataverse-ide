import type * as vscodeType from "vscode";

import {
  FileSystemProviderCapabilities,
  type FileType,
  type IFileChange,
  type IFileDeleteOptions,
  type IFileOverwriteOptions,
  type IFileSystemProviderWithFileReadWriteCapability,
  type IFileWriteOptions,
  type IStat,
  type IWatchOptions,
  type HTMLFileSystemProvider,
} from "@codingame/monaco-vscode-files-service-override";

import type { IFileReadStreamOptions } from "@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files";

import {
  newWriteableStream,
  type ReadableStreamEvents,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/stream";
import type { CancellationToken } from "@codingame/monaco-vscode-api/vscode/vs/base/common/cancellation";

import { OpfsOverlayProvider } from "./opfsOverlay.js";

/*
 * Path-prefix router for the workspace `file` provider.
 *
 * The library's OverlayFileSystemProvider is a "try each delegate until one
 * succeeds" router. It sorts delegates with the OPFS overlay first, so:
 *
 * - every non-overlay operation (src/…, .git/…) first rejects against the
 *   overlay before reaching the real folder
 * - readdir() always queries *both* delegates, and the overlay delegate
 *   internally merges the real folder again
 * - a missing overlay file is retried against the real folder twice (inside
 *   OpfsOverlayProvider's legacy fallback and again by the composite)
 *
 * This router picks exactly one delegate from the path prefix, so:
 *
 * - paths inside an overlay dir (node_modules/…) go straight to OPFS
 * - everything else goes straight to the real folder provider
 * - the workspace root readdir is the only merged operation (the explorer
 *   still has to see OPFS-only node_modules)
 */

type Listener<T> = (value: T) => void;

type DisposableLike = {
  dispose(): unknown;
};

class SimpleEmitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  readonly event = (listener: Listener<T>): DisposableLike => {
    this.listeners.add(listener);

    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class WorkspaceFileSystemProvider implements IFileSystemProviderWithFileReadWriteCapability {
  private readonly changeEmitter = new SimpleEmitter<readonly IFileChange[]>();

  readonly onDidChangeFile = this.changeEmitter.event;

  readonly onDidChangeCapabilities = (_listener: () => void): DisposableLike => ({
    dispose: () => {},
  });

  readonly capabilities =
    FileSystemProviderCapabilities.FileReadWrite |
    FileSystemProviderCapabilities.FileReadStream |
    FileSystemProviderCapabilities.PathCaseSensitive;

  constructor(
    /** Workspace root path, e.g. '/my-folder'. */
    private readonly rootPath: string,
    private readonly real: HTMLFileSystemProvider,
    private readonly overlay: OpfsOverlayProvider,
  ) {
    this.real.onDidChangeFile((changes) => this.changeEmitter.fire(changes));
    this.overlay.onDidChangeFile((changes) => this.changeEmitter.fire(changes));
  }

  private isWorkspaceRoot(uri: vscodeType.Uri): boolean {
    return uri.scheme === "file" && uri.path === this.rootPath;
  }

  private isOverlay(uri: vscodeType.Uri): boolean {
    return this.overlay.overlayKeyFor(uri) != null;
  }

  stat(uri: vscodeType.Uri): Promise<IStat> {
    return this.isOverlay(uri) ? this.overlay.stat(uri) : this.real.stat(uri);
  }

  readdir(uri: vscodeType.Uri): Promise<[string, FileType][]> {
    /*
     * The root listing has to merge real-folder entries with OPFS-only overlay
     * dirs (node_modules normally does not exist on the real folder at all).
     */
    if (this.isWorkspaceRoot(uri)) {
      return this.overlay.readdir(uri);
    }

    return this.isOverlay(uri) ? this.overlay.readdir(uri) : this.real.readdir(uri);
  }

  readFile(uri: vscodeType.Uri): Promise<Uint8Array> {
    return this.isOverlay(uri) ? this.overlay.readFile(uri) : this.real.readFile(uri);
  }

  readFileStream(
    uri: vscodeType.Uri,
    opts: IFileReadStreamOptions,
    token: CancellationToken,
  ): ReadableStreamEvents<Uint8Array> {
    if (!this.isOverlay(uri)) {
      return this.real.readFileStream(uri, opts, token);
    }

    const stream = newWriteableStream<Uint8Array>(
      (chunks) => chunks[chunks.length - 1] ?? new Uint8Array(0),
    );

    void (async () => {
      try {
        if (token?.isCancellationRequested === true) {
          stream.end();
          return;
        }

        let data = await this.overlay.readFile(uri);

        const start = opts.position ?? 0;
        const end = opts.length != null ? start + opts.length : undefined;

        if (start > 0 || end != null) {
          data = data.slice(start, end);
        }

        stream.end(data);
      } catch (error) {
        stream.error(error instanceof Error ? error : new Error(String(error)));
        stream.end();
      }
    })();

    return stream;
  }

  writeFile(uri: vscodeType.Uri, content: Uint8Array, opts: IFileWriteOptions): Promise<void> {
    return this.isOverlay(uri)
      ? this.overlay.writeFile(uri, content, opts)
      : this.real.writeFile(uri, content, opts);
  }

  /**
   * Emits change events for writes performed outside IFileService.
   *
   * Normal `vscode.workspace.fs` writes are observed through the file service
   * (or the browser FileSystemObserver). A caller that reaches the provider
   * directly skips both, so it must publish the change through this method to
   * keep `createFileSystemWatcher` subscribers in sync.
   */
  notifyFileChanges(changes: readonly IFileChange[]): void {
    if (changes.length > 0) {
      this.changeEmitter.fire(changes);
    }
  }

  mkdir(uri: vscodeType.Uri): Promise<void> {
    return this.isOverlay(uri) ? this.overlay.mkdir(uri) : this.real.mkdir(uri);
  }

  delete(uri: vscodeType.Uri, opts: IFileDeleteOptions): Promise<void> {
    return this.isOverlay(uri) ? this.overlay.delete(uri, opts) : this.real.delete(uri, opts);
  }

  async rename(
    from: vscodeType.Uri,
    to: vscodeType.Uri,
    opts: IFileOverwriteOptions,
  ): Promise<void> {
    const fromOverlay = this.isOverlay(from);
    const toOverlay = this.isOverlay(to);

    if (fromOverlay === toOverlay) {
      return (fromOverlay ? this.overlay : this.real).rename(from, to, opts);
    }

    /*
     * Cross-boundary move (for example dragging a package out of
     * node_modules). Copy through the router, then delete the source.
     */
    const content = await this.readFile(from);

    await this.writeFile(to, content, {
      create: true,
      overwrite: opts.overwrite,
      unlock: false,
      atomic: false,
    });

    await this.delete(from, {
      recursive: false,
      useTrash: false,
      atomic: false,
    });
  }

  watch(uri: vscodeType.Uri, opts: IWatchOptions): DisposableLike {
    if (this.isWorkspaceRoot(uri)) {
      const realWatch = this.real.watch(uri, opts);
      const overlayWatch = this.overlay.watch(uri, opts);

      return {
        dispose: () => {
          realWatch.dispose();
          overlayWatch.dispose();
        },
      };
    }

    return this.isOverlay(uri) ? this.overlay.watch(uri, opts) : this.real.watch(uri, opts);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
