type BrowserAssetRoot = typeof globalThis & {
  __azaharZ3dsWasmBaseUrl?: string;
  __chdmanWasmBaseUrl?: string;
  __dolphinRvzWasmBaseUrl?: string;
  __romWeaverSevenZipZstdWasmBaseUrl?: string;
  __romWeaverWorkerBaseUrl?: string;
  __xdelta3WasmBaseUrl?: string;
};

const normalizeAssetBaseUrl = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const base =
      typeof document !== "undefined" && typeof document.baseURI === "string" && document.baseURI
        ? document.baseURI
        : typeof location !== "undefined" && typeof location.href === "string" && location.href
          ? location.href
          : "https://rom-weaver.local/";
    const normalized = new URL(trimmed, base).href;
    return normalized.endsWith("/") ? normalized : `${normalized}/`;
  } catch (_error) {
    return null;
  }
};

const configureBrowserAssetBaseUrl = (assetBaseUrl?: string) => {
  const normalized = normalizeAssetBaseUrl(assetBaseUrl);
  if (!normalized) return;
  const root = globalThis as BrowserAssetRoot;
  root.__romWeaverWorkerBaseUrl = normalized;
  root.__romWeaverSevenZipZstdWasmBaseUrl = normalized;
  root.__xdelta3WasmBaseUrl = normalized;
  root.__dolphinRvzWasmBaseUrl = normalized;
  root.__chdmanWasmBaseUrl = normalized;
  root.__azaharZ3dsWasmBaseUrl = normalized;
};

export { configureBrowserAssetBaseUrl };
