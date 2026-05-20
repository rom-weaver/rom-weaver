const createCleanupOnce = (cleanup?: () => Promise<void> | void) => {
  if (typeof cleanup !== "function") return async () => undefined;

  let cleanupPromise: Promise<void> | null = null;
  return () => {
    cleanupPromise ??= Promise.resolve(cleanup()).then(() => undefined);
    return cleanupPromise;
  };
};

const disposeAll = async (disposables: Array<(() => Promise<void> | void) | undefined>) => {
  const errors: unknown[] = [];
  for (const dispose of disposables) {
    if (typeof dispose !== "function") continue;
    try {
      await dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Storage cleanup failed");
};

const throwIfAborted = (signal?: AbortSignal) => {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
};

export { createCleanupOnce, disposeAll, throwIfAborted };
