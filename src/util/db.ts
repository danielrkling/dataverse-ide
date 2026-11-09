export type Db = {
  get: (store: string, key: IDBValidKey) => Promise<unknown>;
  getAll: (store: string) => Promise<unknown[]>;
  getAllEntries: (store: string) => Promise<[IDBValidKey, unknown][]>;
  put: (store: string, value: unknown, key: IDBValidKey) => Promise<void>;
  delete: (store: string, key: IDBValidKey) => Promise<void>;
  close: () => void;
};

function requestToPromise<T>(request: IDBRequest<T>, blockedMessage?: string): Promise<T> {
  return new Promise((resolve, reject) => {
    if (blockedMessage != null) {
      (request as unknown as IDBOpenDBRequest).onblocked = () => reject(new Error(blockedMessage));
    }

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function openDB(
  name: string,
  version: number,
  storeNames: string | string[],
): Promise<Db> {
  const stores = Array.isArray(storeNames) ? storeNames : [storeNames];
  const request = indexedDB.open(name, version);

  request.onupgradeneeded = () => {
    for (const storeName of stores) {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName);
      }
    }
  };

  /*
   * A version bump is blocked while another tab keeps an older connection
   * open. Reject instead of hanging forever; callers can retry after the user
   * closes the other tab.
   */
  const db = await requestToPromise(
    request,
    `IndexedDB "${name}" is blocked by another open tab. Close other IDE tabs and reload.`,
  );

  return {
    get: async (store, key) => {
      const tx = db.transaction(store, "readonly");

      return requestToPromise(tx.objectStore(store).get(key));
    },

    getAll: async (store) => {
      const tx = db.transaction(store, "readonly");

      return requestToPromise(tx.objectStore(store).getAll());
    },

    getAllEntries: async (store) => {
      const tx = db.transaction(store, "readonly");
      const objectStore = tx.objectStore(store);

      return new Promise((resolve, reject) => {
        const entries: [IDBValidKey, unknown][] = [];
        const request = objectStore.openCursor();

        request.onsuccess = () => {
          const cursor = request.result;

          if (cursor == null) {
            resolve(entries);
            return;
          }

          entries.push([cursor.key, cursor.value]);
          cursor.continue();
        };

        request.onerror = () => reject(request.error);
      });
    },

    put: async (store, value, key) => {
      const tx = db.transaction(store, "readwrite");

      tx.objectStore(store).put(value, key);

      await transactionToPromise(tx);
    },

    delete: async (store, key) => {
      const tx = db.transaction(store, "readwrite");

      tx.objectStore(store).delete(key);

      await transactionToPromise(tx);
    },

    close: () => db.close(),
  };
}

export function deleteDB(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error(`IndexedDB database "${name}" is blocked by another connection.`));
  });
}
