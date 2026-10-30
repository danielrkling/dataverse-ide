type Db = {
  get: (store: string, key: IDBValidKey) => Promise<unknown>;
  getAll: (store: string) => Promise<unknown[]>;
  put: (store: string, value: unknown, key: IDBValidKey) => Promise<void>;
  delete: (store: string, key: IDBValidKey) => Promise<void>;
};

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function openDB(name: string, storeName: string): Promise<Db> {
  const request = indexedDB.open(name, 1);

  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(storeName)) {
      request.result.createObjectStore(storeName);
    }
  };

  const db = await requestToPromise(request);

  return {
    get: async (store, key) => {
      const tx = db.transaction(store, "readonly");

      return requestToPromise(tx.objectStore(store).get(key));
    },

    getAll: async (store) => {
      const tx = db.transaction(store, "readonly");

      return requestToPromise(tx.objectStore(store).getAll());
    },

    put: async (store, value, key) => {
      const tx = db.transaction(store, "readwrite");

      tx.objectStore(store).put(value, key);

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },

    delete: async (store, key) => {
      const tx = db.transaction(store, "readwrite");

      tx.objectStore(store).delete(key);

      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    },
  };
}
