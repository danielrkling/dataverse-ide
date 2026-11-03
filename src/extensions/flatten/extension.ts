import type * as vscodeType from "vscode";

import { contributeExtensionManifest } from "../api.js";

import guideContent from "./GUIDE.md?raw";

import { registerGuide } from "../shared/guide.js";

import type { ExtensionContext, IdeExtension } from "../api.js";

/*
 * Flatten extension: combine selected files into a single markdown
 * document (one fenced block per file, path as heading) - useful as LLM
 * context or a quick review bundle.
 *
 * Right-click entries in the file explorer invoke the command with the
 * selected resource URI(s).
 */

const COMMAND_FLATTEN_SELECTED = "dataverseIde.flatten.selected";

/*
 * Output files are written to the workspace root as
 * `~<folder-names>#<n>.md`, e.g. `~src-extensions#1.md`. The number
 * autoincrements so successive runs never overwrite each other, and the
 * leading `~` keeps bundles grouped together in the explorer.
 */
const MAX_SLUG_LENGTH = 40;

/* Generated bundles are skipped when flattening a directory so repeat runs
 * don't fold earlier output back into the new bundle. */
const FLATTEN_OUTPUT_PATTERN = /^~.*#(\d+)\.md$/;

/* Keep a pathological selection from freezing the editor. */
const MAX_FILES_PER_FOLDER = 500;

/* Directories that are never flattened, even when selected as a folder. */
const EXCLUDED_DIRECTORY_NAMES = new Set([".git", "node_modules", ".ide-build", "dist"]);

function isUriLike(value: unknown): value is vscodeType.Uri {
  return (
    typeof value === "object" &&
    value != null &&
    "scheme" in value &&
    typeof (value as { scheme?: unknown }).scheme === "string" &&
    "path" in value &&
    typeof (value as { path?: unknown }).path === "string"
  );
}

/*
 * Explorer context menus forward the selection in more than one shape:
 * the focused resource is passed as the first command argument and the full
 * multi-selection (an array of URIs) is appended after it. Some callers also
 * pass `{ resourceUri }`, `{ resource }` or `{ uri }` wrappers, so normalize
 * all of them here and flatten nested arrays.
 */
function toUris(value: unknown): vscodeType.Uri[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => toUris(entry));
  }

  if (isUriLike(value)) {
    return [value];
  }

  if (typeof value === "object" && value != null) {
    for (const key of ["resourceUri", "resource", "uri"] as const) {
      const candidate = (value as Record<string, unknown>)[key];

      if (isUriLike(candidate)) {
        return [candidate];
      }
    }
  }

  return [];
}

/*
 * Workspace-relative path derived from the workspace root instead of
 * asRelativePath(): the local-folder and OPFS providers both expose `file`
 * URIs, but their paths are not guaranteed to be reported the same way.
 */
function workspaceRelativePath(
  vscode: typeof vscodeType,
  workspaceRootUri: vscodeType.Uri,
  uri: vscodeType.Uri,
): string {
  if (uri.scheme === "file") {
    const rootPath = workspaceRootUri.path.replace(/\/+$/, "");
    const uriPath = uri.path.replace(/\/+$/, "");

    if (rootPath.length === 0 || uriPath === rootPath || uriPath.startsWith(`${rootPath}/`)) {
      const relativePath = (rootPath.length > 0 ? uriPath.slice(rootPath.length) : uriPath)
        .replace(/^\/+/, "")
        .replaceAll("\\", "/");

      if (relativePath.length > 0) {
        return relativePath;
      }
    }
  }

  return vscode.workspace.asRelativePath(uri, false).replaceAll("\\", "/");
}

/*
 * Walk a selected folder through the file system provider directly.
 *
 * vscode.workspace.findFiles() is backed by the workbench search service in
 * this browser build, which can return cached or workspace-wide results
 * depending on provider and timing. Recursing through workspace.fs works the
 * same for local folders, OPFS workspaces and the OPFS overlay.
 */
async function collectDirectoryFiles(
  vscode: typeof vscodeType,
  directory: vscodeType.Uri,
  outputChannel: vscodeType.OutputChannel,
): Promise<vscodeType.Uri[]> {
  const files: vscodeType.Uri[] = [];
  const pending: vscodeType.Uri[] = [directory];

  while (pending.length > 0 && files.length < MAX_FILES_PER_FOLDER) {
    const current = pending.shift()!;

    let entries: Array<[string, vscodeType.FileType]>;

    try {
      entries = await vscode.workspace.fs.readDirectory(current);
    } catch {
      outputChannel.appendLine(
        `[flatten] could not read directory ${vscode.workspace.asRelativePath(current, false)}`,
      );
      continue;
    }

    entries.sort(([left], [right]) => left.localeCompare(right));

    for (const [name, type] of entries) {
      const child = vscode.Uri.joinPath(current, name);

      if ((type & vscode.FileType.Directory) !== 0) {
        if (!EXCLUDED_DIRECTORY_NAMES.has(name.toLowerCase())) {
          pending.push(child);
        }

        continue;
      }

      if ((type & vscode.FileType.File) === 0 || isGeneratedFlattenFile(child)) {
        continue;
      }

      files.push(child);

      if (files.length >= MAX_FILES_PER_FOLDER) {
        break;
      }
    }
  }

  return files;
}

/*
 * Extensions that are known-decodable as text. Everything else (images,
 * binaries) is skipped with a placeholder note.
 */
const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "jsonc",
  "json5",
  "webmanifest",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  "css",
  "scss",
  "sass",
  "less",
  "html",
  "htm",
  "xml",
  "svg",
  "xsl",
  "yml",
  "yaml",
  "csv",
  "ini",
  "cfg",
  "toml",
  "env",
  "sh",
  "bat",
  "ps1",
  "resx",
  "config",
]);

function extensionOf(uri: vscodeType.Uri): string {
  const name = uri.path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");

  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function languageTag(uri: vscodeType.Uri): string {
  const extension = extensionOf(uri);

  const aliases: Record<string, string> = {
    htm: "html",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "javascript",
    ts: "typescript",
    mts: "typescript",
    cts: "typescript",
    tsx: "tsx",
    md: "markdown",
    markdown: "markdown",
    yml: "yaml",
    jsonc: "json",
    json5: "json",
    resx: "xml",
    config: "xml",
  };

  return aliases[extension] ?? (extension || "");
}

function isGeneratedFlattenFile(uri: vscodeType.Uri): boolean {
  const name = uri.path.split("/").at(-1) ?? "";

  return FLATTEN_OUTPUT_PATTERN.test(name);
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/*
 * Build a short, filesystem-safe name from the selected folders. Only the
 * trailing (most specific) folder names are kept when the full path would be
 * too long; root-level files therefore fall back to just the numeric suffix.
 */
function selectionSlug(
  selections: Array<{ path: string; isDirectory: boolean }>,
): string | undefined {
  const segments: string[] = [];

  for (const selection of selections) {
    const parts = selection.path
      .replace(/\\/g, "/")
      .replace(/^\.?\//, "")
      .split("/")
      .filter(Boolean);

    const folderParts = selection.isDirectory ? parts : parts.slice(0, -1);

    for (const part of folderParts) {
      const slug = slugify(part);

      if (slug !== "" && !segments.includes(slug)) {
        segments.push(slug);
      }
    }
  }

  while (segments.length > 1 && segments.join("-").length > MAX_SLUG_LENGTH) {
    segments.shift();
  }

  const slug = segments.join("-");

  return slug === "" || slug.length > MAX_SLUG_LENGTH ? undefined : slug;
}

async function nextBundleNumber(
  vscode: typeof vscodeType,
  workspaceRoot: vscodeType.Uri,
): Promise<number> {
  let entries: Array<[string, vscodeType.FileType]>;

  try {
    entries = await vscode.workspace.fs.readDirectory(workspaceRoot);
  } catch {
    return 1;
  }

  let highest = 0;

  for (const [name] of entries) {
    const match = FLATTEN_OUTPUT_PATTERN.exec(name);

    if (match != null) {
      highest = Math.max(highest, Number(match[1]));
    }
  }

  return highest + 1;
}

async function outputFileName(
  vscode: typeof vscodeType,
  workspaceRoot: vscodeType.Uri,
  selections: Array<{ path: string; isDirectory: boolean }>,
): Promise<string> {
  const slug = selectionSlug(selections);
  const number = await nextBundleNumber(vscode, workspaceRoot);

  return `~${slug != null ? `${slug}#` : "#"}${number}.md`;
}

function fencedBlock(language: string, content: string): string {
  /*
   * Use one more backtick than the longest backtick run inside the content
   * so nested fenced blocks never break the outer fence.
   */
  const longestRun =
    content.match(/`+/g)?.reduce((longest, run) => Math.max(longest, run.length), 0) ?? 0;

  const fence = "`".repeat(Math.max(3, longestRun + 1));

  return `${fence}${language}\n${content.replace(/\s+$/, "")}\n${fence}`;
}

export default {
  id: "flatten",

  async activate(context: ExtensionContext): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context;

    const guideRegistration = registerGuide({
      vscode,
      extensionId: "flatten",
      content: guideContent,
    });

    await contributeExtensionManifest({
      id: "flatten",
      displayName: "Dataverse IDE Flatten",
      description: "Combine selected files into a single markdown document.",
      commands: [
        {
          command: COMMAND_FLATTEN_SELECTED,
          title: "Flatten: Combine Selected Files into Markdown",
        },
        {
          command: "dataverseIde.flatten.openGuide",
          title: "Flatten: How-to Guide",
        },
      ],
      menus: [
        {
          menu: "explorer/context",
          command: COMMAND_FLATTEN_SELECTED,
          group: "dataverse@70",
        },
      ],
    });

    const flattenCommand = vscode.commands.registerCommand(
      COMMAND_FLATTEN_SELECTED,
      async (...args: unknown[]) => {
        /*
         * Context-menu invocations pass the focused resource *and* the full
         * selection array as separate arguments, so merge every argument
         * instead of reading only the first one (which collapsed a
         * multi-selection to the single clicked file).
         */
        const uris: vscodeType.Uri[] = [];
        const seenUris = new Set<string>();

        for (const arg of args) {
          for (const uri of toUris(arg)) {
            const key = uri.toString();

            if (!seenUris.has(key)) {
              seenUris.add(key);
              uris.push(uri);
            }
          }
        }

        /*
         * Command-palette / welcome-page invocations have no selection; fall
         * back to the active editor so the action still does something useful.
         */
        if (uris.length === 0) {
          const activeUri = vscode.window.activeTextEditor?.document.uri;

          if (activeUri != null && activeUri.scheme === "file") {
            const rootPath = context.workspaceRootUri.path.replace(/\/+$/, "");
            const activePath = activeUri.path.replace(/\/+$/, "");

            if (
              rootPath.length === 0 ||
              activePath === rootPath ||
              activePath.startsWith(`${rootPath}/`)
            ) {
              uris.push(activeUri);
            }
          }
        }

        if (uris.length === 0) {
          await vscode.window.showWarningMessage(
            "Flatten: select one or more files in the explorer first.",
          );

          return;
        }

        const sections: string[] = [];
        const selections: Array<{ path: string; isDirectory: boolean }> = [];
        const seenFiles = new Set<string>();
        let included = 0;
        let skipped = 0;

        for (const uri of uris) {
          const relativePath = workspaceRelativePath(vscode, context.workspaceRootUri, uri);

          let stat: vscodeType.FileStat;

          try {
            stat = await vscode.workspace.fs.stat(uri);
          } catch {
            skipped++;
            outputChannel.appendLine(`[flatten] could not stat ${relativePath}`);
            continue;
          }

          const isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
          selections.push({ path: relativePath, isDirectory });

          const files = isDirectory
            ? await collectDirectoryFiles(vscode, uri, outputChannel)
            : [uri];

          for (const file of files) {
            /*
             * A file can appear twice when the user selects a folder and one
             * of its descendants, or when the same resource is forwarded as
             * both the focused argument and part of the selection array.
             */
            if (!seenFiles.add(file.toString())) {
              continue;
            }

            const section = await readSection(vscode, context.workspaceRootUri, file);

            if (section != null) {
              sections.push(section);
              included++;
            } else {
              skipped++;
            }
          }
        }

        if (sections.length === 0) {
          await vscode.window.showWarningMessage(
            "Flatten: no readable text files in the selection.",
          );

          return;
        }

        const generatedAt = new Date();
        const header =
          `# Flattened workspace files\n\n` +
          `Generated ${generatedAt.toISOString()} — ` +
          `${included} file(s)` +
          (skipped > 0 ? `, ${skipped} skipped (binary or unreadable)` : "") +
          `\n`;

        const markdown = `${header}\n${sections.join("\n\n")}\n`;
        const fileName = await outputFileName(vscode, context.workspaceRootUri, selections);

        const outFile = vscode.Uri.joinPath(context.workspaceRootUri, fileName);

        await vscode.workspace.fs.writeFile(outFile, new TextEncoder().encode(markdown));

        outputChannel.appendLine(`[flatten] wrote ${included} file(s) to ${fileName}.`);

        await vscode.window.showTextDocument(outFile);
      },
    );

    outputChannel.appendLine("[flatten] extension activated.");

    return {
      dispose() {
        flattenCommand.dispose();
        guideRegistration.dispose();
      },
    };
  },
} satisfies IdeExtension;

async function readSection(
  vscode: typeof vscodeType,
  workspaceRootUri: vscodeType.Uri,
  uri: vscodeType.Uri,
): Promise<string | undefined> {
  const relativePath = workspaceRelativePath(vscode, workspaceRootUri, uri);

  if (!TEXT_EXTENSIONS.has(extensionOf(uri))) {
    return `## ${relativePath}\n\n_(binary or unsupported file type - skipped)_`;
  }

  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder().decode(bytes);

    return `## ${relativePath}\n\n${fencedBlock(languageTag(uri), text)}`;
  } catch {
    return `## ${relativePath}\n\n_(unreadable - skipped)_`;
  }
}
