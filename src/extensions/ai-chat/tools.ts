import type * as vscodeType from "vscode";

import type { OpenAiToolCall, OpenAiToolDefinition } from "./client.js";
import { globToRegExp, isGlobPattern, matchesFindPattern } from "./globMatch.js";
import { MAX_TOOL_FILE_BYTES, type AiChatSettings } from "./settings.js";

/*
 * Workspace tools exposed to the model.
 *
 * Every path is validated to stay inside the workspace root, file reads are
 * size/binary capped, and destructive operations honour the "confirm file
 * writes" setting with a modal confirmation.
 */

export type ToolResult = {
  /** JSON string returned to the model as the tool message. */
  content: string;
  ok: boolean;
  /** Short outcome shown on the tool card in the chat transcript. */
  summary: string;
  declined?: boolean;
};

const SEARCH_SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
]);

const SEARCH_MAX_FILES = 4000;
const SEARCH_MAX_RESULTS = 500;
const SEARCH_MAX_PATH_MATCHES = 100;
const SEARCH_LINE_MAX_CHARACTERS = 400;
const FIND_MAX_RESULTS = 500;

const READ_FILES_MAX_PATHS = 20;
const READ_FILES_TOTAL_CHARACTERS = 512 * 1024;

const LIST_DEFAULT_MAX_ENTRIES = 2000;
const LIST_HARD_MAX_ENTRIES = 10000;

const PATH_PARAMETER = {
  type: "string",
  description: "Relative path from the workspace root, for example: src/index.ts",
} as const;

export const WORKSPACE_TOOLS: OpenAiToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a UTF-8 text file from the workspace. Returns the file content. Paths are relative to the workspace root.",
      parameters: {
        type: "object",
        properties: { path: PATH_PARAMETER },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_files",
      description:
        "Read several UTF-8 text files in one call. Prefer this over multiple read_file calls when you already know which files you need. Paths are relative to the workspace root.",
      parameters: {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: { type: "string" },
            description: 'Relative file paths, for example ["src/index.ts", "README.md"].',
          },
        },
        required: ["paths"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or replace a UTF-8 text file in the workspace. Creates missing parent directories. Paths are relative to the workspace root.",
      parameters: {
        type: "object",
        properties: {
          path: PATH_PARAMETER,
          content: {
            type: "string",
            description: "Full UTF-8 text content to write.",
          },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description:
        "List files and subdirectories in a workspace directory. Set recursive to true to list every nested file in one call. Use '.' for the workspace root.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Optional relative directory path. Defaults to '.'.",
          },
          recursive: {
            type: "boolean",
            description:
              "Walk all nested directories and return a flat list of paths. Defaults to false.",
          },
          includeIgnored: {
            type: "boolean",
            description:
              "When recursive, also descend into node_modules, .git, dist, and similar folders. Defaults to false.",
          },
          maxEntries: {
            type: "number",
            description: `Maximum number of entries to return when recursive (default ${LIST_DEFAULT_MAX_ENTRIES}, maximum ${LIST_HARD_MAX_ENTRIES}).`,
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_directory",
      description:
        "Create a directory (and any missing parents) in the workspace. Paths are relative to the workspace root.",
      parameters: {
        type: "object",
        properties: { path: PATH_PARAMETER },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description:
        "Delete a file, or a directory when recursive is true. Paths are relative to the workspace root.",
      parameters: {
        type: "object",
        properties: {
          path: PATH_PARAMETER,
          recursive: {
            type: "boolean",
            description: "Delete a directory and everything inside it. Defaults to false.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_file",
      description:
        "Move or rename a file or directory inside the workspace. Creates missing parent directories for the destination.",
      parameters: {
        type: "object",
        properties: {
          from: PATH_PARAMETER,
          to: {
            type: "string",
            description: "Destination path relative to the workspace root.",
          },
        },
        required: ["from", "to"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_file_info",
      description:
        "Return metadata (type, size, modified time) for a file or directory in the workspace.",
      parameters: {
        type: "object",
        properties: { path: PATH_PARAMETER },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_files",
      description:
        "Find files and folders by name or glob pattern (for example App.tsx, *.css, **/*.tsx, src/**). Returns matching paths. Use this instead of search_files when you are looking for a filename.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Filename substring or glob pattern. Glob supports *, ?, and **.",
          },
          path: {
            type: "string",
            description: "Optional relative directory to search. Defaults to the workspace root.",
          },
          includeIgnored: {
            type: "boolean",
            description:
              "Also search node_modules, .git, dist, and similar folders. Defaults to false.",
          },
          maxResults: {
            type: "number",
            description: "Maximum number of matches to return (default 100, maximum 500).",
          },
        },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Search text files in the workspace for a string or regular expression. Returns matching paths, line numbers, and line text. Plain-text queries also match file paths. For filenames use find_files.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text to search for (or a regular expression when isRegex is true).",
          },
          path: {
            type: "string",
            description: "Optional relative directory to search. Defaults to the workspace root.",
          },
          isRegex: {
            type: "boolean",
            description: "Treat query as a JavaScript regular expression. Defaults to false.",
          },
          maxResults: {
            type: "number",
            description: `Maximum number of matches to return (default 100, maximum ${SEARCH_MAX_RESULTS}).`,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_file",
      description:
        "Open a workspace file in the editor and optionally jump to a 1-based line number. Use this to show the user a relevant file.",
      parameters: {
        type: "object",
        properties: {
          path: PATH_PARAMETER,
          line: {
            type: "number",
            description: "Optional 1-based line number to reveal.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
];

export const WORKSPACE_TOOL_PROMPT =
  "You can inspect and modify the current workspace using tools: read_file, read_files, " +
  "write_file, list_directory, create_directory, delete_file, move_file, get_file_info, " +
  "find_files, search_files, and open_file. All paths are relative to the workspace root. " +
  "Prefer read_files when you need several files, and list_directory with recursive: true " +
  "to enumerate nested files in one call. Use find_files for filenames or glob patterns, " +
  "and search_files for file contents. Use list_directory, find_files, search_files, and " +
  "read_file before writing, and never attempt to access paths outside the workspace. " +
  "After using tools, summarize what changed.";

function workspaceToolUri(
  vscode: typeof vscodeType,
  workspaceRootUri: vscodeType.Uri,
  relativePath: string,
): { uri: vscodeType.Uri; segments: string[]; path: string } {
  const normalized = relativePath.trim().replace(/\\/g, "/");

  if (normalized.length === 0) {
    throw new Error("Path must be a non-empty relative workspace path.");
  }

  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error("Path must be relative to the workspace root.");
  }

  const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");

  if (segments.length === 0) {
    if (normalized === ".") {
      return { uri: workspaceRootUri, segments: [], path: "." };
    }

    throw new Error("Path must be a non-empty relative workspace path.");
  }

  if (segments.some((segment) => segment === "..")) {
    throw new Error("Path must remain inside the authorized workspace.");
  }

  const uri = vscode.Uri.joinPath(workspaceRootUri, ...segments);
  const rootPath = workspaceRootUri.path.replace(/\/+$/, "");
  const uriPath = uri.path.replace(/\/+$/, "");

  if (uriPath !== rootPath && !uriPath.startsWith(`${rootPath}/`)) {
    throw new Error("Path must remain inside the authorized workspace.");
  }

  return { uri, segments, path: segments.join("/") };
}

function parentSegments(segments: string[]): string[] {
  return segments.slice(0, -1);
}

async function ensureWorkspaceDirectory(
  vscode: typeof vscodeType,
  workspaceRootUri: vscodeType.Uri,
  segments: string[],
): Promise<void> {
  for (let index = 1; index <= segments.length; index += 1) {
    const uri = vscode.Uri.joinPath(workspaceRootUri, ...segments.slice(0, index));

    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.workspace.fs.createDirectory(uri);
    }
  }
}

function stringArgument(args: Record<string, unknown>, name: string): string {
  const value = args[name];

  if (typeof value !== "string") {
    throw new Error(`Missing or invalid string argument: ${name}`);
  }

  return value;
}

function stringArrayArgument(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Missing or invalid string array argument: ${name}`);
  }

  return value as string[];
}

function optionalStringArgument(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];

  if (value == null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`Invalid string argument: ${name}`);
  }

  return value;
}

function booleanArgument(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];

  if (value == null) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw new Error(`Invalid boolean argument: ${name}`);
  }

  return value;
}

function numberArgument(args: Record<string, unknown>, name: string, fallback: number): number {
  const value = args[name];

  if (value == null) {
    return fallback;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid number argument: ${name}`);
  }

  return value;
}

function isDirectoryType(type: vscodeType.FileType): boolean {
  // FileType.Directory === 2. Keep this numeric so the helper stays free of a
  // runtime `vscode` import.
  return (type & 2) !== 0;
}

async function confirmMutation(
  vscode: typeof vscodeType,
  settings: AiChatSettings,
  message: string,
  action: string,
): Promise<boolean> {
  if (!settings.confirmWrites) {
    return true;
  }

  const choice = await vscode.window.showWarningMessage(message, { modal: true }, action);

  return choice === action;
}

function failure(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);

  return {
    content: JSON.stringify({ error: message }),
    ok: false,
    summary: message,
  };
}

function decline(reason: string): ToolResult {
  return {
    content: JSON.stringify({ error: reason }),
    ok: false,
    summary: reason,
    declined: true,
  };
}

async function readTextFile(
  vscode: typeof vscodeType,
  uri: vscodeType.Uri,
  path: string,
): Promise<string> {
  const stat = await vscode.workspace.fs.stat(uri);

  if (isDirectoryType(stat.type)) {
    throw new Error(`Not a file: ${path}`);
  }

  if (stat.size > MAX_TOOL_FILE_BYTES) {
    throw new Error(
      `File is too large to read (${stat.size} bytes; limit ${MAX_TOOL_FILE_BYTES}).`,
    );
  }

  const bytes = await vscode.workspace.fs.readFile(uri);

  if (bytes.byteLength > MAX_TOOL_FILE_BYTES) {
    throw new Error(
      `File is too large to read (${bytes.byteLength} bytes; limit ${MAX_TOOL_FILE_BYTES}).`,
    );
  }

  const content = new TextDecoder().decode(bytes);

  if (content.includes("\u0000")) {
    throw new Error(`Not a UTF-8 text file: ${path}`);
  }

  return content;
}

type SearchMatch = {
  path: string;
  line: number;
  text: string;
};

async function searchWorkspace(
  vscode: typeof vscodeType,
  root: { uri: vscodeType.Uri; path: string },
  query: string,
  isRegex: boolean,
  maxResults: number,
): Promise<{
  matches: SearchMatch[];
  pathMatches: string[];
  files: number;
  truncated: boolean;
}> {
  const matcher = isRegex
    ? new RegExp(query, "i")
    : {
        test(line: string) {
          return line.toLowerCase().includes(query.toLowerCase());
        },
      };

  const matches: SearchMatch[] = [];
  const pathMatches: string[] = [];
  const queue: { uri: vscodeType.Uri; path: string }[] = [root];
  const lowerQuery = query.toLowerCase();
  let files = 0;
  let truncated = false;

  while (queue.length > 0 && !truncated) {
    const current = queue.shift()!;
    let entries: [string, vscodeType.FileType][];

    try {
      entries = await vscode.workspace.fs.readDirectory(current.uri);
    } catch {
      continue;
    }

    for (const [name, type] of entries) {
      const childPath = current.path === "." ? name : `${current.path}/${name}`;
      const childUri = vscode.Uri.joinPath(current.uri, name);

      if (isDirectoryType(type)) {
        if (SEARCH_SKIP_DIRECTORIES.has(name.toLowerCase())) {
          continue;
        }

        queue.push({ uri: childUri, path: childPath });
        continue;
      }

      files += 1;

      if (files > SEARCH_MAX_FILES) {
        truncated = true;
        break;
      }

      if (
        !isRegex &&
        pathMatches.length < SEARCH_MAX_PATH_MATCHES &&
        childPath.toLowerCase().includes(lowerQuery)
      ) {
        pathMatches.push(childPath);
      }

      let content: string;

      try {
        content = await readTextFile(vscode, childUri, childPath);
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);

      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];

        if (!matcher.test(line)) {
          continue;
        }

        matches.push({
          path: childPath,
          line: index + 1,
          text:
            line.length > SEARCH_LINE_MAX_CHARACTERS
              ? `${line.slice(0, SEARCH_LINE_MAX_CHARACTERS)}…`
              : line,
        });

        if (matches.length >= maxResults) {
          truncated = true;
          break;
        }
      }

      if (truncated) {
        break;
      }
    }
  }

  return { matches, pathMatches, files, truncated };
}

type ListedEntry = {
  path: string;
  type: "file" | "directory";
};

async function listWorkspaceTree(
  vscode: typeof vscodeType,
  root: { uri: vscodeType.Uri; path: string },
  includeIgnored: boolean,
  maxEntries: number,
): Promise<{ entries: ListedEntry[]; truncated: boolean }> {
  const entries: ListedEntry[] = [];
  const queue: { uri: vscodeType.Uri; path: string }[] = [root];
  let truncated = false;

  while (queue.length > 0 && !truncated) {
    const current = queue.shift()!;
    let children: [string, vscodeType.FileType][];

    try {
      children = await vscode.workspace.fs.readDirectory(current.uri);
    } catch {
      continue;
    }

    for (const [name, type] of children) {
      const childPath =
        current.path === "." || current.path.length === 0 ? name : `${current.path}/${name}`;
      const directory = isDirectoryType(type);

      entries.push({
        path: childPath,
        type: directory ? "directory" : "file",
      });

      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }

      if (directory && (includeIgnored || !SEARCH_SKIP_DIRECTORIES.has(name.toLowerCase()))) {
        queue.push({ uri: vscode.Uri.joinPath(current.uri, name), path: childPath });
      }
    }
  }

  entries.sort((left, right) => left.path.localeCompare(right.path));

  return { entries, truncated };
}

export async function executeWorkspaceTool(
  vscode: typeof vscodeType,
  workspaceRootUri: vscodeType.Uri,
  settings: AiChatSettings,
  toolCall: OpenAiToolCall,
): Promise<ToolResult> {
  try {
    const args = JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;

    switch (toolCall.function.name) {
      case "read_file": {
        const target = workspaceToolUri(vscode, workspaceRootUri, stringArgument(args, "path"));
        const content = await readTextFile(vscode, target.uri, target.path);

        return {
          content: JSON.stringify({ path: target.path, content }),
          ok: true,
          summary: `Read ${target.path} (${content.length.toLocaleString()} chars)`,
        };
      }

      case "read_files": {
        const requested = stringArrayArgument(args, "paths");

        if (requested.length === 0) {
          throw new Error("paths must contain at least one file path.");
        }

        const paths = requested.slice(0, READ_FILES_MAX_PATHS);
        const skipped = requested.slice(READ_FILES_MAX_PATHS);
        const files: { path: string; content: string }[] = [];
        const errors: { path: string; error: string }[] = [];
        let remaining = READ_FILES_TOTAL_CHARACTERS;

        for (const rawPath of paths) {
          try {
            const target = workspaceToolUri(vscode, workspaceRootUri, rawPath);
            const content = await readTextFile(vscode, target.uri, target.path);

            if (content.length > remaining) {
              throw new Error(
                `Skipped: batch read limit of ${READ_FILES_TOTAL_CHARACTERS.toLocaleString()} characters reached.`,
              );
            }

            remaining -= content.length;
            files.push({ path: target.path, content });
          } catch (error) {
            errors.push({
              path: rawPath,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        return {
          content: JSON.stringify({
            files,
            errors,
            ...(skipped.length > 0 ? { skipped } : {}),
          }),
          ok: files.length > 0,
          summary:
            files.length > 0
              ? `Read ${files.length} file${files.length === 1 ? "" : "s"}${
                  errors.length > 0
                    ? ` (${errors.length} error${errors.length === 1 ? "" : "s"})`
                    : ""
                }`
              : `No files read (${errors.length} error${errors.length === 1 ? "" : "s"})`,
        };
      }

      case "write_file": {
        const target = workspaceToolUri(vscode, workspaceRootUri, stringArgument(args, "path"));
        const content = stringArgument(args, "content");
        const bytes = new TextEncoder().encode(content);

        if (bytes.byteLength > MAX_TOOL_FILE_BYTES) {
          throw new Error(
            `Content is too large to write (${bytes.byteLength} bytes; limit ${MAX_TOOL_FILE_BYTES}).`,
          );
        }

        const confirmed = await confirmMutation(
          vscode,
          settings,
          `Dataverse AI wants to write \`${target.path}\` (${bytes.byteLength} bytes).`,
          "Write",
        );

        if (!confirmed) {
          return decline(`The user declined writing ${target.path}.`);
        }

        await ensureWorkspaceDirectory(vscode, workspaceRootUri, parentSegments(target.segments));
        await vscode.workspace.fs.writeFile(target.uri, bytes);

        return {
          content: JSON.stringify({
            success: true,
            path: target.path,
            bytesWritten: bytes.byteLength,
          }),
          ok: true,
          summary: `Wrote ${target.path} (${bytes.byteLength} bytes)`,
        };
      }

      case "list_directory": {
        const rawPath = optionalStringArgument(args, "path");
        const target = workspaceToolUri(
          vscode,
          workspaceRootUri,
          rawPath == null || rawPath.trim().length === 0 ? "." : rawPath,
        );
        const recursive = booleanArgument(args, "recursive", false);

        if (!recursive) {
          const entries = await vscode.workspace.fs.readDirectory(target.uri);

          return {
            content: JSON.stringify({
              path: target.path,
              entries: entries.map(([name, type]) => ({
                name,
                type: isDirectoryType(type) ? "directory" : "file",
              })),
            }),
            ok: true,
            summary: `Listed ${target.path} (${entries.length} entries)`,
          };
        }

        const includeIgnored = booleanArgument(args, "includeIgnored", false);
        const requested = Math.round(numberArgument(args, "maxEntries", LIST_DEFAULT_MAX_ENTRIES));
        const maxEntries = Math.min(LIST_HARD_MAX_ENTRIES, Math.max(1, requested));
        const listed = await listWorkspaceTree(vscode, target, includeIgnored, maxEntries);

        return {
          content: JSON.stringify({
            path: target.path,
            recursive: true,
            entries: listed.entries,
            truncated: listed.truncated,
          }),
          ok: true,
          summary: `Listed ${target.path} (${listed.entries.length} entries, recursive${
            listed.truncated ? ", truncated" : ""
          })`,
        };
      }

      case "create_directory": {
        const target = workspaceToolUri(vscode, workspaceRootUri, stringArgument(args, "path"));

        await ensureWorkspaceDirectory(vscode, workspaceRootUri, target.segments);

        return {
          content: JSON.stringify({ success: true, path: target.path }),
          ok: true,
          summary: `Created ${target.path}`,
        };
      }

      case "delete_file": {
        const target = workspaceToolUri(vscode, workspaceRootUri, stringArgument(args, "path"));
        const recursive = booleanArgument(args, "recursive", false);

        if (target.segments.length === 0) {
          throw new Error("Refusing to delete the workspace root.");
        }

        const confirmed = await confirmMutation(
          vscode,
          settings,
          `Dataverse AI wants to delete \`${target.path}\`${recursive ? " and everything inside it" : ""}.`,
          "Delete",
        );

        if (!confirmed) {
          return decline(`The user declined deleting ${target.path}.`);
        }

        await vscode.workspace.fs.delete(target.uri, { recursive, useTrash: false });

        return {
          content: JSON.stringify({ success: true, path: target.path, recursive }),
          ok: true,
          summary: `Deleted ${target.path}`,
        };
      }

      case "move_file": {
        const from = workspaceToolUri(vscode, workspaceRootUri, stringArgument(args, "from"));
        const to = workspaceToolUri(vscode, workspaceRootUri, stringArgument(args, "to"));

        if (from.segments.length === 0 || to.segments.length === 0) {
          throw new Error("Refusing to move the workspace root.");
        }

        const confirmed = await confirmMutation(
          vscode,
          settings,
          `Dataverse AI wants to move \`${from.path}\` to \`${to.path}\`.`,
          "Move",
        );

        if (!confirmed) {
          return decline(`The user declined moving ${from.path}.`);
        }

        await ensureWorkspaceDirectory(vscode, workspaceRootUri, parentSegments(to.segments));
        await vscode.workspace.fs.rename(from.uri, to.uri, { overwrite: false });

        return {
          content: JSON.stringify({ success: true, from: from.path, to: to.path }),
          ok: true,
          summary: `Moved ${from.path} → ${to.path}`,
        };
      }

      case "get_file_info": {
        const target = workspaceToolUri(vscode, workspaceRootUri, stringArgument(args, "path"));
        const stat = await vscode.workspace.fs.stat(target.uri);
        const type = isDirectoryType(stat.type) ? "directory" : "file";

        return {
          content: JSON.stringify({
            path: target.path,
            type,
            size: stat.size,
            mtime: stat.mtime,
          }),
          ok: true,
          summary: `${target.path}: ${type}, ${stat.size.toLocaleString()} bytes`,
        };
      }

      case "find_files": {
        const pattern = stringArgument(args, "pattern").trim();

        if (pattern.length === 0) {
          throw new Error("Find pattern must not be empty.");
        }

        const rawPath = optionalStringArgument(args, "path");
        const root = workspaceToolUri(
          vscode,
          workspaceRootUri,
          rawPath == null || rawPath.trim().length === 0 ? "." : rawPath,
        );
        const includeIgnored = booleanArgument(args, "includeIgnored", false);
        const requested = Math.round(numberArgument(args, "maxResults", 100));
        const maxResults = Math.min(FIND_MAX_RESULTS, Math.max(1, requested));
        const scanned = await listWorkspaceTree(
          vscode,
          root,
          includeIgnored,
          LIST_HARD_MAX_ENTRIES,
        );
        const matcher = isGlobPattern(pattern) ? globToRegExp(pattern) : undefined;
        const matches: ListedEntry[] = [];

        for (const entry of scanned.entries) {
          if (!matchesFindPattern(matcher, pattern, entry.path)) {
            continue;
          }

          matches.push(entry);

          if (matches.length >= maxResults) {
            break;
          }
        }

        return {
          content: JSON.stringify({
            pattern,
            path: root.path,
            matches,
            truncated: scanned.truncated || matches.length >= maxResults,
          }),
          ok: true,
          summary:
            matches.length === 0
              ? `No files matching “${pattern}”`
              : `${matches.length} file${matches.length === 1 ? "" : "s"} matching “${pattern}”`,
        };
      }

      case "search_files": {
        const query = stringArgument(args, "query");

        if (query.length === 0) {
          throw new Error("Search query must not be empty.");
        }

        const rawPath = optionalStringArgument(args, "path");
        const root = workspaceToolUri(
          vscode,
          workspaceRootUri,
          rawPath == null || rawPath.trim().length === 0 ? "." : rawPath,
        );
        const isRegex = booleanArgument(args, "isRegex", false);
        const requested = Math.round(numberArgument(args, "maxResults", 100));
        const maxResults = Math.min(SEARCH_MAX_RESULTS, Math.max(1, requested));
        const result = await searchWorkspace(vscode, root, query, isRegex, maxResults);

        return {
          content: JSON.stringify({
            query,
            path: root.path,
            matches: result.matches,
            pathMatches: result.pathMatches,
            truncated: result.truncated,
            filesScanned: result.files,
          }),
          ok: true,
          summary:
            result.matches.length === 0 && result.pathMatches.length === 0
              ? `No matches for “${query}”`
              : `${result.matches.length} content match${
                  result.matches.length === 1 ? "" : "es"
                }, ${result.pathMatches.length} path match${
                  result.pathMatches.length === 1 ? "" : "es"
                } for “${query}”`,
        };
      }

      case "open_file": {
        const target = workspaceToolUri(vscode, workspaceRootUri, stringArgument(args, "path"));
        const lineArgument = args.line;

        if (
          lineArgument != null &&
          (typeof lineArgument !== "number" || !Number.isFinite(lineArgument))
        ) {
          throw new Error("Invalid number argument: line");
        }

        const document = await vscode.workspace.openTextDocument(target.uri);
        const line = typeof lineArgument === "number" ? Math.max(1, Math.round(lineArgument)) : 1;
        const position = new vscode.Position(Math.min(line - 1, document.lineCount - 1), 0);

        await vscode.window.showTextDocument(document, {
          preview: false,
          selection: new vscode.Range(position, position),
        });

        return {
          content: JSON.stringify({ success: true, path: target.path, line }),
          ok: true,
          summary: `Opened ${target.path}${typeof lineArgument === "number" ? ` at line ${line}` : ""}`,
        };
      }

      default:
        return {
          content: JSON.stringify({ error: `Unsupported tool: ${toolCall.function.name}` }),
          ok: false,
          summary: `Unsupported tool: ${toolCall.function.name}`,
        };
    }
  } catch (error) {
    return failure(error);
  }
}
