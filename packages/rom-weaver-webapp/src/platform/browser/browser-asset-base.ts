type BrowserAssetRoot = typeof globalThis & {
  __romWeaverWorkerBaseUrl?: string;
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
  } catch {
    return null;
  }
};

const configureBrowserAssetBaseUrl = (assetBaseUrl?: string) => {
  const normalized = normalizeAssetBaseUrl(assetBaseUrl);
  if (!normalized) return;
  const root = globalThis as BrowserAssetRoot;
  root.__romWeaverWorkerBaseUrl = normalized;
};

export { configureBrowserAssetBaseUrl };
