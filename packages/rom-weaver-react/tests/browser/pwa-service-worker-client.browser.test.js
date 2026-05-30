import { expect, test, vi } from "vitest";
import { createPwaServiceWorkerClient } from "../../src/webapp/pwa/pwa-service-worker-client.ts";

const COI_COEP_CREDENTIALLESS_ACTION = "set-coep-credentialless";
const COI_RELOADED_BY_SELF_KEY = "rom-weaver-coi-reloaded-by-self";

const flushAsync = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const createSessionStorage = (seed = {}) => {
  const state = new Map(Object.entries(seed));
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

const createHarness = ({ controller = null, crossOriginIsolated = false, sessionStorageSeed = {} } = {}) => {
  const sessionStorage = createSessionStorage(sessionStorageSeed);
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
  const registerServiceWorker = (options) => {
    queueMicrotask(() => {
      options.onRegisteredSW?.("/cache-service-worker.js", registration);
    });
    return async () => undefined;
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
    location,
    registration,
    serviceWorker,
    sessionStorage,
  };
};

test("initializes in controlled isolated mode without reloading", async () => {
  const controller = createController();
  const harness = createHarness({ controller, crossOriginIsolated: true });

  harness.client.initialize();
  await flushAsync();

  expect(harness.location.reload).not.toHaveBeenCalled();
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
  await flushAsync();

  expect(harness.location.reload).toHaveBeenCalledTimes(1);
  expect(harness.sessionStorage.getItem(COI_RELOADED_BY_SELF_KEY)).toBe("notcontrolling");
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
