import type * as vscodeType from "vscode";

import { normalizePath } from "./packageResolver.js";

/*
 * Live editor buffer overlay.
 *
 * vscode.workspace.fs always returns the last *saved* bytes. Extensions that
 * bundle or scan source files therefore lag behind the editor until autosave
 * (or a manual save) runs, which made builds look one edit behind.
 *
 * These helpers expose the current text of open, dirty documents keyed by
 * workspace-relative path so readers can layer them over the filesystem.
 */

export type DirtyDocumentSnapshot = ReadonlyMap<string, string>;

/** Snapshot the current text of every open, dirty document in the workspace. */
export function captureDirtyDocuments(
  vscode: typeof vscodeType,
  rootUri: vscodeType.Uri,
): DirtyDocumentSnapshot {
  const documents = new Map<string, string>();
  const rootPath = rootUri.path.replace(/\/+$/, "");

  for (const document of vscode.workspace.textDocuments) {
    if (document.uri.scheme !== "file" || document.isUntitled || !document.isDirty) {
      continue;
    }

    const uriPath = document.uri.path;

    if (rootPath.length > 0 && uriPath !== rootPath && !uriPath.startsWith(`${rootPath}/`)) {
      continue;
    }

    const relative = rootPath.length > 0 ? uriPath.slice(rootPath.length) : uriPath;

    const normalized = normalizePath(relative.replace(/^\/+/, ""));

    if (normalized.length === 0) {
      continue;
    }

    documents.set(normalized, document.getText());
  }

  return documents;
}

/** Current unsaved text for a workspace-relative path, when the buffer is dirty. */
export function dirtyDocumentText(
  documents: DirtyDocumentSnapshot,
  path: string,
): string | undefined {
  return documents.get(normalizePath(path));
}
