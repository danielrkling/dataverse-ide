/*
 * Shell command history backed by the IDE's IndexedDB database.
 *
 * One record per workspace (`terminalHistory` store, keyed by the workspace
 * URI) holds the command array. Appends are read-modify-write and serialized
 * per terminal; each write re-reads the record first so two terminals merge
 * entries instead of replacing each other's history.
 *
 * `createShellHistory` takes a small store abstraction so the merge/debounce
 * logic is testable without IndexedDB.
 */

import { dataverseDB, TERMINAL_HISTORY_STORE } from "../../util/dataverseDb.js";

const DEFAULT_LIMIT = 1000;

export type ShellHistory = {
  load: () => Promise<string[]>;
  append: (command: string) => void;
  flush: () => Promise<void>;
};

export type HistoryStore = {
  read: () => Promise<string[]>;
  write: (commands: string[]) => Promise<void>;
};

export type ShellHistoryOptions = {
  limit?: number;
};

export function createShellHistory(
  store: HistoryStore,
  options: ShellHistoryOptions = {},
): ShellHistory {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const unsaved: string[] = [];

  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> = Promise.resolve();

  async function persist(): Promise<void> {
    if (unsaved.length === 0) {
      return;
    }

    const batch = [...unsaved];

    try {
      const existing = await store.read();
      const merged = [...existing, ...batch].slice(-limit);

      await store.write(merged);
      unsaved.splice(0, batch.length);
    } catch {
      /* Keep unsaved entries for the next attempt. */
    }
  }

  function schedule(): void {
    if (timer != null) {
      return;
    }

    timer = setTimeout(() => {
      timer = undefined;
      pending = pending.then(persist).catch(() => {});
    }, 200);
  }

  return {
    async load(): Promise<string[]> {
      try {
        return await store.read();
      } catch {
        return [];
      }
    },

    append(command: string): void {
      if (command.trim().length === 0) {
        return;
      }

      unsaved.push(command);
      schedule();
    },

    async flush(): Promise<void> {
      if (timer != null) {
        clearTimeout(timer);
        timer = undefined;
      }

      pending = pending.then(persist).catch(() => {});
      await pending;
    },
  };
}

type HistoryRecord = {
  commands?: unknown;
};

/**
 * Per-workspace history stored in the `dataverse-ide` IndexedDB database.
 *
 * `workspaceKey` should be stable for a workspace across reloads (the root
 * URI string is used by the terminal extension).
 */
export function createWorkspaceShellHistory(
  workspaceKey: string,
  options: ShellHistoryOptions = {},
): ShellHistory {
  const store: HistoryStore = {
    async read(): Promise<string[]> {
      const db = await dataverseDB();
      const value = (await db.get(TERMINAL_HISTORY_STORE, workspaceKey)) as
        HistoryRecord | undefined;

      return Array.isArray(value?.commands)
        ? value.commands.filter((command): command is string => typeof command === "string")
        : [];
    },

    async write(commands: string[]): Promise<void> {
      const db = await dataverseDB();

      await db.put(TERMINAL_HISTORY_STORE, { commands, updatedAt: Date.now() }, workspaceKey);
    },
  };

  return createShellHistory(store, options);
}
