import { hasMobileToken, isAppleTouchDesktop, isSafariBrowser } from "../platform/shared/webkit-runtime.ts";

type BrowserRuntimeFeatureProbe = {
  available: boolean;
  error?: string;
  ok?: boolean;
};

type BrowserRuntimeHeaderProbe = {
  crossOriginEmbedderPolicy: string | null;
  crossOriginOpenerPolicy: string | null;
  crossOriginResourcePolicy: string | null;
  error?: string;
};

type BrowserRuntimeStorageEstimate = {
  quota?: number;
  usage?: number;
  usageDetails?: Record<string, number>;
  error?: string;
};

type BrowserRuntimeDiagnostics = {
  atomicsWaitAsync: string;
  blobArrayBuffer: string;
  cacheStorage: string;
  crossOriginIsolated: boolean;
  deviceMemory: number | null;
  file: string;
  fileSystemFileHandle: string;
  fileSystemSyncAccessHandle: string;
  headers: BrowserRuntimeHeaderProbe | null;
  href: string;
  isSecureContext: boolean;
  maxTouchPoints: number;
  mobileSafariCandidate: boolean;
  opfs: BrowserRuntimeFeatureProbe;
  platform: string;
  serviceWorker: string;
  serviceWorkerController: boolean;
  sharedArrayBuffer: string;
  storageEstimate: BrowserRuntimeStorageEstimate | null;
  timestamp: string;
  userAgent: string;
  webAssembly: string;
  worker: string;
};

type BrowserRuntimeDiagnosticsApi = {
  collect: () => Promise<BrowserRuntimeDiagnostics>;
  copy: () => Promise<BrowserRuntimeDiagnostics>;
  log: () => Promise<BrowserRuntimeDiagnostics>;
};

const formatError = (error: unknown) => (error instanceof Error ? error.message : String(error));

const getNavigator = () => (typeof navigator === "object" ? navigator : null);

const isMobileSafariLike = (navigatorObject: Navigator | null) => {
  const environment = {
    maxTouchPoints: navigatorObject?.maxTouchPoints,
    platform: navigatorObject?.platform,
    userAgent: navigatorObject?.userAgent,
  };
  const isMobile = hasMobileToken(environment) || isAppleTouchDesktop(environment);
  return isSafariBrowser(environment) && isMobile;
};

const collectHeaders = async (): Promise<BrowserRuntimeHeaderProbe | null> => {
  if (typeof fetch !== "function" || typeof location !== "object") return null;
  try {
    const response = await fetch(location.href, { cache: "no-store", credentials: "same-origin" });
    return {
      crossOriginEmbedderPolicy: response.headers.get("Cross-Origin-Embedder-Policy"),
      crossOriginOpenerPolicy: response.headers.get("Cross-Origin-Opener-Policy"),
      crossOriginResourcePolicy: response.headers.get("Cross-Origin-Resource-Policy"),
    };
  } catch (error) {
    return {
      crossOriginEmbedderPolicy: null,
      crossOriginOpenerPolicy: null,
      crossOriginResourcePolicy: null,
      error: formatError(error),
    };
  }
};

const collectOpfsProbe = async (navigatorObject: Navigator | null): Promise<BrowserRuntimeFeatureProbe> => {
  const storage = navigatorObject?.storage;
  if (!storage || typeof storage.getDirectory !== "function") return { available: false };
  try {
    await storage.getDirectory();
    return { available: true, ok: true };
  } catch (error) {
    return { available: true, error: formatError(error), ok: false };
  }
};

const collectStorageEstimate = async (
  navigatorObject: Navigator | null,
): Promise<BrowserRuntimeStorageEstimate | null> => {
  const storage = navigatorObject?.storage;
  if (!storage || typeof storage.estimate !== "function") return null;
  try {
    const estimate = await storage.estimate();
    const usageDetails = (estimate as StorageEstimate & { usageDetails?: Record<string, unknown> }).usageDetails;
    return {
      quota: estimate.quota,
      usage: estimate.usage,
      usageDetails: usageDetails
        ? Object.fromEntries(Object.entries(usageDetails).map(([key, value]) => [key, Number(value)]))
        : undefined,
    };
  } catch (error) {
    return { error: formatError(error) };
  }
};

const collectBrowserRuntimeDiagnostics = async (): Promise<BrowserRuntimeDiagnostics> => {
  const navigatorObject = getNavigator();
  const storageEstimatePromise = collectStorageEstimate(navigatorObject);
  const opfsPromise = collectOpfsProbe(navigatorObject);
  const headersPromise = collectHeaders();

  return {
    atomicsWaitAsync: typeof Atomics === "object" ? typeof Atomics.waitAsync : "undefined",
    blobArrayBuffer: typeof Blob === "function" ? typeof Blob.prototype.arrayBuffer : "undefined",
    cacheStorage: typeof caches,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
    deviceMemory:
      typeof navigatorObject?.deviceMemory === "number" && Number.isFinite(navigatorObject.deviceMemory)
        ? navigatorObject.deviceMemory
        : null,
    file: typeof File,
    fileSystemFileHandle: typeof FileSystemFileHandle,
    fileSystemSyncAccessHandle: typeof FileSystemSyncAccessHandle,
    headers: await headersPromise,
    href: typeof location === "object" ? location.href : "",
    isSecureContext: globalThis.isSecureContext === true,
    maxTouchPoints: typeof navigatorObject?.maxTouchPoints === "number" ? navigatorObject.maxTouchPoints : 0,
    mobileSafariCandidate: isMobileSafariLike(navigatorObject),
    opfs: await opfsPromise,
    platform: navigatorObject?.platform || "",
    serviceWorker: typeof navigatorObject?.serviceWorker,
    serviceWorkerController: !!navigatorObject?.serviceWorker?.controller,
    sharedArrayBuffer: typeof SharedArrayBuffer,
    storageEstimate: await storageEstimatePromise,
    timestamp: new Date().toISOString(),
    userAgent: navigatorObject?.userAgent || "",
    webAssembly: typeof WebAssembly,
    worker: typeof Worker,
  };
};

const diagnosticsApi: BrowserRuntimeDiagnosticsApi = {
  collect: collectBrowserRuntimeDiagnostics,
  copy: async () => {
    const diagnostics = await collectBrowserRuntimeDiagnostics();
    const text = JSON.stringify(diagnostics, null, 2);
    const navigatorObject = getNavigator();
    if (navigatorObject?.clipboard?.writeText) await navigatorObject.clipboard.writeText(text);
    else console.info(text);
    return diagnostics;
  },
  log: async () => {
    const diagnostics = await collectBrowserRuntimeDiagnostics();
    console.info("RomWeaver browser runtime diagnostics", diagnostics);
    return diagnostics;
  },
};

if (typeof window === "object") {
  window.ROM_WEAVER_BROWSER_DIAGNOSTICS = diagnosticsApi;
  window.ROM_WEAVER_MOBILE_SAFARI_DIAGNOSTICS = diagnosticsApi;
}

export { type BrowserRuntimeDiagnostics, collectBrowserRuntimeDiagnostics };
