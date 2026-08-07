const EMULATORJS_MANIFEST_PATH = "emulatorjs/manifest.json";
const EMULATORJS_DATA_PATH = "emulatorjs/data/";
const EMULATORJS_CACHE_PREFIX = "precache-rom-weaver-emulatorjs-";

import {
  syncEmulatorAssets,
  type EmulatorAssetCache,
  type EmulatorAssetSyncResult,
  validateEmulatorAssetManifest,
} from "./emulator-asset-sync.ts";

type EmulatorAsset = {
  path: string;
  sizeBytes: number;
};

type EmulatorAssetManifest = {
  version: string;
  files: readonly EmulatorAsset[];
};

type EmulatorPrefetchProgress = {
  bytesDone: number;
  currentFile?: string;
  failedFiles: number;
  filesDone: number;
  skippedFiles: number;
  totalBytes: number;
  totalFiles: number;
};

type EmulatorPrefetchResult = EmulatorAssetSyncResult;

type CachedEmulatorAssets = {
  cachedBytes: number;
  cachedFiles: number;
};

type CacheStorageLike = Pick<CacheStorage, "match"> & Partial<Pick<CacheStorage, "open">>;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type ServiceWorkerRegistrationLike = Pick<ServiceWorkerRegistration, "scope">;
type ServiceWorkerContainerLike = Pick<ServiceWorkerContainer, "controller" | "ready">;
type NavigatorLike = { serviceWorker?: ServiceWorkerContainerLike };

type LoadEmulatorPrefetchStateOptions = {
  baseUrl?: string | URL;
  caches?: CacheStorageLike;
  fetch?: FetchLike;
  navigator?: NavigatorLike;
};

type LoadedEmulatorPrefetchState = {
  available: boolean;
  baseUrl: URL | null;
  cached: CachedEmulatorAssets;
  manifest: EmulatorAssetManifest | null;
  reason: string | null;
};

type PrefetchEmulatorAssetsOptions = {
  baseUrl: string | URL;
  caches: CacheStorageLike;
  fetch?: FetchLike;
  onProgress?: (progress: EmulatorPrefetchProgress) => void;
  signal?: AbortSignal;
};

type SyncEmulatorAssetsOptions = {
  navigator?: NavigatorLike;
  onProgress?: (progress: EmulatorPrefetchProgress) => void;
  signal?: AbortSignal;
};

const getGlobalNavigator = (): NavigatorLike | undefined => {
  if (typeof navigator === "undefined") return undefined;
  return navigator;
};

const getGlobalFetch = (): FetchLike => {
  if (typeof fetch !== "function") throw new Error("Fetch is unavailable");
  return fetch.bind(globalThis);
};

const normalizeBaseUrl = (value: string | URL) => {
  const baseUrl = new URL(value);
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
  return baseUrl;
};

const isSafeAssetPath = (value: unknown): value is string => {
  if (typeof value !== "string" || !value || value.startsWith("/") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
};

const parseManifest = (value: unknown): EmulatorAssetManifest => {
  validateEmulatorAssetManifest(value);
  return {
    files: value.files.map((file) => ({ path: file.path, sizeBytes: file.sizeBytes })),
    version: value.version,
  };
};

const getManifestUrl = (baseUrl: string | URL) => new URL(EMULATORJS_MANIFEST_PATH, normalizeBaseUrl(baseUrl)).href;

const getAssetUrl = (baseUrl: string | URL, path: string) => {
  if (!isSafeAssetPath(path)) throw new Error("EmulatorJS asset path is invalid");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return new URL(EMULATORJS_DATA_PATH + encodedPath, normalizeBaseUrl(baseUrl)).href;
};

const getCachedAssetPaths = async (
  manifest: EmulatorAssetManifest,
  baseUrl: string | URL,
  cacheStorage: CacheStorageLike,
) => {
  const cache = cacheStorage.open
    ? await cacheStorage.open(`${EMULATORJS_CACHE_PREFIX}${manifest.version}`)
    : cacheStorage;
  const cachedPaths = new Set<string>();
  await Promise.all(
    manifest.files.map(async (file) => {
      if (await cache.match(getAssetUrl(baseUrl, file.path))) cachedPaths.add(file.path);
    }),
  );
  return cachedPaths;
};

const getCachedEmulatorAssets = async (
  manifest: EmulatorAssetManifest,
  baseUrl: string | URL,
  cacheStorage: CacheStorageLike,
): Promise<CachedEmulatorAssets> => {
  const cachedPaths = await getCachedAssetPaths(manifest, baseUrl, cacheStorage);
  return manifest.files.reduce(
    (cached, file) => {
      if (!cachedPaths.has(file.path)) return cached;
      return {
        cachedBytes: cached.cachedBytes + file.sizeBytes,
        cachedFiles: cached.cachedFiles + 1,
      };
    },
    { cachedBytes: 0, cachedFiles: 0 },
  );
};

const resolveRuntime = async (
  options: LoadEmulatorPrefetchStateOptions,
): Promise<{ available: boolean; baseUrl: URL | null; reason: string | null }> => {
  if (options.baseUrl) return { available: true, baseUrl: normalizeBaseUrl(options.baseUrl), reason: null };
  const serviceWorker = (options.navigator ?? getGlobalNavigator())?.serviceWorker;
  if (!serviceWorker?.controller) {
    return {
      available: false,
      baseUrl: null,
      reason: "The service worker is not controlling this page.",
    };
  }
  try {
    const registration: ServiceWorkerRegistrationLike = await serviceWorker.ready;
    return { available: true, baseUrl: normalizeBaseUrl(registration.scope), reason: null };
  } catch {
    return {
      available: false,
      baseUrl: null,
      reason: "The service worker registration is not ready.",
    };
  }
};

const loadEmulatorPrefetchState = async (
  options: LoadEmulatorPrefetchStateOptions = {},
): Promise<LoadedEmulatorPrefetchState> => {
  const runtime = await resolveRuntime(options);
  if (!runtime.baseUrl) {
    return {
      ...runtime,
      cached: { cachedBytes: 0, cachedFiles: 0 },
      manifest: null,
    };
  }
  const fetcher = options.fetch ?? getGlobalFetch();
  const response = await fetcher(getManifestUrl(runtime.baseUrl), { credentials: "same-origin" });
  if (!response.ok) throw new Error("EmulatorJS asset manifest could not be loaded");
  const manifest = parseManifest(await response.json());
  const cacheStorage = options.caches ?? (typeof caches === "undefined" ? undefined : caches);
  const cached =
    runtime.available && cacheStorage
      ? await getCachedEmulatorAssets(manifest, runtime.baseUrl, cacheStorage)
      : { cachedBytes: 0, cachedFiles: 0 };
  setEmulatorCoresComplete(runtime.available ? cached.cachedFiles >= manifest.files.length : null);
  return { ...runtime, cached, manifest };
};

const prefetchEmulatorAssets = async (
  manifest: EmulatorAssetManifest,
  options: PrefetchEmulatorAssetsOptions,
): Promise<EmulatorPrefetchResult> => {
  const fetcher = options.fetch ?? getGlobalFetch();
  const cache: EmulatorAssetCache = options.caches.open
    ? await options.caches.open(`${EMULATORJS_CACHE_PREFIX}${manifest.version}`)
    : {
        match: (request) => options.caches.match(request),
        put: async () => undefined,
      };
  return syncEmulatorAssets(manifest, {
    baseUrl: options.baseUrl,
    cache,
    fetch: fetcher,
    onProgress: options.onProgress,
    signal: options.signal,
  });
};

const SYNC_EMULATORJS_ASSETS_ACTION = "sync-emulatorjs-assets";
const CANCEL_EMULATORJS_ASSETS_ACTION = "cancel-emulatorjs-assets";

const syncEmulatorAssetsInServiceWorker = (
  manifest: EmulatorAssetManifest,
  options: SyncEmulatorAssetsOptions = {},
): Promise<EmulatorPrefetchResult> => {
  const controller = (options.navigator ?? getGlobalNavigator())?.serviceWorker?.controller;
  if (!controller) return Promise.reject(new Error("The service worker is not controlling this page."));
  if (typeof MessageChannel !== "function") return Promise.reject(new Error("MessageChannel is unavailable."));

  const syncId = `emulator-assets-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const channel = new MessageChannel();
  let settled = false;

  return new Promise<EmulatorPrefetchResult>((resolve, reject) => {
    let cancel = () => undefined;
    const cleanup = () => {
      channel.port1.onmessage = null;
      try {
        channel.port1.close();
      } catch {
        // best-effort cleanup
      }
      options.signal?.removeEventListener("abort", cancel);
    };
    const finish = (result: EmulatorPrefetchResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    cancel = () => {
      try {
        controller.postMessage({ action: CANCEL_EMULATORJS_ASSETS_ACTION, syncId });
      } catch (error) {
        fail(error);
      }
    };

    channel.port1.onmessage = (event) => {
      const data = event.data as {
        message?: unknown;
        progress?: EmulatorPrefetchProgress;
        result?: EmulatorPrefetchResult;
        type?: unknown;
      };
      if (data.type === "progress" && data.progress) {
        options.onProgress?.(data.progress);
        return;
      }
      if (data.type === "complete" && data.result) {
        finish(data.result);
        return;
      }
      if (data.type === "error") {
        fail(data.message || "EmulatorJS asset sync failed");
      }
    };
    channel.port1.start();
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      controller.postMessage(
        {
          action: SYNC_EMULATORJS_ASSETS_ACTION,
          manifest,
          syncId,
        },
        [channel.port2],
      );
      if (options.signal?.aborted) cancel();
    } catch (error) {
      fail(error);
    }
  });
};

const formatEmulatorBytes = (bytes: number) => {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  const megabytes = (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "");
  return megabytes + " MB";
};

/**
 * Whether every EmulatorJS asset is in the offline cache: true, false, or null
 * while unknown / not applicable (no service worker, load failed). Module-level
 * so the masthead runtime chip can read it without owning the prefetch panel.
 */
let emulatorCoresComplete: boolean | null = null;
const emulatorCoresCompleteListeners = new Set<() => void>();

const readEmulatorCoresComplete = (): boolean | null => emulatorCoresComplete;

const setEmulatorCoresComplete = (value: boolean | null): void => {
  if (emulatorCoresComplete === value) return;
  emulatorCoresComplete = value;
  for (const listener of emulatorCoresCompleteListeners) listener();
};

const subscribeEmulatorCoresComplete = (listener: () => void): (() => void) => {
  emulatorCoresCompleteListeners.add(listener);
  return () => emulatorCoresCompleteListeners.delete(listener);
};

let emulatorCoresProbeInFlight = false;
let emulatorCoresProbeDone = false;
/**
 * Background probe so the runtime chip knows the cache state without opening
 * the dialog. Latches only once the service worker was actually available: a
 * first-visit probe can run before the controller claims the page, and that
 * attempt must not block a retry after the status changes.
 */
const probeEmulatorCoresComplete = async (options: LoadEmulatorPrefetchStateOptions = {}): Promise<void> => {
  if (emulatorCoresProbeDone || emulatorCoresProbeInFlight) return;
  emulatorCoresProbeInFlight = true;
  try {
    const state = await loadEmulatorPrefetchState(options);
    emulatorCoresProbeDone = state.available;
  } catch {
    // Leave the latch open so a later service-worker transition can retry.
  } finally {
    emulatorCoresProbeInFlight = false;
  }
};

export {
  formatEmulatorBytes,
  getCachedEmulatorAssets,
  loadEmulatorPrefetchState,
  parseManifest,
  prefetchEmulatorAssets,
  probeEmulatorCoresComplete,
  readEmulatorCoresComplete,
  setEmulatorCoresComplete,
  subscribeEmulatorCoresComplete,
  syncEmulatorAssetsInServiceWorker,
};
export type { EmulatorAssetManifest, EmulatorPrefetchProgress, LoadedEmulatorPrefetchState };
