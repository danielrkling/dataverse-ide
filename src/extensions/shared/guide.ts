import type * as vscodeType from "vscode";

/*
 * Colocated how-to guides.
 *
 * Each extension keeps its guide next to its code as GUIDE.md and calls
 * registerGuide() during activation. The guide is served as a read-only
 * virtual document (`dataverse-ide-guide:/<id>.md`) so it opens in a normal
 * editor tab through the markdown preview without writing anything into the
 * user's workspace.
 *
 * The provider is shared: the first extension that registers a guide creates
 * it, every later guide just adds content to the same map.
 */

const GUIDE_SCHEME = "dataverse-ide-guide";

const guideContents = new Map<string, string>();

let provider: vscodeType.Disposable | undefined;

/** Command id contributed by every extension that ships a guide. */
export function guideCommandId(extensionId: string): string {
  return `dataverseIde.${extensionId}.openGuide`;
}

function guideUri(vscode: typeof vscodeType, extensionId: string): vscodeType.Uri {
  return vscode.Uri.parse(`${GUIDE_SCHEME}:/${encodeURIComponent(extensionId)}.md`);
}

function ensureProvider(vscode: typeof vscodeType): void {
  if (provider != null) {
    return;
  }

  provider = vscode.workspace.registerTextDocumentContentProvider(GUIDE_SCHEME, {
    provideTextDocumentContent(uri) {
      const id = decodeURIComponent(uri.path.replace(/^\/+/, "").replace(/\.md$/, ""));

      return (
        guideContents.get(id) ?? `# Guide not found\n\nNo help guide is registered for \`${id}\`.`
      );
    },
  });
}

export type RegisterGuideOptions = {
  vscode: typeof vscodeType;
  extensionId: string;
  content: string;
};

/*
 * Register the `<extension>: How-to Guide` command for one extension's guide.
 *
 * The command id is derived from the extension id so the welcome page and any
 * other caller can link to it without importing the extension module:
 *
 *   dataverseIde.esbuild.openGuide
 *   dataverseIde.dataverse.openGuide
 *   dataverseIde.git.openGuide
 */
export function registerGuide(options: RegisterGuideOptions): vscodeType.Disposable {
  const { vscode, extensionId, content } = options;
  const uri = guideUri(vscode, extensionId);

  guideContents.set(extensionId, content);
  ensureProvider(vscode);

  return vscode.commands.registerCommand(guideCommandId(extensionId), async () => {
    try {
      await vscode.commands.executeCommand("markdown.showPreview", uri);
    } catch (error) {
      /*
       * If the markdown preview extension is unavailable, still let the user
       * read the guide as markdown source instead of failing the command.
       */
      try {
        await vscode.commands.executeCommand("vscode.open", uri);
      } catch {
        await vscode.window.showErrorMessage(
          `Could not open the ${extensionId} guide: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  });
}
