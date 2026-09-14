import { bufferedResponse, encodedSizeOf, readWithByteProgress } from "./response-encoded-size.ts";
import { cacheWithDownloadLog } from "./offline-download-log.ts";

type DeferredEntry = { url: string; revision?: string | null; sizeBytes?: number };

type DeferredState = { cachedBytes: number; cachedFiles: number; totalBytes: number; totalFiles: number };

const createDeferredPrecache = ({
  entries,
  cacheName,
  scope,
  download,
  log = () => undefined,
}: {
  entries: DeferredEntry[];
  cacheName: string;
  scope: string;
  download: (request: Request) => Promise<Response>;
  log?: (message: string, details?: Record<string, unknown>) => void;
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
  const progressListeners = new Set<(delta: number) => void>();

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
      if (!keys.has(file.key)) {
        result.cachedBytes += Math.min(file.sizeBytes ?? 0, inFlight.get(file.key)?.loadedBytes ?? 0);
        continue;
      }
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
            for (const listener of progressListeners) listener(delta);
          });
          const complete = bufferedResponse(response, buffer, encodedSizeOf(file.url));
          await cacheWithDownloadLog(cache, file.key, complete.clone(), log);
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

  // A pump MUST observe all downloads, including app requests that start after its batch selection.
  const runNextBatch = async (onBytes?: (delta: number) => void) => {
    if (onBytes) {
      progressListeners.add(onBytes);
      for (const pending of inFlight.values()) {
        if (pending.loadedBytes > 0) onBytes(pending.loadedBytes);
      }
    }
    try {
      const cache = await caches.open(cacheName);
      const keys = new Set((await cache.keys()).map((request) => request.url));
      const missing = files.filter((file) => !keys.has(file.key));
      const started = missing.filter((file) => inFlight.has(file.key));
      const batch = [...started, ...missing.filter((file) => !inFlight.has(file.key))].slice(0, 4);
      const results = await Promise.allSettled(batch.map((file) => serve(file.url)));
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
      }
      return batch.length > 0;
    } finally {
      if (onBytes) progressListeners.delete(onBytes);
    }
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
