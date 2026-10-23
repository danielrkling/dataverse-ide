type Db = {
  get: (store: string, key: string) => Promise<unknown>
  put: (store: string, value: unknown, key: string) => Promise<void>
}

export async function openDB (name: string, storeName: string): Promise<Db> {
  const request = indexedDB.open(name, 1)
  request.onupgradeneeded = () => {
    request.result.createObjectStore(storeName)
  }
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

  return {
    get: (store, key) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly')
      const req = tx.objectStore(store).get(key)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    }),
    put: (store, value, key) => new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite')
      tx.objectStore(store).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }
}
