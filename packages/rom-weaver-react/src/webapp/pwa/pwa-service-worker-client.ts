import { registerSW } from "virtual:pwa-register";
import type { RegisterSWOptions } from "vite-plugin-pwa/types";

import {
  createServiceWorkerCacheState,
  type ServiceWorkerCacheState,
  setServiceWorkerCacheVersion,
  withDeferredServiceWorkerUpdate,
  withoutDeferredServiceWorkerUpdate,
} from "./service-worker-cache-state.ts";

type ServiceWorkerRegistrationLike = Pick<
  ServiceWorkerRegistration,
  "scope" | "active" | "waiting" | "installing" | "unregister" | "update"
>;
type ServiceWorkerContainerLike = Pick<ServiceWorkerContainer, "controller" | "getRegistrations"> &
  Pick<EventTarget, "addEventListener">;
type NavigatorLike = {
  serviceWorker?: ServiceWorkerContainerLike;
};
type CacheStorageLike = Pick<CacheStorage, "keys" | "delete">;
type SessionStorageLike = Pick<Storage, "getItem" | "removeItem" | "setItem">;
type WindowLike = Pick<Window, "location" | "addEventListener" | "setInterval" | "clearInterval"> & {
  crossOriginIsolated?: boolean;
};
type DocumentLike = Pick<Document, "addEventListener" | "visibilityState">;
type RegisterServiceWorker = typeof registerSW;

type CreatePwaServiceWorkerClientOptions = {
  cachePrefix: string;
  cacheVersionTimeoutMs: number;
  document: DocumentLike | undefined;
  enabled: boolean;
  navigator: NavigatorLike | undefined;
  onBeforeReload?: () => void;
  onConfirmReload: () => Promise<boolean>;
  onStateChange: (state: ServiceWorkerCacheState) => void;
  registerServiceWorker?: RegisterServiceWorker;
  sessionStorage?: SessionStorageLike | undefined;
  updateIntervalMs: number;
  window: WindowLike | undefined;
};

type PwaServiceWorkerClient = {
  getState: () => ServiceWorkerCacheState;
  initialize: () => void;
  reloadPendingUpdate: () => Promise<boolean>;
  refreshCacheVersion: () => void;
};

const ROM_WEAVER_SERVICE_WORKER_URL_PATTERN = /\/(?:_cache_service_worker|cache-service-worker|dev-sw)\.js(?:$|\?)/;
const COI_COEP_CREDENTIALLESS_ACTION = "set-coep-credentialless";
const COI_COEP_HAS_FAILED_KEY = "rom-weaver-coi-coep-has-failed";
const COI_RELOADED_BY_SELF_KEY = "rom-weaver-coi-reloaded-by-self";
const COI_RELOAD_REASON_COEP_DEGRADE = "coepdegrade";
const COI_RELOAD_REASON_NOT_CONTROLLING = "notcontrolling";

const createPwaServiceWorkerClient = ({
  cachePrefix,
  cacheVersionTimeoutMs,
  document,
  enabled,
  navigator,
  onBeforeReload,
  onConfirmReload,
  onStateChange,
  registerServiceWorker: registerServiceWorkerOverride,
  sessionStorage: sessionStorageOverride,
  updateIntervalMs,
  window,
}: CreatePwaServiceWorkerClientOptions): PwaServiceWorkerClient => {
  const registerServiceWorker = registerServiceWorkerOverride ?? registerSW;
  const sessionStorage = sessionStorageOverride;
  let initialized = false;
  let state = createServiceWorkerCacheState();
  let updateServiceWorker: ReturnType<RegisterServiceWorker> | null = null;
  let serviceWorkerRegistration: ServiceWorkerRegistrationLike | undefined;
  let updateIntervalId: number | null = null;

  const setSessionStorageItem = (key: string, value: string) => {
    try {
      sessionStorage?.setItem(key, value);
    } catch (_err) {
      // session storage is best-effort
    }
  };
  const getSessionStorageItem = (key: string) => {
    try {
      return sessionStorage?.getItem(key) || "";
    } catch (_err) {
      return "";
    }
  };
  const removeSessionStorageItem = (key: string) => {
    try {
      sessionStorage?.removeItem(key);
    } catch (_err) {
      // session storage is best-effort
    }
  };
  const takeReloadReason = () => {
    const reason = getSessionStorageItem(COI_RELOADED_BY_SELF_KEY);
    if (reason) removeSessionStorageItem(COI_RELOADED_BY_SELF_KEY);
    return reason;
  };
  const isCrossOriginIsolationKnown = () => typeof window?.crossOriginIsolated === "boolean";
  const isCrossOriginIsolated = () => window?.crossOriginIsolated === true;
  const reloadForCrossOriginIsolation = (reason: string) => {
    if (!window?.location || typeof window.location.reload !== "function") return false;
    setSessionStorageItem(COI_RELOADED_BY_SELF_KEY, reason);
    window.location.reload();
    return true;
  };
  const postCoepCredentialless = (value: boolean) => {
    const controller = navigator?.serviceWorker?.controller;
    if (!controller) return false;
    try {
      controller.postMessage({
        action: COI_COEP_CREDENTIALLESS_ACTION,
        value,
      });
      return true;
    } catch (_err) {
      return false;
    }
  };
  let pendingReloadReason = takeReloadReason();
  const syncCrossOriginIsolationMode = ({ allowReload }: { allowReload: boolean }) => {
    if (!(navigator?.serviceWorker?.controller && isCrossOriginIsolationKnown())) return;
    if (!isCrossOriginIsolated()) setSessionStorageItem(COI_COEP_HAS_FAILED_KEY, "true");
    const coepHasFailed = getSessionStorageItem(COI_COEP_HAS_FAILED_KEY) === "true";
    const reloadedBySelf = pendingReloadReason;
    pendingReloadReason = "";
    const coepDegrading = reloadedBySelf === COI_RELOAD_REASON_COEP_DEGRADE;
    const reloadToDegrade = allowReload && !coepDegrading && !isCrossOriginIsolated();
    const useCredentialless = !(reloadToDegrade || coepHasFailed);
    postCoepCredentialless(useCredentialless);
    if (reloadToDegrade) reloadForCrossOriginIsolation(COI_RELOAD_REASON_COEP_DEGRADE);
  };

  const emitState = () => {
    onStateChange(state);
  };
  const setVersion = (version: string, title?: string) => {
    state = setServiceWorkerCacheVersion(state, version, title);
    emitState();
  };
  const markUpdateReady = () => {
    state = withDeferredServiceWorkerUpdate(state);
    emitState();
  };
  const clearUpdateReady = () => {
    state = withoutDeferredServiceWorkerUpdate(state);
    emitState();
  };

  const refreshCacheVersion = () => {
    if (!enabled) {
      setVersion("off", "Service worker cache is disabled");
      return;
    }
    const serviceWorker = navigator?.serviceWorker;
    if (!serviceWorker) {
      setVersion("off", "Service worker is not available in this browser");
      return;
    }
    const controller = serviceWorker.controller;
    if (!controller) {
      setVersion("network", "This page is not controlled by a service worker");
      return;
    }
    if (typeof MessageChannel !== "function") {
      setVersion("unknown", "This browser cannot query the loaded service worker cache version");
      return;
    }

    const channel = new MessageChannel();
    let complete = false;
    const finish = (version?: string, title?: string) => {
      if (complete) return;
      complete = true;
      clearTimeout(timeout);
      channel.port1.onmessage = null;
      try {
        channel.port1.close();
      } catch (_err) {
        // best-effort cleanup
      }
      try {
        channel.port2.close();
      } catch (_err) {
        // best-effort cleanup
      }
      setVersion(version || "unknown", title);
    };
    const timeout = setTimeout(() => {
      finish("unknown", "The loaded service worker did not report a cache version");
    }, cacheVersionTimeoutMs);
    channel.port1.onmessage = (event) => {
      const data = event.data || {};
      finish(
        typeof data.precacheVersion === "string" ? data.precacheVersion : undefined,
        `Loaded service worker cache: ${data.precacheName || data.precacheVersion || "unknown"}`,
      );
    };

    try {
      controller.postMessage({ action: "get-service-worker-cache-version" }, [channel.port2]);
    } catch (_err) {
      finish("unknown", "Could not query the loaded service worker cache version");
    }
  };
  const runServiceWorkerUpdateCheck = () => {
    void serviceWorkerRegistration?.update?.().catch(() => undefined);
  };
  const startServiceWorkerUpdateChecks = () => {
    if (!window || updateIntervalId !== null) return;
    updateIntervalId = window.setInterval(runServiceWorkerUpdateCheck, updateIntervalMs);
  };
  const stopServiceWorkerUpdateChecks = () => {
    if (!window || updateIntervalId === null) return;
    window.clearInterval(updateIntervalId);
    updateIntervalId = null;
  };

  const isRomWeaverServiceWorkerRegistration = (
    registration: ServiceWorkerRegistrationLike,
    expectedScope: string,
  ): boolean => {
    const workers = [registration.active, registration.waiting, registration.installing];
    for (const worker of workers) {
      if (worker && ROM_WEAVER_SERVICE_WORKER_URL_PATTERN.test(worker.scriptURL)) return true;
    }
    return registration.scope === expectedScope;
  };

  const deleteServiceWorkerCaches = async () => {
    const cacheStorage = typeof caches === "undefined" ? null : (caches as CacheStorageLike);
    if (!cacheStorage) return;
    const cacheNames = await cacheStorage.keys();
    await Promise.all(
      cacheNames
        .filter((cacheName) => cacheName.indexOf(cachePrefix) === 0)
        .map((cacheName) => cacheStorage.delete(cacheName)),
    );
  };

  const disableServiceWorkerCache = () => {
    setVersion("off", "Service worker cache is disabled");
    const serviceWorker = navigator?.serviceWorker;
    if (!(serviceWorker && window?.location)) {
      void deleteServiceWorkerCaches().catch(() => undefined);
      return;
    }

    const expectedScope = new URL("./", window.location.href).href;
    void serviceWorker
      .getRegistrations()
      .then((registrations) =>
        Promise.all(
          registrations
            .filter((registration) => isRomWeaverServiceWorkerRegistration(registration, expectedScope))
            .map((registration) => registration.unregister()),
        ),
      )
      .then(deleteServiceWorkerCaches)
      .then(() => {
        setVersion("off", "Service worker cache is disabled");
      })
      .catch(() => {
        setVersion("off", "Service worker cache is disabled");
      });
  };
  const reloadPendingUpdate = async (): Promise<boolean> => {
    if (!(state.updateReady && updateServiceWorker)) return false;
    if (!(await onConfirmReload())) return false;
    clearUpdateReady();
    onBeforeReload?.();
    await updateServiceWorker(true);
    return true;
  };

  const initialize = () => {
    if (initialized) return;
    initialized = true;

    if (!enabled) {
      disableServiceWorkerCache();
      return;
    }

    const serviceWorker = navigator?.serviceWorker;
    if (!serviceWorker) {
      refreshCacheVersion();
      return;
    }

    serviceWorker.addEventListener("controllerchange", () => {
      clearUpdateReady();
      syncCrossOriginIsolationMode({ allowReload: true });
      refreshCacheVersion();
    });
    window?.addEventListener("beforeunload", stopServiceWorkerUpdateChecks);
    window?.addEventListener("focus", runServiceWorkerUpdateCheck);
    window?.addEventListener("online", runServiceWorkerUpdateCheck);
    document?.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") runServiceWorkerUpdateCheck();
    });

    updateServiceWorker = registerServiceWorker({
      immediate: true,
      onNeedRefresh: markUpdateReady,
      onOfflineReady: refreshCacheVersion,
      onRegisterError: () => {
        refreshCacheVersion();
      },
      onRegisteredSW: (
        _swScriptUrl: string,
        registration: Parameters<NonNullable<RegisterSWOptions["onRegisteredSW"]>>[1],
      ) => {
        serviceWorkerRegistration = registration as ServiceWorkerRegistrationLike | undefined;
        if (!registration) {
          refreshCacheVersion();
          return;
        }
        void registration.update?.().catch(() => undefined);
        if (!serviceWorker.controller) {
          if (pendingReloadReason !== COI_RELOAD_REASON_NOT_CONTROLLING)
            reloadForCrossOriginIsolation(COI_RELOAD_REASON_NOT_CONTROLLING);
          return;
        }
        syncCrossOriginIsolationMode({ allowReload: true });
        startServiceWorkerUpdateChecks();
        refreshCacheVersion();
      },
    });

    syncCrossOriginIsolationMode({ allowReload: false });
    refreshCacheVersion();
  };

  return {
    getState: () => state,
    initialize,
    refreshCacheVersion,
    reloadPendingUpdate,
  };
};

export { createPwaServiceWorkerClient, type PwaServiceWorkerClient };
