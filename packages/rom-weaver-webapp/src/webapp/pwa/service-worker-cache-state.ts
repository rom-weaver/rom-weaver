const DEFAULT_CACHE_TITLE = "Loaded service worker cache version";
const DEFAULT_UPDATE_LABEL = "Reload to update";
const DEFAULT_UPDATE_TITLE = "A newer app version is ready. Reload when you are ready to switch to it.";

type ServiceWorkerCacheState = {
  label: string;
  offlineReady: boolean | null;
  serviceWorkerControlled: boolean | null;
  title: string;
  updateLabel: string;
  updateReady: boolean;
  updateTitle: string;
};

const createServiceWorkerCacheState = (): ServiceWorkerCacheState => ({
  label: "cache ...",
  offlineReady: null,
  serviceWorkerControlled: null,
  title: DEFAULT_CACHE_TITLE,
  updateLabel: DEFAULT_UPDATE_LABEL,
  updateReady: false,
  updateTitle: DEFAULT_UPDATE_TITLE,
});

const setServiceWorkerCacheVersion = (
  state: ServiceWorkerCacheState,
  version: string,
  title?: string,
  offlineReady = false,
  serviceWorkerControlled = state.serviceWorkerControlled,
): ServiceWorkerCacheState => ({
  ...state,
  label: `cache ${version}`,
  offlineReady,
  serviceWorkerControlled,
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
