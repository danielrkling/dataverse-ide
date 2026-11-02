import { openDB } from "../../util/db.js";

/*
 * Persistent store for installed VSIX packages.
 *
 * The original archive is kept (not an extracted tree) so the extension can
 * be re-registered on every page load: files are served from data: URLs
 * registered through monaco-vscode-api's registerFileUrl. Keeping the VSIX
 * also makes uninstall/export a simple IndexedDB delete/get.
 */

const DATABASE_NAME = "dataverse-ide-vsix";
const STORE_NAME = "vsix";

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

type Database = Awaited<ReturnType<typeof openDB>>;

let databasePromise: Promise<Database> | undefined;

function database(): Promise<Database> {
  databasePromise ??= openDB(DATABASE_NAME, STORE_NAME);

  return databasePromise;
}

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
  const values = await (await database()).getAll(STORE_NAME);
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
  await (await database()).put(STORE_NAME, entry, entry.id);
}

export async function deleteStoredVsix(id: string): Promise<void> {
  await (await database()).delete(STORE_NAME, id);
}
