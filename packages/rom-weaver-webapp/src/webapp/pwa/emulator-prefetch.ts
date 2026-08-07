const EMULATORJS_MANIFEST_PATH = "emulatorjs/manifest.json";
const EMULATORJS_DATA_PATH = "emulatorjs/data/";
const EMULATOR_PREFETCH_DELAY_MS = 5000;

type EmulatorAsset = {
  path: string;
  sizeBytes: number;
};

type EmulatorAssetManifest = {
  version: string;
  files: readonly EmulatorAsset[];
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type ServiceWorkerRegistrationLike = Pick<ServiceWorkerRegistration, "scope">;

type ServiceWorkerContainerLike = {
  controller: ServiceWorker | null;
  ready: Promise<ServiceWorkerRegistrationLike>;
  addEventListener?: (type: "controllerchange", listener: () => void) => void;
  removeEventListener?: (type: "controllerchange", listener: () => void) => void;
};

type NavigatorLike = { serviceWorker?: ServiceWorkerContainerLike };

type PrefetchEmulatorAssetsOptions = {
  fetch?: FetchLike;
  signal?: AbortSignal;
};

type ScheduleEmulatorAssetPrefetchOptions = PrefetchEmulatorAssetsOptions & {
  delayMs?: number;
  navigator?: NavigatorLike;
};

type EmulatorPrefetchResult = {
  downloadedFiles: number;
  failedFiles: readonly string[];
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

const prefetchEmulatorAssets = async (
  baseUrl: string | URL,
  options: PrefetchEmulatorAssetsOptions = {},
): Promise<EmulatorPrefetchResult> => {
  const fetcher = options.fetch ?? getGlobalFetch();
  const manifestResponse = await fetcher(getManifestUrl(baseUrl), {
    credentials: "same-origin",
    signal: options.signal,
  });
  if (!manifestResponse.ok) throw new Error("EmulatorJS asset manifest could not be loaded");
  const manifest = parseManifest(await manifestResponse.json());
  const failedFiles: string[] = [];
  let downloadedFiles = 0;

  for (const file of manifest.files) {
    if (options.signal?.aborted) break;
    try {
      const response = await fetcher(getAssetUrl(baseUrl, file.path), {
        credentials: "same-origin",
        signal: options.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      downloadedFiles += 1;
    } catch {
      if (options.signal?.aborted) break;
      failedFiles.push(file.path);
    }
  }

  return { downloadedFiles, failedFiles };
};

const scheduleEmulatorAssetPrefetch = (options: ScheduleEmulatorAssetPrefetchOptions = {}): (() => void) => {
  const serviceWorker = (options.navigator ?? getGlobalNavigator())?.serviceWorker;
  if (!serviceWorker) return () => undefined;

  let cancelled = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fetchController: AbortController | undefined;

  const start = () => {
    if (cancelled || started || !serviceWorker.controller) return;
    started = true;
    serviceWorker.removeEventListener?.("controllerchange", start);
    timer = setTimeout(() => {
      if (cancelled) return;
      fetchController = new AbortController();
      void serviceWorker.ready
        .then((registration) =>
          prefetchEmulatorAssets(registration.scope, {
            fetch: options.fetch,
            signal: fetchController?.signal,
          }),
        )
        .catch(() => undefined);
    }, options.delayMs ?? EMULATOR_PREFETCH_DELAY_MS);
  };

  if (serviceWorker.controller) start();
  else serviceWorker.addEventListener?.("controllerchange", start);

  return () => {
    cancelled = true;
    if (timer !== undefined) clearTimeout(timer);
    fetchController?.abort();
    serviceWorker.removeEventListener?.("controllerchange", start);
  };
};

export { parseManifest, prefetchEmulatorAssets, scheduleEmulatorAssetPrefetch };
export type { EmulatorAssetManifest };
