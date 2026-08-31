import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bumpOfflineWarmupPriority,
  createOfflineWarmupProgressGate,
  listenForOfflinePrecacheProgress,
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
  cancel?.();
  cancel = undefined;
  await flush();
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

    post({ action: "offline-precache-progress", cachedFiles: 12, totalFiles: 40 });
    expect(onProgress).toHaveBeenLastCalledWith({
      cachedBytes: 0,
      cachedFiles: 12,
      pendingUnits: 28,
      phase: "precache",
      ready: false,
      totalBytes: 0,
      totalFiles: 40,
    });

    post({ action: "offline-precache-progress", cachedFiles: "junk", totalFiles: -1 });
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ cachedFiles: 0, totalFiles: 0 }));

    stop();
    post({ action: "offline-precache-progress", cachedFiles: 13, totalFiles: 40 });
    expect(onProgress).toHaveBeenCalledTimes(2);
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

    cancel = scheduleOfflineWarmup({ idleDelayMs: 0, navigator: { serviceWorker } });
    await flush();

    expect(messages.map((message) => message.action)).toEqual(["offline-warmup-pump"]);
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

    pauseOfflineWarmup();
    cancel = scheduleOfflineWarmup({ delayMs: 0, idleDelayMs: 0, navigator: { serviceWorker } });
    await flush();
    expect(messages).toHaveLength(0);

    resumeOfflineWarmup();
    await flush();
    expect(messages.length).toBeGreaterThan(0);
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
    // The bump message reorders the worker's queue for the emulator page's own
    // fetches, but the ~30 MB core set is not pulled on a metered connection.
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

  it("stops pumping after cancel", async () => {
    const replies = Array.from({ length: 50 }, () => progressReply());
    const { controller, messages } = createFakeController(replies);
    const { serviceWorker } = createServiceWorker(controller);

    cancel = scheduleOfflineWarmup({ delayMs: 0, idleDelayMs: 0, navigator: { serviceWorker } });
    await flush(4);
    cancel();
    cancel = undefined;
    const posted = messages.length;
    await flush();
    expect(messages.length).toBe(posted);
  });
});
