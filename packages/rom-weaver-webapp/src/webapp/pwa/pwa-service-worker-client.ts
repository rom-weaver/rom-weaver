import { registerSW } from "virtual:pwa-register";
import type { RegisterSWOptions } from "vite-plugin-pwa/types";
import { createLogger } from "../../lib/logging.ts";

import {
  createServiceWorkerCacheState,
  type ServiceWorkerCacheState,
  type ServiceWorkerStatus,
  setServiceWorkerCacheVersion,
} from "./service-worker-cache-state.ts";

type ServiceWorkerRegistrationLike = Pick<
  ServiceWorkerRegistration,
  "scope" | "active" | "waiting" | "installing" | "unregister" | "update"
>;
type ServiceWorkerContainerLike = Pick<ServiceWorkerContainer, "controller" | "getRegistrations" | "ready"> &
  Pick<EventTarget, "addEventListener">;
type NavigatorLike = {
  onLine?: boolean;
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
  /** This page's build, compared with the build its controlling worker reports. */
  buildVersion: string;
  cachePrefix: string;
  cacheVersionTimeoutMs: number;
  document: DocumentLike | undefined;
  enabled: boolean;
  /** True when nothing on the page would be lost by reloading it. */
  isPageIdle: () => boolean;
  navigator: NavigatorLike | undefined;
  onStateChange: (state: ServiceWorkerCacheState) => void;
  registerServiceWorker?: RegisterServiceWorker;
  sessionStorage?: SessionStorageLike | undefined;
  updateIntervalMs: number;
  window: WindowLike | undefined;
};

type PwaServiceWorkerClient = {
  forceCacheAndReload: () => Promise<boolean>;
  getState: () => ServiceWorkerCacheState;
  /** True once an update took control of this page, which keeps running its own build. */
  hasUpdateTakenOver: () => boolean;
  initialize: () => void;
  refreshCacheVersion: () => void;
};

// `cache-service-worker` and `_cache_service_worker` are the pre-rename script names. A tab that a
// previously deployed worker still controls reports one of them until the renamed worker activates,
// so the pattern MUST keep matching them.
const ROM_WEAVER_SERVICE_WORKER_URL_PATTERN =
  /\/(?:rom-weaver-service-worker|_cache_service_worker|cache-service-worker|dev-sw)\.js(?:$|\?)/;
const COI_COEP_CREDENTIALLESS_ACTION = "set-coep-credentialless";
const COI_COEP_HAS_FAILED_KEY = "rom-weaver-coi-coep-has-failed";
const COI_RELOADED_BY_SELF_KEY = "rom-weaver-coi-reloaded-by-self";
const COI_RELOAD_REASON_COEP_DEGRADE = "coepdegrade";
const COI_RELOAD_REASON_NOT_CONTROLLING = "notcontrolling";
const logger = createLogger("rom-weaver-sw-client");
const SERVICE_WORKER_READY_TIMEOUT_MS = 8000;

// Per-tab-session budget on silent reloads of a hidden tab after an update took over. It stops a
// deploy that keeps producing workers from looping one tab's reloads.
const HIDDEN_RELOAD_COUNT_KEY = "rom-weaver-sw-hidden-reloads";
const HIDDEN_RELOAD_BUDGET = 3;

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
  buildVersion,
  cachePrefix,
  cacheVersionTimeoutMs,
  document,
  enabled,
  isPageIdle,
  navigator,
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
  // Version last reported by the controlling worker, or a sentinel such as "network" or "unknown".
  // Shown while a newer report is pending.
  let controllerVersion = "";
  let serviceWorkerRegistration: ServiceWorkerRegistrationLike | undefined;
  let updateIntervalId: number | null = null;
  let reloadForControlPending = false;
  let updateTookOver = false;
  let controllerBuildVersion = "";
  // True once an update check found no worker newer than the controlling one.
  let isControllerNewest = false;

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
  const reloadPage = (message: string, reason: string) => {
    if (!window?.location || typeof window.location.reload !== "function") {
      logServiceWorkerClient("reload skipped; window.location.reload is unavailable", { reason });
      return false;
    }
    logServiceWorkerClient(message, { reason });
    window.location.reload();
    return true;
  };
  const reloadForCrossOriginIsolation = (reason: string) => {
    if (!window?.location || typeof window.location.reload !== "function") {
      logServiceWorkerClient("reload skipped; window.location.reload is unavailable", { reason });
      return false;
    }
    setSessionStorageItem(COI_RELOADED_BY_SELF_KEY, reason);
    return reloadPage("reloading page for service worker isolation", reason);
  };
  // Leaving a page also turns it hidden, after its pagehide event. A reload cannot start there and would
  // only spend the budget.
  let isLeavingPage = false;
  const getHiddenReloadBlocker = (reloads: number) => {
    if (document?.visibilityState !== "hidden") return "the tab is visible";
    if (isLeavingPage) return "the page is being left";
    if (reloads >= HIDDEN_RELOAD_BUDGET) return "the reload budget is spent";
    if (navigator?.onLine === false) return "the browser is offline";
    if (!isPageIdle()) return "work is in progress";
    return undefined;
  };
  // Reloads a hidden, idle tab onto the build that took over, before its next visit. The reload needs
  // the network for files the new build has not cached yet.
  const reloadHiddenIdleTab = (trigger: string) => {
    if (!updateTookOver) return;
    const reloads = Number.parseInt(getSessionStorageItem(HIDDEN_RELOAD_COUNT_KEY), 10) || 0;
    const blocker = getHiddenReloadBlocker(reloads);
    if (blocker) {
      logServiceWorkerClient("hidden tab reload skipped", { blocker, reloads, trigger });
      return;
    }
    setSessionStorageItem(HIDDEN_RELOAD_COUNT_KEY, String(reloads + 1));
    reloadPage("reloading the hidden idle tab onto the build that took over", trigger);
  };
  // A takeover that lands while the page boots fires no controllerchange here. The newest worker
  // running another build than the page shows the same takeover.
  const catchUpOnMissedTakeover = () => {
    if (updateTookOver || !isControllerNewest) return;
    if (!(buildVersion && controllerBuildVersion) || buildVersion === controllerBuildVersion) return;
    updateTookOver = true;
    logServiceWorkerClient("page build differs from the newest worker's; an update took over unseen", {
      buildVersion,
      controllerBuildVersion,
    });
    reloadHiddenIdleTab("missed takeover");
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
  const setVersion = (
    version: string,
    title?: string,
    serviceWorkerStatus: ServiceWorkerStatus | null = state.serviceWorkerStatus,
  ) => {
    controllerVersion = version;
    state = setServiceWorkerCacheVersion(state, version, title, serviceWorkerStatus);
    emitState();
  };

  const refreshCacheVersion = () => {
    if (!enabled) {
      logServiceWorkerClient("cache version refresh skipped; service worker cache is disabled");
      setVersion("off", "Service worker cache is disabled", "off");
      return;
    }
    const serviceWorker = navigator?.serviceWorker;
    if (!serviceWorker) {
      logServiceWorkerClient("cache version refresh skipped; service worker is unavailable");
      setVersion("off", "Service worker is not available in this browser", "off");
      return;
    }
    const controller = serviceWorker.controller;
    if (!controller) {
      logServiceWorkerClient("cache version refresh skipped; page is uncontrolled");
      if (serviceWorkerRegistration) {
        setVersion("network", "This page is not controlled by a service worker", "ready");
      }
      return;
    }
    if (typeof MessageChannel !== "function") {
      logServiceWorkerClient("cache version refresh skipped; MessageChannel is unavailable");
      setVersion("unknown", "This browser cannot query the loaded service worker cache version", "ready");
      return;
    }

    logServiceWorkerClient("requesting loaded service worker cache version");
    setVersion(controllerVersion || "unknown", "Service worker is active; checking its offline cache", "active");
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
      setVersion(version || "unknown", title, version ? "active" : "ready");
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
      controllerBuildVersion = typeof data.buildVersion === "string" ? data.buildVersion : "";
      finish(
        typeof data.precacheVersion === "string" ? data.precacheVersion : undefined,
        `Loaded service worker cache: ${data.precacheName || data.precacheVersion || "unknown"}`,
      );
      catchUpOnMissedTakeover();
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
  const onUpdateCheckDone = () => {
    isControllerNewest = !(serviceWorkerRegistration?.installing || serviceWorkerRegistration?.waiting);
    catchUpOnMissedTakeover();
  };
  const checkForUpdate = (failureMessage: string) => {
    void serviceWorkerRegistration?.update?.().then(onUpdateCheckDone, (err) => {
      logServiceWorkerClient(failureMessage, { error: formatError(err) });
    });
  };
  const runServiceWorkerUpdateCheck = () => checkForUpdate("service worker update check failed");
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
    setVersion("off", "Service worker cache is disabled", "off");
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
        setVersion("off", "Service worker cache is disabled", "off");
      })
      .catch((err) => {
        logServiceWorkerClient("service worker cache disable failed", {
          error: formatError(err),
        });
        setVersion("off", "Service worker cache is disabled", "off");
      });
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

    let controlled = Boolean(serviceWorker.controller);
    serviceWorker.addEventListener("controllerchange", () => {
      // A takeover MUST NOT reload a page that is in use. The page keeps running its build.
      const tookOver = controlled;
      if (tookOver) updateTookOver = true;
      controlled = true;
      logServiceWorkerClient("controllerchange event received", { updateTookOver: tookOver });
      syncCrossOriginIsolationMode({ allowReload: !tookOver });
      refreshCacheVersion();
      reloadHiddenIdleTab("takeover");
    });
    window?.addEventListener("beforeunload", stopServiceWorkerUpdateChecks);
    window?.addEventListener("focus", runServiceWorkerUpdateCheck);
    window?.addEventListener("online", runServiceWorkerUpdateCheck);
    window?.addEventListener("pagehide", () => {
      isLeavingPage = true;
    });
    // A page restored from the back-forward cache is in use again.
    window?.addEventListener("pageshow", () => {
      isLeavingPage = false;
    });
    document?.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") runServiceWorkerUpdateCheck();
      else reloadHiddenIdleTab("hidden");
    });

    registerServiceWorker({
      // An unisolated first visit needs the worker before the boot gate can release. Pages that
      // already have server or worker COOP/COEP headers can keep registration off the load path.
      immediate: !isCrossOriginIsolated(),
      // Without this callback the registrar reloads the page when an update takes control.
      onNeedReload: () => {
        logServiceWorkerClient("service worker update took control; the page keeps its build");
      },
      // The update activates by itself. It waits only for the outgoing worker to finish.
      onNeedRefresh: () => {
        logServiceWorkerClient("service worker update waiting for the outgoing worker");
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
        setVersion("off", "Service worker registration failed", "off");
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
          setVersion("off", "Service worker registration is unavailable", "off");
          return;
        }
        setVersion(controllerVersion || "unknown", "Service worker is registered and ready to take control", "ready");
        checkForUpdate("initial service worker update check failed");
        if (!serviceWorker.controller) {
          if (pendingReloadReason === COI_RELOAD_REASON_NOT_CONTROLLING) {
            logServiceWorkerClient("uncontrolled reload skipped; page already reloaded for control");
          } else if (isCrossOriginIsolationKnown() && isCrossOriginIsolated()) {
            // Server headers already isolated us, so the service worker has no COEP to inject.
            // It claims this client on its own; the controllerchange handler finishes the wiring.
            logServiceWorkerClient("uncontrolled reload skipped; page is already cross-origin isolated");
            startServiceWorkerUpdateChecks();
          } else {
            reloadWhenReadyForControl();
            return;
          }
          refreshCacheVersion();
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
    hasUpdateTakenOver: () => updateTookOver,
    initialize,
    refreshCacheVersion,
  };
};

export { createPwaServiceWorkerClient };
