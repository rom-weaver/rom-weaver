import {
  bufferedResponse,
  createCachedTransferSizeReader,
  encodedSizeOf,
  readWithByteProgress,
} from "./response-encoded-size.ts";
import { cacheWithDownloadLog } from "./offline-download-log.ts";
import type { OfflineCopyPolicy } from "./offline-copy-policy.ts";

const DOWNLOAD_CONCURRENCY = 4;
const BATCH_FILE_LIMIT = 16;

type DeferredEntry = { url: string; revision?: string | null; sizeBytes?: number };

type DeferredState = {
  cachedBytes: number;
  cachedFiles: number;
  totalBytes: number;
  totalFiles: number;
  transferredBytes: number;
  transferBytesIncomplete: boolean;
};

const createDeferredPrecache = ({
  entries,
  cacheName,
  scope,
  download,
  policy,
  log = () => undefined,
}: {
  entries: DeferredEntry[];
  cacheName: string;
  scope: string;
  download: (request: Request) => Promise<Response>;
  policy?: OfflineCopyPolicy;
  log?: (message: string, details?: Record<string, unknown>) => void;
}) => {
  const files = entries.map((entry) => {
    const url = new URL(entry.url, scope);
    const key = new URL(url);
    if (entry.revision) key.searchParams.set("__WB_REVISION__", entry.revision);
    const downloadUrl = new URL(url);
    // Directory URLs MUST avoid the index.html redirect used by static hosts.
    downloadUrl.pathname = downloadUrl.pathname.replace(/\/index\.html$/, "/");
    return { ...entry, downloadUrl: downloadUrl.href, key: key.href, url: url.href };
  });
  const byUrl = new Map(files.map((file) => [file.url, file]));
  // One download per file. Every caller that joins it gets the same byte
  // progress, so a pump that arrives after the app requested the file itself
  // still reports that download as it happens instead of crediting the whole
  // file when it lands.
  type InFlight = { listeners: Set<(delta: number) => void>; loadedBytes: number; promise: Promise<Response> };
  const inFlight = new Map<string, InFlight>();
  const progressListeners = new Set<(key: string, loadedBytes: number) => void>();
  const cachedListeners = new Set<() => void>();
  const transferSizes = createCachedTransferSizeReader();

  const find = (input: string) => {
    const url = new URL(input, scope);
    url.hash = "";
    url.searchParams.delete("sha256");
    return byUrl.get(url.href);
  };

  const state = async (): Promise<DeferredState> => {
    const cache = await caches.open(cacheName);
    const keys = new Set((await cache.keys()).map((request) => request.url));
    const result = {
      cachedBytes: 0,
      cachedFiles: 0,
      totalBytes: 0,
      totalFiles: files.length,
      transferredBytes: 0,
      transferBytesIncomplete: false,
    };
    const measurements: Array<Promise<void>> = [];
    for (const file of files) {
      result.totalBytes += file.sizeBytes ?? 0;
      if (!keys.has(file.key)) {
        result.cachedBytes += Math.min(file.sizeBytes ?? 0, inFlight.get(file.key)?.loadedBytes ?? 0);
        continue;
      }
      result.cachedBytes += file.sizeBytes ?? 0;
      result.cachedFiles += 1;
      measurements.push(
        transferSizes.read(cache, file.key, file.sizeBytes).then((size) => {
          if (size === null) result.transferBytesIncomplete = true;
          else result.transferredBytes += size;
        }),
      );
    }
    await Promise.all(measurements);
    return result;
  };

  const match = async (url: string) => {
    const file = find(url);
    if (!file) return undefined;
    return (await caches.open(cacheName)).match(file.key);
  };

  const serve = async (
    url: string,
    onBytes?: (delta: number) => void,
    backgroundGeneration?: number,
  ): Promise<Response> => {
    const file = find(url);
    if (!file) throw new Error(`Unknown offline app file: ${url}`);
    if (
      policy &&
      backgroundGeneration !== undefined &&
      (backgroundGeneration !== policy.token() || !(await policy.isEnabled()))
    )
      return Response.error();
    if (policy && !(await policy.isEnabled())) {
      return download(new Request(file.downloadUrl, { cache: file.revision ? "reload" : "default" }));
    }
    const generation = policy?.token();
    const cache = await caches.open(cacheName);
    const cached = await cache.match(file.key);
    if (cached) {
      for (const listener of progressListeners) listener(file.key, file.sizeBytes ?? 0);
      for (const listener of cachedListeners) listener();
      return cached;
    }
    if (
      policy &&
      backgroundGeneration !== undefined &&
      (backgroundGeneration !== policy.token() || !(await policy.isEnabled()))
    )
      return Response.error();
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
          const response = await download(
            new Request(file.downloadUrl, { cache: file.revision ? "reload" : "default" }),
          );
          if (!response.ok) throw new Error(`Offline app download failed with HTTP ${response.status}: ${file.url}`);
          const buffer = await readWithByteProgress(response, (delta) => {
            if (policy && generation !== policy.token()) return;
            entry.loadedBytes += delta;
            for (const listener of entry.listeners) listener(delta);
            for (const listener of progressListeners) listener(file.key, entry.loadedBytes);
          });
          const complete = bufferedResponse(response, buffer, encodedSizeOf(file.downloadUrl));
          const stored = policy
            ? await policy.write(() => cacheWithDownloadLog(cache, file.key, complete.clone(), log), generation)
            : (await cacheWithDownloadLog(cache, file.key, complete.clone(), log), true);
          if (stored) {
            transferSizes.forget(file.key);
            for (const listener of progressListeners) listener(file.key, file.sizeBytes ?? buffer.byteLength);
            for (const listener of cachedListeners) listener();
          }
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
  const runNextBatch = async (
    onProgress?: (cachedBytes: number) => void,
    onCached?: () => void,
    shouldContinue = () => true,
  ) => {
    if (policy && !(await policy.isEnabled())) return false;
    const generation = policy?.token();
    let cachedKeys: Set<string> | undefined;
    const loaded = new Map([...inFlight].map(([key, pending]) => [key, pending.loadedBytes]));
    const report = () => {
      const keys = cachedKeys;
      if (!(keys && onProgress)) return;
      const cachedBytes = files.reduce((sum, file) => {
        const size = file.sizeBytes ?? 0;
        return sum + (keys.has(file.key) ? size : Math.min(size, loaded.get(file.key) ?? 0));
      }, 0);
      onProgress(cachedBytes);
    };
    // The listener MUST retain arrivals while the starting cache snapshot is pending.
    const onBytes = (key: string, loadedBytes: number) => {
      loaded.set(key, loadedBytes);
      report();
    };
    if (onProgress) progressListeners.add(onBytes);
    if (onCached) cachedListeners.add(onCached);
    try {
      const cache = await caches.open(cacheName);
      const keys = new Set((await cache.keys()).map((request) => request.url));
      cachedKeys = keys;
      const missing = files.filter((file) => !keys.has(file.key));
      const started = missing.filter((file) => inFlight.has(file.key));
      const batch = [...started, ...missing.filter((file) => !inFlight.has(file.key))].slice(0, BATCH_FILE_LIMIT);
      if (batch.length > 0) report();
      let next = 0;
      let failed = false;
      const run = async () => {
        while (
          !failed &&
          shouldContinue() &&
          (!policy || (generation === policy.token() && (await policy.isEnabled())))
        ) {
          const file = batch[next++];
          if (!file) return;
          try {
            await serve(file.url, undefined, generation);
          } catch (error) {
            failed = true;
            throw error;
          }
        }
      };
      const results = await Promise.allSettled(Array.from({ length: DOWNLOAD_CONCURRENCY }, run));
      for (const result of results) {
        if (result.status === "rejected") throw result.reason;
      }
      return batch.length > 0;
    } finally {
      if (onProgress) progressListeners.delete(onBytes);
      if (onCached) cachedListeners.delete(onCached);
    }
  };

  const migrate = async (sourceCacheName: string) => {
    if (policy && !(await policy.isEnabled())) return;
    const generation = policy?.token();
    const [source, destination] = await Promise.all([caches.open(sourceCacheName), caches.open(cacheName)]);
    for (const file of files) {
      if (await destination.match(file.key)) continue;
      const cached = await source.match(file.key);
      if (cached) {
        if (policy) await policy.write(() => destination.put(file.key, cached), generation);
        else await destination.put(file.key, cached);
      }
    }
  };

  const cleanup = async () => {
    const cache = await caches.open(cacheName);
    const expected = new Set(files.map((file) => file.key));
    await Promise.all(
      (await cache.keys()).filter((request) => !expected.has(request.url)).map((request) => cache.delete(request)),
    );
  };

  const reset = () => {
    inFlight.clear();
    transferSizes.clear();
  };

  const setSizes = (sizes: ReadonlyMap<string, number>) => {
    for (const file of files) file.sizeBytes ??= sizes.get(new URL(file.url).pathname);
  };

  return {
    cleanup,
    has: (url: string) => Boolean(find(url)),
    match,
    migrate,
    reset,
    runNextBatch,
    serve,
    setSizes,
    state,
  };
};

export { createDeferredPrecache };
