import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bumpOfflineWarmupPriority,
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
  it("queries the service worker for cached files", async () => {
    const files = [{ cache: "emulatorjs-4.2.3", url: "https://example.test/emulatorjs/data/loader.js" }];
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
