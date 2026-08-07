import { describe, expect, it, vi } from "vitest";
import {
  parseManifest,
  prefetchEmulatorAssets,
  probeEmulatorCoresComplete,
  readEmulatorCoresComplete,
  syncEmulatorAssetsInServiceWorker,
  type EmulatorAssetManifest,
  type EmulatorPrefetchProgress,
} from "../../src/webapp/pwa/emulator-prefetch.ts";

const BASE_URL = "https://example.test/app/";

const manifest: EmulatorAssetManifest = parseManifest({
  files: [
    { path: "cores/first.data", sizeBytes: 10 },
    { path: "cores/second.data", sizeBytes: 20 },
    { path: "loader.js", sizeBytes: 30 },
  ],
  version: "4.2.3",
});

const createCacheStorage = (cachedPaths: Iterable<string> = []) => {
  const cached = new Set(cachedPaths);
  const match = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    return [...cached].some((path) => url.endsWith("/emulatorjs/data/" + path)) ? new Response("cached") : undefined;
  });
  return {
    cached,
    match,
  };
};

const createFetcher = (cache: ReturnType<typeof createCacheStorage>, failures = new Set<string>()) =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const path = url.split("/emulatorjs/data/")[1];
    if (failures.has(path)) throw new Error("network failed");
    cache.cached.add(path);
    return new Response("asset");
  });

describe("emulator prefetch", () => {
  it("accounts for cached bytes and downloaded bytes in progress", async () => {
    const cache = createCacheStorage(["cores/first.data"]);
    const fetcher = createFetcher(cache);
    const progress: EmulatorPrefetchProgress[] = [];

    const result = await prefetchEmulatorAssets(manifest, {
      baseUrl: BASE_URL,
      caches: cache,
      fetch: fetcher,
      onProgress: (next) => progress.push(next),
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.cancelled).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.progress).toMatchObject({
      bytesDone: 60,
      failedFiles: 0,
      filesDone: 3,
      skippedFiles: 1,
      totalBytes: 60,
      totalFiles: 3,
    });
    expect(progress[0]).toMatchObject({ bytesDone: 10, filesDone: 1, skippedFiles: 1 });
    expect(progress.at(-1)).toMatchObject({ bytesDone: 60, filesDone: 3 });
  });

  it("resumes by skipping every asset cached by the previous run", async () => {
    const cache = createCacheStorage(["cores/first.data"]);
    const fetcher = createFetcher(cache);

    await prefetchEmulatorAssets(manifest, { baseUrl: BASE_URL, caches: cache, fetch: fetcher });
    fetcher.mockClear();

    const result = await prefetchEmulatorAssets(manifest, { baseUrl: BASE_URL, caches: cache, fetch: fetcher });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.progress).toMatchObject({ bytesDone: 60, filesDone: 3, skippedFiles: 3 });
  });

  it("continues after a failed file and reports the failure", async () => {
    const cache = createCacheStorage();
    const fetcher = createFetcher(cache, new Set(["cores/second.data"]));

    const result = await prefetchEmulatorAssets(manifest, { baseUrl: BASE_URL, caches: cache, fetch: fetcher });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.failures).toEqual([{ message: "network failed", path: "cores/second.data" }]);
    expect(result.progress).toMatchObject({
      bytesDone: 40,
      failedFiles: 1,
      filesDone: 2,
      totalFiles: 3,
    });
  });

  it("stops without reporting an aborted fetch as a file failure", async () => {
    const cache = createCacheStorage();
    const controller = new AbortController();
    const fetcher = vi.fn(async () => {
      controller.abort();
      throw new Error("aborted");
    });

    const result = await prefetchEmulatorAssets(manifest, {
      baseUrl: BASE_URL,
      caches: cache,
      fetch: fetcher,
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.progress).toMatchObject({ bytesDone: 0, failedFiles: 0, filesDone: 0 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("asks the controlling service worker to sync assets and relays progress", async () => {
    const progress: EmulatorPrefetchProgress[] = [];
    const controller = {
      postMessage: vi.fn((message: { action: string }, transfer?: Transferable[]) => {
        if (message.action !== "sync-emulatorjs-assets") return;
        const port = transfer?.[0] as MessagePort;
        queueMicrotask(() => {
          port.postMessage({
            progress: { bytesDone: 10, filesDone: 1, totalBytes: 60, totalFiles: 3 },
            type: "progress",
          });
          port.postMessage({
            result: {
              cancelled: false,
              failures: [],
              progress: { bytesDone: 60, filesDone: 3, totalBytes: 60, totalFiles: 3 },
            },
            type: "complete",
          });
        });
      }),
    };

    const result = await syncEmulatorAssetsInServiceWorker(manifest, {
      navigator: {
        serviceWorker: {
          controller: controller as unknown as ServiceWorker,
          ready: Promise.resolve({ scope: BASE_URL }),
        },
      },
      onProgress: (next) => progress.push(next),
    });

    expect(controller.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: "sync-emulatorjs-assets", manifest: expect.any(Object) }),
      expect.any(Array),
    );
    expect(progress).toHaveLength(1);
    expect(result.progress.filesDone).toBe(3);
  });

  it("cancels an in-flight service-worker sync without rejecting", async () => {
    const abortController = new AbortController();
    let port: MessagePort | undefined;
    const controller = {
      postMessage: vi.fn((message: { action: string }, transfer?: Transferable[]) => {
        if (message.action === "sync-emulatorjs-assets") port = transfer?.[0] as MessagePort;
        if (message.action === "cancel-emulatorjs-assets") {
          queueMicrotask(() =>
            port?.postMessage({
              result: {
                cancelled: true,
                failures: [],
                progress: { bytesDone: 0, filesDone: 0, totalBytes: 60, totalFiles: 3 },
              },
              type: "complete",
            }),
          );
        }
      }),
    };
    const promise = syncEmulatorAssetsInServiceWorker(manifest, {
      navigator: {
        serviceWorker: {
          controller: controller as unknown as ServiceWorker,
          ready: Promise.resolve({ scope: BASE_URL }),
        },
      },
      signal: abortController.signal,
    });

    abortController.abort();
    const result = await promise;

    expect(result.cancelled).toBe(true);
    expect(controller.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cancel-emulatorjs-assets" }),
    );
  });

  it("cancels when the signal was already aborted before the request", async () => {
    const abortController = new AbortController();
    abortController.abort();
    let port: MessagePort | undefined;
    const controller = {
      postMessage: vi.fn((message: { action: string }, transfer?: Transferable[]) => {
        if (message.action === "sync-emulatorjs-assets") port = transfer?.[0] as MessagePort;
        if (message.action === "cancel-emulatorjs-assets") {
          queueMicrotask(() =>
            port?.postMessage({
              result: {
                cancelled: true,
                failures: [],
                progress: { bytesDone: 0, filesDone: 0, totalBytes: 60, totalFiles: 3 },
              },
              type: "complete",
            }),
          );
        }
      }),
    };

    const result = await syncEmulatorAssetsInServiceWorker(manifest, {
      navigator: {
        serviceWorker: {
          controller: controller as unknown as ServiceWorker,
          ready: Promise.resolve({ scope: BASE_URL }),
        },
      },
      signal: abortController.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(controller.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ action: "cancel-emulatorjs-assets" }),
    );
  });

  it("keeps the cores probe retryable until the service worker is available", async () => {
    // First-visit shape: no controller yet, so the probe must not latch.
    await probeEmulatorCoresComplete({ navigator: {} });
    expect(readEmulatorCoresComplete()).toBeNull();

    const cache = createCacheStorage(["cores/first.data"]);
    const manifestFetch = vi.fn(async () =>
      Response.json({
        files: [
          { path: "cores/first.data", sizeBytes: 10 },
          { path: "loader.js", sizeBytes: 30 },
        ],
        version: "4.2.3",
      }),
    );
    await probeEmulatorCoresComplete({ baseUrl: BASE_URL, caches: cache, fetch: manifestFetch });
    expect(readEmulatorCoresComplete()).toBe(false);

    // Latched after an available run: a later unavailable call changes nothing.
    await probeEmulatorCoresComplete({ navigator: {} });
    expect(readEmulatorCoresComplete()).toBe(false);
  });
});
