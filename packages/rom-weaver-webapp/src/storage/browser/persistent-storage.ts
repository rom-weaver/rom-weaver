const requestPersistentStorage = async (): Promise<boolean> => {
  const storage = globalThis.navigator?.storage;
  if (!storage?.persist) return false;
  return storage.persist();
};

export { requestPersistentStorage };
