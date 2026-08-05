const EMULATORJS_MANIFEST_PATH = "emulatorjs/manifest.json";
const EMULATORJS_DATA_PATH = "emulatorjs/data/";

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

type EmulatorPrefetchFailure = {
  message: string;
  path: string;
};

type EmulatorPrefetchResult = {
  cancelled: boolean;
  failures: readonly EmulatorPrefetchFailure[];
  progress: EmulatorPrefetchProgress;
};

type CachedEmulatorAssets = {
  cachedBytes: number;
  cachedFiles: number;
};

type CacheStorageLike = Pick<CacheStorage, "match">;
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
  if (typeof value !== "string" || !value || value.startsWith("/")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
};

const parseManifest = (value: unknown): EmulatorAssetManifest => {
  if (!value || typeof value !== "object") throw new Error("EmulatorJS asset manifest is invalid");
  const record = value as { files?: unknown; version?: unknown };
  if (typeof record.version !== "string" || !Array.isArray(record.files)) {
    throw new Error("EmulatorJS asset manifest is invalid");
  }
  const paths = new Set<string>();
  const files = record.files.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("EmulatorJS asset manifest contains an invalid file");
    const file = entry as { path?: unknown; sizeBytes?: unknown };
    if (
      !isSafeAssetPath(file.path) ||
      typeof file.sizeBytes !== "number" ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      paths.has(file.path)
    ) {
      throw new Error("EmulatorJS asset manifest contains an invalid file");
    }
    paths.add(file.path);
    return { path: file.path, sizeBytes: file.sizeBytes };
  });
  return { files, version: record.version };
};

const getManifestUrl = (baseUrl: string | URL) => new URL(EMULATORJS_MANIFEST_PATH, normalizeBaseUrl(baseUrl)).href;

const getAssetUrl = (baseUrl: string | URL, path: string) => {
  if (!isSafeAssetPath(path)) throw new Error("EmulatorJS asset path is invalid");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return new URL(EMULATORJS_DATA_PATH + encodedPath, normalizeBaseUrl(baseUrl)).href;
};

const getTotalSize = (manifest: EmulatorAssetManifest) =>
  manifest.files.reduce((total, file) => total + file.sizeBytes, 0);

const getCachedAssetPaths = async (
  manifest: EmulatorAssetManifest,
  baseUrl: string | URL,
  cacheStorage: CacheStorageLike,
) => {
  const cachedPaths = new Set<string>();
  await Promise.all(
    manifest.files.map(async (file) => {
      if (await cacheStorage.match(getAssetUrl(baseUrl, file.path))) cachedPaths.add(file.path);
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
  return { ...runtime, cached, manifest };
};

const createProgress = (
  manifest: EmulatorAssetManifest,
  cachedPaths: ReadonlySet<string>,
): EmulatorPrefetchProgress => {
  const cachedFiles = manifest.files.filter((file) => cachedPaths.has(file.path));
  return {
    bytesDone: cachedFiles.reduce((total, file) => total + file.sizeBytes, 0),
    failedFiles: 0,
    filesDone: cachedFiles.length,
    skippedFiles: cachedFiles.length,
    totalBytes: getTotalSize(manifest),
    totalFiles: manifest.files.length,
  };
};

const prefetchEmulatorAssets = async (
  manifest: EmulatorAssetManifest,
  options: PrefetchEmulatorAssetsOptions,
): Promise<EmulatorPrefetchResult> => {
  const fetcher = options.fetch ?? getGlobalFetch();
  const cachedPaths = await getCachedAssetPaths(manifest, options.baseUrl, options.caches);
  const progress = createProgress(manifest, cachedPaths);
  const failures: EmulatorPrefetchFailure[] = [];
  options.onProgress?.({ ...progress });

  for (const file of manifest.files) {
    if (cachedPaths.has(file.path)) continue;
    if (options.signal?.aborted) {
      return { cancelled: true, failures, progress: { ...progress } };
    }
    const currentProgress = { ...progress, currentFile: file.path };
    options.onProgress?.(currentProgress);
    try {
      const response = await fetcher(getAssetUrl(options.baseUrl, file.path), {
        credentials: "same-origin",
        signal: options.signal,
      });
      if (options.signal?.aborted) {
        return { cancelled: true, failures, progress: { ...progress } };
      }
      if (!response.ok) throw new Error("HTTP " + response.status);
      progress.bytesDone += file.sizeBytes;
      progress.filesDone += 1;
      progress.currentFile = undefined;
      options.onProgress?.({ ...progress });
    } catch (error) {
      if (options.signal?.aborted) {
        return { cancelled: true, failures, progress: { ...progress } };
      }
      progress.failedFiles += 1;
      progress.currentFile = undefined;
      failures.push({
        message: error instanceof Error ? error.message : String(error),
        path: file.path,
      });
      options.onProgress?.({ ...progress });
    }
  }
  return { cancelled: false, failures, progress: { ...progress } };
};

const formatEmulatorBytes = (bytes: number) => {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
  const megabytes = (bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "");
  return megabytes + " MB";
};

export {
  formatEmulatorBytes,
  getCachedEmulatorAssets,
  loadEmulatorPrefetchState,
  parseManifest,
  prefetchEmulatorAssets,
};
export type { EmulatorAssetManifest, EmulatorPrefetchProgress, LoadedEmulatorPrefetchState };
