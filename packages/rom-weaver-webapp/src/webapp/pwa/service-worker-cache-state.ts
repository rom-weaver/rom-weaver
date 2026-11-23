const DEFAULT_CACHE_TITLE = "Loaded service worker cache version";

type ServiceWorkerCacheState = {
  label: string;
  serviceWorkerStatus: ServiceWorkerStatus | null;
  title: string;
};

type ServiceWorkerStatus = "active" | "ready" | "off";

const createServiceWorkerCacheState = (): ServiceWorkerCacheState => ({
  label: "cache ...",
  serviceWorkerStatus: null,
  title: DEFAULT_CACHE_TITLE,
});

const setServiceWorkerCacheVersion = (
  state: ServiceWorkerCacheState,
  version: string,
  title?: string,
  serviceWorkerStatus = state.serviceWorkerStatus,
): ServiceWorkerCacheState => ({
  ...state,
  label: `cache ${version}`,
  serviceWorkerStatus,
  title: title || DEFAULT_CACHE_TITLE,
});

export {
  createServiceWorkerCacheState,
  type ServiceWorkerCacheState,
  type ServiceWorkerStatus,
  setServiceWorkerCacheVersion,
};
