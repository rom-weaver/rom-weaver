type DeferredEntry = { url: string; revision?: string | null; sizeBytes?: number };

type DeferredState = { cachedBytes: number; cachedFiles: number; totalBytes: number; totalFiles: number };

const createDeferredPrecache = ({
  entries,
  cacheName,
  scope,
  download,
  release,
}: {
  entries: DeferredEntry[];
  cacheName: string;
  scope: string;
  download: (request: Request, onBytes?: (delta: number) => void) => Promise<Response>;
  release: (request: Request) => Promise<void>;
}) => {
  const files = entries.map((entry) => {
    const url = new URL(entry.url, scope);
    const key = new URL(url);
    if (entry.revision) key.searchParams.set("__WB_REVISION__", entry.revision);
    return { ...entry, key: key.href, url: url.href };
  });
  const byUrl = new Map(files.map((file) => [file.url, file]));
  const inFlight = new Map<string, Promise<Response>>();

  const find = (input: string) => {
    const url = new URL(input, scope);
    url.hash = "";
    url.searchParams.delete("sha256");
    return byUrl.get(url.href);
  };

  const state = async (): Promise<DeferredState> => {
    const cache = await caches.open(cacheName);
    const keys = new Set((await cache.keys()).map((request) => request.url));
    const result = { cachedBytes: 0, cachedFiles: 0, totalBytes: 0, totalFiles: files.length };
    for (const file of files) {
      result.totalBytes += file.sizeBytes ?? 0;
      if (!keys.has(file.key)) continue;
      result.cachedBytes += file.sizeBytes ?? 0;
      result.cachedFiles += 1;
    }
    return result;
  };

  const match = async (url: string) => {
    const file = find(url);
    if (!file) return undefined;
    return (await caches.open(cacheName)).match(file.key);
  };

  const serve = async (url: string, onBytes?: (delta: number) => void): Promise<Response> => {
    const file = find(url);
    if (!file) throw new Error(`Unknown offline app file: ${url}`);
    const cache = await caches.open(cacheName);
    const cached = await cache.match(file.key);
    if (cached) return cached;
    let pending = inFlight.get(file.key);
    if (!pending) {
      pending = (async () => {
        const response = await download(
          new Request(file.url, { cache: file.revision ? "reload" : "default" }),
          onBytes,
        );
        if (!response.ok) throw new Error(`Offline app download failed with HTTP ${response.status}: ${file.url}`);
        await cache.put(file.key, response.clone());
        await release(new Request(file.url));
        return response;
      })();
      inFlight.set(file.key, pending);
    }
    try {
      return (await pending).clone();
    } finally {
      if (inFlight.get(file.key) === pending) inFlight.delete(file.key);
    }
  };

  const runNextBatch = async (onBytes?: (delta: number) => void) => {
    const cache = await caches.open(cacheName);
    const keys = new Set((await cache.keys()).map((request) => request.url));
    const batch = files.filter((file) => !keys.has(file.key)).slice(0, 4);
    const results = await Promise.allSettled(batch.map((file) => serve(file.url, onBytes)));
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
    return batch.length > 0;
  };

  const migrate = async (sourceCacheName: string) => {
    const [source, destination] = await Promise.all([caches.open(sourceCacheName), caches.open(cacheName)]);
    for (const file of files) {
      if (await destination.match(file.key)) continue;
      const cached = await source.match(file.key);
      if (cached) await destination.put(file.key, cached);
    }
  };

  const cleanup = async () => {
    const cache = await caches.open(cacheName);
    const expected = new Set(files.map((file) => file.key));
    await Promise.all(
      (await cache.keys()).filter((request) => !expected.has(request.url)).map((request) => cache.delete(request)),
    );
  };

  return { cleanup, has: (url: string) => Boolean(find(url)), match, migrate, runNextBatch, serve, state };
};

export { createDeferredPrecache };
