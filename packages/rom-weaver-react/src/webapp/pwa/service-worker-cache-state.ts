const DEFAULT_CACHE_TITLE = "Loaded service worker cache version";
const DEFAULT_UPDATE_LABEL = "Reload to update";
const DEFAULT_UPDATE_TITLE = "A newer app version is ready. Reload when you are ready to switch to it.";

type ServiceWorkerCacheState = {
  label: string;
  title: string;
  updateLabel: string;
  updateReady: boolean;
  updateTitle: string;
};

const createServiceWorkerCacheState = (): ServiceWorkerCacheState => ({
  label: "cache ...",
  title: DEFAULT_CACHE_TITLE,
  updateLabel: DEFAULT_UPDATE_LABEL,
  updateReady: false,
  updateTitle: DEFAULT_UPDATE_TITLE,
});

const setServiceWorkerCacheVersion = (
  state: ServiceWorkerCacheState,
  version: string,
  title?: string,
): ServiceWorkerCacheState => ({
  ...state,
  label: `cache ${version}`,
  title: title || DEFAULT_CACHE_TITLE,
});

const withDeferredServiceWorkerUpdate = (state: ServiceWorkerCacheState): ServiceWorkerCacheState => ({
  ...state,
  updateLabel: DEFAULT_UPDATE_LABEL,
  updateReady: true,
  updateTitle: DEFAULT_UPDATE_TITLE,
});

const withoutDeferredServiceWorkerUpdate = (state: ServiceWorkerCacheState): ServiceWorkerCacheState => ({
  ...state,
  updateReady: false,
});

export {
  createServiceWorkerCacheState,
  type ServiceWorkerCacheState,
  setServiceWorkerCacheVersion,
  withDeferredServiceWorkerUpdate,
  withoutDeferredServiceWorkerUpdate,
};
