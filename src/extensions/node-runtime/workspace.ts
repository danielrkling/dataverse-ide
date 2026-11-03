/*
 * Direct workspace filesystem access for the node-runtime extension.
 *
 * Everything goes through vscode.workspace.fs, so reads and writes use the
 * mounted workspace provider (local folder, browser workspace and the OPFS
 * node_modules overlay) instead of a mirrored in-memory VFS.
 *
 * Paths are workspace-relative, slash-normalized and never start with "/".
 */

import type * as vscodeType from "vscode";

import { ensureWorkspaceDirectory } from "../../workspace/workspaceFs.js";

export type WorkspaceFs = {
  readText: (path: string) => Promise<string | undefined>;
  readBytes: (path: string) => Promise<Uint8Array | undefined>;
  stat: (path: string) => Promise<vscodeType.FileStat | undefined>;
  readDirectory: (path: string) => Promise<Array<[string, vscodeType.FileType]> | undefined>;
  writeFile: (path: string, content: Uint8Array) => Promise<void>;
  createDirectory: (path: string) => Promise<void>;
  deletePath: (path: string, recursive: boolean) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  copy: (from: string, to: string) => Promise<void>;
};

const decoder = new TextDecoder();

export function normalizePath(value: string): string {
  const segments: string[] = [];

  for (const segment of value.replaceAll("\\", "/").split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }

    if (segment === "..") {
      segments.pop();
      continue;
    }

    segments.push(segment);
  }

  return segments.join("/");
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter((part) => part.length > 0).join("/"));
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");

  return index < 0 ? "" : normalized.slice(0, index);
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");

  return index < 0 ? normalized : normalized.slice(index + 1);
}

export function toUri(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  path: string,
): vscodeType.Uri {
  const normalized = normalizePath(path);

  if (normalized.length === 0) {
    return rootUri;
  }

  return vscode.Uri.joinPath(rootUri, ...normalized.split("/"));
}

function permissionDenied(path: string, syscall: string): Error {
  const error = new Error(
    `EACCES: permission denied, ${syscall} '${path}'`,
  ) as Error & { code: string; errno: number; syscall: string; path: string };

  error.code = "EACCES";
  error.errno = -13;
  error.syscall = syscall;
  error.path = path;

  return error;
}

export function createWorkspaceFs(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
  options: { writable?: boolean } = {},
): WorkspaceFs {
  const writable = options.writable ?? true;

  function uri(path: string): vscodeType.Uri {
    return toUri(vscode, rootUri, path);
  }

  function assertWritable(path: string, syscall: string): void {
    if (!writable) {
      throw permissionDenied(path, syscall);
    }
  }

  async function readBytes(path: string): Promise<Uint8Array | undefined> {
    try {
      return await vscode.workspace.fs.readFile(uri(path));
    } catch {
      return undefined;
    }
  }

  return {
    async readText(path: string): Promise<string | undefined> {
      const bytes = await readBytes(path);

      return bytes == null ? undefined : decoder.decode(bytes);
    },

    readBytes,

    async stat(path: string): Promise<vscodeType.FileStat | undefined> {
      try {
        return await vscode.workspace.fs.stat(uri(path));
      } catch {
        return undefined;
      }
    },

    async readDirectory(path: string): Promise<Array<[string, vscodeType.FileType]> | undefined> {
      try {
        return await vscode.workspace.fs.readDirectory(uri(path));
      } catch {
        return undefined;
      }
    },

    async writeFile(path: string, content: Uint8Array): Promise<void> {
      assertWritable(path, "open");
      const parent = dirname(path);

      if (parent.length > 0) {
        await ensureWorkspaceDirectory(vscode, uri(parent));
      }

      await vscode.workspace.fs.writeFile(uri(path), content);
    },

    async createDirectory(path: string): Promise<void> {
      assertWritable(path, "mkdir");
      if (normalizePath(path).length === 0) {
        return;
      }

      await ensureWorkspaceDirectory(vscode, uri(path));
    },

    async deletePath(path: string, recursive: boolean): Promise<void> {
      assertWritable(path, "delete");
      await vscode.workspace.fs.delete(uri(path), {
        recursive,
        useTrash: false,
      });
    },

    async rename(from: string, to: string): Promise<void> {
      assertWritable(to, "rename");
      const parent = dirname(to);

      if (parent.length > 0) {
        await ensureWorkspaceDirectory(vscode, uri(parent));
      }

      await vscode.workspace.fs.rename(uri(from), uri(to), {
        overwrite: true,
      });
    },

    async copy(from: string, to: string): Promise<void> {
      assertWritable(to, "copyfile");
      const parent = dirname(to);

      if (parent.length > 0) {
        await ensureWorkspaceDirectory(vscode, uri(parent));
      }

      await vscode.workspace.fs.copy(uri(from), uri(to), {
        overwrite: true,
      });
    },
  };
}
