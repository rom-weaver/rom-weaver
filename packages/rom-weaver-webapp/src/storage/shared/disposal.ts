const createCleanupOnce = (cleanup?: () => Promise<void> | void) => {
  if (typeof cleanup !== "function") return async () => undefined;

  let cleanupPromise: Promise<void> | null = null;
  return () => {
    cleanupPromise ??= Promise.resolve(cleanup()).then(() => undefined);
    return cleanupPromise;
  };
};

export { createCleanupOnce };
