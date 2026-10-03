type DocsImageFormat = "avif" | "webp";

const AVIF_PROBE =
  "data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAABsAAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAEAAAABAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQAMAAAAABNjb2xybmNseAACAAIABoAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAACNtZGF0EgAKCBgABggQEDQgMg0TQAIIIIQAAGjSFMWA";

// The probe MUST use the page's decoder, which also selects <picture> sources.
const detectDocsImageFormat = (): Promise<DocsImageFormat> =>
  new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth === 1 ? "avif" : "webp");
    image.onerror = () => resolve("webp");
    image.src = AVIF_PROBE;
  });

const createDocsImagePolicy = (cacheName: string, scope: string) => {
  const preferenceUrl = new URL("__rom-weaver-docs-image-format__", scope).href;
  let formatPromise: Promise<DocsImageFormat | null> | null = null;
  const hydrate = () => {
    formatPromise ??= caches.open(cacheName).then(async (cache) => {
      const response = await cache.match(preferenceUrl);
      const format = response ? await response.text() : null;
      return format === "avif" || format === "webp" ? format : null;
    });
    return formatPromise;
  };

  const setFormat = (format: DocsImageFormat) => {
    let changed = false;
    formatPromise = hydrate().then(async (previous) => {
      changed = previous !== format;
      if (changed) await (await caches.open(cacheName)).put(preferenceUrl, new Response(format));
      return format;
    });
    return formatPromise.then(() => changed);
  };

  const selectEntries = async <T extends { url: string }>(entries: readonly T[]): Promise<readonly T[]> => {
    const format = await hydrate();
    if (!format) return entries;
    const urls = new Set(entries.map((entry) => entry.url));
    return entries.filter(({ url }) => {
      const match = /^docs\/screenshots\/(.+)\.(avif|webp)$/u.exec(url);
      if (!match || match[2] === format) return true;
      return !urls.has(`docs/screenshots/${match[1]}.${format}`);
    });
  };

  return { selectEntries, setFormat };
};

export { createDocsImagePolicy, detectDocsImageFormat };
