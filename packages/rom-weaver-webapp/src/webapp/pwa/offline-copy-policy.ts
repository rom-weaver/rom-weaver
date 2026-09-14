type OfflineCopyPolicy = ReturnType<typeof createOfflineCopyPolicy>;

const createOfflineCopyPolicy = (cacheName: string, scope: string) => {
  const preferenceUrl = new URL("/__rom-weaver-offline-copy-enabled__", scope).href;
  let enabled = true;
  let generation = 0;
  let explicitChange = false;
  let hydration: Promise<void> | null = null;
  const writes = new Set<Promise<unknown>>();

  const hydrate = () => {
    if (!hydration) {
      hydration = (async () => {
        const response = await (await caches.open(cacheName)).match(preferenceUrl);
        if (!explicitChange && response) enabled = (await response.text()) !== "false";
      })().catch((error) => {
        hydration = null;
        throw error;
      });
    }
    return hydration;
  };

  const isEnabled = async () => {
    await hydrate();
    return enabled;
  };

  const token = () => generation;

  // A disabled transition waits for every Cache.put already started before its caller deletes file caches.
  const write = async (operation: () => Promise<unknown>, expectedGeneration = generation): Promise<boolean> => {
    await hydrate();
    if (!enabled || expectedGeneration !== generation) return false;
    const pending = Promise.resolve().then(operation);
    writes.add(pending);
    try {
      await pending;
      return true;
    } finally {
      writes.delete(pending);
    }
  };

  const setEnabled = async (next: boolean) => {
    explicitChange = true;
    if (!next) {
      enabled = false;
      generation += 1;
    }
    await hydrate();
    await (await caches.open(cacheName)).put(preferenceUrl, new Response(String(next)));
    if (next) {
      enabled = true;
    } else {
      while (writes.size) await Promise.allSettled(writes);
    }
  };

  return { hydrate, isEnabled, setEnabled, token, write };
};

export { createOfflineCopyPolicy };
export type { OfflineCopyPolicy };
