/*
 * Node-style fs implementation for the direct-fs runtime.
 *
 * Sync calls are served from an in-memory cache populated by the loader
 * (module reads) and by the async fs API. A cache miss throws
 * MissingPathError; the engine hydrates the path through
 * vscode.workspace.fs and retries the run. That keeps CJS `require` and
 * `readFileSync` working without a full workspace mirror.
 *
 * Async calls go straight to vscode.workspace.fs.
 *
 * Sync writes are recorded in an overlay and flushed to the workspace when
 * the run finishes, so `fs.writeFileSync(...)` persists like Node.
 */

import { Buffer } from "buffer";

import type * as vscodeType from "vscode";

import type { WorkspaceFs } from "./workspace.js";
import { basename, dirname, normalizePath } from "./workspace.js";

type PathLike = string | URL | Uint8Array;

type Operation = "read" | "stat" | "readdir";

export class MissingPathError extends Error {
  constructor(
    readonly path: string,
    readonly operation: Operation,
  ) {
    super(
      `Path "${path}" is not cached yet (${operation}). ` +
        "The runtime will hydrate it and retry.",
    );
    this.name = "MissingPathError";
  }
}

type FileStat = vscodeType.FileStat;

type DirEntries = Set<string>;

type OverlayOperation =
  | { kind: "write"; path: string; bytes: Uint8Array }
  | { kind: "mkdir"; path: string }
  | { kind: "delete"; path: string; recursive: boolean }
  | { kind: "rename"; from: string; to: string };

export type FlushResult = {
  applied: number;
  errors: string[];
};

export type RuntimeFs = {
  fs: Record<string, unknown>;
  promises: Record<string, unknown>;
  hydrate: (path: string, operation: Operation) => Promise<boolean>;
  flush: () => Promise<FlushResult>;
};

const DIRECTORY = 2;

function pathError(code: string, syscall: string, path: string): Error {
  const errno: Record<string, number> = {
    ENOENT: -2,
    ENOTDIR: -20,
    EISDIR: -21,
    EEXIST: -17,
    ENOTEMPTY: -39,
  };

  const description: Record<string, string> = {
    ENOENT: "no such file or directory",
    ENOTDIR: "not a directory",
    EISDIR: "is a directory",
    EEXIST: "file already exists",
    ENOTEMPTY: "directory not empty",
  };

  const error = new Error(
    `${code}: ${description[code] ?? "filesystem error"}, ${syscall} '${path}'`,
  ) as Error & { code: string; errno: number; syscall: string; path: string };

  error.code = code;
  error.errno = errno[code] ?? -1;
  error.syscall = syscall;
  error.path = path;

  return error;
}

function notFound(path: string, syscall = "stat"): Error {
  return pathError("ENOENT", syscall, path);
}

function toPath(pathLike: PathLike, cwd: string): string {
  let value: string;

  if (typeof pathLike === "string") {
    value = pathLike;
  } else if (pathLike instanceof URL) {
    if (pathLike.protocol !== "file:") {
      throw new Error(`Unsupported URL protocol: ${pathLike.protocol}`);
    }

    value = decodeURIComponent(pathLike.pathname);
  } else if (pathLike instanceof Uint8Array) {
    value = Buffer.from(pathLike).toString("utf8");
  } else {
    value = String(pathLike);
  }

  value = value.replaceAll("\\", "/");

  if (!value.startsWith("/")) {
    const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
    value = `${base}${value}`;
  }

  return normalizePath(value);
}

function encodingOf(options?: string | { encoding?: string | null } | null): string | undefined {
  if (typeof options === "string") {
    return options === "buffer" ? undefined : options;
  }

  return options?.encoding === "buffer" ? undefined : (options?.encoding ?? undefined);
}

function encodeData(data: string | Uint8Array, encoding?: string): Uint8Array {
  if (typeof data === "string") {
    return Buffer.from(data, encoding ?? "utf8");
  }

  return new Uint8Array(data);
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes);
}

class RuntimeStats {
  readonly mode: number;
  readonly size: number;
  readonly mtime: Date;
  readonly atime: Date;
  readonly ctime: Date;
  readonly birthtime: Date;
  readonly mtimeMs: number;
  readonly atimeMs: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;
  readonly nlink = 1;
  readonly uid = 0;
  readonly gid = 0;
  readonly dev = 0;
  readonly ino = 0;
  readonly rdev = 0;
  readonly blksize = 4096;
  readonly blocks: number;

  constructor(
    private readonly directory: boolean,
    stat?: FileStat,
    size?: number,
  ) {
    const now = Date.now();
    const mtime = stat?.mtime ?? now;
    const ctime = stat?.ctime ?? mtime;

    this.mode = directory ? 0o755 : 0o644;
    this.size = size ?? stat?.size ?? 0;
    this.mtime = new Date(mtime);
    this.atime = new Date(mtime);
    this.ctime = new Date(ctime);
    this.birthtime = new Date(ctime);
    this.mtimeMs = mtime;
    this.atimeMs = mtime;
    this.ctimeMs = ctime;
    this.birthtimeMs = ctime;
    this.blocks = Math.ceil(this.size / 512);
  }

  isFile(): boolean {
    return !this.directory;
  }

  isDirectory(): boolean {
    return this.directory;
  }

  isSymbolicLink(): boolean {
    return false;
  }

  isBlockDevice(): boolean {
    return false;
  }

  isCharacterDevice(): boolean {
    return false;
  }

  isFIFO(): boolean {
    return false;
  }

  isSocket(): boolean {
    return false;
  }
}

class RuntimeDirent {
  constructor(
    readonly name: string,
    private readonly directory: boolean,
    private readonly file: boolean,
  ) {}

  isDirectory(): boolean {
    return this.directory;
  }

  isFile(): boolean {
    return this.file;
  }

  isSymbolicLink(): boolean {
    return false;
  }

  isBlockDevice(): boolean {
    return false;
  }

  isCharacterDevice(): boolean {
    return false;
  }

  isFIFO(): boolean {
    return false;
  }

  isSocket(): boolean {
    return false;
  }
}

type FileDescriptor = {
  path: string;
  position: number;
  flags: string;
  content: Uint8Array;
};

export function createRuntimeFs(options: { reader: WorkspaceFs; cwd?: string }): RuntimeFs {
  const { reader } = options;
  const cwd = options.cwd ?? "/";

  const files = new Map<string, Uint8Array>();
  const stats = new Map<string, FileStat>();
  const directories = new Map<string, DirEntries>();
  const hydratedDirectories = new Set<string>();
  const absent = new Set<string>();
  const deleted = new Set<string>();
  const overlay: OverlayOperation[] = [];

  const descriptors = new Map<number, FileDescriptor>();
  let nextDescriptor = 3;

  const constants = {
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
  };

  function resolvePath(pathLike: PathLike): string {
    return toPath(pathLike, cwd);
  }

  function ensureDirectory(path: string): void {
    const normalized = normalizePath(path);
    const parts = normalized.length === 0 ? [] : normalized.split("/");
    let current = "";

    if (!directories.has("")) {
      directories.set("", new Set());
    }

    for (const part of parts) {
      const parent = current;
      current = current.length === 0 ? part : `${current}/${part}`;

      if (!directories.has(current)) {
        directories.set(current, new Set());
        if (!stats.has(current)) {
          stats.set(current, {
            type: DIRECTORY,
            ctime: Date.now(),
            mtime: Date.now(),
            size: 0,
          });
        }
      }

      directories.get(parent)?.add(part);
    }
  }

  function unlinkFromParent(path: string): void {
    const parent = dirname(path);
    directories.get(parent)?.delete(basename(path));
  }

  function removeSubtree(path: string): void {
    const prefix = path.length === 0 ? "" : `${path}/`;

    for (const key of [...files.keys()]) {
      if (key === path || key.startsWith(prefix)) {
        files.delete(key);
      }
    }

    for (const key of [...stats.keys()]) {
      if (key === path || key.startsWith(prefix)) {
        stats.delete(key);
      }
    }

    for (const key of [...directories.keys()]) {
      if (key === path || key.startsWith(prefix)) {
        directories.delete(key);
      }
    }

    hydratedDirectories.delete(path);
    unlinkFromParent(path);
  }

  function learnFile(path: string, bytes: Uint8Array, stat?: FileStat): void {
    const normalized = normalizePath(path);

    files.set(normalized, bytes);
    deleted.delete(normalized);
    absent.delete(normalized);

    if (stat != null) {
      stats.set(normalized, stat);
    } else if (!stats.has(normalized)) {
      stats.set(normalized, {
        type: 1,
        ctime: Date.now(),
        mtime: Date.now(),
        size: bytes.length,
      });
    }

    ensureDirectory(dirname(normalized));
  }

  function learnDirectory(path: string, entries: Array<[string, vscodeType.FileType]>): void {
    const normalized = normalizePath(path);

    ensureDirectory(normalized);

    const set = directories.get(normalized) ?? new Set<string>();
    directories.set(normalized, set);
    hydratedDirectories.add(normalized);

    for (const [name, type] of entries) {
      set.add(name);

      const child = normalized.length === 0 ? name : `${normalized}/${name}`;

      if ((type & DIRECTORY) !== 0) {
        ensureDirectory(child);
      }
    }
  }

  /*
   * Drop queued sync writes/deletes for a path before an async operation
   * writes through to the workspace directly. Otherwise replaying the
   * overlay at flush time could undo the async result.
   */
  function discardOverlayFor(...paths: string[]): void {
    for (let index = overlay.length - 1; index >= 0; index -= 1) {
      const operation = overlay[index];
      const touched =
        operation.kind === "rename"
          ? paths.includes(operation.from) || paths.includes(operation.to)
          : paths.includes(operation.path);

      if (touched) {
        overlay.splice(index, 1);
      }
    }
  }

  async function hydrate(path: string, operation: Operation): Promise<boolean> {
    const normalized = normalizePath(path);

    if (deleted.has(normalized) || absent.has(normalized)) {
      return false;
    }

    const stat = await reader.stat(normalized);

    if (stat == null) {
      absent.add(normalized);
      return false;
    }

    absent.delete(normalized);
    stats.set(normalized, stat);

    if ((stat.type & DIRECTORY) !== 0) {
      ensureDirectory(normalized);

      if (operation === "readdir" && !hydratedDirectories.has(normalized)) {
        const entries = (await reader.readDirectory(normalized)) ?? [];
        learnDirectory(normalized, entries);
      }

      return true;
    }

    if (operation === "read" && !files.has(normalized)) {
      const bytes = await reader.readBytes(normalized);

      if (bytes == null) {
        absent.add(normalized);
        return false;
      }

      files.set(normalized, bytes);
    }

    return true;
  }

  function listDirectory(path: string): string[] {
    const entries = directories.get(path);

    if (entries == null) {
      if (absent.has(path) || deleted.has(path)) {
        throw notFound(path, "scandir");
      }

      throw new MissingPathError(path, "readdir");
    }

    return [...entries].sort();
  }

  function statOf(path: string): RuntimeStats {
    const stat = stats.get(path);

    if (stat != null) {
      return new RuntimeStats((stat.type & DIRECTORY) !== 0, stat);
    }

    if (files.has(path)) {
      return new RuntimeStats(false, undefined, files.get(path)?.length ?? 0);
    }

    if (directories.has(path)) {
      return new RuntimeStats(true);
    }

    if (absent.has(path) || deleted.has(path)) {
      throw notFound(path);
    }

    throw new MissingPathError(path, "stat");
  }

  function readFileSync(
    pathLike: PathLike,
    options?: string | { encoding?: string | null } | null,
  ): string | Buffer {
    const path = resolvePath(pathLike);
    const bytes = files.get(path);

    if (bytes == null) {
      if (absent.has(path) || deleted.has(path) || directories.has(path)) {
        throw pathError(directories.has(path) ? "EISDIR" : "ENOENT", "open", path);
      }

      throw new MissingPathError(path, "read");
    }

    const encoding = encodingOf(options);

    return encoding == null ? toBuffer(bytes) : toBuffer(bytes).toString(encoding);
  }

  function writeFileSync(
    pathLike: PathLike,
    data: string | Uint8Array,
    options?: string | { encoding?: string | null } | null,
  ): void {
    const path = resolvePath(pathLike);
    const encoding = encodingOf(options);
    const bytes = encodeData(data, encoding);

    learnFile(path, bytes);
    deleted.delete(path);
    overlay.push({ kind: "write", path, bytes });
  }

  function existsSync(pathLike: PathLike): boolean {
    const path = resolvePath(pathLike);

    if (deleted.has(path) || absent.has(path)) {
      return false;
    }

    if (files.has(path) || stats.has(path) || directories.has(path)) {
      return true;
    }

    throw new MissingPathError(path, "stat");
  }

  function mkdirSync(
    pathLike: PathLike,
    options?: { recursive?: boolean; mode?: number } | number,
  ): void {
    const path = resolvePath(pathLike);
    const recursive = typeof options === "object" && options?.recursive === true;

    if (files.has(path)) {
      throw pathError("EEXIST", "mkdir", path);
    }

    if (recursive) {
      ensureDirectory(path);
      hydratedDirectories.add(path);
      overlay.push({ kind: "mkdir", path });
      return;
    }

    const parent = dirname(path);

    if (parent.length > 0 && !directories.has(parent)) {
      if (absent.has(parent) || deleted.has(parent)) {
        throw notFound(parent, "mkdir");
      }

      throw new MissingPathError(parent, "stat");
    }

    if (directories.has(path)) {
      throw pathError("EEXIST", "mkdir", path);
    }

    ensureDirectory(path);
    hydratedDirectories.add(path);
    overlay.push({ kind: "mkdir", path });
  }

  function readdirSync(
    pathLike: PathLike,
    options?: { withFileTypes?: boolean; encoding?: string } | string,
  ): string[] | RuntimeDirent[] {
    const path = resolvePath(pathLike);
    const stat = stats.get(path);

    if (stat != null && (stat.type & DIRECTORY) === 0) {
      throw pathError("ENOTDIR", "scandir", path);
    }

    const names = listDirectory(path);

    if (typeof options === "object" && options?.withFileTypes === true) {
      return names.map((name) => {
        const child = path.length === 0 ? name : `${path}/${name}`;
        const stat = stats.get(child);
        const directory = (stat?.type ?? 0) === DIRECTORY;

        return new RuntimeDirent(name, directory, !directory);
      });
    }

    return names;
  }

  function unlinkSync(pathLike: PathLike): void {
    const path = resolvePath(pathLike);

    if (directories.has(path)) {
      throw pathError("EISDIR", "unlink", path);
    }

    if (!files.has(path)) {
      if (absent.has(path) || deleted.has(path)) {
        throw notFound(path, "unlink");
      }

      throw new MissingPathError(path, "read");
    }

    files.delete(path);
    stats.delete(path);
    deleted.add(path);
    unlinkFromParent(path);
    overlay.push({ kind: "delete", path, recursive: false });
  }

  function rmdirSync(pathLike: PathLike): void {
    const path = resolvePath(pathLike);

    if (!directories.has(path)) {
      if (absent.has(path) || deleted.has(path)) {
        throw notFound(path, "rmdir");
      }

      throw new MissingPathError(path, "readdir");
    }

    if ((directories.get(path)?.size ?? 0) > 0) {
      throw pathError("ENOTEMPTY", "rmdir", path);
    }

    directories.delete(path);
    stats.delete(path);
    deleted.add(path);
    unlinkFromParent(path);
    overlay.push({ kind: "delete", path, recursive: false });
  }

  function rmSync(pathLike: PathLike, options?: { recursive?: boolean; force?: boolean }): void {
    const path = resolvePath(pathLike);

    if (files.has(path)) {
      unlinkSync(path);
      return;
    }

    if (directories.has(path)) {
      if (!options?.recursive && (directories.get(path)?.size ?? 0) > 0) {
        throw pathError("ENOTEMPTY", "rm", path);
      }

      removeSubtree(path);
      deleted.add(path);
      overlay.push({
        kind: "delete",
        path,
        recursive: options?.recursive === true,
      });
      return;
    }

    if (absent.has(path) || deleted.has(path)) {
      if (options?.force) {
        return;
      }

      throw notFound(path, "rm");
    }

    throw new MissingPathError(path, "read");
  }

  function renameSync(fromLike: PathLike, toLike: PathLike): void {
    const from = resolvePath(fromLike);
    const to = resolvePath(toLike);
    const bytes = files.get(from);

    if (bytes != null) {
      learnFile(to, bytes, stats.get(from));
      files.delete(from);
      stats.delete(from);
      unlinkFromParent(from);
      overlay.push({ kind: "rename", from, to });
      return;
    }

    if (directories.has(from)) {
      directories.set(to, directories.get(from) ?? new Set());
      directories.delete(from);
      unlinkFromParent(from);
      ensureDirectory(dirname(to));
      overlay.push({ kind: "rename", from, to });
      return;
    }

    if (absent.has(from) || deleted.has(from)) {
      throw notFound(from, "rename");
    }

    throw new MissingPathError(from, "read");
  }

  function copyFileSync(fromLike: PathLike, toLike: PathLike): void {
    const from = resolvePath(fromLike);
    const bytes = files.get(from);

    if (bytes == null) {
      if (absent.has(from) || deleted.has(from)) {
        throw notFound(from, "copyfile");
      }

      throw new MissingPathError(from, "read");
    }

    writeFileSync(resolvePath(toLike), new Uint8Array(bytes));
  }

  function realpathSync(pathLike: PathLike): string {
    const path = resolvePath(pathLike);

    if (!files.has(path) && !directories.has(path)) {
      if (absent.has(path) || deleted.has(path)) {
        throw notFound(path, "realpath");
      }

      throw new MissingPathError(path, "stat");
    }

    return path;
  }

  function accessSync(pathLike: PathLike): void {
    const path = resolvePath(pathLike);

    if (files.has(path) || directories.has(path)) {
      return;
    }

    if (absent.has(path) || deleted.has(path)) {
      throw notFound(path, "access");
    }

    throw new MissingPathError(path, "stat");
  }

  function mkdtempSync(prefixLike: PathLike): string {
    const prefix = resolvePath(prefixLike);
    const suffix = Math.random().toString(36).slice(2, 8);
    const path = `${prefix}${suffix}`;

    ensureDirectory(path);
    overlay.push({ kind: "mkdir", path });

    return path;
  }

  function openSync(pathLike: PathLike, flags: string | number, _mode?: number): number {
    const path = resolvePath(pathLike);
    const flag = typeof flags === "number" ? "r" : flags;
    const writing = /[wa]/.test(flag);
    const appending = flag.includes("a");
    const exists = files.has(path) || directories.has(path);

    if (!exists && !writing) {
      if (absent.has(path) || deleted.has(path)) {
        throw notFound(path, "open");
      }

      throw new MissingPathError(path, "read");
    }

    if (directories.has(path)) {
      throw pathError("EISDIR", "open", path);
    }

    const content = exists ? new Uint8Array(files.get(path) ?? []) : new Uint8Array(0);
    const descriptor = nextDescriptor++;

    descriptors.set(descriptor, {
      path,
      position: appending ? content.length : 0,
      flags: flag,
      content: new Uint8Array(content),
    });

    return descriptor;
  }

  function closeSync(fd: number): void {
    const entry = descriptors.get(fd);

    if (entry == null) {
      return;
    }

    if (/[wa+]/.test(entry.flags)) {
      writeFileSync(entry.path, entry.content);
    }

    descriptors.delete(fd);
  }

  function readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number {
    const entry = descriptors.get(fd);

    if (entry == null) {
      throw new Error("EBADF: bad file descriptor, read");
    }

    const start = position ?? entry.position;
    const count = Math.min(length, entry.content.length - start);

    if (count <= 0) {
      return 0;
    }

    buffer.set(entry.content.subarray(start, start + count), offset);

    if (position == null) {
      entry.position += count;
    }

    return count;
  }

  function writeSync(
    fd: number,
    buffer: Uint8Array | string,
    offset?: number,
    length?: number,
    position?: number | null,
  ): number {
    const entry = descriptors.get(fd);

    if (entry == null) {
      throw new Error("EBADF: bad file descriptor, write");
    }

    const data = typeof buffer === "string" ? encodeData(buffer) : buffer;
    const start = typeof buffer === "string" ? 0 : (offset ?? 0);
    const count = typeof buffer === "string" ? data.length : (length ?? data.length - start);
    const at = position ?? entry.position;
    const end = at + count;

    if (end > entry.content.length) {
      const next = new Uint8Array(end);
      next.set(entry.content);
      entry.content = next;
    }

    entry.content.set(data.subarray(start, start + count), at);

    if (position == null) {
      entry.position = end;
    }

    return count;
  }

  function ftruncateSync(fd: number, length = 0): void {
    const entry = descriptors.get(fd);

    if (entry == null) {
      throw new Error("EBADF: bad file descriptor, ftruncate");
    }

    const next = new Uint8Array(length);
    next.set(entry.content.subarray(0, Math.min(length, entry.content.length)));
    entry.content = next;
  }

  function fstatSync(fd: number): RuntimeStats {
    const entry = descriptors.get(fd);

    if (entry == null) {
      throw new Error("EBADF: bad file descriptor, fstat");
    }

    return new RuntimeStats(false, stats.get(entry.path), entry.content.length);
  }

  function createReadStream(pathLike: PathLike): unknown {
    const path = resolvePath(pathLike);
    const bytes = files.get(path);

    if (bytes == null) {
      if (absent.has(path) || deleted.has(path)) {
        throw notFound(path, "open");
      }

      throw new MissingPathError(path, "read");
    }

    let offset = 0;

    const stream = {
      on(event: string, listener: (...args: unknown[]) => void) {
        if (event === "data") {
          while (offset < bytes.length) {
            listener(toBuffer(bytes.subarray(offset, offset + 65536)));
            offset += 65536;
          }
        }

        if (event === "end") {
          listener();
        }

        return stream;
      },
      once(event: string, listener: (...args: unknown[]) => void) {
        return stream.on(event, listener);
      },
      pipe(destination: { write: (chunk: Uint8Array) => void }) {
        destination.write(bytes);
        return destination;
      },
      destroy() {},
      close() {},
    };

    return stream;
  }

  function createWriteStream(pathLike: PathLike): unknown {
    const path = resolvePath(pathLike);
    const chunks: Uint8Array[] = [];

    const stream = {
      write(chunk: string | Uint8Array) {
        chunks.push(encodeData(chunk));
        return true;
      },
      end(chunk?: string | Uint8Array) {
        if (chunk != null) {
          chunks.push(encodeData(chunk));
        }

        writeFileSync(path, Buffer.concat(chunks.map((item) => toBuffer(item))));
      },
      on() {
        return stream;
      },
      once() {
        return stream;
      },
      emit() {
        return false;
      },
      destroy() {},
      close() {},
    };

    return stream;
  }

  const promises = {
    async readFile(
      pathLike: PathLike,
      options?: string | { encoding?: string | null } | null,
    ): Promise<string | Buffer> {
      const path = resolvePath(pathLike);
      const cached = files.get(path);
      const bytes = cached ?? (await reader.readBytes(path));

      if (bytes == null) {
        throw notFound(path, "open");
      }

      if (cached == null) {
        learnFile(path, bytes);
      }

      const encoding = encodingOf(options);

      return encoding == null ? toBuffer(bytes) : toBuffer(bytes).toString(encoding);
    },

    async writeFile(
      pathLike: PathLike,
      data: string | Uint8Array,
      options?: string | { encoding?: string | null } | null,
    ): Promise<void> {
      const path = resolvePath(pathLike);
      const bytes = encodeData(data, encodingOf(options));

      discardOverlayFor(path);
      await reader.writeFile(path, bytes);
      learnFile(path, bytes);
    },

    async appendFile(
      pathLike: PathLike,
      data: string | Uint8Array,
      options?: string | { encoding?: string | null } | null,
    ): Promise<void> {
      const path = resolvePath(pathLike);
      const existing = files.get(path) ?? (await reader.readBytes(path));
      const next = encodeData(data, encodingOf(options));

      const joined = new Uint8Array((existing?.length ?? 0) + next.length);
      if (existing != null) {
        joined.set(existing);
      }
      joined.set(next, existing?.length ?? 0);

      discardOverlayFor(path);
      await reader.writeFile(path, joined);
      learnFile(path, joined);
    },

    async stat(pathLike: PathLike): Promise<RuntimeStats> {
      const path = resolvePath(pathLike);

      if (files.has(path) || stats.has(path) || directories.has(path)) {
        return statOf(path);
      }

      const stat = await reader.stat(path);

      if (stat == null) {
        throw notFound(path);
      }

      stats.set(path, stat);

      if ((stat.type & DIRECTORY) !== 0) {
        ensureDirectory(path);
      }

      return new RuntimeStats((stat.type & DIRECTORY) !== 0, stat);
    },

    async lstat(pathLike: PathLike): Promise<RuntimeStats> {
      return this.stat(pathLike);
    },

    async readdir(
      pathLike: PathLike,
      options?: { withFileTypes?: boolean } | string,
    ): Promise<string[] | RuntimeDirent[]> {
      const path = resolvePath(pathLike);

      if (!hydratedDirectories.has(path)) {
        const entries = await reader.readDirectory(path);

        if (entries == null) {
          /*
           * The directory may exist only in the unflushed sync overlay
           * (for example after writeFileSync("new-dir/file.txt")).
           */
          if (!directories.has(path)) {
            throw notFound(path, "scandir");
          }

          hydratedDirectories.add(path);
        } else {
          learnDirectory(path, entries);
        }
      }

      return readdirSync(path, options);
    },

    async mkdir(pathLike: PathLike, options?: { recursive?: boolean } | number): Promise<void> {
      const path = resolvePath(pathLike);

      discardOverlayFor(path);
      await reader.createDirectory(path);
      ensureDirectory(path);
      hydratedDirectories.add(path);
    },

    async unlink(pathLike: PathLike): Promise<void> {
      const path = resolvePath(pathLike);

      discardOverlayFor(path);
      await reader.deletePath(path, false);
      files.delete(path);
      stats.delete(path);
      unlinkFromParent(path);
    },

    async rmdir(pathLike: PathLike): Promise<void> {
      const path = resolvePath(pathLike);

      discardOverlayFor(path);
      await reader.deletePath(path, false);
      removeSubtree(path);
    },

    async rm(
      pathLike: PathLike,
      options?: { recursive?: boolean; force?: boolean },
    ): Promise<void> {
      const path = resolvePath(pathLike);

      discardOverlayFor(path);

      try {
        await reader.deletePath(path, options?.recursive === true);
      } catch (error) {
        if (options?.force !== true) {
          throw error;
        }
      }

      removeSubtree(path);
    },

    async rename(fromLike: PathLike, toLike: PathLike): Promise<void> {
      const from = resolvePath(fromLike);
      const to = resolvePath(toLike);
      const cached = files.get(from);

      /*
       * A file written earlier in this run may not be on disk yet.
       */
      if (cached != null) {
        discardOverlayFor(from, to);
        await reader.writeFile(from, cached);
        await reader.rename(from, to);
        learnFile(to, cached, stats.get(from));
        files.delete(from);
        stats.delete(from);
        unlinkFromParent(from);
        return;
      }

      discardOverlayFor(from, to);
      await reader.rename(from, to);
    },

    async copyFile(fromLike: PathLike, toLike: PathLike): Promise<void> {
      const from = resolvePath(fromLike);
      const to = resolvePath(toLike);
      const cached = files.get(from);

      if (cached != null) {
        discardOverlayFor(from, to);
        await reader.writeFile(from, cached);
        await reader.copy(from, to);
        learnFile(to, cached, stats.get(from));
        return;
      }

      discardOverlayFor(to);
      await reader.copy(from, to);
      const bytes = await reader.readBytes(to);

      if (bytes != null) {
        learnFile(to, bytes);
      }
    },

    async access(pathLike: PathLike): Promise<void> {
      const path = resolvePath(pathLike);

      if (files.has(path) || directories.has(path)) {
        return;
      }

      const stat = await reader.stat(path);

      if (stat == null) {
        throw notFound(path, "access");
      }
    },

    async realpath(pathLike: PathLike): Promise<string> {
      const path = resolvePath(pathLike);

      if (files.has(path) || directories.has(path)) {
        return path;
      }

      const stat = await reader.stat(path);

      if (stat == null) {
        throw notFound(path, "realpath");
      }

      return path;
    },

    async exists(pathLike: PathLike): Promise<boolean> {
      const path = resolvePath(pathLike);

      if (files.has(path) || directories.has(path) || stats.has(path)) {
        return true;
      }

      return (await reader.stat(path)) != null;
    },
  };

  function callback(
    fn: (...args: any[]) => Promise<unknown>,
    args: any[],
    callbackFn: (error: Error | null, result?: any) => void,
  ): void {
    fn(...args).then(
      (result) => queueMicrotask(() => callbackFn(null, result)),
      (error: Error) => queueMicrotask(() => callbackFn(error)),
    );
  }

  const fs: Record<string, unknown> = {
    constants,
    readFileSync,
    writeFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    statSync: statOf,
    lstatSync: statOf,
    unlinkSync,
    rmdirSync,
    rmSync,
    renameSync,
    copyFileSync,
    realpathSync,
    accessSync,
    mkdtempSync,
    openSync,
    closeSync,
    readSync,
    writeSync,
    ftruncateSync,
    fstatSync,
    fsyncSync() {},
    fdatasyncSync() {},
    createReadStream,
    createWriteStream,
    promises,
    readFile(
      pathLike: PathLike,
      optionsOrCallback:
        | string
        | { encoding?: string | null }
        | ((error: Error | null, data?: string | Buffer) => void),
      maybeCallback?: (error: Error | null, data?: string | Buffer) => void,
    ) {
      const callbackFn =
        typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;

      callback(
        promises.readFile,
        [pathLike, options],
        callbackFn as (error: Error | null, result?: unknown) => void,
      );
    },
    writeFile(
      pathLike: PathLike,
      data: string | Uint8Array,
      optionsOrCallback: string | { encoding?: string | null } | ((error: Error | null) => void),
      maybeCallback?: (error: Error | null) => void,
    ) {
      const callbackFn =
        typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;

      callback(
        promises.writeFile,
        [pathLike, data, options],
        callbackFn as (error: Error | null, result?: unknown) => void,
      );
    },
    stat(pathLike: PathLike, callbackFn: (error: Error | null, stat?: RuntimeStats) => void) {
      callback(promises.stat, [pathLike], callbackFn);
    },
    lstat(pathLike: PathLike, callbackFn: (error: Error | null, stat?: RuntimeStats) => void) {
      callback(promises.lstat, [pathLike], callbackFn);
    },
    readdir(
      pathLike: PathLike,
      optionsOrCallback:
        { withFileTypes?: boolean } | ((error: Error | null, files?: string[]) => void),
      maybeCallback?: (error: Error | null, files?: string[]) => void,
    ) {
      const callbackFn =
        typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;

      callback(
        promises.readdir,
        [pathLike, options],
        callbackFn as (error: Error | null, result?: unknown) => void,
      );
    },
    mkdir(
      pathLike: PathLike,
      optionsOrCallback: { recursive?: boolean } | ((error: Error | null) => void),
      maybeCallback?: (error: Error | null) => void,
    ) {
      const callbackFn =
        typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;

      callback(
        promises.mkdir,
        [pathLike, options],
        callbackFn as (error: Error | null, result?: unknown) => void,
      );
    },
    unlink(pathLike: PathLike, callbackFn: (error: Error | null) => void) {
      callback(promises.unlink, [pathLike], callbackFn);
    },
    rm(
      pathLike: PathLike,
      optionsOrCallback: { recursive?: boolean; force?: boolean } | ((error: Error | null) => void),
      maybeCallback?: (error: Error | null) => void,
    ) {
      const callbackFn =
        typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback;
      const options = typeof optionsOrCallback === "function" ? undefined : optionsOrCallback;

      callback(
        promises.rm,
        [pathLike, options],
        callbackFn as (error: Error | null, result?: unknown) => void,
      );
    },
    rename(from: PathLike, to: PathLike, callbackFn: (error: Error | null) => void) {
      callback(promises.rename, [from, to], callbackFn);
    },
    copyFile(from: PathLike, to: PathLike, callbackFn: (error: Error | null) => void) {
      callback(promises.copyFile, [from, to], callbackFn);
    },
    access(
      pathLike: PathLike,
      modeOrCallback: number | ((error: Error | null) => void),
      maybeCallback?: (error: Error | null) => void,
    ) {
      const callbackFn = typeof modeOrCallback === "function" ? modeOrCallback : maybeCallback;

      callback(
        promises.access,
        [pathLike],
        callbackFn as (error: Error | null, result?: unknown) => void,
      );
    },
    realpath(pathLike: PathLike, callbackFn: (error: Error | null, resolved?: string) => void) {
      callback(promises.realpath, [pathLike], callbackFn);
    },
    exists(pathLike: PathLike, callbackFn: (exists: boolean) => void) {
      try {
        queueMicrotask(() => callbackFn(existsSync(pathLike)));
      } catch {
        queueMicrotask(() => callbackFn(false));
      }
    },
    watch(_pathLike: PathLike, _options?: unknown, _listener?: unknown) {
      return {
        close() {},
        ref() {
          return this;
        },
        unref() {
          return this;
        },
        on() {
          return this;
        },
        once() {
          return this;
        },
      };
    },
  };

  async function flush(): Promise<FlushResult> {
    const errors: string[] = [];
    let applied = 0;

    for (const operation of overlay) {
      try {
        if (operation.kind === "write") {
          await reader.writeFile(operation.path, operation.bytes);
        } else if (operation.kind === "mkdir") {
          await reader.createDirectory(operation.path);
        } else if (operation.kind === "delete") {
          await reader.deletePath(operation.path, operation.recursive);
        } else {
          await reader.rename(operation.from, operation.to);
        }

        applied += 1;
      } catch (error) {
        errors.push(
          `${operation.kind} ${"path" in operation ? operation.path : `${operation.from} -> ${operation.to}`}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    overlay.length = 0;

    return { applied, errors };
  }

  return {
    fs,
    promises,
    hydrate,
    flush,
  };
}
