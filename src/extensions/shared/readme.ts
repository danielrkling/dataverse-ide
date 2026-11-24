import type * as vscodeType from "vscode";

/*
 * Colocated extension READMEs.
 *
 * Each extension keeps its documentation next to its code as README.md. The
 * Extensions view reads it from the extension's `readmeUrl`, so the content
 * shows in the normal README tab without opening a separate virtual document.
 *
 * The manifest can only point at a path relative to the extension location
 * (`extension-file://…/extension/`). registerFileUrl() maps that path to a
 * data URL holding the bundled markdown.
 */

export const EXTENSION_README_PATH = "README.md";

export type RegisterReadmeFile = (
  path: string,
  url: string,
  mimeType?: string,
) => { dispose(): void };

export function readmeDataUrl(content: string): string {
  return `data:text/markdown;charset=utf-8,${encodeURIComponent(content)}`;
}

/** Serve the bundled markdown at the manifest's relative readme path. */
export function registerExtensionReadme(
  registerFileUrl: RegisterReadmeFile,
  content: string,
): void {
  registerFileUrl(EXTENSION_README_PATH, readmeDataUrl(content), "text/markdown");
}

/** Open the Extensions view details page on an extension's README tab. */
export function openExtensionReadme(
  vscode: typeof vscodeType,
  extensionId: string,
): Thenable<unknown> {
  return vscode.commands.executeCommand("_extensions.manage", extensionId, "readme");
}
