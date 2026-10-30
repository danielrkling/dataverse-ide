import type * as vscodeType from "vscode";

import * as prettier from "prettier/standalone";

/*
 * Plugin modules must be passed as whole namespace objects (the way
 * prettier's standalone docs recommend). Destructuring `{ parsers }` out of
 * these subpath modules yields an object with no parser entries.
 */
import * as prettierPluginBabel from "prettier/plugins/babel";
import * as prettierPluginEstree from "prettier/plugins/estree";
import * as prettierPluginTypescript from "prettier/plugins/typescript";
import * as prettierPluginHtml from "prettier/plugins/html";
import * as prettierPluginPostcss from "prettier/plugins/postcss";
import * as prettierPluginYaml from "prettier/plugins/yaml";
import * as prettierPluginMarkdown from "prettier/plugins/markdown";
import * as prettierPluginGraphql from "prettier/plugins/graphql";
import { createPlugin as createTaggedJsxPlugin } from "@tagged-jsx/prettier-plugin/web";

import type { ExtensionContext, IdeExtension } from "../api.js";

import { ExtensionHostKind, registerExtension } from "@codingame/monaco-vscode-api/extensions";

/*
 * Prettier extension: formats the active document with the browser build
 * of Prettier ("prettier/standalone" plus its parser plugins, which carry
 * the estree printer even though no explicit parser is consumed from it).
 *
 * Formatting edit providers MUST be registered through the extension host
 * api (registerExtension -> getApi). The main-thread vscode module does not
 * expose languages.registerDocumentFormattingEditProvider, and without an
 * extension-host registration the "Format Document" menu entry never
 * appears.
 */

const COMMAND_FORMAT = "dataverseIde.prettier.formatDocument";

/*
 * Default tags whose contents are treated as embedded JSX by
 * prettier-plugin-embed's estree extension, configurable per workspace
 * through "embeddedJsxTags" in .prettierrc.
 */
const DEFAULT_EMBEDDED_JSX_TAGS = ["jsx", "html"];

const plugins = [
  prettierPluginEstree,
  prettierPluginBabel,
  prettierPluginTypescript,
  prettierPluginHtml,
  prettierPluginPostcss,
  prettierPluginYaml,
  prettierPluginMarkdown,
  prettierPluginGraphql,
];

/* Monaco language ids supported by the bundled parser set. */
const PARSER_BY_LANGUAGE: Record<string, string> = {
  javascript: "babel",
  typescript: "typescript",
  tsx: "typescript",
  jsx: "babel",
  html: "html",
  vue: "vue",
  css: "css",
  scss: "scss",
  less: "less",
  json: "json",
  jsonc: "json5",
  yaml: "yaml",
  markdown: "markdown",
  mdx: "mdx",
  graphql: "graphql",
};

const PARSER_BY_EXTENSION: Record<string, string> = {
  html: "html",
  htm: "html",
  js: "babel",
  cjs: "babel",
  mjs: "babel",
  jsx: "babel",
  ts: "typescript",
  cts: "typescript",
  mts: "typescript",
  tsx: "typescript",
  vue: "vue",
  css: "css",
  scss: "scss",
  less: "less",
  json: "json",
  jsonc: "json5",
  json5: "json5",
  yml: "yaml",
  yaml: "yaml",
  md: "markdown",
  markdown: "markdown",
  mdx: "mdx",
  graphql: "graphql",
  gql: "graphql",
};

/* Config files consulted, in the order they are found. */
const CONFIG_CANDIDATES = [".prettierrc", ".prettierrc.json", ".prettierrc.json5"];

/*
 * Fallback file names so the parsers always see a path: several (the
 * TypeScript parser distinguishing .tsx from .ts, the babel parser's jsx
 * detection, markdown front-matter) branch on the "filepath" option.
 */
const FILEPATH_BY_LANGUAGE: Record<string, string> = {
  javascript: "file.js",
  typescript: "file.ts",
  html: "file.html",
  vue: "file.vue",
  css: "file.css",
  scss: "file.scss",
  less: "file.less",
  json: "file.json",
  jsonc: "file.jsonc",
  yaml: "file.yaml",
  markdown: "file.md",
  mdx: "file.mdx",
  graphql: "file.graphql",
};

/*
 * The tagged-JSX embed plugin merges the babel/typescript parsers with the
 * estree printer, so its instance is keyed by configured tags and reused
 * across format calls.
 */
const taggedJsxPlugins = new Map<string, unknown>();

function getTaggedJsxPlugin(tags: string[]): unknown {
  const key = tags.join(",");

  let plugin = taggedJsxPlugins.get(key);

  if (plugin == null) {
    plugin = createTaggedJsxPlugin(tags);
    taggedJsxPlugins.set(key, plugin);
  }

  return plugin;
}

function formatPlugins(embeddedJsxTags: string[] | undefined): unknown[] {
  return [getTaggedJsxPlugin(embeddedJsxTags ?? DEFAULT_EMBEDDED_JSX_TAGS), ...plugins];
}

function extensionOf(uri: vscodeType.Uri): string {
  const name = uri.path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");

  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function parserOf(document: vscodeType.TextDocument): string | undefined {
  return PARSER_BY_LANGUAGE[document.languageId] ?? PARSER_BY_EXTENSION[extensionOf(document.uri)];
}

/*
 * Reads the workspace's prettierrc-style options. Not a full parser
 * (no .prettierrc.js, no overrides), but covers a JSON / JSONC prettierrc
 * or a "prettier" key in package.json.
 */
async function resolveOptions(
  vscodeApiForFs: typeof vscodeType,
  workspaceRootUri: vscodeType.Uri,
): Promise<Record<string, unknown>> {
  for (const fileName of CONFIG_CANDIDATES) {
    try {
      const uri = vscodeApiForFs.Uri.joinPath(workspaceRootUri, fileName);
      const bytes = await vscodeApiForFs.workspace.fs.readFile(uri);

      // Prettier tolerates comments and trailing commas in .prettierrc;
      // strip them so JSON.parse succeeds.
      const text = new TextDecoder()
        .decode(bytes)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/(?!$)[^\n]*/g, "$1")
        .replace(/,(\s*[}\]])/g, "$1");

      const parsed = JSON.parse(text);

      if (parsed != null && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Missing or unreadable config: try the next candidate.
    }
  }

  try {
    const uri = vscodeApiForFs.Uri.joinPath(workspaceRootUri, "package.json");
    const bytes = await vscodeApiForFs.workspace.fs.readFile(uri);
    const pkg = JSON.parse(new TextDecoder().decode(bytes)) as {
      prettier?: Record<string, unknown>;
    };

    if (pkg.prettier != null && typeof pkg.prettier === "object") {
      return pkg.prettier;
    }
  } catch {
    // No package.json or no prettier key: defaults it is.
  }

  return {};
}

function createFormatProvider(
  vscodeApi: typeof vscodeType,
  workspaceRootUri: vscodeType.Uri,
): {
  formatText: (
    document: vscodeType.TextDocument,
    range?: vscodeType.Range,
  ) => Promise<vscodeType.TextEdit[]>;
  formatDocument: vscodeType.DocumentFormattingEditProvider;
  formatRange: vscodeType.DocumentRangeFormattingEditProvider;
} {
  const formatText = async (
    document: vscodeType.TextDocument,
    range?: vscodeType.Range,
  ): Promise<vscodeType.TextEdit[]> => {
    const parser = parserOf(document);

    if (parser == null) {
      // Not a language we can format; the workbench will try other
      // providers registered for the document.
      return [];
    }

    const source = document.getText(range);

    // The parsers branch on a filepath (TypeScript picks tsx parsing from a
    // ".tsx" suffix), so always supply one, real or synthesized.
    const fileName = document.fileName ?? "";
    const hasExtension = fileName.includes(".");
    const filepath = hasExtension ? fileName : FILEPATH_BY_LANGUAGE[document.languageId];

    try {
      const baseOptions = await resolveOptions(vscodeApi, workspaceRootUri);

      // "embeddedJsxTags" drives the tagged-JSX plugin, not prettier core.
      const { embeddedJsxTags, ...optionsWithoutPlugin } = baseOptions as Record<string, unknown>;

      const formatted = await prettier.format(source, {
        ...optionsWithoutPlugin,
        parser,
        filepath,
        plugins: formatPlugins(embeddedJsxTags as string[] | undefined),
      } as import("prettier").Options);

      if (formatted === source) {
        return [];
      }

      const rangeStartLine = range?.start.line ?? 0;
      const rangeStartChar = range?.start.character ?? 0;
      const lastLine = range ? range.end.line : document.lineCount - 1;
      const rangeEndLine = range?.end.line ?? lastLine;
      const rangeEndChar = range?.end.character ?? document.lineAt(lastLine).text.length;

      return [
        {
          range: new vscodeApi.Range(rangeStartLine, rangeStartChar, rangeEndLine, rangeEndChar),
          newText: formatted,
        },
      ];
    } catch (error) {
      // Prettier throws on syntax errors; surface it, but don't crash.
      console.warn(
        "[Dataverse IDE] Prettier could not format this document:",
        error instanceof Error ? error.message : error,
      );

      return [];
    }
  };

  return {
    formatText,
    formatDocument: {
      provideDocumentFormattingEdits: (document) => formatText(document),
    },
    formatRange: {
      provideDocumentRangeFormattingEdits: (document, range) => formatText(document, range),
    },
  };
}

export default {
  id: "prettier",

  async activate(context: ExtensionContext): Promise<vscodeType.Disposable | void> {
    const { workspaceRootUri } = context;

    /*
     * Register this extension with the extension host so that languages.*
     * registrations flow through extHostLanguageFeatures into the
     * workbench's formatter service. The returned api runs this code as a
     * real extension.
     */
    const { getApi } = registerExtension(
      {
        name: "dataverse-ide-prettier",
        publisher: "dataverse-ide",
        version: "0.1.0",
        engines: {
          vscode: "*",
        },
        displayName: "Dataverse IDE Prettier",
        description: "Format documents with Prettier.",
        contributes: {
          commands: [
            {
              command: COMMAND_FORMAT,
              title: "Prettier: Format Document",
            },
          ],
          configuration: {
            title: "Prettier",
            properties: {
              "dataverseIde.prettier.formatOnSave": {
                type: "boolean",
                default: false,
                description: "Run Prettier every time a file is saved.",
              },
            },
          },
        },
      },
      ExtensionHostKind.LocalProcess,
    );

    // Extension-host api; do not fall back to context.vscode here: that is
    // the main-thread module and its languages namespace cannot register
    // formatting edit providers.
    const vscode = (await getApi()) as unknown as typeof vscodeType;

    const provider = createFormatProvider(vscode, workspaceRootUri);
    const disposables: vscodeType.Disposable[] = [];

    for (const language of Object.keys(PARSER_BY_LANGUAGE)) {
      disposables.push(
        vscode.languages.registerDocumentFormattingEditProvider(language, provider.formatDocument),
        vscode.languages.registerDocumentRangeFormattingEditProvider(
          language,
          provider.formatRange,
        ),
      );
    }

    disposables.push(
      vscode.commands.registerCommand(COMMAND_FORMAT, async (arg?: vscodeType.Uri) => {
        let document: vscodeType.TextDocument | undefined;

        if (arg != null) {
          document = vscode.workspace.textDocuments.find(
            (candidate) => candidate.uri.toString() === arg.toString(),
          );
        } else {
          document = vscode.window.activeTextEditor?.document;
        }

        if (document == null) {
          context.outputChannel.appendLine("No active document to format; nothing to do.");

          return;
        }

        const edits = await provider.formatText(document);

        if (edits.length === 0) {
          context.outputChannel.appendLine(
            `Prettier produced no changes for ${document.uri.toString()}.`,
          );

          return;
        }

        const edit = new vscode.WorkspaceEdit();
        edit.set(document.uri, edits);

        await vscode.workspace.applyEdit(edit);
      }),
    );

    /*
     * Format on save: hook the workspace save path when the setting is on.
     * Guarded because the api type doesn't always expose onWillSaveTextDocument.
     */
    const onWillSave = vscode.workspace.onWillSaveTextDocument?.bind(vscode.workspace);

    if (onWillSave) {
      const willSaveListener = onWillSave((event) => {
        const config = vscode.workspace.getConfiguration();
        const enabled = config.get<boolean>("dataverseIde.prettier.formatOnSave", false);

        if (!enabled) {
          return;
        }

        void provider.formatText(event.document).then((edits) => {
          if (!edits || edits.length === 0) {
            return;
          }

          const edit = new vscode.WorkspaceEdit();
          edit.set(event.document.uri, edits);
          void vscode.workspace.applyEdit(edit);
        });
      });

      if (willSaveListener) {
        disposables.push(willSaveListener);
      }
    }

    return {
      dispose() {
        for (const disposable of disposables.reverse()) {
          disposable.dispose();
        }
      },
    };
  },
};
