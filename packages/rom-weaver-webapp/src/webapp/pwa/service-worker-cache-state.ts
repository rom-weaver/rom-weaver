const DEFAULT_CACHE_TITLE = "Loaded service worker cache version";
const DEFAULT_UPDATE_LABEL = "Reload to update";

type ServiceWorkerCacheState = {
  label: string;
  serviceWorkerStatus: ServiceWorkerStatus | null;
  title: string;
  updateLabel: string;
  updateReady: boolean;
};

type ServiceWorkerStatus = "active" | "ready" | "off";

const createServiceWorkerCacheState = (): ServiceWorkerCacheState => ({
  label: "cache ...",
  serviceWorkerStatus: null,
  title: DEFAULT_CACHE_TITLE,
  updateLabel: DEFAULT_UPDATE_LABEL,
  updateReady: false,
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

const withDeferredServiceWorkerUpdate = (state: ServiceWorkerCacheState): ServiceWorkerCacheState => ({
  ...state,
  updateLabel: DEFAULT_UPDATE_LABEL,
  updateReady: true,
});

const withoutDeferredServiceWorkerUpdate = (state: ServiceWorkerCacheState): ServiceWorkerCacheState => ({
  ...state,
  updateReady: false,
});

export {
  createServiceWorkerCacheState,
  type ServiceWorkerCacheState,
  type ServiceWorkerStatus,
  setServiceWorkerCacheVersion,
  withDeferredServiceWorkerUpdate,
  withoutDeferredServiceWorkerUpdate,
};
