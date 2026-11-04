import { dataverseDB, VSIX_STORE } from "../../util/dataverseDb.js";

/*
 * Persistent store for installed VSIX packages.
 *
 * The original archive is kept (not an extracted tree) so the extension can
 * be re-registered on every page load: files are served from data: URLs
 * registered through monaco-vscode-api's registerFileUrl. Keeping the VSIX
 * also makes uninstall/export a simple IndexedDB delete/get.
 */

const STORE_NAME = VSIX_STORE;

export type StoredVsix = {
  id: string;
  publisher: string;
  name: string;
  displayName: string;
  version: string;
  fileName: string;
  installedAt: number;
  data: Uint8Array;
};

function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  throw new Error("Stored VSIX data is not a byte array.");
}

export async function listStoredVsix(): Promise<StoredVsix[]> {
  const values = await (await dataverseDB()).getAll(STORE_NAME);
  const stored: StoredVsix[] = [];

  for (const value of values) {
    try {
      const entry = value as StoredVsix;

      stored.push({
        ...entry,
        data: toUint8Array(entry.data),
      });
    } catch (error) {
      console.warn("[Dataverse IDE] Ignoring a corrupt VSIX database entry.", error);
    }
  }

  return stored;
}

export async function saveStoredVsix(entry: StoredVsix): Promise<void> {
  await (await dataverseDB()).put(STORE_NAME, entry, entry.id);
}

export async function deleteStoredVsix(id: string): Promise<void> {
  await (await dataverseDB()).delete(STORE_NAME, id);
}
