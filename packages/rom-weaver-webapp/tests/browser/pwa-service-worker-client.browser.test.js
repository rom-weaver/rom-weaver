import { expect, test, vi } from "vitest";
import { createPwaServiceWorkerClient } from "../../src/webapp/pwa/pwa-service-worker-client.ts";

const COI_COEP_CREDENTIALLESS_ACTION = "set-coep-credentialless";
const COI_RELOADED_BY_SELF_KEY = "rom-weaver-coi-reloaded-by-self";

const flushAsync = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const createSessionStorage = () => {
  const state = new Map();
  return {
    getItem: (key) => (state.has(key) ? state.get(key) : null),
    removeItem: (key) => {
      state.delete(key);
    },
    setItem: (key, value) => {
      state.set(key, String(value));
    },
  };
};

const createController = () => {
  return {
    postMessage: vi.fn((message, transfer) => {
      if (message?.action !== "get-service-worker-cache-version") return;
      const port = Array.isArray(transfer) ? transfer[0] : null;
      port?.postMessage?.({
        precacheName: "precache-rom-weaver-test",
        precacheVersion: "test",
      });
    }),
  };
};

const createHarness = ({ controller = null, crossOriginIsolated = false } = {}) => {
  const sessionStorage = createSessionStorage();
  const location = {
    href: "https://example.com/webapp/index.html",
    reload: vi.fn(),
  };
  const browserWindow = {
    addEventListener: vi.fn(),
    clearInterval: vi.fn(),
    crossOriginIsolated,
    location,
    setInterval: vi.fn(() => 1),
  };
  const registration = {
    active: { scriptURL: "https://example.com/cache-service-worker.js" },
    installing: null,
    scope: "https://example.com/webapp/",
    unregister: vi.fn(async () => true),
    update: vi.fn(async () => undefined),
    waiting: null,
  };
  const serviceWorker = {
    addEventListener: vi.fn(),
    controller,
    getRegistrations: vi.fn(async () => []),
  };
  const navigatorLike = { serviceWorker };
  let registerOptions;
  // Models virtual:pwa-register's prompt mode: the reloadPage argument is ignored, and once the
  // incoming worker takes control the registrar reloads the page unless onNeedReload is supplied.
  const updateServiceWorker = vi.fn(async () => {
    if (registerOptions?.onNeedReload) registerOptions.onNeedReload();
    else location.reload();
  });
  const registerServiceWorker = (options) => {
    registerOptions = options;
    queueMicrotask(() => {
      options.onRegisteredSW?.("/cache-service-worker.js", registration);
    });
    return updateServiceWorker;
  };
  const client = createPwaServiceWorkerClient({
    cachePrefix: "precache-rom-weaver-",
    cacheVersionTimeoutMs: 50,
    document: {
      addEventListener: vi.fn(),
      visibilityState: "visible",
    },
    enabled: true,
    navigator: navigatorLike,
    onConfirmReload: async () => true,
    onStateChange: () => undefined,
    registerServiceWorker,
    sessionStorage,
    updateIntervalMs: 5000,
    window: browserWindow,
  });

  return {
    client,
    controller,
    getRegisterOptions: () => registerOptions,
    location,
    registration,
    serviceWorker,
    sessionStorage,
    triggerNeedRefresh: () => registerOptions?.onNeedRefresh?.(),
    updateServiceWorker,
  };
};

test("initializes in controlled isolated mode without reloading", async () => {
  const controller = createController();
  const harness = createHarness({ controller, crossOriginIsolated: true });

  harness.client.initialize();
  expect(harness.getRegisterOptions().immediate).toBe(false);
  expect(harness.client.getState().serviceWorkerStatus).toBe("active");
  await flushAsync();

  expect(harness.location.reload).not.toHaveBeenCalled();
  expect(harness.client.getState().serviceWorkerStatus).toBe("active");
  expect(harness.controller.postMessage).toHaveBeenCalledWith({
    action: COI_COEP_CREDENTIALLESS_ACTION,
    value: true,
  });
});

test("reloads once to gain control when registration is active but uncontrolled", async () => {
  const harness = createHarness({
    controller: null,
  });

  harness.client.initialize();
  expect(harness.getRegisterOptions().immediate).toBe(true);
  await flushAsync();

  expect(harness.client.getState().serviceWorkerStatus).toBe("ready");
  expect(harness.location.reload).toHaveBeenCalledTimes(1);
  expect(harness.sessionStorage.getItem(COI_RELOADED_BY_SELF_KEY)).toBe("notcontrolling");
});

test("does not reload to gain control when server headers already isolated the page", async () => {
  const harness = createHarness({
    controller: null,
    crossOriginIsolated: true,
  });

  harness.client.initialize();
  await flushAsync();

  expect(harness.location.reload).not.toHaveBeenCalled();
  expect(harness.sessionStorage.getItem(COI_RELOADED_BY_SELF_KEY)).toBe(null);
});

test("defers every update to the visible prompt", async () => {
  const controller = createController();
  const harness = createHarness({
    controller,
    crossOriginIsolated: true,
  });

  harness.client.initialize();
  await flushAsync();
  harness.triggerNeedRefresh();
  await flushAsync();

  expect(harness.updateServiceWorker).not.toHaveBeenCalled();
  expect(harness.location.reload).not.toHaveBeenCalled();
  expect(harness.client.getState().updateReady).toBe(true);
});

test("reloads when the user applies a deferred update from the prompt", async () => {
  const controller = createController();
  const harness = createHarness({
    controller,
    crossOriginIsolated: true,
  });

  harness.client.initialize();
  await flushAsync();
  harness.triggerNeedRefresh();
  expect(await harness.client.reloadPendingUpdate()).toBe(true);
  await flushAsync();

  expect(harness.location.reload).toHaveBeenCalledTimes(1);
  expect(harness.client.getState().updateReady).toBe(false);
});

test("degrades to require-corp and reloads when controlled but still not isolated", async () => {
  const controller = createController();
  const harness = createHarness({
    controller,
    crossOriginIsolated: false,
  });

  harness.client.initialize();
  await flushAsync();

  expect(harness.controller.postMessage).toHaveBeenCalledWith({
    action: COI_COEP_CREDENTIALLESS_ACTION,
    value: false,
  });
  expect(harness.location.reload).toHaveBeenCalledTimes(1);
  expect(harness.sessionStorage.getItem(COI_RELOADED_BY_SELF_KEY)).toBe("coepdegrade");
});
