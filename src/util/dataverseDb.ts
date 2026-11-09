import { deleteDB, openDB, type Db } from "./db.js";

/*
 * One IndexedDB database for everything the IDE stores itself:
 *
 * - `workspaces`      — recent workspace records and folder handles
 * - `vsix`            — installed VSIX archives
 * - `terminalHistory` — shell command history, keyed by workspace URI
 * - `chats`           — AI chat sessions, keyed by chat id
 *
 * Earlier builds used one database per feature (`dataverse-ide-recents` and
 * `dataverse-ide-vsix`). They are copied into this database and then removed
 * the first time this module opens.
 */

const DB_NAME = "dataverse-ide";
const DB_VERSION = 3;

export const WORKSPACE_STORE = "workspaces";
export const VSIX_STORE = "vsix";
export const TERMINAL_HISTORY_STORE = "terminalHistory";
export const CHAT_STORE = "chats";

type LegacyDatabase = {
  name: string;
  storeName: string;
};

const LEGACY_DATABASES: LegacyDatabase[] = [
  { name: "dataverse-ide-recents", storeName: WORKSPACE_STORE },
  { name: "dataverse-ide-vsix", storeName: VSIX_STORE },
];

let databasePromise: Promise<Db> | undefined;

export function dataverseDB(): Promise<Db> {
  databasePromise ??= openDataverseDB().catch((error: unknown) => {
    /*
     * Allow a later call to retry, for example after a blocked open from
     * another tab has been resolved.
     */
    databasePromise = undefined;
    throw error;
  });

  return databasePromise;
}

async function openDataverseDB(): Promise<Db> {
  const db = await openDB(DB_NAME, DB_VERSION, [
    WORKSPACE_STORE,
    VSIX_STORE,
    TERMINAL_HISTORY_STORE,
    CHAT_STORE,
  ]);

  for (const legacy of LEGACY_DATABASES) {
    await migrateLegacyDatabase(db, legacy);
  }

  return db;
}

async function migrateLegacyDatabase(target: Db, legacy: LegacyDatabase): Promise<void> {
  if (!(await databaseExists(legacy.name))) {
    return;
  }

  let source: Db | undefined;

  try {
    source = await openDB(legacy.name, 1, [legacy.storeName]);

    const entries = await source.getAllEntries(legacy.storeName);

    for (const [key, value] of entries) {
      /*
       * Keep data that already exists in the combined database. This makes a
       * retried migration safe and avoids overwriting newer records with old
       * ones after a downgrade/upgrade cycle.
       */
      if ((await target.get(legacy.storeName, key)) !== undefined) {
        continue;
      }

      await target.put(legacy.storeName, value, key);
    }
  } catch (error) {
    console.warn(`[Dataverse IDE] Could not migrate legacy database "${legacy.name}".`, error);

    return;
  } finally {
    source?.close();
  }

  try {
    await deleteDB(legacy.name);
  } catch (error) {
    /*
     * The data is already in the combined database. A blocked delete usually
     * means another tab still has the legacy database open; retry next load.
     */
    console.warn(`[Dataverse IDE] Could not remove legacy database "${legacy.name}".`, error);
  }
}

async function databaseExists(name: string): Promise<boolean> {
  if (typeof indexedDB.databases !== "function") {
    /*
     * No way to enumerate databases. Let the caller open it instead; an
     * empty legacy database is harmless and gets removed afterwards.
     */
    return true;
  }

  try {
    const databases = await indexedDB.databases();

    return databases.some((database) => database.name === name);
  } catch {
    return true;
  }
}
