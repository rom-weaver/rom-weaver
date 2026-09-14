import { afterEach, describe, expect, it, vi } from "vitest";
import { configureLogger } from "../../src/lib/logging.ts";
import {
  bumpOfflineWarmupPriority,
  createOfflineWarmupProgressGate,
  downloadOfflineCopy,
  listenForOfflinePrecacheProgress,
  listenForServiceWorkerLog,
  pauseOfflineWarmup,
  queryOfflineCachedFiles,
  resumeOfflineWarmup,
  scheduleOfflineWarmup,
} from "../../src/webapp/pwa/offline-warmup-client.ts";

type Reply = Record<string, unknown>;

/**
 * Fake service worker controller: records every posted message, and answers
 * pump/ready-state requests over the transferred port from a scripted list.
 */
const createFakeController = (replies: Reply[]) => {
  const messages: Reply[] = [];
  const controller = {
    postMessage: (message: Reply, transfer?: Transferable[]) => {
      messages.push(message);
      const port = transfer?.[0] as MessagePort | undefined;
      if (!port) return;
      const reply = replies.shift() ?? { action: "offline-warmup-failed", error: "no scripted reply" };
      // Reply asynchronously, as a real worker would.
      setTimeout(() => port.postMessage(reply), 0);
    },
  } as unknown as ServiceWorker;
  return { controller, messages };
};

const createServiceWorker = (controller: ServiceWorker | null) => {
  const listeners: (() => void)[] = [];
  const serviceWorker = {
    controller,
    addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
    removeEventListener: vi.fn(),
  };
  const notifyControllerChange = () => {
    for (const listener of listeners) listener();
  };
  return { serviceWorker, notifyControllerChange };
};

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const progressReply = (overrides: Reply = {}): Reply => ({
  action: "offline-warmup-progress",
  cachedBytes: 1,
  pendingUnits: 1,
  ready: false,
  totalBytes: 2,
  unit: "emulatorjs:loader.js",
  ...overrides,
});

let cancel: (() => void) | undefined;

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cancel?.();
  cancel = undefined;
  await flush();
  configureLogger({ level: "warn", sink: null });
});

describe("offline warm-up client", () => {
  it("ignores an initial snapshot that arrives after live progress", () => {
    const onProgress = vi.fn();
    const gate = createOfflineWarmupProgressGate(onProgress);
    const completed = {
      cachedBytes: 2,
      cachedFiles: 2,
      pendingUnits: 0,
      ready: true,
      totalBytes: 2,
      totalFiles: 2,
    };

    gate.acceptLive({ ...completed, detail: null, unit: null, unitLoadedBytes: null, unitTotalBytes: null });
    gate.acceptSnapshot({ ...completed, cachedBytes: 1, pendingUnits: 1, ready: false });

    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true }));
  });

  it("forwards precache progress only until a warmer source reports", () => {
    const onProgress = vi.fn();
    const gate = createOfflineWarmupProgressGate(onProgress);
    const precache = {
      cachedBytes: 0,
      cachedFiles: 3,
      pendingUnits: 7,
      ready: false,
      totalBytes: 0,
      totalFiles: 10,
    };

    gate.acceptPrecache(precache);
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ cachedFiles: 3, totalFiles: 10 }));

    gate.acceptSnapshot({ ...precache, cachedBytes: 5, totalBytes: 20 });
    gate.acceptPrecache({ ...precache, cachedFiles: 4 });
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ totalBytes: 20 }));
  });

  it("relays service worker log lines into the page log and cleans up", () => {
    const listeners: Array<(event: MessageEvent) => void> = [];
    const posted: unknown[] = [];
    const serviceWorker = {
      controller: { postMessage: (message: unknown) => posted.push(message) },
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.push(listener),
      removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
    };
    const sink = vi.fn();
    configureLogger({ level: "debug", sink });
    const stop = listenForServiceWorkerLog({ serviceWorker });
    expect(posted).toEqual([{ action: "flush-service-worker-log" }]);
    const post = (data: unknown) => {
      for (const listener of listeners.slice()) listener({ data } as MessageEvent);
    };

    post({ action: "offline-precache-progress" });
    expect(sink).not.toHaveBeenCalled();

    post({ action: "service-worker-log", details: { url: "/assets/identify-x.pack" }, message: "identify pack fetch" });
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({
        details: { url: "/assets/identify-x.pack" },
        level: "debug",
        message: "identify pack fetch",
        namespace: "rom-weaver-service-worker",
      }),
    );

    stop();
    sink.mockClear();
    post({ action: "service-worker-log", message: "after stop" });
    expect(sink).not.toHaveBeenCalled();
    configureLogger({ level: "warn", sink: null });
  });

  it("stamps a replayed worker line with the time the worker wrote it", () => {
    const listeners: Array<(event: MessageEvent) => void> = [];
    const serviceWorker = {
      controller: { postMessage: () => undefined },
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.push(listener),
      removeEventListener: () => undefined,
    };
    const sink = vi.fn();
    configureLogger({ level: "debug", sink });
    listenForServiceWorkerLog({ serviceWorker });

    for (const listener of listeners.slice()) {
      listener({
        data: {
          action: "service-worker-log",
          message: "install event",
          queued: true,
          timestamp: "2026-09-03T17:00:00.000Z",
        },
      } as MessageEvent);
    }

    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ details: { queuedAt: "2026-09-03T17:00:00.000Z" }, message: "install event" }),
    );
    configureLogger({ level: "warn", sink: null });
  });

  it("listens for precache broadcasts and cleans the listener up", () => {
    const listeners: Array<(event: MessageEvent) => void> = [];
    const serviceWorker = {
      controller: null,
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.push(listener),
      removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
    };
    const onProgress = vi.fn();
    const stop = listenForOfflinePrecacheProgress(onProgress, { serviceWorker });
    const post = (data: unknown) => {
      for (const listener of listeners.slice()) listener({ data } as MessageEvent);
    };

    post({ action: "service-worker-cache-version" });
    expect(onProgress).not.toHaveBeenCalled();

    post({
      action: "offline-precache-progress",
      cachedBytes: 300,
      cachedFiles: 12,
      pendingUnits: 5,
      totalBytes: 1200,
      totalFiles: 40,
      transferredBytes: 200,
      transferBytesIncomplete: true,
    });
    expect(onProgress).toHaveBeenLastCalledWith({
      cachedBytes: 300,
      cachedFiles: 12,
      pendingUnits: 5,
      phase: "precache",
      ready: false,
      totalBytes: 1200,
      totalFiles: 40,
      transferredBytes: 200,
      transferBytesIncomplete: true,
    });

    for (const transferredBytes of [-1, Infinity, NaN, "200"]) {
      post({
        action: "offline-precache-progress",
        cachedBytes: "junk",
        cachedFiles: "junk",
        totalFiles: -1,
        transferredBytes,
        transferBytesIncomplete: "yes",
      });
      expect(onProgress).toHaveBeenLastCalledWith(
        expect.objectContaining({ cachedBytes: 0, cachedFiles: 0, totalBytes: 0, totalFiles: 0 }),
      );
      expect(onProgress.mock.lastCall?.[0]).not.toHaveProperty("transferredBytes");
      expect(onProgress.mock.lastCall?.[0]).not.toHaveProperty("transferBytesIncomplete");
    }

    post({ action: "offline-precache-progress", transferredBytes: 0, transferBytesIncomplete: false });
    expect(onProgress.mock.lastCall?.[0]).toMatchObject({ transferredBytes: 0, transferBytesIncomplete: false });

    post({ action: "offline-precache-progress" });
    expect(onProgress.mock.lastCall?.[0]).not.toHaveProperty("transferredBytes");
    expect(onProgress.mock.lastCall?.[0]).not.toHaveProperty("transferBytesIncomplete");

    stop();
    post({ action: "offline-precache-progress", cachedFiles: 13, totalFiles: 40 });
    expect(onProgress).toHaveBeenCalledTimes(7);
  });

  it("queries the service worker for cached files", async () => {
    const files = [
      {
        cache: "emulatorjs-4.2.3",
        compressedBytes: 120,
        sizeBytes: 400,
        url: "https://example.test/emulatorjs/data/loader.js",
      },
    ];
    const { controller, messages } = createFakeController([{ action: "offline-cached-files", files }]);
    const { serviceWorker } = createServiceWorker(controller);

    await expect(queryOfflineCachedFiles({ serviceWorker })).resolves.toEqual(files);
    expect(messages).toEqual([{ action: "get-offline-cached-files" }]);
  });

  it("stops waiting quickly when an older service worker ignores the inventory query", async () => {
    vi.useFakeTimers();
    const controller = { postMessage: vi.fn() } as unknown as ServiceWorker;
    const { serviceWorker } = createServiceWorker(controller);

    const result = expect(queryOfflineCachedFiles({ serviceWorker })).rejects.toThrow(
      "offline warm-up get-offline-cached-files timed out",
    );
    await vi.advanceTimersByTimeAsync(2000);
    await result;
    vi.useRealTimers();
  });

  it("pumps sequentially after the start delay and stops on ready", async () => {
    const { controller, messages } = createFakeController([
      progressReply(),
      progressReply({ cachedBytes: 2, pendingUnits: 0, ready: true, unit: "identify-group:optional-computers" }),
    ]);
    const { serviceWorker } = createServiceWorker(controller);
    const onProgress = vi.fn();

    cancel = scheduleOfflineWarmup({
      delayMs: 0,
      idleDelayMs: 0,
      navigator: { serviceWorker },
      onProgress,
    });
    await flush();

    expect(messages.map((message) => message.action)).toEqual(["offline-warmup-pump", "offline-warmup-pump"]);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls[1]?.[0]).toMatchObject({ ready: true });
  });

  it("starts the first low-priority pump without a default delay", async () => {
    const { controller, messages } = createFakeController([progressReply({ ready: true })]);
    const { serviceWorker } = createServiceWorker(controller);

    cancel = scheduleOfflineWarmup({ navigator: { serviceWorker } });
    await flush();

    expect(messages.map((message) => message.action)).toEqual(["offline-warmup-pump"]);
  });

  it("yields between default fallback pumps without a 250 ms wait", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    const { controller, messages } = createFakeController([progressReply(), progressReply({ ready: true })]);
    const { serviceWorker } = createServiceWorker(controller);
    const observedPumpCounts: number[] = [];

    cancel = scheduleOfflineWarmup({
      navigator: { serviceWorker },
      onProgress: (progress) => {
        if (!progress.ready) setTimeout(() => observedPumpCounts.push(messages.length), 0);
      },
    });
    await flush();

    expect(messages).toHaveLength(2);
    expect(observedPumpCounts).toEqual([1]);
  });

  it("honors a pause between default fallback pumps", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    const { controller, messages } = createFakeController([progressReply(), progressReply({ ready: true })]);
    const { serviceWorker } = createServiceWorker(controller);

    cancel = scheduleOfflineWarmup({
      navigator: { serviceWorker },
      onProgress: (progress) => {
        if (!progress.ready) pauseOfflineWarmup();
      },
    });
    try {
      await flush(8);
      expect(messages.map(({ action }) => action)).toEqual(["offline-warmup-pump", "offline-warmup-pause"]);

      resumeOfflineWarmup();
      await flush(8);
      expect(messages.map(({ action }) => action)).toEqual([
        "offline-warmup-pump",
        "offline-warmup-pause",
        "offline-warmup-pump",
      ]);
    } finally {
      resumeOfflineWarmup();
    }
  });

  it("does not pump before the delay elapses or without a controller", async () => {
    const { controller, messages } = createFakeController([]);
    const { serviceWorker, notifyControllerChange } = createServiceWorker(null);

    cancel = scheduleOfflineWarmup({ delayMs: 0, idleDelayMs: 0, navigator: { serviceWorker } });
    await flush();
    expect(messages).toHaveLength(0);

    (serviceWorker as { controller: ServiceWorker | null }).controller = controller;
    notifyControllerChange();
    await flush();
    expect(messages.length).toBeGreaterThan(0);
  });

  it("holds pumping while paused and continues on resume", async () => {
    const { controller, messages } = createFakeController([
      progressReply(),
      progressReply({ ready: true, unit: null }),
    ]);
    const { serviceWorker } = createServiceWorker(controller);
    const sink = vi.fn();
    configureLogger({ level: "debug", sink });

    pauseOfflineWarmup();
    cancel = scheduleOfflineWarmup({ delayMs: 0, idleDelayMs: 0, navigator: { serviceWorker } });
    await flush();
    expect(messages).toHaveLength(0);

    resumeOfflineWarmup();
    await flush();
    expect(messages.length).toBeGreaterThan(0);
    const resumeLog = sink.mock.calls
      .map(([record]) => record)
      .find(({ message }) => message === "offline warm-up interactive wait ended");
    expect(resumeLog?.details).toMatchObject({ aborted: false, pauseCount: 0 });
    expect(resumeLog?.details?.durationMs).toBeGreaterThanOrEqual(10);
  });

  it("downloads every unit on data saver after an explicit request without starting duplicate pumps", async () => {
    const { controller, messages } = createFakeController([
      progressReply({ unit: "app-files" }),
      progressReply({ unit: "emulatorjs:loader.js" }),
      progressReply({ unit: "identify-group:default", ready: true }),
    ]);
    const { serviceWorker } = createServiceWorker(controller);
    const onProgress = vi.fn();
    cancel = scheduleOfflineWarmup({ navigator: { connection: { saveData: true }, serviceWorker }, onProgress });
    await flush();
    expect(messages).toHaveLength(0);
    expect(downloadOfflineCopy()).toBe(true);
    expect(downloadOfflineCopy()).toBe(true);
    await flush();
    expect(messages.map(({ action }) => action)).toEqual(Array(3).fill("offline-warmup-pump"));
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ ready: true }));
  });

  it("keeps a manual request until a service worker controls the page", async () => {
    const { controller, messages } = createFakeController([progressReply({ ready: true })]);
    const { serviceWorker, notifyControllerChange } = createServiceWorker(null);
    cancel = scheduleOfflineWarmup({ navigator: { connection: { saveData: true }, serviceWorker } });
    expect(downloadOfflineCopy()).toBe(true);
    await flush();
    expect(messages).toHaveLength(0);
    serviceWorker.controller = controller;
    notifyControllerChange();
    await flush();
    expect(messages.map(({ action }) => action)).toEqual(["offline-warmup-pump"]);
  });

  it("still waits for interactive work before starting an explicit download", async () => {
    const { controller, messages } = createFakeController([progressReply({ ready: true })]);
    const { serviceWorker } = createServiceWorker(controller);
    pauseOfflineWarmup();
    try {
      cancel = scheduleOfflineWarmup({ navigator: { connection: { saveData: true }, serviceWorker } });
      expect(downloadOfflineCopy()).toBe(true);
      await flush();
      expect(messages).toHaveLength(0);
      resumeOfflineWarmup();
      await flush();
      expect(messages.map(({ action }) => action)).toEqual(["offline-warmup-pump"]);
    } finally {
      resumeOfflineWarmup();
    }
  });

  it("does not preserve a manual override after the scheduler is cancelled", async () => {
    const { controller, messages } = createFakeController([progressReply({ ready: true })]);
    const { serviceWorker } = createServiceWorker(controller);
    const navigator = { connection: { saveData: true }, serviceWorker };
    cancel = scheduleOfflineWarmup({ navigator });
    downloadOfflineCopy();
    await flush();
    cancel();
    expect(downloadOfflineCopy()).toBe(false);
    cancel = scheduleOfflineWarmup({ navigator });
    await flush();
    expect(messages).toHaveLength(1);
  });

  it("starts a requested download when the browser comes back online", async () => {
    const listeners = new EventTarget();
    vi.stubGlobal("addEventListener", listeners.addEventListener.bind(listeners));
    vi.stubGlobal("removeEventListener", listeners.removeEventListener.bind(listeners));
    const { controller, messages } = createFakeController([progressReply(), progressReply({ ready: true })]);
    const { serviceWorker } = createServiceWorker(controller);
    const navigator = { connection: { saveData: true }, onLine: false, serviceWorker };
    cancel = scheduleOfflineWarmup({ navigator });
    expect(downloadOfflineCopy()).toBe(true);
    await flush();
    expect(messages).toHaveLength(0);
    navigator.onLine = true;
    listeners.dispatchEvent(new Event("online"));
    await flush();
    expect(messages.map(({ action }) => action)).toEqual(Array(2).fill("offline-warmup-pump"));
  });

  it("does not restart a completed manual download when the automatic start delay ends", async () => {
    vi.useFakeTimers();
    const { controller, messages } = createFakeController([progressReply({ ready: true })]);
    const { serviceWorker } = createServiceWorker(controller);
    const onProgress = vi.fn();
    cancel = scheduleOfflineWarmup({ delayMs: 1000, navigator: { serviceWorker }, onProgress });
    expect(downloadOfflineCopy()).toBe(true);
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ ready: true })));
    await vi.advanceTimersByTimeAsync(1000);
    expect(messages.map(({ action }) => action)).toEqual(["offline-warmup-pump"]);
  });

  it("posts an identify-group bump and pumps immediately, even on data saver", async () => {
    const { controller, messages } = createFakeController([
      progressReply({ unit: "identify-group:optional-computers" }),
      progressReply({ ready: true, unit: "emulatorjs:loader.js" }),
    ]);
    const { serviceWorker } = createServiceWorker(controller);

    cancel = scheduleOfflineWarmup({
      delayMs: 0,
      idleDelayMs: 0,
      navigator: { connection: { saveData: true }, serviceWorker },
    });
    await flush();
    // Data saver: no automatic pumping.
    expect(messages).toHaveLength(0);

    bumpOfflineWarmupPriority({ groupIds: ["optional-computers"], kind: "identify-groups" });
    await flush();
    expect(messages[0]).toMatchObject({
      action: "offline-warmup-bump",
      target: { groupIds: ["optional-computers"], kind: "identify-groups" },
    });
    expect(messages.filter((message) => message.action === "offline-warmup-pump").length).toBeGreaterThan(0);
  });

  it("only reorders on an emulatorjs bump under data saver - no pumping", async () => {
    const { controller, messages } = createFakeController([]);
    const { serviceWorker } = createServiceWorker(controller);

    cancel = scheduleOfflineWarmup({
      delayMs: 0,
      idleDelayMs: 0,
      navigator: { connection: { saveData: true }, serviceWorker },
    });
    await flush();

    bumpOfflineWarmupPriority({ kind: "emulatorjs" });
    await flush();
    // An EmulatorJS bump may reorder the queue on data saver, but only the player's on-demand requests fetch assets.
    expect(messages).toEqual([{ action: "offline-warmup-bump", target: { kind: "emulatorjs" } }]);
  });

  it("forwards interim progress events without ending the pump", async () => {
    const onProgress = vi.fn();
    const messages: Reply[] = [];
    const controller = {
      postMessage: (message: Reply, transfer?: Transferable[]) => {
        messages.push(message);
        const port = transfer?.[0] as MessagePort | undefined;
        if (!port) return;
        setTimeout(() => {
          port.postMessage({ action: "offline-warmup-interim", cachedBytes: 1, ready: false, totalBytes: 4 });
          port.postMessage({ action: "offline-warmup-interim", cachedBytes: 2, ready: false, totalBytes: 4 });
          port.postMessage(progressReply({ cachedBytes: 4, ready: true, unit: null }));
        }, 0);
      },
    } as unknown as ServiceWorker;
    const { serviceWorker } = createServiceWorker(controller);

    cancel = scheduleOfflineWarmup({ delayMs: 0, idleDelayMs: 0, navigator: { serviceWorker }, onProgress });
    await flush();

    // Two interim events plus the final progress reply, in order.
    expect(onProgress.mock.calls.map(([progress]) => progress.cachedBytes)).toEqual([1, 2, 4]);
    expect(messages.filter((message) => message.action === "offline-warmup-pump")).toHaveLength(1);
  });

  it("logs measured pump and idle waits with decoded progress totals", async () => {
    vi.stubGlobal("requestIdleCallback", undefined);
    const replies = [
      progressReply({ cachedFiles: 1, totalFiles: 2, transferredBytes: 123 }),
      progressReply({ cachedBytes: 2, cachedFiles: 2, pendingUnits: 0, ready: true, totalFiles: 2 }),
    ];
    const messages: Reply[] = [];
    const controller = {
      postMessage: (message: Reply, transfer?: Transferable[]) => {
        messages.push(message);
        const port = transfer?.[0] as MessagePort | undefined;
        if (port) setTimeout(() => port.postMessage(replies.shift()), 12);
      },
    } as unknown as ServiceWorker;
    const { serviceWorker } = createServiceWorker(controller);
    const sink = vi.fn();
    configureLogger({ level: "debug", sink });

    cancel = scheduleOfflineWarmup({
      delayMs: 0,
      idleDelayMs: 20,
      navigator: { connection: { downlink: 3, effectiveType: "3g", rtt: 300 }, serviceWorker },
    });
    await flush(90);

    const logs = sink.mock.calls.map(([record]) => record);
    expect(logs.find(({ message }) => message === "offline warm-up scheduler started")?.details).toMatchObject({
      delayMs: 0,
      downlinkMbpsHint: 3,
      effectiveType: "3g",
      idleDelayMs: 20,
      idleMechanism: "timer",
      rttMsHint: 300,
    });
    const requests = logs.filter(({ message }) => message === "offline warm-up pump requested");
    const completions = logs.filter(({ message }) => message === "offline warm-up pump completed");
    expect(messages).toHaveLength(2);
    expect(requests).toHaveLength(2);
    expect(completions).toHaveLength(2);
    expect(completions[0]?.details).toMatchObject({
      cachedFiles: 1,
      decodedCachedByteCount: 1,
      decodedTotalByteCount: 2,
      transferredByteCount: 123,
      pendingUnits: 1,
      pumpNumber: 1,
      totalFiles: 2,
      unit: "emulatorjs:loader.js",
    });
    expect(completions[0]?.details?.durationMs).toBeGreaterThanOrEqual(10);
    expect(
      logs.find(({ message }) => message === "offline warm-up idle wait ended")?.details?.durationMs,
    ).toBeGreaterThanOrEqual(15);
    expect(requests[1]?.details?.sincePreviousPumpMs).toBeGreaterThanOrEqual(15);
    expect(completions[0]?.details).not.toHaveProperty("networkMbps");
  });

  it("logs an aborted interactive wait without starting a pump", async () => {
    const { controller, messages } = createFakeController([progressReply({ ready: true })]);
    const { serviceWorker } = createServiceWorker(controller);
    const sink = vi.fn();
    configureLogger({ level: "debug", sink });

    pauseOfflineWarmup();
    try {
      cancel = scheduleOfflineWarmup({ delayMs: 0, idleDelayMs: 0, navigator: { serviceWorker } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      cancel();
      cancel = undefined;
      resumeOfflineWarmup();
      await flush(5);

      const logs = sink.mock.calls.map(([record]) => record);
      expect(logs.some(({ message }) => message === "offline warm-up waiting for interactive work")).toBe(true);
      expect(logs.find(({ message }) => message === "offline warm-up interactive wait ended")?.details).toMatchObject({
        aborted: true,
      });
      expect(
        logs.find(({ message }) => message === "offline warm-up interactive wait ended")?.details?.durationMs,
      ).toBeGreaterThanOrEqual(15);
      expect(messages).toHaveLength(0);
    } finally {
      resumeOfflineWarmup();
    }
  });

  it("stops pumping after cancel", async () => {
    const replies = Array.from({ length: 50 }, () => progressReply());
    const { controller, messages } = createFakeController(replies);
    const { serviceWorker } = createServiceWorker(controller);

    cancel = scheduleOfflineWarmup({ delayMs: 0, navigator: { serviceWorker } });
    await flush(4);
    cancel();
    cancel = undefined;
    const posted = messages.length;
    await flush();
    expect(messages.length).toBe(posted);
  });
});
