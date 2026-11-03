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
      async (arg?: vscodeType.Uri | vscodeType.Uri[]) => {
        /*
         * The explorer passes a single URI when one item is selected and an
         * array when several are (or when invoked from the parent of a
         * multi-select).
         */
        const uris = Array.isArray(arg) ? arg : arg != null ? [arg] : [];

        if (uris.length === 0) {
          await vscode.window.showWarningMessage(
            "Flatten: select one or more files in the explorer first.",
          );

          return;
        }

        const sections: string[] = [];
        const selections: Array<{ path: string; isDirectory: boolean }> = [];
        let included = 0;
        let skipped = 0;

        for (const uri of uris) {
          const relativePath = vscode.workspace.asRelativePath(uri, false);

          let stat: vscodeType.FileStat;

          try {
            stat = await vscode.workspace.fs.stat(uri);
          } catch {
            skipped++;
            outputChannel.appendLine(`[flatten] could not stat ${relativePath}`);
            continue;
          }

          const isDirectory = stat.type === vscode.FileType.Directory;
          selections.push({ path: relativePath, isDirectory });

          if (isDirectory) {
            /*
             * Include directory selections by flattening their text files
             * recursively.
             */
            const children = await vscode.workspace.findFiles(
              new vscode.RelativePattern(uri, "**/*"),
              "{**/.git/**,**/node_modules/**,**/.ide-build/**,**/dist/**}",
              500,
            );

            for (const child of children) {
              if (isGeneratedFlattenFile(child)) {
                continue;
              }

              const section = await readSection(vscode, child);

              if (section != null) {
                sections.push(section);
                included++;
              } else {
                skipped++;
              }
            }

            continue;
          }

          const section = await readSection(vscode, uri);

          if (section != null) {
            sections.push(section);
            included++;
          } else {
            skipped++;
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
  uri: vscodeType.Uri,
): Promise<string | undefined> {
  const relativePath = vscode.workspace.asRelativePath(uri, false);

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
