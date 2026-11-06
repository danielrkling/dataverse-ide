/*
 * Workspace-backed filesystem for just-bash.
 *
 * There is no workspace mirror here. Reads and writes go straight through
 * vscode.workspace.fs, which means the shell mutates the workspace exactly
 * like an external process would. The small in-memory filesystem is only
 * used for scratch paths (/tmp, /home, /dev, ...).
 *
 * just-bash calls fs.getAllPaths() synchronously for glob expansion, so we
 * keep a metadata-only path index. It contains path strings, never file
 * contents.
 */

import { Buffer } from "buffer";

import type * as vscodeType from "vscode";

import type {
  BufferEncoding,
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash";

import {
  createWorkspaceFs,
  dirname,
  normalizePath,
  type WorkspaceFs,
} from "../node-runtime/workspace.js";

/*
 * just-bash's index does not re-export these option/dirent types, but they
 * are structurally identical to the IFileSystem signatures.
 */
type ReadFileOptions = { encoding?: BufferEncoding | null };
type WriteFileOptions = { encoding?: BufferEncoding };
type DirentEntry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
};

const DIRECTORY = 2;
const FILE = 1;

const SCRATCH_ROOTS = ["/tmp", "/home", "/dev", "/usr", "/bin", "/var"];

const DEFAULT_EXCLUDES = "{**/.git/**,**/node_modules/**,**/.ide-build/**,**/dist/**}";

const DEFAULT_PATH_LIMIT = 20000;

type NodeError = Error & {
  code: string;
  errno?: number;
  syscall?: string;
  path?: string;
};

function pathError(code: string, syscall: string, path: string): NodeError {
  const errno: Record<string, number> = {
    EACCES: -13,
    EEXIST: -17,
    EISDIR: -21,
    ENOENT: -2,
    ENOTDIR: -20,
    ENOTEMPTY: -39,
  };
  const description: Record<string, string> = {
    EACCES: "permission denied",
    EEXIST: "file already exists",
    EISDIR: "is a directory",
    ENOENT: "no such file or directory",
    ENOTDIR: "not a directory",
    ENOTEMPTY: "directory not empty",
  };

  const error = new Error(
    `${code}: ${description[code] ?? "filesystem error"}, ${syscall} '${path}'`,
  ) as NodeError;

  error.code = code;
  error.errno = errno[code] ?? -1;
  error.syscall = syscall;
  error.path = path;

  return error;
}

function unsupported(operation: string, path: string): Error {
  return pathError("EACCES", operation, path);
}

function absolute(path: string): string {
  const normalized = normalizePath(path);

  return normalized.length === 0 ? "/" : `/${normalized}`;
}

function joinAbsolute(base: string, path: string): string {
  if (path.startsWith("/")) {
    return absolute(path);
  }

  const combined = base.endsWith("/") ? `${base}${path}` : `${base}/${path}`;

  return absolute(combined);
}

function isScratchPath(path: string): boolean {
  const normalized = absolute(path);

  return SCRATCH_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function isPathWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

function decode(bytes: Uint8Array, encoding?: BufferEncoding): string {
  const buffer = Buffer.from(bytes);

  switch (encoding) {
    case undefined:
    case "utf8":
    case "utf-8":
      return new TextDecoder().decode(bytes);
    case "ascii":
      return buffer.toString("ascii");
    case "binary":
    case "latin1":
      return buffer.toString("latin1");
    case "base64":
      return buffer.toString("base64");
    case "hex":
      return buffer.toString("hex");
    default:
      return new TextDecoder().decode(bytes);
  }
}

function encode(content: FileContent, encoding?: BufferEncoding): Uint8Array {
  if (typeof content === "string") {
    return new Uint8Array(Buffer.from(content, encoding ?? "utf8"));
  }

  return new Uint8Array(content);
}

function isExecutable(path: string): boolean {
  return /\/node_modules\/\.bin\//.test(path);
}

function addAncestors(paths: Set<string>, path: string): void {
  let current = path;

  while (current.length > 1) {
    const parent = dirname(current.slice(1));

    current = parent.length === 0 ? "/" : `/${parent}`;
    paths.add(current);

    if (current === "/") {
      break;
    }
  }
}

function addPath(paths: Set<string>, path: string): void {
  if (path === "/" || path.length === 0) {
    paths.add("/");

    return;
  }

  paths.add(path);
  addAncestors(paths, path);
}

function removePath(paths: Set<string>, path: string): void {
  for (const candidate of [...paths]) {
    if (isPathWithin(candidate, path)) {
      paths.delete(candidate);
    }
  }
}

function movePath(paths: Set<string>, from: string, to: string): void {
  const moved: string[] = [];

  for (const candidate of [...paths]) {
    if (isPathWithin(candidate, from)) {
      moved.push(`${to}${candidate.slice(from.length)}`);
      paths.delete(candidate);
    }
  }

  paths.add(to);
  addAncestors(paths, to);

  for (const candidate of moved) {
    paths.add(candidate);
  }
}

export type ShellFsOptions = {
  vscode: typeof vscodeType;
  rootUri: vscodeType.Uri;
  writable?: boolean;
  excludes?: string;
  pathLimit?: number;
  /** Injectable for tests; otherwise created from vscode + rootUri. */
  workspace?: WorkspaceFs;
  /** Injectable for tests; returns workspace-relative file paths. */
  listWorkspacePaths?: () => Promise<string[]>;
  /** Skip the filesystem watcher (used by tests). */
  watch?: boolean;
  /** Direct workspace handle, used as a root-listing fallback when available. */
  directoryHandle?: FileSystemDirectoryHandle;
};

export type ShellFs = IFileSystem & {
  readonly writable: boolean;
  /** Wait for the initial workspace path scan. */
  ready: () => Promise<void>;
  /** Re-scan the workspace path index (for example after npm install). */
  refreshIndex: () => Promise<void>;
  dispose: () => void;
  /**
   * just-bash duck-types this optional method to write `/bin/<command>`
   * stubs for its registered commands. Only scratch paths are writable
   * synchronously; workspace writes must go through the async API.
   */
  writeFileSync: (path: string, content: string | Uint8Array) => void;
};

export async function createShellFs(options: ShellFsOptions): Promise<ShellFs> {
  const { vscode, rootUri } = options;
  const writable = options.writable ?? true;
  const workspace =
    options.workspace ??
    createWorkspaceFs(vscode, rootUri, {
      writable,
    });

  /*
   * Loaded here rather than at module scope so activating the terminal
   * extension does not pull the just-bash bundle into the boot chunks.
   */
  const { InMemoryFs } = await import("just-bash");
  const scratch = new InMemoryFs();

  scratch.mkdirSync("/tmp", { recursive: true });
  scratch.mkdirSync("/home/user", { recursive: true });
  scratch.mkdirSync("/dev", { recursive: true });
  scratch.mkdirSync("/usr/bin", { recursive: true });
  scratch.mkdirSync("/bin", { recursive: true });
  scratch.mkdirSync("/var", { recursive: true });
  scratch.writeFileSync("/dev/null", "");

  const paths = new Set<string>(["/"]);
  const disposables: vscodeType.Disposable[] = [];
  let indexReady: Promise<void> | undefined;

  function toWorkspace(path: string): string {
    return normalizePath(path);
  }

  function assertWritable(path: string, operation: string): void {
    if (!writable && !isScratchPath(path)) {
      throw pathError("EACCES", operation, path);
    }
  }

  function isNullDevice(path: string): boolean {
    return absolute(path) === "/dev/null";
  }

  async function listWorkspacePaths(): Promise<string[]> {
    if (options.listWorkspacePaths != null) {
      return options.listWorkspacePaths();
    }

    const uris = await vscode.workspace.findFiles(
      "**/*",
      options.excludes ?? DEFAULT_EXCLUDES,
      options.pathLimit ?? DEFAULT_PATH_LIMIT,
    );

    return uris.map((uri) => vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/"));
  }

  async function refreshIndex(): Promise<void> {
    const files = await listWorkspacePaths();

    paths.clear();
    paths.add("/");

    for (const file of files) {
      const relative = normalizePath(file);

      if (relative.length === 0) {
        continue;
      }

      addPath(paths, `/${relative}`);
    }

    for (const scratchPath of scratch.getAllPaths()) {
      addPath(paths, absolute(scratchPath));
    }
  }

  function ensureIndex(): Promise<void> {
    if (indexReady == null) {
      indexReady = refreshIndex().catch((error) => {
        indexReady = undefined;
        throw error;
      });
    }

    return indexReady;
  }

  if (options.watch !== false) {
    try {
      const watcher = vscode.workspace.createFileSystemWatcher("**/*");

      const onPath = (uri: vscodeType.Uri, operation: "add" | "delete"): void => {
        const relative = normalizePath(
          vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/"),
        );

        if (relative.length === 0) {
          return;
        }

        if (operation === "add") {
          addPath(paths, `/${relative}`);
        } else {
          removePath(paths, `/${relative}`);
        }
      };

      disposables.push(
        watcher,
        watcher.onDidCreate((uri) => onPath(uri, "add")),
        watcher.onDidDelete((uri) => onPath(uri, "delete")),
      );
    } catch {
      /* A watcher is an optimization; the shell still works without one. */
    }
  }

  function scratchPath(path: string): string {
    return absolute(path);
  }

  /*
   * Last-resort directory listing from the path index. Some workspace
   * providers return an empty/undefined root readdir even though individual
   * paths resolve; globbing already relies on the index, so use it here too.
   */
  async function namesFromWorkspace(directory: string): Promise<string[]> {
    try {
      const files = await listWorkspacePaths();
      const normalized = absolute(directory);
      const prefix = normalized === "/" ? "" : `${normalized.slice(1)}/`;
      const names = new Set<string>();

      for (const file of files) {
        const relative = normalizePath(file);

        if (!relative.startsWith(prefix)) {
          continue;
        }

        const rest = relative.slice(prefix.length);

        if (rest.length === 0) {
          continue;
        }

        const [name] = rest.split("/");

        if (name != null && name.length > 0) {
          names.add(name);
        }
      }

      return [...names].sort();
    } catch {
      return [];
    }
  }

  function namesFromIndex(directory: string): string[] {
    const normalized = absolute(directory);
    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const names = new Set<string>();

    for (const candidate of paths) {
      if (!candidate.startsWith(prefix)) {
        continue;
      }

      const rest = candidate.slice(prefix.length);

      if (rest.length === 0) {
        continue;
      }

      const [name] = rest.split("/");

      if (name != null && name.length > 0) {
        names.add(name);
      }
    }

    return [...names].sort();
  }

  const fs: ShellFs = {
    writable,

    async readFile(path: string, readOptions?: ReadFileOptions | BufferEncoding): Promise<string> {
      if (isNullDevice(path)) {
        return "";
      }

      if (isScratchPath(path)) {
        return scratch.readFile(scratchPath(path), readOptions);
      }

      const encoding = typeof readOptions === "string" ? readOptions : readOptions?.encoding;

      const bytes = await workspace.readBytes(toWorkspace(path));

      if (bytes == null) {
        throw pathError("ENOENT", "open", absolute(path));
      }

      return decode(bytes, encoding ?? undefined);
    },

    async readFileBuffer(path: string): Promise<Uint8Array> {
      if (isNullDevice(path)) {
        return new Uint8Array(0);
      }

      if (isScratchPath(path)) {
        return scratch.readFileBuffer(scratchPath(path));
      }

      const bytes = await workspace.readBytes(toWorkspace(path));

      if (bytes == null) {
        throw pathError("ENOENT", "open", absolute(path));
      }

      return bytes;
    },

    async writeFile(
      path: string,
      content: FileContent,
      writeOptions?: WriteFileOptions | BufferEncoding,
    ): Promise<void> {
      if (isNullDevice(path)) {
        return;
      }

      assertWritable(path, "open");

      const encoding = typeof writeOptions === "string" ? writeOptions : writeOptions?.encoding;

      if (isScratchPath(path)) {
        await scratch.writeFile(scratchPath(path), content, writeOptions);
        addPath(paths, absolute(path));

        return;
      }

      const normalized = absolute(path);

      if (normalized === "/") {
        throw pathError("EISDIR", "open", normalized);
      }

      await workspace.writeFile(toWorkspace(path), encode(content, encoding));
      addPath(paths, normalized);
    },

    async appendFile(
      path: string,
      content: FileContent,
      writeOptions?: WriteFileOptions | BufferEncoding,
    ): Promise<void> {
      if (isNullDevice(path)) {
        return;
      }

      if (isScratchPath(path)) {
        await scratch.appendFile(scratchPath(path), content, writeOptions);
        addPath(paths, absolute(path));

        return;
      }

      assertWritable(path, "open");

      const existing = (await workspace.readBytes(toWorkspace(path))) ?? new Uint8Array(0);
      const encoding = typeof writeOptions === "string" ? writeOptions : writeOptions?.encoding;
      const appended = encode(content, encoding);
      const joined = new Uint8Array(existing.length + appended.length);

      joined.set(existing);
      joined.set(appended, existing.length);

      await workspace.writeFile(toWorkspace(path), joined);
      addPath(paths, absolute(path));
    },

    async exists(path: string): Promise<boolean> {
      if (isNullDevice(path)) {
        return true;
      }

      if (isScratchPath(path)) {
        return scratch.exists(scratchPath(path));
      }

      if (absolute(path) === "/") {
        return true;
      }

      return (await workspace.stat(toWorkspace(path))) != null;
    },

    async stat(path: string): Promise<FsStat> {
      if (isNullDevice(path)) {
        return {
          isFile: true,
          isDirectory: false,
          isSymbolicLink: false,
          mode: 0o644,
          size: 0,
          mtime: new Date(),
        };
      }

      if (isScratchPath(path)) {
        return scratch.stat(scratchPath(path));
      }

      const stat = await workspace.stat(toWorkspace(path));

      if (stat == null) {
        throw pathError("ENOENT", "stat", absolute(path));
      }

      const directory = (stat.type & DIRECTORY) !== 0;
      const file = (stat.type & FILE) !== 0;

      if (!directory && !file) {
        throw pathError("ENOENT", "stat", absolute(path));
      }

      return {
        isFile: file,
        isDirectory: directory,
        isSymbolicLink: false,
        mode: directory ? 0o755 : isExecutable(absolute(path)) ? 0o755 : 0o644,
        size: stat.size,
        mtime: new Date(stat.mtime),
      };
    },

    async lstat(path: string): Promise<FsStat> {
      return fs.stat(path);
    },

    async mkdir(path: string, mkdirOptions?: MkdirOptions): Promise<void> {
      if (isScratchPath(path)) {
        await scratch.mkdir(scratchPath(path), mkdirOptions);
        addPath(paths, absolute(path));

        return;
      }

      assertWritable(path, "mkdir");

      const normalized = absolute(path);

      if (normalized === "/") {
        return;
      }

      if (!mkdirOptions?.recursive) {
        const parent = absolute(dirname(normalized.slice(1)) || "/");

        if (!(await fs.exists(parent))) {
          throw pathError("ENOENT", "mkdir", normalized);
        }
      }

      await workspace.createDirectory(toWorkspace(path));
      addPath(paths, normalized);
    },

    async readdir(path: string): Promise<string[]> {
      if (isScratchPath(path)) {
        return scratch.readdir(scratchPath(path));
      }

      const normalized = absolute(path);

      if (normalized === "/") {
        const names = new Set((await workspace.readDirectory(""))?.map(([name]) => name) ?? []);

        if (names.size === 0) {
          if (options.directoryHandle != null) {
            try {
              for await (const child of options.directoryHandle.values()) {
                names.add(child.name);
              }
            } catch {
              /* Fall through to the path index. */
            }
          }

          for (const name of await namesFromWorkspace("/")) {
            names.add(name);
          }

          for (const name of namesFromIndex("/")) {
            names.add(name);
          }

          /*
           * node_modules normally lives in the OPFS overlay, so it is absent
           * from both the real directory handle and the findFiles index.
           */
          if ((await workspace.stat("node_modules")) != null) {
            names.add("node_modules");
          }
        }

        for (const root of SCRATCH_ROOTS) {
          names.add(root.slice(1));
        }

        return [...names].sort();
      }

      const entries = await workspace.readDirectory(toWorkspace(path));

      if (entries == null) {
        const stat = await workspace.stat(toWorkspace(path));

        if (stat == null) {
          throw pathError("ENOENT", "scandir", normalized);
        }

        if ((stat.type & DIRECTORY) === 0) {
          throw pathError("ENOTDIR", "scandir", normalized);
        }

        const indexed = namesFromIndex(normalized);

        return indexed.length > 0 ? indexed : namesFromWorkspace(normalized);
      }

      const names = entries.map(([name]) => name);

      if (names.length === 0) {
        const indexed = namesFromIndex(normalized);

        if (indexed.length > 0) {
          return indexed;
        }

        return namesFromWorkspace(normalized);
      }

      return names;
    },

    async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
      const names = await fs.readdir(path);
      const entries: DirentEntry[] = [];

      for (const name of names) {
        const child = joinAbsolute(absolute(path), name);

        try {
          const stat = await fs.lstat(child);

          entries.push({
            name,
            isFile: stat.isFile,
            isDirectory: stat.isDirectory,
            isSymbolicLink: false,
          });
        } catch {
          /* The entry disappeared between readdir and lstat. */
        }
      }

      return entries;
    },

    async rm(path: string, rmOptions?: RmOptions): Promise<void> {
      if (isScratchPath(path)) {
        await scratch.rm(scratchPath(path), rmOptions);
        removePath(paths, absolute(path));

        return;
      }

      assertWritable(path, "rm");

      const normalized = absolute(path);

      if (normalized === "/") {
        throw pathError("EACCES", "rm", normalized);
      }

      try {
        await workspace.deletePath(toWorkspace(path), rmOptions?.recursive === true);
      } catch (error) {
        if (rmOptions?.force === true) {
          return;
        }

        throw error;
      }

      removePath(paths, normalized);
    },

    async cp(src: string, dest: string, cpOptions?: CpOptions): Promise<void> {
      const source = absolute(src);
      const target = absolute(dest);

      assertWritable(dest, "cp");

      const stat = await fs.stat(source);

      if (stat.isFile) {
        await fs.writeFile(target, await fs.readFileBuffer(source));

        return;
      }

      if (!cpOptions?.recursive) {
        throw pathError("EISDIR", "cp", source);
      }

      await fs.mkdir(target, { recursive: true });

      for (const name of await fs.readdir(source)) {
        await fs.cp(joinAbsolute(source, name), joinAbsolute(target, name), { recursive: true });
      }
    },

    async mv(src: string, dest: string): Promise<void> {
      const source = absolute(src);
      const target = absolute(dest);

      assertWritable(dest, "mv");

      if (source === target) {
        return;
      }

      if (!isScratchPath(source) && !isScratchPath(target)) {
        await workspace.rename(toWorkspace(source), toWorkspace(target));
        movePath(paths, source, target);

        return;
      }

      await fs.cp(source, target, { recursive: true });
      await fs.rm(source, { recursive: true });
    },

    resolvePath(base: string, path: string): string {
      return joinAbsolute(absolute(base), path);
    },

    getAllPaths(): string[] {
      if (indexReady == null) {
        void ensureIndex();
      }

      const all = new Set(paths);

      for (const scratchPath of scratch.getAllPaths()) {
        addPath(all, absolute(scratchPath));
      }

      return [...all].sort();
    },

    async chmod(path: string, mode: number): Promise<void> {
      if (isScratchPath(path)) {
        await scratch.chmod(scratchPath(path), mode);

        return;
      }

      /* The workspace provider does not expose POSIX modes. */
      await fs.stat(path);
    },

    async symlink(target: string, linkPath: string): Promise<void> {
      void target;
      throw unsupported("symlink", linkPath);
    },

    async link(existingPath: string, newPath: string): Promise<void> {
      void existingPath;
      throw unsupported("link", newPath);
    },

    async readlink(path: string): Promise<string> {
      throw unsupported("readlink", path);
    },

    async realpath(path: string): Promise<string> {
      const normalized = absolute(path);

      await fs.stat(normalized);

      return normalized;
    },

    async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
      if (isScratchPath(path)) {
        await scratch.utimes(scratchPath(path), atime, mtime);

        return;
      }

      /* The workspace provider tracks timestamps itself. */
      await fs.stat(path);
    },

    ready: () => ensureIndex(),

    async refreshIndex(): Promise<void> {
      await refreshIndex();
    },

    writeFileSync(path: string, content: string | Uint8Array): void {
      const normalized = absolute(path);

      if (!isScratchPath(normalized)) {
        throw pathError("EACCES", "open", normalized);
      }

      scratch.writeFileSync(scratchPath(normalized), content);
      addPath(paths, normalized);
    },

    dispose(): void {
      for (const disposable of disposables) {
        disposable.dispose();
      }

      disposables.length = 0;
    },
  };

  void ensureIndex().catch(() => {
    /* The shell still works without the glob path index. */
  });

  return fs;
}
