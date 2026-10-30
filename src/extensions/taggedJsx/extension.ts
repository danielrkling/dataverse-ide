import type * as vscodeType from "vscode";

import { ExtensionHostKind, registerExtension } from "@codingame/monaco-vscode-api/extensions";

import type { ExtensionContext, IdeExtension } from "../api.js";

import {
  convertJsxSourceToTagged,
  convertSelectionToTagged,
  convertTaggedSourceToJsx,
  smartConvertSource,
  type ConversionResult,
  type ConvertOptions,
} from "./convert.js";
import { buildTaggedJsxGrammar, grammarDataUrl, GRAMMAR_FILE_PATH } from "./grammar.js";

/*
 * Tagged JSX extension: editor convenience for JSX written inside tagged
 * template literals (the `html`...`` syntax of Solid's tagged-template
 * runtime). Ported from the "Tagged JSX Tools" VS Code extension.
 *
 * Features:
 *  - Conversion commands (smart toggle, to JSX, to tagged template) that work
 *    on the whole document or the active selection, powered by
 *    @tagged-jsx/parse + the prettier parsers (see convert.ts).
 *  - A generated TextMate injection grammar that highlights JSX inside
 *    configured tagged templates (see grammar.ts), contributed through
 *    `contributes.grammars` + injectTo. Formatting inside templates is
 *    provided by the prettier extension (@tagged-jsx/prettier-plugin).
 *  - Configuration under "tagged-jsx.*" (customTags, preferredTag,
 *    useCallbacks, registeredComponents).
 *
 * Two registrations are used: a main-thread registration that only carries
 * the grammar contribution (the textmate service consumes contributed
 * grammars from the extension registry), and a LocalProcess registration
 * whose extension-host api provides commands + the configuration schema.
 */

const COMMAND_TOGGLE = "taggedJsx.toggle";
const COMMAND_TO_JSX = "taggedJsx.convertToJsx";
const COMMAND_TO_TAGGED = "taggedJsx.convertToTagged";
const COMMAND_REGENERATE_GRAMMAR = "taggedJsx.regenerateGrammar";

const GRAMMAR_ID = "dataverse-ide-tagged-jsx-grammar";
const INJECT_INTO = ["source.js", "source.ts", "source.tsx"];

const DEFAULT_OPTIONS: ConvertOptions = {
  tags: ["html", "jsx"],
  preferredTag: "html",
  useCallbacks: true,
  registeredComponents: [],
};

/*
 * Grammar registration state, so "Regenerate Grammar" can dispose the
 * previous contribution and register a fresh one from the current tags.
 */
let currentGrammarRegistration: { dispose(): Promise<void> } | undefined;

function getOptions(
  vscodeApi: typeof vscodeType,
  rootUri: vscodeType.Uri | undefined,
): ConvertOptions {
  const config = vscodeApi.workspace.getConfiguration("tagged-jsx", rootUri ?? null);

  return {
    tags: config.get<string[]>("customTags") ?? DEFAULT_OPTIONS.tags,
    preferredTag: config.get<string>("preferredTag") ?? DEFAULT_OPTIONS.preferredTag,
    useCallbacks: config.get<boolean>("useCallbacks") ?? DEFAULT_OPTIONS.useCallbacks,
    registeredComponents:
      config.get<string[]>("registeredComponents") ?? DEFAULT_OPTIONS.registeredComponents,
  };
}

function grammarManifest(tagsScopeName: string): object {
  return {
    name: GRAMMAR_ID,
    publisher: "dataverse-ide",
    version: "0.1.0",
    engines: { vscode: "*" },
    displayName: "Dataverse IDE Tagged JSX Grammar",
    description: "TextMate grammar injecting JSX highlighting into tagged templates.",
    contributes: {
      grammars: [
        {
          scopeName: tagsScopeName,
          path: `./${GRAMMAR_FILE_PATH}`,
          injectTo: INJECT_INTO,
        },
      ],
    },
  };
}

function registerGrammar(tags: string[]): { dispose(): Promise<void> } {
  const grammar = buildTaggedJsxGrammar(tags, INJECT_INTO);
  const api = registerExtension(
    grammarManifest(grammar.scopeName) as never,
    undefined, // main-thread data-only registration: no extension host
  );

  api.registerFileUrl(GRAMMAR_FILE_PATH, grammarDataUrl(grammar));

  return {
    dispose: () => api.dispose(),
  };
}

/** `.ts` selections wrap in a synthetic source that must parse as TSX. */
function syntheticFileName(fileName: string): string {
  return /\.(tsx|jsx)$/i.test(fileName) ? fileName : `${fileName}x`;
}

function createConverter(
  vscodeApi: typeof vscodeType,
  rootUri: vscodeType.Uri | undefined,
  outputChannel: { appendLine(line: string): void },
) {
  return async (mode: "toggle" | "toJsx" | "toTagged"): Promise<void> => {
    const editor = vscodeApi.window.activeTextEditor;

    if (editor == null) {
      outputChannel.appendLine("No active editor; nothing to convert.");

      return;
    }

    const document = editor.document;
    const selection = editor.selection;
    const hasSelection = selection != null && !selection.isEmpty;
    const options = getOptions(vscodeApi, rootUri);

    let result: ConversionResult & { direction?: string };

    if (hasSelection) {
      const source = document.getText(selection);

      if (mode === "toTagged") {
        result = convertSelectionToTagged(source, syntheticFileName(document.fileName), options);
      } else if (mode === "toJsx") {
        result = convertTaggedSourceToJsx(document.getText(), document.fileName, options, {
          start: selection.start,
          end: selection.end,
        });
      } else {
        const selectionHasTagged = new RegExp(`\\b(?:${options.tags.join("|")})\\b\\s*\x60`).test(
          source,
        );

        result = selectionHasTagged
          ? convertTaggedSourceToJsx(document.getText(), document.fileName, options, {
              start: selection.start,
              end: selection.end,
            })
          : convertSelectionToTagged(source, syntheticFileName(document.fileName), options);
      }
    } else if (mode === "toTagged") {
      result = convertJsxSourceToTagged(document.getText(), document.fileName, options);
    } else if (mode === "toJsx") {
      result = convertTaggedSourceToJsx(document.getText(), document.fileName, options);
    } else {
      result = smartConvertSource(document.getText(), document.fileName, options);
    }

    if (result.encounteredError != null) {
      outputChannel.appendLine(`Conversion error: ${result.encounteredError}`);
      void vscodeApi.window.showErrorMessage(`Tagged JSX: ${result.encounteredError}`);

      return;
    }

    if (result.edits.length === 0) {
      void vscodeApi.window.showInformationMessage(`Tagged JSX: nothing to convert (${mode}).`);

      return;
    }

    /*
     * Converters emit absolute-offset edits (selection conversions emit
     * selection-relative ones); shift selection-relative edits back into
     * document space before applying.
     */
    const edit = new vscodeApi.WorkspaceEdit();
    const sorted = [...result.edits].sort((a, b) => b.start - a.start);

    for (const sourceEdit of sorted) {
      const startOffset = hasSelection ? selection.start + sourceEdit.start : sourceEdit.start;
      const endOffset = hasSelection ? selection.start + sourceEdit.end : sourceEdit.end;

      edit.replace(
        document.uri,
        new vscodeApi.Range(document.positionAt(startOffset), document.positionAt(endOffset)),
        sourceEdit.text,
      );
    }

    await vscodeApi.workspace.applyEdit(edit);

    if (result.direction === "toTagged") {
      outputChannel.appendLine(
        "Converted JSX to a tagged template. Run Format Document to tidy layout (the prettier extension formats templates via @tagged-jsx/prettier-plugin).",
      );
    }
  };
}

export default {
  id: "taggedJsx",

  async activate(context: ExtensionContext): Promise<vscodeType.Disposable | void> {
    const { vscode, workspaceRootUri, outputChannel } = context;

    // 1. Grammar contribution (main-thread registration + data-URL file).
    const initialOptions = getOptions(vscode, workspaceRootUri);

    currentGrammarRegistration = registerGrammar(initialOptions.tags);

    // 2. Extension-host registration for commands + configuration schema.
    const { getApi } = registerExtension(
      {
        name: "dataverse-ide-tagged-jsx-tools",
        publisher: "dataverse-ide",
        version: "0.1.0",
        engines: { vscode: "*" },
        displayName: "Dataverse IDE Tagged JSX Tools",
        description: "Convert between tagged template literals and JSX syntax.",
        contributes: {
          commands: [
            { command: COMMAND_TOGGLE, title: "Tagged JSX: Toggle (Smart Convert)" },
            { command: COMMAND_TO_JSX, title: "Tagged JSX: Convert to JSX" },
            { command: COMMAND_TO_TAGGED, title: "Tagged JSX: Convert to tagged template" },
            { command: COMMAND_REGENERATE_GRAMMAR, title: "Tagged JSX: Regenerate Grammar" },
          ],
          configuration: {
            title: "Tagged JSX",
            properties: {
              "tagged-jsx.customTags": {
                type: "array",
                default: ["html", "jsx"],
                description: "Tags whose template literals contain JSX.",
              },
              "tagged-jsx.preferredTag": {
                type: "string",
                default: "html",
                description: "Tag used when converting from JSX to a tagged template.",
              },
              "tagged-jsx.useCallbacks": {
                type: "boolean",
                default: true,
                description:
                  "Wrap non-primitive expressions with '() =>' for lazy tagged-template evaluation.",
              },
              "tagged-jsx.registeredComponents": {
                type: "array",
                default: [],
                description: "Component names emitted as literal tag names in tagged templates.",
              },
            },
          },
        },
      },
      ExtensionHostKind.LocalProcess,
    );

    const vscodeApi = (await getApi()) as unknown as typeof vscodeType;
    const convert = createConverter(vscodeApi, workspaceRootUri, outputChannel);

    const disposables = [
      vscodeApi.commands.registerCommand(COMMAND_TOGGLE, () => void convert("toggle")),
      vscodeApi.commands.registerCommand(COMMAND_TO_JSX, () => void convert("toJsx")),
      vscodeApi.commands.registerCommand(COMMAND_TO_TAGGED, () => void convert("toTagged")),
      vscodeApi.commands.registerCommand(COMMAND_REGENERATE_GRAMMAR, () => {
        const { tags } = getOptions(vscode, workspaceRootUri);
        const previous = currentGrammarRegistration;

        void Promise.resolve(previous?.dispose() ?? Promise.resolve()).then(() => {
          currentGrammarRegistration = registerGrammar(tags);

          void vscodeApi.window.showInformationMessage(
            "Tagged JSX: grammar regenerated. Reload the window if colors look stale.",
          );
        });
      }),
    ];

    return {
      dispose() {
        for (const disposable of disposables.reverse()) {
          disposable.dispose();
        }

        void currentGrammarRegistration?.dispose();
        currentGrammarRegistration = undefined;
      },
    };
  },
};
