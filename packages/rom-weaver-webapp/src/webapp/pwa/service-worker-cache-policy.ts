type ServiceWorkerCachePolicy = {
  activeCacheNames: readonly string[];
  emulatorJsCacheName: string;
  emulatorJsCachePrefix: string;
  managedCachePrefix: string;
};

const createServiceWorkerCachePolicy = ({
  emulatorJsCacheName,
  emulatorJsCachePrefix,
  identifyOptionalCacheName,
  managedCachePrefix,
  precacheName,
  runtimeCacheName,
}: {
  emulatorJsCacheName: string;
  emulatorJsCachePrefix: string;
  identifyOptionalCacheName: string;
  managedCachePrefix: string;
  precacheName: string;
  runtimeCacheName: string;
}): ServiceWorkerCachePolicy => ({
  activeCacheNames: [precacheName, runtimeCacheName, emulatorJsCacheName, identifyOptionalCacheName],
  emulatorJsCacheName,
  emulatorJsCachePrefix,
  managedCachePrefix,
});

const findStaleServiceWorkerCaches = (
  cacheNames: readonly string[],
  { activeCacheNames, emulatorJsCacheName, emulatorJsCachePrefix, managedCachePrefix }: ServiceWorkerCachePolicy,
) => {
  const active = new Set(activeCacheNames);
  return cacheNames.filter((cacheName) => {
    if (cacheName.startsWith(emulatorJsCachePrefix)) return cacheName !== emulatorJsCacheName;
    return cacheName.startsWith(managedCachePrefix) && !active.has(cacheName);
  });
};

export { createServiceWorkerCachePolicy, findStaleServiceWorkerCaches };
