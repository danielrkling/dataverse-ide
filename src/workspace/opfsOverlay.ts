import type * as vscodeType from "vscode";
import * as vscode from "vscode";
import {
  FileChangeType,
  FileSystemProviderCapabilities,
  FileSystemProviderErrorCode,
  FileType,
  type IFileChange,
  type IFileDeleteOptions,
  type IFileOverwriteOptions,
  type IFileSystemProviderWithFileReadWriteCapability,
  type IFileWriteOptions,
  type IStat,
  type IWatchOptions,
} from "@codingame/monaco-vscode-files-service-override";
import { createFileSystemProviderError } from "@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files";
import { contributeExtensionManifest } from "../extensions/api.js";

/*
 * OPFS-backed overlay for selected top-level workspace directories.
 *
 * Purpose: keep stores that generate huge numbers of .js files (by default
 * `node_modules`) out of the real workspace folder. When the workspace lives
 * under a OneDrive-synced directory, OneDrive syncs/flags those files, which
 * breaks installs.
 *
 * Architecture:
 * - `fsProvider.ts` builds an OverlayFileSystemProvider for the `file`
 *   scheme with two delegates: the HTMLFileSystemProvider (real folder,
 *   priority 1) and this provider (priority 2, wins inside overlay dirs).
 * - Reads inside an overlay dir prefer OPFS and fall back to the real folder
 *   (legacy content keeps working without a migration step).
 * - Writes inside an overlay dir land in OPFS only - the real folder is
 *   never touched for overlay paths.
 * - Deletes remove the OPFS entry and also the matching real entry, so a
 *   merged readdir cannot resurrect stale legacy files.
 * - Everything else (paths outside the overlay dirs) falls straight through
 *   to the real-folder delegate.
 *
 * Configuration: `dataverseIde.overlayDirs` (default ["node_modules"]); see
 * ensureOverlayDirsSetting() below.
 */

export const OVERLAY_SETTING_SECTION = "dataverseIde";
export const OVERLAY_SETTING_KEY = "overlayDirs";

/** Top-level workspace directories persisted in OPFS instead of on disk. */
export const DEFAULT_OVERLAY_DIRS = ["node_modules"];

const OPFS_ROOT_DIR = "dataverse-ide-overlay";

const OVERLAY_DIRS_TTL_MS = 30_000;

type Listener<T> = (e: T) => void;

type DisposableLike = {
  dispose(): unknown;
};

class SimpleEmitter<T> {
  private listeners = new Set<Listener<T>>();

  readonly event: (listener: Listener<T>) => DisposableLike = (listener) => {
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

function isNotFoundError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "NotFoundError";
}

/*
 * The File System Access API throws NotTypeMismatchError ("The path supplied
 * exists, but was not an entry of requested type") when a name is looked up
 * as a file but exists as a directory, or the other way around. Package
 * layouts routinely hit this (a package name can be both a file and a
 * directory at different points), so treat mismatches as "exists as the
 * other Kind" and fall through instead of leaking the DOM error.
 */
function isTypeMismatchError(error: unknown): boolean {
  if (!(error instanceof DOMException)) {
    return false;
  }

  return (
    error.name === "TypeMismatchError" ||
    error.name === "InvalidModificationError" ||
    /not an entry of requested type/i.test(error.message)
  );
}

function notFound(uri: vscodeType.Uri): never {
  throw createFileSystemProviderError(
    `No such entry: ${uri.toString()}`,
    FileSystemProviderErrorCode.FileNotFound,
  );
}

function notAllowed(message: string): never {
  throw createFileSystemProviderError(message, FileSystemProviderErrorCode.NoPermissions);
}

function fileIsADirectory(uri: vscodeType.Uri): never {
  throw createFileSystemProviderError(
    `Entry is a directory: ${uri.toString()}`,
    FileSystemProviderErrorCode.FileIsADirectory,
  );
}

/*
 * Current overlay directory names, mirrored from the vscode setting.
 * Re-read when a configuration change arrives; also invalidated after a TTL
 * in case the configuration service was not alive yet on the first query.
 */
let cachedOverlayDirs: string[] = DEFAULT_OVERLAY_DIRS;
let cachedOverlayDirsAt = 0;

function sanitizeOverlayDirs(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const names: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }

    const normalized = entry.trim();

    if (
      normalized.length === 0 ||
      normalized === "." ||
      normalized === ".." ||
      normalized.includes("/") ||
      normalized.includes("\\")
    ) {
      continue;
    }

    names.push(normalized);
  }

  return names;
}

export function getOverlayDirs(): string[] {
  const now = Date.now();

  if (now - cachedOverlayDirsAt < OVERLAY_DIRS_TTL_MS) {
    return cachedOverlayDirs;
  }

  let resolved: string[] | null = null;

  try {
    resolved = sanitizeOverlayDirs(
      vscode.workspace.getConfiguration(OVERLAY_SETTING_SECTION).get<string[]>(OVERLAY_SETTING_KEY),
    );
  } catch {
    /*
     * The configuration service may not be running yet (this can be queried
     * while the workbench is still initializing); keep the default.
     */
  }

  if (resolved != null) {
    cachedOverlayDirs = resolved;
  }

  cachedOverlayDirsAt = now;

  return cachedOverlayDirs;
}

/** Clears the cached setting so the next call re-reads configuration. */
export function resetOverlayDirsCache(): void {
  cachedOverlayDirs = DEFAULT_OVERLAY_DIRS;
  cachedOverlayDirsAt = 0;
}

type OverlayEntry =
  | { kind: "file"; handle: FileSystemFileHandle }
  | { kind: "directory"; handle: FileSystemDirectoryHandle };

class OpfsWorkspace {
  private rootPromise?: Promise<FileSystemDirectoryHandle>;

  constructor(readonly handle: FileSystemDirectoryHandle) {}

  get root(): Promise<FileSystemDirectoryHandle> {
    if (this.rootPromise == null) {
      this.rootPromise = (async () => {
        const opfsRoot = await navigator.storage.getDirectory();
        const overlayRoot = await opfsRoot.getDirectoryHandle(OPFS_ROOT_DIR, {
          create: true,
        });

        /*
         * Namespace the cache by workspace kind: OPFS-native workspaces live
         * directly under the OPFS root, local folders are keyed explicitly,
         * so a local folder and an OPFS workspace with the same display name
         * do not share one dependency cache.
         */
        let workspaceKey = `local:${this.handle.name}`;

        try {
          const candidate = await opfsRoot.getDirectoryHandle(this.handle.name);

          if (await candidate.isSameEntry(this.handle)) {
            workspaceKey = `opfs:${this.handle.name}`;
          }
        } catch {
          // Not an OPFS-native workspace (or the name vanished); use local.
        }

        return overlayRoot.getDirectoryHandle(workspaceKey, {
          create: true,
        });
      })();
    }

    return this.rootPromise;
  }
}

/*
 * Resolve an overlay-relative path ('node_modules/pkg/lib/x.js') inside one
 * directory handle to an entry, or undefined when missing.
 */
async function lookupIn(
  start: FileSystemDirectoryHandle,
  key: string,
  { createParents = false }: { createParents?: boolean } = {},
): Promise<OverlayEntry | undefined> {
  const segments = key.split("/").filter(Boolean);

  if (segments.length === 0) {
    return { kind: "directory", handle: start };
  }

  let current: FileSystemDirectoryHandle = start;

  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index];

    if (createParents) {
      current = await ensureDirectory(current, segment);
      continue;
    }

    try {
      current = await current.getDirectoryHandle(segment);
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined;
      }

      if (isTypeMismatchError(error)) {
        /*
         * The segment exists but is a file; resolve to the file entry.
         */
        try {
          return {
            kind: "file",
            handle: await current.getFileHandle(segment),
          };
        } catch {
          return undefined;
        }
      }

      throw error;
    }
  }

  const last = segments[segments.length - 1];

  try {
    return {
      kind: "directory",
      handle: await current.getDirectoryHandle(last),
    };
  } catch (error) {
    if (isNotFoundError(error)) {
      // Fall through to the file lookup below.
    } else if (isTypeMismatchError(error)) {
      // 'last' exists but is a file; resolve the file entry.
      try {
        return {
          kind: "file",
          handle: await current.getFileHandle(last),
        };
      } catch {
        return undefined;
      }
    } else {
      throw error;
    }
  }

  try {
    return {
      kind: "file",
      handle: await current.getFileHandle(last),
    };
  } catch {
    return undefined;
  }
}

/**
 * getDirectoryHandle(..., {create:true}) but resilient to a file already
 * occupying the name (replaces it, matching install-overwrite semantics).
 */
async function ensureDirectory(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemDirectoryHandle> {
  try {
    return await parent.getDirectoryHandle(name, { create: true });
  } catch (error) {
    if (!isTypeMismatchError(error)) {
      throw error;
    }

    /*
     * A file occupies the name; clear it so the directory can be created.
     */
    try {
      await parent.removeEntry(name);
    } catch {
      throw new Error(
        `Cannot create directory "${name}": entry already exists as a file and could not be replaced.`,
      );
    }

    return parent.getDirectoryHandle(name, { create: true });
  }
}

async function parentOf(
  start: FileSystemDirectoryHandle,
  key: string,
  { create = false }: { create?: boolean } = {},
): Promise<FileSystemDirectoryHandle> {
  const segments = key.split("/").filter(Boolean).slice(0, -1);

  let current: FileSystemDirectoryHandle = start;

  for (const segment of segments) {
    if (create) {
      current = await ensureDirectory(current, segment);
      continue;
    }

    try {
      current = await current.getDirectoryHandle(segment);
    } catch (error) {
      if (isNotFoundError(error) || isTypeMismatchError(error)) {
        throw createFileSystemProviderError(
          `Missing parent directory in the OPFS overlay: ${segment}`,
          FileSystemProviderErrorCode.FileNotFound,
        );
      }

      throw error;
    }
  }

  return current;
}

async function statEntry(entry: OverlayEntry): Promise<IStat> {
  if (entry.kind === "directory") {
    return {
      type: FileType.Directory,
      ctime: 0,
      mtime: 0,
      size: 0,
    };
  }

  const file = await entry.handle.getFile();

  return {
    type: FileType.File,
    ctime: file.lastModified,
    mtime: file.lastModified,
    size: file.size,
  };
}

async function readEntry(entry: OverlayEntry): Promise<Uint8Array> {
  if (entry.kind !== "file") {
    throw new Error("Entry is a directory.");
  }

  return new Uint8Array(await (await entry.handle.getFile()).arrayBuffer());
}

async function readdirInto(
  start: FileSystemDirectoryHandle,
  key: string,
  merged: Map<string, FileType>,
): Promise<void> {
  const entry = await lookupIn(start, key);

  if (entry?.kind !== "directory") {
    return;
  }

  for await (const child of entry.handle.values()) {
    merged.set(child.name, child.kind === "file" ? FileType.File : FileType.Directory);
  }
}

async function deleteIn(
  start: FileSystemDirectoryHandle,
  key: string,
  recursive: boolean,
): Promise<boolean> {
  const segments = key.split("/").filter(Boolean);

  if (segments.length === 0) {
    return false;
  }

  let parent = start;

  for (let index = 0; index < segments.length - 1; index++) {
    try {
      parent = await parent.getDirectoryHandle(segments[index]);
    } catch {
      return false;
    }
  }

  try {
    await parent.removeEntry(segments[segments.length - 1], {
      recursive,
    });

    return true;
  } catch {
    return false;
  }
}

export class OpfsOverlayProvider implements IFileSystemProviderWithFileReadWriteCapability {
  private readonly workspace: OpfsWorkspace;

  private readonly changeEmitter = new SimpleEmitter<readonly IFileChange[]>();

  private pendingChanges = new Map<string, { type: FileChangeType; resource: vscodeType.Uri }>();

  private fireSoonTimer: number | undefined;

  constructor(
    private readonly workspaceHandle: FileSystemDirectoryHandle,
    /** Workspace root path, e.g. '/my-folder' (rootUri.path). */
    private readonly workspaceRootPath: string,
  ) {
    this.workspace = new OpfsWorkspace(workspaceHandle);
  }

  /*
   * Overlay-relative key ('node_modules/…') for a workspace URI, or null when
   * the URI is outside the overlay.
   */
  private overlayKeyFor(uri: vscodeType.Uri): string | null {
    if (uri.scheme !== "file") {
      return null;
    }

    if (!(
      uri.path === this.workspaceRootPath || uri.path.startsWith(`${this.workspaceRootPath}/`)
    )) {
      return null;
    }

    const relative =
      uri.path === this.workspaceRootPath ? "" : uri.path.slice(this.workspaceRootPath.length + 1);

    const segments = relative.split("/").filter(Boolean);

    if (segments.length === 0) {
      return null;
    }

    const first = segments[0];

    const matched = getOverlayDirs().find((dir) => dir.toLowerCase() === first.toLowerCase());

    if (matched == null) {
      return null;
    }

    return segments.join("/");
  }

  private fireSoon(type: FileChangeType, resource: vscodeType.Uri): void {
    this.pendingChanges.set(resource.toString(), { type, resource });

    if (this.fireSoonTimer != null) {
      window.clearTimeout(this.fireSoonTimer);
    }

    this.fireSoonTimer = window.setTimeout(() => {
      const changes = [...this.pendingChanges.values()];

      this.pendingChanges.clear();
      this.fireSoonTimer = undefined;

      if (changes.length > 0) {
        this.changeEmitter.fire(changes);
      }
    }, 10);
  }

  readonly onDidChangeFile: (listener: Listener<readonly IFileChange[]>) => DisposableLike =
    this.changeEmitter.event;

  readonly onDidChangeCapabilities: (listener: Listener<void>) => DisposableLike = () => ({
    dispose: () => {},
  });

  get capabilities(): FileSystemProviderCapabilities {
    return (
      FileSystemProviderCapabilities.FileReadWrite |
      FileSystemProviderCapabilities.PathCaseSensitive
    );
  }

  private isWorkspaceRoot(uri: vscodeType.Uri): boolean {
    return uri.scheme === "file" && uri.path === this.workspaceRootPath;
  }

  async stat(uri: vscodeType.Uri): Promise<IStat> {
    if (this.isWorkspaceRoot(uri)) {
      return {
        type: FileType.Directory,
        ctime: 0,
        mtime: 0,
        size: 0,
      };
    }

    const overlayKey = this.overlayKeyFor(uri);

    if (overlayKey == null) {
      notFound(uri);
    }

    try {
      const entry = await lookupIn(await this.workspace.root, overlayKey);

      if (entry != null) {
        return statEntry(entry);
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    /*
     * Legacy real-folder fallback: the entry has not been migrated into the
     * OPFS overlay yet, so report the real entry.
     */
    const legacy = await lookupIn(this.workspaceHandle, overlayKey);

    if (legacy == null) {
      notFound(uri);
    }

    return statEntry(legacy);
  }

  async readdir(uri: vscodeType.Uri): Promise<[string, FileType][]> {
    if (this.isWorkspaceRoot(uri)) {
      /*
       * The file explorer lists the workspace root through this provider
       * (it wins the delegate chain), so the root listing must include the
       * real folder contents PLUS the overlay directories that only exist
       * in OPFS (e.g. node_modules): the real folder legitimately has no
       * such entries since overlay writes never touch it.
       */
      const merged = new Map<string, FileType>();

      for await (const child of this.workspaceHandle.values()) {
        merged.set(child.name, child.kind === "file" ? FileType.File : FileType.Directory);
      }

      const opfsRoot = await this.workspace.root;

      for (const dir of getOverlayDirs()) {
        const entry = await lookupIn(opfsRoot, dir);

        if (entry?.kind === "directory") {
          merged.set(dir, FileType.Directory);
          continue;
        }

        try {
          await this.workspaceHandle.getDirectoryHandle(dir);

          merged.set(dir, FileType.Directory);
        } catch {
          // Neither OPFS nor the real folder has this overlay directory.
        }
      }

      return [...merged.entries()];
    }

    const overlayKey = this.overlayKeyFor(uri);

    if (overlayKey == null) {
      notFound(uri);
    }

    /*
     * Merge legacy real-folder entries with OPFS entries (OPFS wins), so
     * replacements hide their stale legacy file from disk while
     * un-migrated content keeps working.
     */
    const merged = new Map<string, FileType>();

    await readdirInto(this.workspaceHandle, overlayKey, merged);
    await readdirInto(await this.workspace.root, overlayKey, merged);

    if (merged.size === 0) {
      const exists =
        (await lookupIn(await this.workspace.root, overlayKey))?.kind === "directory" ||
        (await lookupIn(this.workspaceHandle, overlayKey))?.kind === "directory";

      if (!exists) {
        notFound(uri);
      }
    }

    return [...merged.entries()];
  }

  async readFile(uri: vscodeType.Uri): Promise<Uint8Array> {
    const overlayKey = this.overlayKeyFor(uri);

    if (overlayKey == null) {
      notFound(uri);
    }

    try {
      const entry = await lookupIn(await this.workspace.root, overlayKey);

      if (entry != null) {
        if (entry.kind === "directory") {
          fileIsADirectory(uri);
        }

        return await readEntry(entry);
      }
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    const legacy = await lookupIn(this.workspaceHandle, overlayKey);

    if (legacy == null) {
      notFound(uri);
    }

    if (legacy.kind === "directory") {
      fileIsADirectory(uri);
    }

    return readEntry(legacy);
  }

  async writeFile(
    uri: vscodeType.Uri,
    content: Uint8Array,
    opts: IFileWriteOptions,
  ): Promise<void> {
    const overlayKey = this.overlayKeyFor(uri);

    if (overlayKey == null) {
      notFound(uri);
    }

    if (opts.create === false && !opts.overwrite) {
      const existing = await lookupIn(await this.workspace.root, overlayKey);

      if (existing == null) {
        /*
         * Guard mirrored from the html provider: honor the "create: false"
         * contract of the overlay contract for entries the overlay owns.
         */
        notFound(uri);
      }
    }

    await this.writeOpfsFile(uri, overlayKey, content);
  }

  private async writeOpfsFile(
    uri: vscodeType.Uri,
    overlayKey: string,
    content: Uint8Array,
  ): Promise<void> {
    const parent = await parentOf(await this.workspace.root, overlayKey, { create: true });

    const name = overlayKey.split("/").pop()!;

    let handle: FileSystemFileHandle;

    try {
      handle = await parent.getFileHandle(name, {
        create: true,
      });
    } catch (error) {
      if (!isTypeMismatchError(error)) {
        throw error;
      }

      /*
       * A directory occupies the name where a file must be written (package
       * layouts flip file/dir between versions). Replace the directory,
       * matching npm overwrite semantics.
       */
      try {
        await parent.removeEntry(name, { recursive: true });
      } catch {
        throw new Error(
          `Cannot write "${overlayKey}": a directory already exists at that path and could not be replaced.`,
        );
      }

      handle = await parent.getFileHandle(name, {
        create: true,
      });
    }

    const writable = await handle.createWritable({
      keepExistingData: false,
    });

    try {
      await writable.write(content as Uint8Array<ArrayBuffer>);

      await writable.close();
    } catch (error) {
      throw new Error(`Failed to write to the OPFS overlay: ${uri.toString()}`, {
        cause: error,
      });
    }

    this.fireSoon(FileChangeType.UPDATED, uri);
  }

  async mkdir(uri: vscodeType.Uri): Promise<void> {
    const overlayKey = this.overlayKeyFor(uri);

    if (overlayKey == null) {
      notFound(uri);
    }

    const parent = await parentOf(await this.workspace.root, overlayKey, { create: true });

    const name = overlayKey.split("/").pop()!;

    await ensureDirectory(parent, name);

    this.fireSoon(FileChangeType.ADDED, uri);
  }

  async delete(uri: vscodeType.Uri, opts: IFileDeleteOptions): Promise<void> {
    const overlayKey = this.overlayKeyFor(uri);

    if (overlayKey == null) {
      notFound(uri);
    }

    await deleteIn(await this.workspace.root, overlayKey, Boolean(opts.recursive));

    /*
     * Also drop the matching legacy real-folder entry, otherwise the merged
     * readdir would bring it back from disk.
     */
    await deleteIn(this.workspaceHandle, overlayKey, Boolean(opts.recursive));

    this.fireSoon(FileChangeType.DELETED, uri);
  }

  async rename(
    from: vscodeType.Uri,
    to: vscodeType.Uri,
    opts: IFileOverwriteOptions,
  ): Promise<void> {
    const fromKey = this.overlayKeyFor(from);
    const toKey = this.overlayKeyFor(to);

    if (fromKey == null) {
      notFound(from);
    }

    if (toKey == null) {
      notAllowed(
        "Renaming out of the OPFS overlay is not supported: " + `${fromKey} -> ${to.toString()}`,
      );
    }

    const entry = await lookupIn(await this.workspace.root, fromKey);

    if (entry == null) {
      notFound(from);
    }

    if (entry.kind === "directory") {
      await this.copyDirectoryRecursively(entry.handle, toKey);

      await deleteIn(await this.workspace.root, fromKey, true);
    } else {
      const content = await readEntry(entry);

      await this.writeOpfsFile(to, toKey, content);

      await deleteIn(await this.workspace.root, fromKey, false);
    }

    this.fireSoon(FileChangeType.DELETED, from);
    this.fireSoon(FileChangeType.ADDED, to);
  }

  private async copyDirectoryRecursively(
    source: FileSystemDirectoryHandle,
    toKey: string,
  ): Promise<void> {
    for await (const child of source.values()) {
      const childKey = `${toKey}/${child.name}`;

      if (child.kind === "file") {
        const file = await (child as FileSystemFileHandle).getFile();

        await this.writeOpfsFile(
          this.toUriForOverlayPath(childKey),
          childKey,
          new Uint8Array(await file.arrayBuffer()),
        );
      } else {
        await this.copyDirectoryRecursively(child as FileSystemDirectoryHandle, childKey);
      }
    }
  }

  private toUriForOverlayPath(overlayKey: string): vscodeType.Uri {
    return vscode.Uri.joinPath(vscode.Uri.file(this.workspaceRootPath), ...overlayKey.split("/"));
  }

  watch(_resource: vscodeType.Uri, _opts: IWatchOptions): DisposableLike {
    /*
     * Watching is event-driven: writes performed through this provider emit
     * change events via onDidChangeFile (see fireSoon), and the
     * OverlayFileSystemProvider aggregates them with the real folder
     * provider's own watcher.
     */
    return {
      dispose: () => {},
    };
  }

  dispose(): void {
    if (this.fireSoonTimer != null) {
      window.clearTimeout(this.fireSoonTimer);
    }

    this.changeEmitter.dispose();
  }
}

export async function ensureOverlayDirsSetting(): Promise<void> {
  await contributeExtensionManifest({
    id: "workspace-overlay",
    displayName: "Dataverse IDE Workspace Overlay",
    description:
      "Persist top-level workspace directories in the browser (OPFS) instead of the real workspace folder.",
    commands: [],
    configuration: {
      title: "Dataverse IDE Workspace Overlay",
      properties: {
        [`${OVERLAY_SETTING_SECTION}.${OVERLAY_SETTING_KEY}`]: {
          type: "array",
          items: {
            type: "string",
          },
          default: DEFAULT_OVERLAY_DIRS,
          markdownDescription:
            'Top-level workspace directories served from browser storage (OPFS) instead of the real workspace folder. Default: `["node_modules"]`.',
          description:
            "Top-level workspace directories served from browser storage (OPFS) instead of the real workspace folder.",
        },
      },
    },
  });

  vscode.workspace.onDidChangeConfiguration((event) => {
    if (
      event.affectsConfiguration(OVERLAY_SETTING_KEY) ||
      event.affectsConfiguration(OVERLAY_SETTING_SECTION)
    ) {
      resetOverlayDirsCache();
    }
  });
}
