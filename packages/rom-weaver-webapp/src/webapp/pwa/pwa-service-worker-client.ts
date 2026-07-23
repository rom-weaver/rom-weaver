import { registerSW } from "virtual:pwa-register";
import type { RegisterSWOptions } from "vite-plugin-pwa/types";
import { createLogger } from "../../lib/logging.ts";

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
type ServiceWorkerContainerLike = Pick<ServiceWorkerContainer, "controller" | "getRegistrations" | "ready"> &
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
  appVersion: string;
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
  // Return true to apply an update as soon as it's detected instead of prompting. Called when an update
  // is detected, while there's no in-progress work. Applied silently (skipWaiting, no reload) when the
  // page already runs the incoming version, or with a reload when the running code is the outgoing
  // controller's (see the appVersion comparison in onNeedRefresh).
  shouldAutoApplyUpdate?: () => boolean;
  updateIntervalMs: number;
  window: WindowLike | undefined;
};

type PwaServiceWorkerClient = {
  forceCacheAndReload: () => Promise<boolean>;
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
const logger = createLogger("rom-weaver-sw-client");
const SERVICE_WORKER_READY_TIMEOUT_MS = 8000;
// Per-tab-session budget on unattended auto-applies. Prompt mode had the user as the circuit breaker;
// auto-apply needs its own so a deploy that ever serves a byte-varying worker cannot churn skipWaiting
// on an idle tab endlessly. Past the budget we fall back to the manual update prompt. sessionStorage
// clears on tab close, so this resets naturally per browsing session.
const AUTO_APPLY_RELOAD_COUNT_KEY = "rom-weaver-sw-auto-apply-reloads";
const AUTO_APPLY_RELOAD_BUDGET = 3;

const logServiceWorkerClient = (message: string, details?: Record<string, unknown>) => {
  logger.info(message, details);
};

const formatError = (error: unknown) => {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
};

const isCertificateRegistrationError = (error: unknown) =>
  /certificate|ssl|tls/i.test(error instanceof Error ? `${error.name} ${error.message}` : String(error));

const describeWorker = (worker: ServiceWorker | null) =>
  worker
    ? {
        scriptURL: worker.scriptURL,
        state: worker.state,
      }
    : null;

const describeRegistration = (registration: ServiceWorkerRegistrationLike | null | undefined) =>
  registration
    ? {
        active: describeWorker(registration.active),
        installing: describeWorker(registration.installing),
        scope: registration.scope,
        waiting: describeWorker(registration.waiting),
      }
    : null;

const createPwaServiceWorkerClient = ({
  appVersion,
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
  shouldAutoApplyUpdate,
  updateIntervalMs,
  window,
}: CreatePwaServiceWorkerClientOptions): PwaServiceWorkerClient => {
  const registerServiceWorker = registerServiceWorkerOverride ?? registerSW;
  const sessionStorage = sessionStorageOverride;
  let initialized = false;
  let state = createServiceWorkerCacheState();
  // Raw version last reported by the controlling worker (or a sentinel like "network"/"unknown"). Used
  // to decide whether an auto-applied update needs a reload; state itself only keeps a display label.
  let controllerVersion = "";
  let updateServiceWorker: ReturnType<RegisterServiceWorker> | null = null;
  let serviceWorkerRegistration: ServiceWorkerRegistrationLike | undefined;
  let updateIntervalId: number | null = null;
  let reloadForControlPending = false;

  const setSessionStorageItem = (key: string, value: string) => {
    try {
      sessionStorage?.setItem(key, value);
    } catch {
      // session storage is best-effort
    }
  };
  const getSessionStorageItem = (key: string) => {
    try {
      return sessionStorage?.getItem(key) || "";
    } catch {
      return "";
    }
  };
  const removeSessionStorageItem = (key: string) => {
    try {
      sessionStorage?.removeItem(key);
    } catch {
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
    if (!window?.location || typeof window.location.reload !== "function") {
      logServiceWorkerClient("reload skipped; window.location.reload is unavailable", { reason });
      return false;
    }
    logServiceWorkerClient("reloading page for service worker isolation", { reason });
    setSessionStorageItem(COI_RELOADED_BY_SELF_KEY, reason);
    window.location.reload();
    return true;
  };
  const getRegistrationSnapshot = async () => {
    const serviceWorker = navigator?.serviceWorker;
    if (!serviceWorker) return { controller: false, registrations: [] };
    try {
      const registrations = await serviceWorker.getRegistrations();
      return {
        controller: Boolean(serviceWorker.controller),
        registrations: registrations.map((registration) => describeRegistration(registration)),
      };
    } catch (err) {
      return {
        controller: Boolean(serviceWorker.controller),
        error: formatError(err),
        registrations: [],
      };
    }
  };

  const waitForReadyRegistration = async (reason: string) => {
    const serviceWorker = navigator?.serviceWorker;
    if (!serviceWorker) {
      logServiceWorkerClient("ready wait skipped; service worker is unavailable", { reason });
      return serviceWorkerRegistration;
    }
    const ready = serviceWorker.ready;
    if (!(ready && typeof ready.then === "function")) {
      logServiceWorkerClient("ready wait skipped; service worker ready promise is unavailable", { reason });
      return serviceWorkerRegistration;
    }
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      logServiceWorkerClient("waiting for service worker ready registration", {
        reason,
        timeoutMs: SERVICE_WORKER_READY_TIMEOUT_MS,
      });
      const result = await Promise.race([
        ready.then((registration) => ({ registration, timedOut: false })),
        new Promise<{ registration: ServiceWorkerRegistrationLike | undefined; timedOut: true }>((resolve) => {
          timeoutId = setTimeout(() => {
            resolve({ registration: serviceWorkerRegistration, timedOut: true });
          }, SERVICE_WORKER_READY_TIMEOUT_MS);
        }),
      ]);
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (result.timedOut) {
        logServiceWorkerClient("service worker ready registration timed out", {
          reason,
          timeoutMs: SERVICE_WORKER_READY_TIMEOUT_MS,
          ...(await getRegistrationSnapshot()),
        });
        return result.registration;
      }
      logServiceWorkerClient("service worker ready registration resolved", {
        reason,
        scope: result.registration?.scope,
      });
      return result.registration;
    } catch (err) {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      logServiceWorkerClient("service worker ready registration failed", {
        error: formatError(err),
        reason,
      });
      return serviceWorkerRegistration;
    }
  };
  const reloadWhenReadyForControl = () => {
    if (reloadForControlPending) {
      logServiceWorkerClient("control reload already pending");
      return;
    }
    logServiceWorkerClient("scheduled reload after service worker is ready");
    reloadForControlPending = true;
    void waitForReadyRegistration("gain-control").then(() => {
      reloadForControlPending = false;
      if (navigator?.serviceWorker?.controller) {
        logServiceWorkerClient("control reload skipped; controller is already active");
        return;
      }
      if (pendingReloadReason === COI_RELOAD_REASON_NOT_CONTROLLING) {
        logServiceWorkerClient("control reload skipped; page already reloaded for control");
        return;
      }
      reloadForCrossOriginIsolation(COI_RELOAD_REASON_NOT_CONTROLLING);
    });
  };
  const postCoepCredentialless = (value: boolean) => {
    const controller = navigator?.serviceWorker?.controller;
    if (!controller) {
      logServiceWorkerClient("COEP mode update skipped; no active controller", { value });
      return false;
    }
    try {
      controller.postMessage({
        action: COI_COEP_CREDENTIALLESS_ACTION,
        value,
      });
      logServiceWorkerClient("COEP mode update sent", { credentialless: value });
      return true;
    } catch (err) {
      logServiceWorkerClient("COEP mode update failed", {
        credentialless: value,
        error: formatError(err),
      });
      return false;
    }
  };
  let pendingReloadReason = takeReloadReason();
  const syncCrossOriginIsolationMode = ({ allowReload }: { allowReload: boolean }) => {
    if (!(navigator?.serviceWorker?.controller && isCrossOriginIsolationKnown())) {
      logServiceWorkerClient("COEP mode sync skipped", {
        controller: Boolean(navigator?.serviceWorker?.controller),
        crossOriginIsolationKnown: isCrossOriginIsolationKnown(),
      });
      return;
    }
    if (!isCrossOriginIsolated()) setSessionStorageItem(COI_COEP_HAS_FAILED_KEY, "true");
    const coepHasFailed = getSessionStorageItem(COI_COEP_HAS_FAILED_KEY) === "true";
    const reloadedBySelf = pendingReloadReason;
    pendingReloadReason = "";
    const coepDegrading = reloadedBySelf === COI_RELOAD_REASON_COEP_DEGRADE;
    const reloadToDegrade = allowReload && !coepDegrading && !isCrossOriginIsolated();
    const useCredentialless = !(reloadToDegrade || coepHasFailed);
    logServiceWorkerClient("syncing COEP mode", {
      allowReload,
      coepHasFailed,
      crossOriginIsolated: isCrossOriginIsolated(),
      reloadedBySelf,
      reloadToDegrade,
      useCredentialless,
    });
    postCoepCredentialless(useCredentialless);
    if (reloadToDegrade) reloadForCrossOriginIsolation(COI_RELOAD_REASON_COEP_DEGRADE);
  };

  const emitState = () => {
    onStateChange(state);
  };
  const setVersion = (version: string, title?: string) => {
    controllerVersion = version;
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
      logServiceWorkerClient("cache version refresh skipped; service worker cache is disabled");
      setVersion("off", "Service worker cache is disabled");
      return;
    }
    const serviceWorker = navigator?.serviceWorker;
    if (!serviceWorker) {
      logServiceWorkerClient("cache version refresh skipped; service worker is unavailable");
      setVersion("off", "Service worker is not available in this browser");
      return;
    }
    const controller = serviceWorker.controller;
    if (!controller) {
      logServiceWorkerClient("cache version refresh skipped; page is uncontrolled");
      setVersion("network", "This page is not controlled by a service worker");
      return;
    }
    if (typeof MessageChannel !== "function") {
      logServiceWorkerClient("cache version refresh skipped; MessageChannel is unavailable");
      setVersion("unknown", "This browser cannot query the loaded service worker cache version");
      return;
    }

    logServiceWorkerClient("requesting loaded service worker cache version");
    const channel = new MessageChannel();
    let complete = false;
    const finish = (version?: string, title?: string) => {
      if (complete) return;
      complete = true;
      clearTimeout(timeout);
      channel.port1.onmessage = null;
      try {
        channel.port1.close();
      } catch {
        // best-effort cleanup
      }
      try {
        channel.port2.close();
      } catch {
        // best-effort cleanup
      }
      setVersion(version || "unknown", title);
    };
    const timeout = setTimeout(() => {
      logServiceWorkerClient("cache version refresh timed out");
      finish("unknown", "The loaded service worker did not report a cache version");
    }, cacheVersionTimeoutMs);
    channel.port1.onmessage = (event) => {
      const data = event.data || {};
      logServiceWorkerClient("cache version response received", {
        precacheName: typeof data.precacheName === "string" ? data.precacheName : undefined,
        precacheVersion: typeof data.precacheVersion === "string" ? data.precacheVersion : undefined,
      });
      finish(
        typeof data.precacheVersion === "string" ? data.precacheVersion : undefined,
        `Loaded service worker cache: ${data.precacheName || data.precacheVersion || "unknown"}`,
      );
    };

    try {
      controller.postMessage({ action: "get-service-worker-cache-version" }, [channel.port2]);
    } catch (err) {
      logServiceWorkerClient("cache version request failed", {
        error: formatError(err),
      });
      finish("unknown", "Could not query the loaded service worker cache version");
    }
  };
  const runServiceWorkerUpdateCheck = () => {
    void serviceWorkerRegistration?.update?.().catch((err) => {
      logServiceWorkerClient("service worker update check failed", {
        error: formatError(err),
      });
    });
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
    if (!cacheStorage) {
      logServiceWorkerClient("cache deletion skipped; CacheStorage is unavailable");
      return;
    }
    const cacheNames = await cacheStorage.keys();
    const cacheNamesToDelete = cacheNames.filter((cacheName) => cacheName.indexOf(cachePrefix) === 0);
    logServiceWorkerClient("deleting service worker caches", {
      cacheNames: cacheNamesToDelete,
      count: cacheNamesToDelete.length,
    });
    await Promise.all(cacheNamesToDelete.map((cacheName) => cacheStorage.delete(cacheName)));
  };

  const disableServiceWorkerCache = () => {
    logServiceWorkerClient("disabling service worker cache");
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
        logServiceWorkerClient("service worker cache disabled");
        setVersion("off", "Service worker cache is disabled");
      })
      .catch((err) => {
        logServiceWorkerClient("service worker cache disable failed", {
          error: formatError(err),
        });
        setVersion("off", "Service worker cache is disabled");
      });
  };
  const reloadPendingUpdate = async (): Promise<boolean> => {
    if (!(state.updateReady && updateServiceWorker)) {
      logServiceWorkerClient("pending update reload skipped; no update is ready");
      return false;
    }
    if (!(await onConfirmReload())) {
      logServiceWorkerClient("pending update reload canceled by user");
      return false;
    }
    logServiceWorkerClient("reloading with pending service worker update");
    clearUpdateReady();
    onBeforeReload?.();
    await updateServiceWorker(true);
    return true;
  };
  const forceCacheAndReload = async (): Promise<boolean> => {
    if (!enabled) {
      logServiceWorkerClient("force cache reload skipped; service worker cache is disabled");
      return false;
    }
    const serviceWorker = navigator?.serviceWorker;
    if (!(serviceWorker && window?.location)) {
      logServiceWorkerClient("force cache reload skipped; service worker or location is unavailable");
      return false;
    }

    logServiceWorkerClient("force cache reload requested");
    await serviceWorkerRegistration?.update?.().catch((err) => {
      logServiceWorkerClient("force cache reload update check failed", {
        error: formatError(err),
      });
    });
    await waitForReadyRegistration("force-cache-and-reload");
    syncCrossOriginIsolationMode({ allowReload: false });
    refreshCacheVersion();

    if (!serviceWorker.controller) return reloadForCrossOriginIsolation(COI_RELOAD_REASON_NOT_CONTROLLING);
    logServiceWorkerClient("force cache reload; reloading controlled page");
    window.location.reload();
    return true;
  };

  const initialize = () => {
    if (initialized) {
      logServiceWorkerClient("initialize skipped; client is already initialized");
      return;
    }
    initialized = true;
    logServiceWorkerClient("initializing service worker client", { enabled });

    if (!enabled) {
      disableServiceWorkerCache();
      return;
    }

    const serviceWorker = navigator?.serviceWorker;
    if (!serviceWorker) {
      logServiceWorkerClient("service worker registration skipped; service worker is unavailable");
      refreshCacheVersion();
      return;
    }

    serviceWorker.addEventListener("controllerchange", () => {
      logServiceWorkerClient("controllerchange event received");
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
      onNeedRefresh: () => {
        logServiceWorkerClient("service worker update ready");
        const autoApplyReloads = Number.parseInt(getSessionStorageItem(AUTO_APPLY_RELOAD_COUNT_KEY), 10) || 0;
        if (shouldAutoApplyUpdate?.() && updateServiceWorker && autoApplyReloads < AUTO_APPLY_RELOAD_BUDGET) {
          // Reload only when the page is still running the code the outgoing controller cached. When the
          // running version is already ahead of that controller — the shell was served fresh from the
          // network — the page IS the incoming version, so a reload would swap in nothing; activate via
          // skipWaiting silently and let the controllerchange handler re-sync COEP and the cache version.
          const reloadToApply = controllerVersion === appVersion;
          logServiceWorkerClient("auto-applying service worker update; no in-progress work", {
            autoApplyReloads,
            controllerVersion,
            reloadToApply,
            runningVersion: appVersion,
          });
          setSessionStorageItem(AUTO_APPLY_RELOAD_COUNT_KEY, String(autoApplyReloads + 1));
          clearUpdateReady();
          if (reloadToApply) onBeforeReload?.();
          void updateServiceWorker(reloadToApply);
          return;
        }
        if (autoApplyReloads >= AUTO_APPLY_RELOAD_BUDGET) {
          logServiceWorkerClient("auto-apply budget exhausted; deferring to manual update prompt", {
            autoApplyReloads,
          });
        }
        markUpdateReady();
      },
      onOfflineReady: () => {
        logServiceWorkerClient("service worker offline cache ready");
        refreshCacheVersion();
      },
      onRegisterError: (err) => {
        logServiceWorkerClient("service worker registration failed", {
          error: formatError(err),
          hint: isCertificateRegistrationError(err)
            ? "Trust the HTTPS certificate for this origin before testing the service worker over LAN."
            : undefined,
        });
        refreshCacheVersion();
      },
      onRegisteredSW: (
        swScriptUrl: string,
        registration: Parameters<NonNullable<RegisterSWOptions["onRegisteredSW"]>>[1],
      ) => {
        serviceWorkerRegistration = registration as ServiceWorkerRegistrationLike | undefined;
        logServiceWorkerClient("service worker registered", {
          controlled: Boolean(serviceWorker.controller),
          scope: registration?.scope,
          swScriptUrl,
        });
        if (!registration) {
          refreshCacheVersion();
          return;
        }
        void registration.update?.().catch((err) => {
          logServiceWorkerClient("initial service worker update check failed", {
            error: formatError(err),
          });
        });
        if (!serviceWorker.controller) {
          if (pendingReloadReason === COI_RELOAD_REASON_NOT_CONTROLLING)
            logServiceWorkerClient("uncontrolled reload skipped; page already reloaded for control");
          else reloadWhenReadyForControl();
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
    forceCacheAndReload,
    getState: () => state,
    initialize,
    refreshCacheVersion,
    reloadPendingUpdate,
  };
};

export { createPwaServiceWorkerClient };
