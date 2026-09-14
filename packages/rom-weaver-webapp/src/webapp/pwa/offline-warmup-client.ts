/**
 * The page starts offline warm-up when a worker takes control, then waits for idle time between units.
 * Data saver disables automatic warm-up; explicit identify-group requests still run, while EmulatorJS fetches needed files on demand.
 */
import { createLogger } from "../../lib/logging.ts";
import type { LogDetails } from "../../types/logging.ts";
import type { OfflineCachedFile, OfflineReadyState, WarmupBumpTarget, WarmupProgress } from "../offline-warmup.ts";

const PUMP_TIMEOUT_MS = 120_000;
const CACHE_INVENTORY_TIMEOUT_MS = 2000;
const MAX_FAILURE_DELAY_MS = 30_000;
const logger = createLogger("offline-warmup");
// Worker lines keep their own namespace so the page log shows which side of the
// service-worker boundary each one came from.
const workerLogger = createLogger("rom-weaver-service-worker");

type OfflineWarmupProgress = WarmupProgress;

/**
 * First-install progress uses combined precache and warm-up totals, with file counts as a fallback.
 */
type OfflinePrecacheProgress = OfflineReadyState & { phase: "precache" };

type ServiceWorkerContainerLike = {
  controller: ServiceWorker | null;
  addEventListener?: {
    (type: "controllerchange", listener: () => void): void;
    (type: "message", listener: (event: MessageEvent) => void): void;
  };
  removeEventListener?: {
    (type: "controllerchange", listener: () => void): void;
    (type: "message", listener: (event: MessageEvent) => void): void;
  };
};

type NavigatorLike = {
  serviceWorker?: ServiceWorkerContainerLike;
  onLine?: boolean;
  connection?: { downlink?: number; effectiveType?: string; rtt?: number; saveData?: boolean };
};

type ScheduleOfflineWarmupOptions = {
  delayMs?: number;
  idleDelayMs?: number;
  navigator?: NavigatorLike;
  onProgress?: (progress: OfflineWarmupProgress) => void;
};

const createOfflineWarmupProgressGate = (onProgress: (progress: OfflineReadyState) => void) => {
  let liveProgressReceived = false;
  let snapshotReceived = false;
  return {
    acceptLive: (progress: OfflineWarmupProgress) => {
      liveProgressReceived = true;
      onProgress(progress);
    },
    // Broadcast from the installing worker's precache, before the page is
    // controlled. Warm-up sources are strictly newer information (the precache
    // is finished by the time a pump can run), so they always win.
    acceptPrecache: (progress: OfflineReadyState) => {
      if (!(liveProgressReceived || snapshotReceived)) onProgress(progress);
    },
    acceptSnapshot: (progress: OfflineReadyState) => {
      snapshotReceived = true;
      // Snapshot and pump messages run independently in the service worker.
      // Once a pump reports progress, an outstanding snapshot is stale.
      if (!liveProgressReceived) onProgress(progress);
    },
  };
};

const getGlobalNavigator = (): NavigatorLike | undefined => (typeof navigator === "undefined" ? undefined : navigator);

const formatError = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Module-level singleton so workflow code and views can pause or bump the
// warm-up without holding a reference to the scheduler instance.
let activeController: {
  bump: (target: WarmupBumpTarget) => void;
  download: () => void;
  notifyResume: () => void;
  pause: () => void;
  configure: () => void;
} | null = null;
let pauseCount = 0;
const pendingBumps: WarmupBumpTarget[] = [];
const initialOfflineCopyState = {
  enabled: true,
  pending: false,
  error: null as string | null,
  downloadRequested: false,
};
let offlineCopyState = initialOfflineCopyState;
const offlineCopyListeners = new Set<() => void>();
const getOfflineCopyState = () => offlineCopyState;
const getInitialOfflineCopyState = () => initialOfflineCopyState;
const subscribeOfflineCopyState = (listener: () => void) => {
  offlineCopyListeners.add(listener);
  return () => {
    offlineCopyListeners.delete(listener);
  };
};
const updateOfflineCopyState = (change: Partial<typeof offlineCopyState>) => {
  offlineCopyState = { ...offlineCopyState, ...change };
  for (const listener of offlineCopyListeners) listener();
};
const setOfflineWarmupEnabled = (enabled: boolean) => {
  if (enabled === offlineCopyState.enabled && !offlineCopyState.error) return;
  updateOfflineCopyState({ enabled, pending: true, error: null, downloadRequested: false });
  if (!enabled) {
    pendingBumps.length = 0;
    persistOfflineReady(false);
  }
  activeController?.configure();
};

/** Hold the warm-up while interactive downloads run. Balanced by resumeOfflineWarmup. */
const pauseOfflineWarmup = () => {
  pauseCount += 1;
  if (pauseCount === 1) activeController?.pause();
};

const resumeOfflineWarmup = () => {
  pauseCount = Math.max(0, pauseCount - 1);
  if (pauseCount === 0) activeController?.notifyResume();
};

/**
 * Move the named assets to the front of the warm-up queue and pump
 * immediately, bypassing the idle wait and the data-saver hold.
 */
const bumpOfflineWarmupPriority = (target: WarmupBumpTarget) => {
  if (!offlineCopyState.enabled) return;
  if (activeController) activeController.bump(target);
  else pendingBumps.push(target);
};

const downloadOfflineCopy = (): boolean => {
  if (!activeController) return false;
  setOfflineWarmupEnabled(true);
  updateOfflineCopyState({ downloadRequested: true });
  activeController.download();
  return true;
};

const postPump = (
  controller: ServiceWorker,
  action: string,
  onInterim?: (data: Record<string, unknown>) => void,
  timeoutMs = PUMP_TIMEOUT_MS,
  payload: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      channel.port1.onmessage = null;
      channel.port1.close();
    };
    const abort = () => {
      cleanup();
      reject(new Error(`offline warm-up ${action} cancelled`));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    // Interim events reset the deadline: a large file on a slow connection is
    // alive as long as bytes keep arriving.
    const armTimeout = () => {
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`offline warm-up ${action} timed out`));
      }, timeoutMs);
    };
    armTimeout();
    channel.port1.onmessage = (event) => {
      const data = event.data || {};
      clearTimeout(timeout);
      if (data.action === "offline-warmup-interim") {
        armTimeout();
        onInterim?.(data);
        return;
      }
      cleanup();
      resolve(data);
    };
    try {
      controller.postMessage({ ...payload, action }, [channel.port2]);
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });

const waitMs = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done);
  });

const waitForIdle = (signal: AbortSignal, idleDelayMs: number): Promise<void> => {
  if (typeof requestIdleCallback !== "function") return waitMs(idleDelayMs, signal);
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const handle = requestIdleCallback(done, { timeout: 2000 });
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      cancelIdleCallback(handle);
      done();
    }
    signal.addEventListener("abort", abort);
  });
};

const matchesBump = (unit: string, target: WarmupBumpTarget) =>
  target.kind === "emulatorjs"
    ? unit.startsWith("emulatorjs:")
    : target.groupIds.some((id) => unit === `identify-group:${id}`);

/**
 * Start the background warm-up once the page is controlled. Returns a cancel
 * function with the same contract the old EmulatorJS prefetch had.
 */
const scheduleOfflineWarmup = (options: ScheduleOfflineWarmupOptions = {}): (() => void) => {
  const nav = options.navigator ?? getGlobalNavigator();
  const serviceWorker = nav?.serviceWorker;
  if (!serviceWorker) return () => undefined;

  const abortController = new AbortController();
  const signal = abortController.signal;
  const idleDelayMs = options.idleDelayMs ?? 0;
  const delayMs = options.delayMs ?? 0;
  const idleMechanism = typeof requestIdleCallback === "function" ? "requestIdleCallback" : "timer";
  const saveData = nav?.connection?.saveData === true;
  logger.debug("offline warm-up scheduler started", {
    delayMs,
    idleDelayMs,
    idleMechanism,
    onLine: nav?.onLine,
    saveData,
    effectiveType: nav?.connection?.effectiveType,
    downlinkMbpsHint: nav?.connection?.downlink,
    rttMsHint: nav?.connection?.rtt,
  });
  const activeBumps: WarmupBumpTarget[] = [];
  let loopRunning = false;
  let started = false;
  let resumeWaiters: (() => void)[] = [];
  let consecutiveFailures = 0;
  let pumpNumber = 0;
  let previousPumpCompletedAt: number | null = null;
  let generation = 0;
  let policyController: ServiceWorker | null = null;
  let policyEnabled: boolean | null = null;
  let policyChain = Promise.resolve(false);
  let requestController = new AbortController();
  let observedController = serviceWorker.controller;

  const synchronizePolicy = () => {
    const controller = serviceWorker.controller;
    const enabled = offlineCopyState.enabled;
    if (!controller || signal.aborted) return Promise.resolve(false);
    if (policyController === controller && policyEnabled === enabled) return policyChain;
    policyController = controller;
    policyEnabled = enabled;
    const currentGeneration = generation;
    const requestSignal = requestController.signal;
    updateOfflineCopyState({ pending: true, error: null });
    policyChain = policyChain.then(async () => {
      if (signal.aborted) return false;
      try {
        const reply = await postPump(
          controller,
          "set-offline-copy-enabled",
          undefined,
          PUMP_TIMEOUT_MS,
          { enabled },
          requestSignal,
        );
        if (reply.action !== "offline-copy-state" || reply.enabled !== enabled) {
          throw new Error(String(reply.error ?? "offline copy setting returned an invalid response"));
        }
        if (!signal.aborted && currentGeneration === generation) {
          updateOfflineCopyState({ pending: false, error: null });
          if (!enabled) options.onProgress?.(reply as unknown as OfflineWarmupProgress);
          persistOfflineReady(enabled && reply.ready === true);
        }
        return true;
      } catch (error) {
        if (!signal.aborted && currentGeneration === generation) {
          policyController = null;
          policyEnabled = null;
          updateOfflineCopyState({ pending: false, error: formatError(error), downloadRequested: false });
          logger.warn("offline copy setting failed", { enabled, error: formatError(error) });
        }
        return false;
      }
    });
    return policyChain;
  };

  const notifyResume = () => {
    const waiters = resumeWaiters;
    resumeWaiters = [];
    for (const waiter of waiters) waiter();
  };

  const waitForResume = (): Promise<void> =>
    new Promise((resolve) => {
      if (pauseCount === 0 || signal.aborted) return resolve();
      const done = () => {
        signal.removeEventListener("abort", done);
        resolve();
      };
      resumeWaiters.push(done);
      signal.addEventListener("abort", done, { once: true });
    });

  const runLoop = async () => {
    if (loopRunning) return;
    loopRunning = true;
    const loopGeneration = generation;
    try {
      if (!(await synchronizePolicy())) return;
      while (!signal.aborted && offlineCopyState.enabled && loopGeneration === generation) {
        while (pauseCount > 0 && !signal.aborted) {
          const waitStartedAt = performance.now();
          logger.debug("offline warm-up waiting for interactive work", { pauseCount });
          await waitForResume();
          logger.debug("offline warm-up interactive wait ended", {
            aborted: signal.aborted,
            durationMs: performance.now() - waitStartedAt,
            pauseCount,
          });
        }
        if (signal.aborted || !offlineCopyState.enabled || loopGeneration !== generation) return;
        if (nav?.onLine === false) {
          // Nothing can download offline. The loop exits; the online listener
          // and any bump restart it.
          logger.debug("offline warm-up paused; browser is offline");
          return;
        }
        const controller = serviceWorker.controller;
        if (!controller) return;
        const currentPump = ++pumpNumber;
        const pumpStartedAt = performance.now();
        logger.debug("offline warm-up pump requested", {
          pumpNumber: currentPump,
          sincePreviousPumpMs: previousPumpCompletedAt === null ? null : pumpStartedAt - previousPumpCompletedAt,
        });
        let reply: Record<string, unknown>;
        try {
          reply = await postPump(
            controller,
            "offline-warmup-pump",
            (interim) => {
              if (offlineCopyState.enabled && loopGeneration === generation && !signal.aborted) {
                options.onProgress?.(interim as unknown as OfflineWarmupProgress);
              }
            },
            PUMP_TIMEOUT_MS,
            {},
            requestController.signal,
          );
        } catch (error) {
          if (signal.aborted || loopGeneration !== generation) return;
          previousPumpCompletedAt = performance.now();
          logger.debug("offline warm-up pump completed", {
            durationMs: previousPumpCompletedAt - pumpStartedAt,
            outcome: "error",
            pumpNumber: currentPump,
          });
          consecutiveFailures += 1;
          const delay = Math.min(MAX_FAILURE_DELAY_MS, 1000 * 2 ** consecutiveFailures);
          logger.warn("offline warm-up pump failed", { delayMs: delay, error: formatError(error) });
          await waitMs(delay, signal);
          continue;
        }
        if (!offlineCopyState.enabled || loopGeneration !== generation || signal.aborted) return;
        if (reply.enabled === false) return;
        previousPumpCompletedAt = performance.now();
        logger.debug("offline warm-up pump completed", {
          action: reply.action,
          cachedFiles: reply.cachedFiles,
          decodedCachedByteCount: reply.cachedBytes,
          decodedTotalByteCount: reply.totalBytes,
          transferredByteCount: reply.transferredBytes,
          durationMs: previousPumpCompletedAt - pumpStartedAt,
          pendingUnits: reply.pendingUnits,
          pumpNumber: currentPump,
          ready: reply.ready,
          totalFiles: reply.totalFiles,
          unit: reply.unit,
        });
        if (reply.action === "offline-warmup-failed") {
          consecutiveFailures += 1;
          const delay = Math.min(MAX_FAILURE_DELAY_MS, 1000 * 2 ** consecutiveFailures);
          logger.warn("offline warm-up unit failed", { delayMs: delay, error: String(reply.error) });
          await waitMs(delay, signal);
          continue;
        }
        consecutiveFailures = 0;
        const progress = reply as unknown as OfflineWarmupProgress;
        options.onProgress?.(progress);
        if (progress.ready) {
          logger.debug("offline warm-up complete", {
            cachedBytes: progress.cachedBytes,
            totalBytes: progress.totalBytes,
          });
          return;
        }
        const unit = typeof progress.unit === "string" ? progress.unit : "";
        for (let i = activeBumps.length - 1; i >= 0; i -= 1) {
          const bumpTarget = activeBumps[i];
          if (!(unit && bumpTarget && matchesBump(unit, bumpTarget))) activeBumps.splice(i, 1);
        }
        if (saveData && !started && activeBumps.length === 0) {
          logger.debug("offline warm-up stopped; data saver is on and no bump is pending");
          return;
        }
        const idleStartedAt = performance.now();
        await waitForIdle(signal, idleDelayMs);
        logger.debug("offline warm-up idle wait ended", {
          aborted: signal.aborted,
          durationMs: performance.now() - idleStartedAt,
          idleMechanism,
        });
      }
    } finally {
      loopRunning = false;
      if (!signal.aborted && loopGeneration !== generation && offlineCopyState.enabled && started) void runLoop();
    }
  };

  const bump = (target: WarmupBumpTarget) => {
    if (!offlineCopyState.enabled) return;
    const controller = serviceWorker.controller;
    if (!controller) {
      pendingBumps.push(target);
      return;
    }
    try {
      controller.postMessage({ action: "offline-warmup-bump", target });
    } catch (error) {
      logger.warn("offline warm-up bump failed", { error: formatError(error) });
    }
    // Until a full download starts, EmulatorJS bumps on data saver MUST only
    // reorder the queue because pumping would download every core; the player
    // fetches only its required files. Identify-group bumps stay bounded.
    if (saveData && !started && target.kind === "emulatorjs") return;
    activeBumps.push(target);
    void runLoop();
  };

  const pause = () => {
    try {
      serviceWorker.controller?.postMessage({ action: "offline-warmup-pause" });
    } catch (error) {
      logger.warn("offline warm-up pause failed", { error: formatError(error) });
    }
  };
  const download = () => {
    if (signal.aborted) return;
    logger.debug("offline download requested by user", { saveData });
    started = true;
    void runLoop();
  };
  const configure = () => {
    generation += 1;
    requestController.abort();
    requestController = new AbortController();
    if (!offlineCopyState.enabled) {
      started = false;
      activeBumps.length = 0;
      pause();
      notifyResume();
    }
    void synchronizePolicy().then((applied) => {
      if (!applied || signal.aborted || !offlineCopyState.enabled) return;
      if (saveData && !offlineCopyState.downloadRequested) return;
      started = true;
      void runLoop();
    });
  };
  activeController = { bump, configure, download, notifyResume, pause };

  const startWarmup = () => {
    if (signal.aborted || !serviceWorker.controller) return;
    serviceWorker.removeEventListener?.("controllerchange", startWarmup);
    void synchronizePolicy();
    const drained = pendingBumps.splice(0);
    for (const target of drained) bump(target);
    const begin = () => {
      if (signal.aborted || started || !offlineCopyState.enabled) return;
      if (saveData) {
        logger.debug("offline warm-up auto-start skipped; data saver is on");
        return;
      }
      started = true;
      void runLoop();
    };
    if (delayMs <= 0) begin();
    else void waitMs(delayMs, signal).then(begin);
  };

  const onOnline = () => {
    if (started || activeBumps.length) void runLoop();
  };
  if (typeof addEventListener === "function") addEventListener("online", onOnline);
  // The loop exits when the controller disappears (a worker update in flight);
  // restart it when a new worker takes control.
  const onControllerChange = () => {
    if (serviceWorker.controller !== observedController) {
      observedController = serviceWorker.controller;
      generation += 1;
      requestController.abort();
      requestController = new AbortController();
    }
    void synchronizePolicy();
    if (started || activeBumps.length) void runLoop();
  };
  serviceWorker.addEventListener?.("controllerchange", onControllerChange);

  if (serviceWorker.controller) startWarmup();
  else serviceWorker.addEventListener?.("controllerchange", startWarmup);

  return () => {
    abortController.abort();
    requestController.abort();
    if (activeController?.bump === bump) {
      activeController = null;
      updateOfflineCopyState({ downloadRequested: false });
    }
    if (typeof removeEventListener === "function") removeEventListener("online", onOnline);
    serviceWorker.removeEventListener?.("controllerchange", startWarmup);
    serviceWorker.removeEventListener?.("controllerchange", onControllerChange);
  };
};

// Also read by the pre-hydration resolvers in index.html and shell.tsx - keep
// the literal in step there when changing it.
const OFFLINE_READY_STORAGE_KEY = "rom-weaver-offline-ready";

const readPersistedOfflineReady = (): boolean => {
  try {
    return localStorage.getItem(OFFLINE_READY_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
};

const persistOfflineReady = (ready: boolean) => {
  try {
    localStorage.setItem(OFFLINE_READY_STORAGE_KEY, ready ? "true" : "false");
  } catch {
    // localStorage is a best-effort hint for the pre-hydration chip only.
  }
};

/**
 * Progress of the first-install precache, broadcast by the installing worker
 * before it controls any page. It carries the same totals the warm-up reports
 * later - the app's own bytes included - so both stages move one percentage.
 * Returns a cleanup function.
 */
const listenForOfflinePrecacheProgress = (
  onProgress: (progress: OfflinePrecacheProgress) => void,
  nav?: NavigatorLike,
): (() => void) => {
  const container = (nav ?? getGlobalNavigator())?.serviceWorker;
  if (!container?.addEventListener) return () => undefined;
  const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
  const onMessage = (event: MessageEvent) => {
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (data.action !== "offline-precache-progress") return;
    const cachedFiles = count(data.cachedFiles);
    const totalFiles = count(data.totalFiles);
    onProgress({
      cachedBytes: count(data.cachedBytes),
      cachedFiles,
      pendingUnits: count(data.pendingUnits) || Math.max(0, totalFiles - cachedFiles),
      phase: "precache",
      ready: false,
      totalBytes: count(data.totalBytes),
      totalFiles,
      ...(typeof data.transferredBytes === "number" &&
      Number.isFinite(data.transferredBytes) &&
      data.transferredBytes >= 0
        ? { transferredBytes: data.transferredBytes }
        : {}),
      ...(typeof data.transferBytesIncomplete === "boolean"
        ? { transferBytesIncomplete: data.transferBytesIncomplete }
        : {}),
    });
  };
  container.addEventListener("message", onMessage);
  return () => container.removeEventListener?.("message", onMessage);
};

/**
 * Mirror the service worker's own log lines into the page log. The worker
 * console is a separate surface that an exported log and a user's bug report
 * never carry, so cache serves, pack-table misses and digest skew were only
 * ever visible to someone with the worker inspector already open. Relayed at
 * debug, so they cost nothing until the log level asks for them.
 *
 * Returns a cleanup function.
 */
const listenForServiceWorkerLog = (nav?: NavigatorLike): (() => void) => {
  const container = (nav ?? getGlobalNavigator())?.serviceWorker;
  if (!container?.addEventListener) return () => undefined;
  const onMessage = (event: MessageEvent) => {
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (data.action !== "service-worker-log" || typeof data.message !== "string") return;
    const details = data.details && typeof data.details === "object" ? { ...(data.details as LogDetails) } : {};
    // A replayed line is stamped when it reaches the page, so it carries the
    // time the worker actually wrote it.
    if (data.queued && typeof data.timestamp === "string") details.queuedAt = data.timestamp;
    workerLogger.debug(data.message, Object.keys(details).length ? details : undefined);
  };
  container.addEventListener("message", onMessage);
  // Ask for whatever the worker logged before this page could listen.
  const requestBacklog = () => container.controller?.postMessage?.({ action: "flush-service-worker-log" });
  requestBacklog();
  container.addEventListener("controllerchange", requestBacklog);
  return () => {
    container.removeEventListener?.("message", onMessage);
    container.removeEventListener?.("controllerchange", requestBacklog);
  };
};

/** One-shot readiness query, for pages that load after the warm-up finished. */
const queryOfflineReadyState = async (nav?: NavigatorLike): Promise<OfflineReadyState | null> => {
  const controller = (nav ?? getGlobalNavigator())?.serviceWorker?.controller;
  if (!controller || typeof MessageChannel !== "function") return null;
  try {
    const reply = await postPump(controller, "get-offline-ready-state");
    if (reply.action !== "offline-ready-state") return null;
    return reply as unknown as OfflineReadyState;
  } catch (error) {
    logger.warn("offline ready-state query failed", { error: formatError(error) });
    return null;
  }
};

/** One-shot inventory of files held by the background offline caches. */
const queryOfflineCachedFiles = async (nav?: NavigatorLike): Promise<OfflineCachedFile[]> => {
  const controller = (nav ?? getGlobalNavigator())?.serviceWorker?.controller;
  if (!controller || typeof MessageChannel !== "function") return [];
  const reply = await postPump(controller, "get-offline-cached-files", undefined, CACHE_INVENTORY_TIMEOUT_MS);
  if (reply.action !== "offline-cached-files" || !Array.isArray(reply.files)) {
    throw new Error("offline cached-file query returned an invalid response");
  }
  return reply.files as OfflineCachedFile[];
};

export {
  bumpOfflineWarmupPriority,
  createOfflineWarmupProgressGate,
  downloadOfflineCopy,
  getInitialOfflineCopyState,
  getOfflineCopyState,
  listenForOfflinePrecacheProgress,
  listenForServiceWorkerLog,
  pauseOfflineWarmup,
  persistOfflineReady,
  queryOfflineCachedFiles,
  queryOfflineReadyState,
  readPersistedOfflineReady,
  resumeOfflineWarmup,
  scheduleOfflineWarmup,
  setOfflineWarmupEnabled,
  subscribeOfflineCopyState,
};
