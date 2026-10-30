import type * as vscodeType from "vscode";

import { ExtensionHostKind, registerExtension } from "@codingame/monaco-vscode-api/extensions";

import type { ExtensionContext, IdeExtension } from "../api.js";

import {
  buildGrammarContributions,
  regenerateLitJsx,
  type GrammarRegistrationData,
} from "./grammar.js";

/*
 * Tagged JSX extension: editor support for JSX inside tagged template
 * literals (`html`...`` / `jsx`...``, the syntax of Solid's tagged-template
 * runtime). Port of the "Tagged JSX Tools" VS Code extension features.
 *
 *  - Conversion commands (Toggle / Convert to JSX / Convert to tagged
 *    template), powered by @tagged-jsx/transform with the SolidJS
 *    `() =>` lazy-expression callbacks (useCallbacks setting). Conversion
 *    replaces the whole document, like the upstream extension.
 *  - TextMate grammar injection: JSX syntax highlighting inside configured
 *    tagged templates. The primary grammar is regenerated from the
 *    `tagged-jsx.customTags` setting (also available as the Regenerate
 *    Grammar command); the embedded JSX + string-substitution grammars are
 *    vendored from upstream. Formatting inside templates comes from the
 *    prettier extension (@tagged-jsx/prettier-plugin is already wired there).
 *
 * Everything is contributed by a single LocalProcess extension: commands +
 * configuration + `contributes.grammars` + `contributes.languages`. The
 * extension registry is shared with the main thread, and registerFileUrl
 * (needed to serve the grammar JSON via data URLs) is only exposed for
 * extension-host registrations.
 */

const COMMAND_TOGGLE = "taggedJsx.toggle";
const COMMAND_TO_JSX = "taggedJsx.convertToJsx";
const COMMAND_TO_TAGGED = "taggedJsx.convertToTagged";
const COMMAND_REGENERATE_GRAMMAR = "taggedJsx.regenerateGrammar";

const MANIFEST_NAME = "dataverse-ide-tagged-jsx";

interface TransformResult {
  code: string;
  errors: unknown[];
}

interface TransformerModule {
  createJsxTransformer(options: {
    tags: string[];
    ts: unknown;
    callbacks?: unknown;
  }): (code: string) => TransformResult;
  createTaggedTransformer(options: {
    tag: string;
    ts: unknown;
    callbacks?: unknown;
    registeredComponents: string[];
  }): (code: string) => TransformResult;
  createExpressionTransformCallbacks(ts: unknown): unknown;
}

interface TaggedJsxConfig {
  tags: string[];
  preferredTag: string;
  useCallbacks: boolean;
  registeredComponents: string[];
}

function getConfig(vscodeApi: typeof vscodeType): TaggedJsxConfig {
  const config = vscodeApi.workspace.getConfiguration("tagged-jsx");

  return {
    tags: config.get<string[]>("customTags") ?? ["jsx", "html"],
    preferredTag: config.get<string>("preferredTag") ?? "html",
    useCallbacks: config.get<boolean>("useCallbacks") ?? true,
    registeredComponents: config.get<string[]>("registeredComponents") ?? [],
  };
}

/*
 * @tagged-jsx/transform needs a TypeScript module instance (it parses with
 * the compiler API). ~8 MB, so both imports are lazy and memoized: nothing
 * loads until the first conversion command runs.
 */
let transformModulePromise: Promise<TransformerModule> | undefined;
let tsModulePromise: Promise<unknown> | undefined;

async function getTransformers(config: TaggedJsxConfig): Promise<{
  toJsx: (code: string) => TransformResult;
  toTagged: (code: string) => TransformResult;
}> {
  transformModulePromise ??=
    import("@tagged-jsx/transform") as unknown as Promise<TransformerModule>;
  tsModulePromise ??= import("typescript");

  const [transform, ts] = await Promise.all([transformModulePromise, tsModulePromise]);
  const callbacks = config.useCallbacks
    ? transform.createExpressionTransformCallbacks(ts)
    : undefined;

  return {
    toJsx: transform.createJsxTransformer({
      tags: config.tags,
      ts,
      callbacks,
    }),
    toTagged: transform.createTaggedTransformer({
      tag: config.preferredTag,
      ts,
      callbacks,
      registeredComponents: config.registeredComponents,
    }),
  };
}

/*
 * Grammar registration state, so Regenerate Grammar can dispose the previous
 * contribution and re-register from the current tags.
 */
let currentRegistration:
  { extensionId: string; api: ReturnType<typeof registerExtension> } | undefined;

function registerTaggedJsxExtension(tags: string[]): ReturnType<typeof registerExtension> {
  const grammarData: GrammarRegistrationData = buildGrammarContributions();

  const api = registerExtension(
    {
      name: MANIFEST_NAME,
      publisher: "dataverse-ide",
      version: "0.2.0",
      engines: { vscode: "*" },
      displayName: "Dataverse IDE Tagged JSX",
      description:
        "Highlights JSX inside tagged template literals and converts between the syntaxes.",
      contributes: {
        languages: grammarData.languages,
        grammars: grammarData.contributions,
        commands: [
          { command: COMMAND_TOGGLE, title: "Tagged JSX: Toggle (Smart Convert)" },
          { command: COMMAND_TO_JSX, title: "Tagged JSX: Convert to jsx tag" },
          { command: COMMAND_TO_TAGGED, title: "Tagged JSX: Convert to tagged template" },
          { command: COMMAND_REGENERATE_GRAMMAR, title: "Tagged JSX: Regenerate Grammar" },
        ],
        configuration: {
          title: "JSX Tagged Templates",
          properties: {
            "tagged-jsx.customTags": {
              type: "array",
              items: { type: "string" },
              default: ["jsx", "html"],
              description:
                "Tags to treat as JSX tagged templates when converting to JSX. As well as format and highlighting support.",
            },
            "tagged-jsx.preferredTag": {
              type: "string",
              default: "html",
              enum: ["html", "jsx"],
              description: "Tag to use when converting from JSX to tagged template",
            },
            "tagged-jsx.useCallbacks": {
              type: "boolean",
              default: true,
              description:
                "Enable expression transform callbacks (wraps expressions with () => for tagged templates)",
            },
            "tagged-jsx.registeredComponents": {
              type: "array",
              items: { type: "string" },
              default: [],
              description:
                "Component names to emit as literal tag names in tagged templates instead of ${} expressions.",
            },
          },
        },
      },
    } as never,
    ExtensionHostKind.LocalProcess,
  );

  for (const file of grammarData.files) {
    api.registerFileUrl(file.path, file.url);
  }

  // The generated lit-jsx grammar is refreshed from the current tag set.
  const generated = regenerateLitJsx(tags);

  api.registerFileUrl(generated.path, generated.url);

  return api;
}

export default {
  id: "taggedJsx",

  async activate(context: ExtensionContext): Promise<vscodeType.Disposable | void> {
    const { vscode, outputChannel } = context;
    const options = getConfig(vscode);

    // Grammar + commands + configuration in one LocalProcess extension.
    const api = registerTaggedJsxExtension(options.tags);
    currentRegistration = { extensionId: String(api.id), api };

    // Extension-host api for the command registrations.
    const { getApi } = api as unknown as { getApi: () => Promise<unknown> };
    const vscodeApi = (await getApi()) as unknown as typeof vscodeType;
    const disposables: vscodeType.Disposable[] = [];

    const convert = async (mode: "toggle" | "toJsx" | "toTagged") => {
      const editor = vscodeApi.window.activeTextEditor;

      if (editor == null) {
        outputChannel.appendLine("No active editor; nothing to convert.");

        return;
      }

      const document = editor.document;
      const source = document.getText();
      const config = getConfig(vscode);

      try {
        const { toJsx, toTagged } = await getTransformers(config);

        let converted = source;

        if (mode === "toJsx") {
          converted = toJsx(source).code;
        } else if (mode === "toTagged") {
          converted = toTagged(source).code;
        } else {
          // Smart toggle: decide direction by content (upstream heuristic).
          const tagAlternation = config.tags.join("|");
          const hasTaggedTemplate = new RegExp(`(${tagAlternation})\`[\\s\\S]*?\``, "g").test(
            source,
          );

          converted = hasTaggedTemplate ? toJsx(source).code : toTagged(source).code;
        }

        if (converted === source) {
          outputChannel.appendLine(
            `No changes (${mode}) for ${document.fileName || document.uri.toString()}.`,
          );

          return;
        }

        const workspaceEdit = new vscodeApi.WorkspaceEdit();
        const fullRange = new vscodeApi.Range(
          document.positionAt(0),
          document.positionAt(source.length),
        );

        workspaceEdit.replace(document.uri, fullRange, converted);
        await vscodeApi.workspace.applyEdit(workspaceEdit);
      } catch (error) {
        outputChannel.appendLine(`Convert error (${mode}): ${String(error)}`);
        void vscodeApi.window.showErrorMessage(`Tagged JSX: ${String(error)}`);
      }
    };

    disposables.push(
      vscodeApi.commands.registerCommand(COMMAND_TO_JSX, () => void convert("toJsx")),
      vscodeApi.commands.registerCommand(COMMAND_TO_TAGGED, () => void convert("toTagged")),
      vscodeApi.commands.registerCommand(COMMAND_TOGGLE, () => void convert("toggle")),
      vscodeApi.commands.registerCommand(COMMAND_REGENERATE_GRAMMAR, () => {
        const { tags } = getConfig(vscode);
        const previous = currentRegistration;

        void Promise.resolve(previous?.api.dispose() ?? Promise.resolve()).then(() => {
          const refreshed = registerTaggedJsxExtension(tags);

          currentRegistration = { extensionId: String(refreshed.id), api: refreshed };

          void vscodeApi.window.showInformationMessage(
            "Tagged JSX: grammar regenerated. Reload the window if colors look stale.",
          );
        });
      }),
    );

    return {
      dispose() {
        for (const disposable of disposables.reverse()) {
          disposable.dispose();
        }

        void currentRegistration?.api.dispose();
        currentRegistration = undefined;
      },
    };
  },
};
