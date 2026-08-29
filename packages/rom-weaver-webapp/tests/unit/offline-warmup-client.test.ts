import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bumpOfflineWarmupPriority,
  pauseOfflineWarmup,
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
  cancel?.();
  cancel = undefined;
  await flush();
});

describe("offline warm-up client", () => {
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

  it("posts a bump message and pumps immediately, even on data saver", async () => {
    const { controller, messages } = createFakeController([
      progressReply({ unit: "emulatorjs:loader.js" }),
      progressReply({ ready: true, unit: "emulatorjs:cores/core.wasm" }),
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

    bumpOfflineWarmupPriority({ kind: "emulatorjs" });
    await flush();
    expect(messages[0]).toMatchObject({ action: "offline-warmup-bump", target: { kind: "emulatorjs" } });
    expect(messages.filter((message) => message.action === "offline-warmup-pump").length).toBeGreaterThan(0);
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
