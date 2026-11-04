import type * as vscodeType from "vscode";

/*
 * Save dirty editors before an intentional page reload.
 *
 * Autosave is debounced, so a reload triggered right after an edit can discard
 * the pending save. Callers should abort the reload when this returns false.
 */
export async function saveAllBeforeReload(vscode: typeof vscodeType): Promise<boolean> {
  try {
    const saved = await vscode.workspace.saveAll(false);

    if (!saved) {
      void vscode.window.showWarningMessage(
        "Some files could not be saved. The reload was cancelled.",
      );
    }

    return saved;
  } catch (error) {
    console.error("[Dataverse IDE] Failed to save all documents before reload.", error);

    void vscode.window.showErrorMessage("Some files could not be saved. The reload was cancelled.");

    return false;
  }
}
