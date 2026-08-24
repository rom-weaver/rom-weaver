/**
 * Verified-pack storage for the identify database manager. Downloads land here
 * only AFTER their SHA-256 matched the catalog, so a failed download or a
 * failed verification can never evict a previously good pack - the store is
 * written on success alone, and a superseded entry for the same file is
 * dropped only after its replacement is stored.
 *
 * The default store is the Cache API (same storage class the service worker's
 * runtime identify cache uses); environments without `caches` fall back to an
 * in-memory store, which tests also inject directly.
 */
type StoredIdentifyPack = {
  bytes: ArrayBuffer;
  fileName: string;
  sha256: string;
};

type IdentifyPackStore = {
  delete: (fileName: string) => Promise<void>;
  get: (fileName: string) => Promise<StoredIdentifyPack | undefined>;
  keys: () => Promise<Array<{ fileName: string; sha256: string }>>;
  put: (fileName: string, sha256: string, bytes: ArrayBuffer) => Promise<void>;
};

const PACK_STORE_CACHE_NAME = "rom-weaver-identify-db-v1";
/** Synthetic same-origin path prefix; these entries never collide with real asset URLs. */
const PACK_STORE_PATH_PREFIX = "/__rom-weaver-identify-db__/";

const createMemoryIdentifyPackStore = (): IdentifyPackStore => {
  const entries = new Map<string, StoredIdentifyPack>();
  return {
    delete: async (fileName) => {
      entries.delete(fileName);
    },
    get: async (fileName) => entries.get(fileName),
    keys: async () => [...entries.values()].map(({ fileName, sha256 }) => ({ fileName, sha256 })),
    put: async (fileName, sha256, bytes) => {
      entries.set(fileName, { bytes, fileName, sha256 });
    },
  };
};

const packRequestUrl = (fileName: string, sha256: string): string => {
  const url = new URL(`${PACK_STORE_PATH_PREFIX}${encodeURIComponent(fileName)}`, globalThis.location?.origin);
  if (sha256) url.searchParams.set("sha256", sha256);
  return url.href;
};

const parsePackRequestUrl = (href: string): { fileName: string; sha256: string } | undefined => {
  const url = new URL(href);
  if (!url.pathname.startsWith(PACK_STORE_PATH_PREFIX)) return undefined;
  const fileName = decodeURIComponent(url.pathname.slice(PACK_STORE_PATH_PREFIX.length));
  return fileName ? { fileName, sha256: url.searchParams.get("sha256") || "" } : undefined;
};

const createCacheIdentifyPackStore = (): IdentifyPackStore => ({
  delete: async (fileName) => {
    const cache = await caches.open(PACK_STORE_CACHE_NAME);
    for (const key of await cache.keys()) {
      if (parsePackRequestUrl(key.url)?.fileName === fileName) await cache.delete(key);
    }
  },
  get: async (fileName) => {
    const cache = await caches.open(PACK_STORE_CACHE_NAME);
    for (const key of await cache.keys()) {
      const parsed = parsePackRequestUrl(key.url);
      if (parsed?.fileName !== fileName) continue;
      const response = await cache.match(key);
      if (!response) continue;
      return { bytes: await response.arrayBuffer(), fileName, sha256: parsed.sha256 };
    }
    return undefined;
  },
  keys: async () => {
    const cache = await caches.open(PACK_STORE_CACHE_NAME);
    const keys: Array<{ fileName: string; sha256: string }> = [];
    for (const key of await cache.keys()) {
      const parsed = parsePackRequestUrl(key.url);
      if (parsed) keys.push(parsed);
    }
    return keys;
  },
  put: async (fileName, sha256, bytes) => {
    const cache = await caches.open(PACK_STORE_CACHE_NAME);
    await cache.put(
      new Request(packRequestUrl(fileName, sha256)),
      new Response(bytes.slice(0), { headers: { "content-type": "application/octet-stream" } }),
    );
    // Drop the superseded entry for the same file only after the new one is stored.
    for (const key of await cache.keys()) {
      const parsed = parsePackRequestUrl(key.url);
      if (parsed?.fileName === fileName && parsed.sha256 !== sha256) await cache.delete(key);
    }
  },
});

let defaultStore: IdentifyPackStore | undefined;

const getDefaultIdentifyPackStore = (): IdentifyPackStore => {
  if (!defaultStore) {
    defaultStore = typeof caches === "undefined" ? createMemoryIdentifyPackStore() : createCacheIdentifyPackStore();
  }
  return defaultStore;
};

/** Test hook: replace the default store (pass `undefined` to restore auto-detection). */
const setDefaultIdentifyPackStore = (store: IdentifyPackStore | undefined) => {
  defaultStore = store;
};

/**
 * Remove a pack's runtime-cache copies from every service-worker identify
 * cache too, so "Remove" leaves nothing the next fetch would resurrect.
 */
const deleteIdentifyPackFromRuntimeCaches = async (fileName: string) => {
  if (typeof caches === "undefined") return;
  for (const cacheName of await caches.keys()) {
    if (!cacheName.includes("-identify-")) continue;
    const cache = await caches.open(cacheName);
    for (const key of await cache.keys()) {
      const pathname = new URL(key.url).pathname;
      if (pathname.endsWith(`/assets/identify-${fileName}`) || pathname.endsWith(`/${fileName}`)) {
        await cache.delete(key);
      }
    }
  }
};

export {
  createMemoryIdentifyPackStore,
  deleteIdentifyPackFromRuntimeCaches,
  getDefaultIdentifyPackStore,
  setDefaultIdentifyPackStore,
};
export type { IdentifyPackStore };
