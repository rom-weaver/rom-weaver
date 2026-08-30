/**
 * Page-side driver for the service worker's offline warm-up. The page pumps
 * the worker one unit at a time. The first low-priority unit starts as soon as
 * the worker controls the page, then later units wait for browser idle time.
 * On data-saver connections the automatic loop stays off; explicit priority
 * bumps (an identify run, the emulator test view) still download what they name.
 */
import { createLogger } from "../../lib/logging.ts";
import type { OfflineCachedFile, OfflineReadyState, WarmupBumpTarget, WarmupProgress } from "../offline-warmup.ts";

const IDLE_DELAY_MS = 250;
const PUMP_TIMEOUT_MS = 120_000;
const CACHE_INVENTORY_TIMEOUT_MS = 2000;
const MAX_FAILURE_DELAY_MS = 30_000;
const logger = createLogger("offline-warmup");

type OfflineWarmupProgress = WarmupProgress;

type ServiceWorkerContainerLike = {
  controller: ServiceWorker | null;
  addEventListener?: (type: "controllerchange", listener: () => void) => void;
  removeEventListener?: (type: "controllerchange", listener: () => void) => void;
};

type NavigatorLike = {
  serviceWorker?: ServiceWorkerContainerLike;
  onLine?: boolean;
  connection?: { saveData?: boolean };
};

type ScheduleOfflineWarmupOptions = {
  delayMs?: number;
  idleDelayMs?: number;
  navigator?: NavigatorLike;
  onProgress?: (progress: OfflineWarmupProgress) => void;
};

const createOfflineWarmupProgressGate = (onProgress: (progress: OfflineReadyState) => void) => {
  let liveProgressReceived = false;
  return {
    acceptLive: (progress: OfflineWarmupProgress) => {
      liveProgressReceived = true;
      onProgress(progress);
    },
    acceptSnapshot: (progress: OfflineReadyState) => {
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
  notifyResume: () => void;
} | null = null;
let pauseCount = 0;
const pendingBumps: WarmupBumpTarget[] = [];

/** Hold the warm-up while interactive downloads run. Balanced by resumeOfflineWarmup. */
const pauseOfflineWarmup = () => {
  pauseCount += 1;
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
  if (activeController) activeController.bump(target);
  else pendingBumps.push(target);
};

const postPump = (
  controller: ServiceWorker,
  action: string,
  onInterim?: (data: Record<string, unknown>) => void,
  timeoutMs = PUMP_TIMEOUT_MS,
): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // Interim events reset the deadline: a large file on a slow connection is
    // alive as long as bytes keep arriving.
    const armTimeout = () => {
      timeout = setTimeout(() => {
        channel.port1.onmessage = null;
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
      channel.port1.onmessage = null;
      resolve(data);
    };
    try {
      controller.postMessage({ action }, [channel.port2]);
    } catch (error) {
      clearTimeout(timeout);
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
  const idleDelayMs = options.idleDelayMs ?? IDLE_DELAY_MS;
  const saveData = nav?.connection?.saveData === true;
  // On data-saver, the loop runs only while a bump target is still pending.
  const activeBumps: WarmupBumpTarget[] = [];
  let loopRunning = false;
  let started = false;
  let resumeWaiters: (() => void)[] = [];
  let consecutiveFailures = 0;

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
    try {
      while (!signal.aborted) {
        while (pauseCount > 0 && !signal.aborted) await waitForResume();
        if (signal.aborted) return;
        if (nav?.onLine === false) {
          // Nothing can download offline. The loop exits; the online listener
          // and any bump restart it.
          logger.debug("offline warm-up paused; browser is offline");
          return;
        }
        const controller = serviceWorker.controller;
        if (!controller) return;
        let reply: Record<string, unknown>;
        try {
          reply = await postPump(controller, "offline-warmup-pump", (interim) => {
            options.onProgress?.(interim as unknown as OfflineWarmupProgress);
          });
        } catch (error) {
          consecutiveFailures += 1;
          const delay = Math.min(MAX_FAILURE_DELAY_MS, 1000 * 2 ** consecutiveFailures);
          logger.warn("offline warm-up pump failed", { delayMs: delay, error: formatError(error) });
          await waitMs(delay, signal);
          continue;
        }
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
        await waitForIdle(signal, idleDelayMs);
      }
    } finally {
      loopRunning = false;
    }
  };

  const bump = (target: WarmupBumpTarget) => {
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
    // On data saver, an emulatorjs bump only reorders the queue: pumping it
    // would download every core, while the emulator page itself fetches
    // exactly the files it needs through the runtime route. Identify-group
    // bumps are bounded, so they still pump.
    if (saveData && !started && target.kind === "emulatorjs") return;
    activeBumps.push(target);
    void runLoop();
  };

  activeController = { bump, notifyResume };

  const startWarmup = () => {
    if (started || signal.aborted || !serviceWorker.controller) return;
    serviceWorker.removeEventListener?.("controllerchange", startWarmup);
    const drained = pendingBumps.splice(0);
    for (const target of drained) bump(target);
    const begin = () => {
      if (signal.aborted) return;
      if (saveData) {
        logger.debug("offline warm-up auto-start skipped; data saver is on");
        return;
      }
      started = true;
      void runLoop();
    };
    const delayMs = options.delayMs ?? 0;
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
    if (started || activeBumps.length) void runLoop();
  };
  serviceWorker.addEventListener?.("controllerchange", onControllerChange);

  if (serviceWorker.controller) startWarmup();
  else serviceWorker.addEventListener?.("controllerchange", startWarmup);

  return () => {
    abortController.abort();
    if (activeController?.bump === bump) activeController = null;
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
  pauseOfflineWarmup,
  persistOfflineReady,
  queryOfflineCachedFiles,
  queryOfflineReadyState,
  readPersistedOfflineReady,
  resumeOfflineWarmup,
  scheduleOfflineWarmup,
};
