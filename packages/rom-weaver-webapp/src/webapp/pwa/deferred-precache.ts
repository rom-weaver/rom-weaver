import { bufferedResponse, encodedSizeOf, readWithByteProgress } from "./response-encoded-size.ts";

type DeferredEntry = { url: string; revision?: string | null; sizeBytes?: number };

type DeferredState = { cachedBytes: number; cachedFiles: number; totalBytes: number; totalFiles: number };

const createDeferredPrecache = ({
  entries,
  cacheName,
  scope,
  download,
}: {
  entries: DeferredEntry[];
  cacheName: string;
  scope: string;
  download: (request: Request) => Promise<Response>;
}) => {
  const files = entries.map((entry) => {
    const url = new URL(entry.url, scope);
    const key = new URL(url);
    if (entry.revision) key.searchParams.set("__WB_REVISION__", entry.revision);
    return { ...entry, key: key.href, url: url.href };
  });
  const byUrl = new Map(files.map((file) => [file.url, file]));
  // One download per file. Every caller that joins it gets the same byte
  // progress, so a pump that arrives after the app requested the file itself
  // still reports that download as it happens instead of crediting the whole
  // file when it lands.
  type InFlight = { listeners: Set<(delta: number) => void>; loadedBytes: number; promise: Promise<Response> };
  const inFlight = new Map<string, InFlight>();

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
    if (pending) {
      // Credit what already arrived so the joiner's progress starts where the download is.
      if (onBytes) {
        pending.listeners.add(onBytes);
        if (pending.loadedBytes > 0) onBytes(pending.loadedBytes);
      }
    } else {
      const entry: InFlight = {
        listeners: new Set(onBytes ? [onBytes] : []),
        loadedBytes: 0,
        promise: (async () => {
          const response = await download(new Request(file.url, { cache: file.revision ? "reload" : "default" }));
          if (!response.ok) throw new Error(`Offline app download failed with HTTP ${response.status}: ${file.url}`);
          const buffer = await readWithByteProgress(response, (delta) => {
            entry.loadedBytes += delta;
            for (const listener of entry.listeners) listener(delta);
          });
          const complete = bufferedResponse(response, buffer, encodedSizeOf(file.url));
          await cache.put(file.key, complete.clone());
          return complete;
        })(),
      };
      pending = entry;
      inFlight.set(file.key, pending);
    }
    try {
      return (await pending.promise).clone();
    } finally {
      if (inFlight.get(file.key) === pending) inFlight.delete(file.key);
    }
  };

  // Files the app is already downloading come first: joining them is free and
  // reports bytes that would otherwise land on the readout all at once.
  const runNextBatch = async (onBytes?: (delta: number) => void) => {
    const cache = await caches.open(cacheName);
    const keys = new Set((await cache.keys()).map((request) => request.url));
    const missing = files.filter((file) => !keys.has(file.key));
    const started = missing.filter((file) => inFlight.has(file.key));
    const batch = [...started, ...missing.filter((file) => !inFlight.has(file.key))].slice(0, 4);
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
