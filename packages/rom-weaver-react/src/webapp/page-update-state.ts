import type { ServiceWorkerCacheState } from "./pwa/service-worker-cache-state.ts";

const PAGE_UPDATE_TITLE = "A newer app version is ready.";
const PAGE_UPDATE_LABEL = "Reload to update";

type PageUpdateSource = "service-worker" | "vite";

type PageUpdateState = {
  ready: boolean;
  label: string;
  title: string;
  source: PageUpdateSource | null;
};

type VitePageUpdateState = {
  ready: boolean;
  versionLabel: string;
};

type ViteReloadAvailablePayload = {
  label?: unknown;
  source?: unknown;
};

const createEmptyPageUpdateState = (): PageUpdateState => ({
  label: PAGE_UPDATE_LABEL,
  ready: false,
  source: null,
  title: PAGE_UPDATE_TITLE,
});

const createEmptyVitePageUpdateState = (): VitePageUpdateState => ({
  ready: false,
  versionLabel: "",
});

const createVitePageUpdateState = (payload?: ViteReloadAvailablePayload): VitePageUpdateState => ({
  ready: true,
  versionLabel: typeof payload?.label === "string" ? payload.label : "",
});

const createReadyPageUpdateState = (source: PageUpdateSource): PageUpdateState => ({
  ...createEmptyPageUpdateState(),
  ready: true,
  source,
});

const getPageUpdateState = ({
  serviceWorkerCache,
  vite,
}: {
  serviceWorkerCache: Pick<ServiceWorkerCacheState, "updateReady">;
  vite: VitePageUpdateState;
}): PageUpdateState => {
  if (serviceWorkerCache.updateReady) return createReadyPageUpdateState("service-worker");
  if (vite.ready) return createReadyPageUpdateState("vite");
  return createEmptyPageUpdateState();
};

export {
  createEmptyPageUpdateState,
  createEmptyVitePageUpdateState,
  createVitePageUpdateState,
  getPageUpdateState,
  type PageUpdateState,
};
