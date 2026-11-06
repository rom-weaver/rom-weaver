type IdbObjectStoreMessages = {
  /** Another tab holds an older version of the database open. */
  blocked: string;
  unavailable: string;
  failed: string;
};

/** One version-1 IndexedDB object store, opened for each call and closed after it. */
const createIdbObjectStore = (databaseName: string, storeName: string, messages: IdbObjectStoreMessages) => {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      let blocked = false;
      request.onupgradeneeded = () => request.result.createObjectStore(storeName);
      request.onblocked = () => {
        blocked = true;
        reject(new Error(messages.blocked));
      };
      request.onerror = () => reject(request.error || new Error(messages.unavailable));
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        if (blocked) database.close();
        else resolve(database);
      };
    });

  const transaction = async <T>(
    mode: IDBTransactionMode,
    action: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const database = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = database.transaction(storeName, mode);
        const request = action(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = tx.onabort = () => reject(tx.error || request.error || new Error(messages.failed));
      });
    } finally {
      database.close();
    }
  };

  return { open, transaction };
};

export { createIdbObjectStore };
