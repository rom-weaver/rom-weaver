// Holds back the first render until cross-origin isolation settles.
//
// When the service worker provides cross-origin isolation (it is enabled and the server does NOT send
// COOP/COEP) the first document loads un-isolated; the service worker client then reloads the page to
// gain control and inject the isolation headers. Without this gate the app would paint on the un-isolated
// document only to be torn down by that reload (a visible flash). The gate suppresses rendering on the
// doomed document so the page stays on the static background until the isolated document loads. If the
// server already sends the headers (document is isolated on first paint) or the service worker is
// disabled/unsupported, the gate is open from the start and boot proceeds immediately.
//
// Recovery: the per-document COOP/COEP handshake can intermittently land controlled-but-not-isolated and
// the service worker client does not always reload again. When that happens the gate reloads the page
// itself to retry (bounded, so a browser that can never isolate is not stuck in a loop). After the retry
// budget is spent it gives up and boots un-isolated rather than hanging.

type GateLogger = {
  debug: (message: string, details?: Record<string, unknown>) => void;
  trace: (message: string, details?: Record<string, unknown>) => void;
};

type GateWindowLike = Pick<Window, "setInterval" | "clearInterval" | "setTimeout" | "clearTimeout"> & {
  crossOriginIsolated?: boolean;
  location?: Pick<Location, "reload">;
};

type GateNavigatorLike = {
  serviceWorker?: Pick<ServiceWorkerContainer, "addEventListener" | "removeEventListener" | "controller">;
};

type GateSessionStorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type CreateServiceWorkerBootGateOptions = {
  serviceWorkerEnabled: boolean;
  navigator: GateNavigatorLike | undefined;
  window: GateWindowLike | undefined;
  sessionStorage: GateSessionStorageLike | undefined;
  // Once the page is controlled but still not isolated for this long, reload to retry the handshake.
  stuckReloadMs: number;
  // Absolute backstop: boot un-isolated rather than hang (covers a worker that never installs).
  timeoutMs: number;
  // Cap on gate-initiated reloads, so a browser that can never isolate is not stuck reloading forever.
  maxReloads: number;
  logger: GateLogger;
};

type ServiceWorkerBootGate = {
  // True while renders should be suppressed. Read this from the render path.
  isGated: () => boolean;
  // Boot now if the gate is open, otherwise wait until isolation settles (reloading to retry if stuck,
  // or giving up at the backstop) then call onReady exactly once. Safe to call once per document load.
  start: (onReady: () => void) => void;
};

const RELOAD_COUNT_KEY = "rom-weaver-coi-gate-reloads";
const POLL_MS = 200;

const createServiceWorkerBootGate = ({
  serviceWorkerEnabled,
  navigator,
  window,
  sessionStorage,
  stuckReloadMs,
  timeoutMs,
  maxReloads,
  logger,
}: CreateServiceWorkerBootGateOptions): ServiceWorkerBootGate => {
  const isCrossOriginIsolated = () => window?.crossOriginIsolated === true;
  const isServiceWorkerSupported = Boolean(navigator?.serviceWorker);
  const hasController = () => Boolean(navigator?.serviceWorker?.controller);

  const getReloadCount = () => {
    const raw = sessionStorage?.getItem(RELOAD_COUNT_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  };
  const setReloadCount = (value: number) => {
    try {
      sessionStorage?.setItem(RELOAD_COUNT_KEY, String(value));
    } catch (_err) {
      // session storage is best-effort
    }
  };
  const clearReloadCount = () => {
    try {
      sessionStorage?.removeItem(RELOAD_COUNT_KEY);
    } catch (_err) {
      // session storage is best-effort
    }
  };

  // Decide synchronously at construction (module load), before any async service worker callback can
  // trigger a render. crossOriginIsolated is fixed for the lifetime of a document, so this value is
  // authoritative for the current document.
  let gated = serviceWorkerEnabled && isServiceWorkerSupported && !isCrossOriginIsolated();

  const start = (onReady: () => void) => {
    if (!gated) {
      // Reached a good (isolated, or isolation-not-needed) document - reset the retry budget.
      clearReloadCount();
      onReady();
      return;
    }

    const reloadCount = getReloadCount();
    logger.debug("Deferring webapp boot until cross-origin isolation settles", {
      crossOriginIsolated: isCrossOriginIsolated(),
      reloadCount,
      stuckReloadMs,
      timeoutMs,
    });

    let released = false;
    const cleanup = () => {
      if (window) window.clearInterval(pollId);
      navigator?.serviceWorker?.removeEventListener?.("controllerchange", onControllerChange);
    };
    const boot = (reason: string) => {
      if (released) return;
      released = true;
      gated = false;
      cleanup();
      clearReloadCount();
      logger.debug("Cross-origin isolation gate released; booting webapp", {
        crossOriginIsolated: isCrossOriginIsolated(),
        reason,
      });
      onReady();
    };
    const reloadToRetry = (reason: string) => {
      if (released) return;
      released = true;
      cleanup();
      setReloadCount(reloadCount + 1);
      logger.debug("Reloading to retry cross-origin isolation", {
        attempt: reloadCount + 1,
        maxReloads,
        reason,
      });
      window?.location?.reload?.();
    };

    let elapsed = 0;
    let controlledAt: number | null = hasController() ? 0 : null;
    const tick = () => {
      if (isCrossOriginIsolated()) {
        boot("cross-origin-isolated");
        return;
      }
      elapsed += POLL_MS;
      if (controlledAt === null && hasController()) controlledAt = elapsed;
      // Controlled but still not isolated for too long: the handshake stalled. Reload to retry while we
      // still have retry budget; otherwise stop holding the page and boot un-isolated.
      if (controlledAt !== null && elapsed - controlledAt >= stuckReloadMs) {
        if (reloadCount < maxReloads) reloadToRetry("controlled-but-not-isolated");
        else boot("reload-budget-exhausted");
        return;
      }
      // Absolute backstop (e.g. the worker never installed): boot un-isolated rather than hang.
      if (elapsed >= timeoutMs) boot("isolation-gate-timeout");
    };
    const onControllerChange = () => {
      logger.trace("controllerchange observed while gating webapp boot", {
        crossOriginIsolated: isCrossOriginIsolated(),
      });
      if (isCrossOriginIsolated()) boot("cross-origin-isolated");
    };

    // crossOriginIsolated is fixed per-document, so on this un-isolated load it only flips once a reload
    // swaps in a fresh document. The poll drives both the isolated check and the stuck/backstop timers.
    const pollId = window ? window.setInterval(tick, POLL_MS) : 0;
    navigator?.serviceWorker?.addEventListener?.("controllerchange", onControllerChange);
  };

  return {
    isGated: () => gated,
    start,
  };
};

export { createServiceWorkerBootGate };
