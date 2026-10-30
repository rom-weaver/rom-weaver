const createCleanupOnce = (cleanup?: () => Promise<void> | void) => {
  if (typeof cleanup !== "function") return async () => undefined;

  let cleanupPromise: Promise<void> | null = null;
  return () => {
    cleanupPromise ??= Promise.resolve()
      .then(cleanup)
      .then(() => undefined)
      .catch((error) => {
        cleanupPromise = null;
        throw error;
      });
    return cleanupPromise;
  };
};

export { createCleanupOnce };
