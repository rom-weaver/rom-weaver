import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:pwa-register", () => ({ registerSW: () => async () => undefined }));

const { createPwaServiceWorkerClient } = await import("../../src/webapp/pwa/pwa-service-worker-client.ts");
const { createServiceWorkerCacheState } = await import("../../src/webapp/pwa/service-worker-cache-state.ts");

type ClientOptions = Parameters<typeof createPwaServiceWorkerClient>[0];
type RegisterOptions = Parameters<NonNullable<ClientOptions["registerServiceWorker"]>>[0];

type FakeWorker = { scriptURL: string; state: string };

type FakeRegistration = {
  active: FakeWorker | null;
  installing: FakeWorker | null;
  scope: string;
  unregister: () => Promise<boolean>;
  update?: () => Promise<void>;
  waiting: FakeWorker | null;
};

type StorageFailure = "get" | "remove" | "set";

const APP_HREF = "https://example.com/webapp/index.html";
const APP_SCOPE = "https://example.com/webapp/";
const CACHE_PREFIX = "precache-rom-weaver-";
const CACHE_VERSION_TIMEOUT_MS = 20;
const COI_RELOADED_BY_SELF_KEY = "rom-weaver-coi-reloaded-by-self";

const createSessionStorage = (seed: Record<string, string> = {}, failOn: StorageFailure[] = []) => {
  const state = new Map<string, string>(Object.entries(seed));
  const failures = new Set(failOn);
  const refuse = (operation: StorageFailure) => {
    if (failures.has(operation)) throw new Error(`sessionStorage.${operation} is blocked`);
  };
  return {
    getItem: (key: string) => {
      refuse("get");
      return state.get(key) ?? null;
    },
    removeItem: (key: string) => {
      refuse("remove");
      state.delete(key);
    },
    setItem: (key: string, value: string) => {
      refuse("set");
      state.set(key, String(value));
    },
    state,
  };
};

const createRegistration = (overrides: Partial<FakeRegistration> = {}): FakeRegistration => ({
  active: { scriptURL: "https://example.com/cache-service-worker.js", state: "activated" },
  installing: null,
  scope: APP_SCOPE,
  unregister: vi.fn(async () => true),
  update: vi.fn(async () => undefined),
  waiting: null,
  ...overrides,
});

const DEFAULT_CACHE_VERSION_REPLY = { precacheName: "precache-rom-weaver-test", precacheVersion: "test" };

const createController = ({
  reply = DEFAULT_CACHE_VERSION_REPLY as Record<string, unknown> | null,
  throwOnPost = false,
}: { reply?: Record<string, unknown> | null; throwOnPost?: boolean } = {}) => ({
  postMessage: vi.fn((message: { action?: string }, transfer?: unknown[]) => {
    if (throwOnPost) throw new Error("the controller is gone");
    if (message.action !== "get-service-worker-cache-version" || !reply) return;
    const port = Array.isArray(transfer) ? (transfer[0] as MessagePort | undefined) : undefined;
    port?.postMessage(reply);
  }),
});

type HarnessOptions = {
  appVersion?: string;
  controller?: ReturnType<typeof createController> | null;
  crossOriginIsolated?: boolean;
  enabled?: boolean;
  getRegistrationsError?: Error;
  hasCrossOriginIsolated?: boolean;
  hasDocument?: boolean;
  hasLocationReload?: boolean;
  hasServiceWorker?: boolean;
  hasWindow?: boolean;
  onBeforeReload?: () => void;
  onConfirmReload?: () => Promise<boolean>;
  ready?: Promise<FakeRegistration> | "missing" | "never";
  registrations?: FakeRegistration[];
  sessionStorageFailOn?: StorageFailure[];
  sessionStorageSeed?: Record<string, string>;
  shouldAutoApplyUpdate?: () => boolean;
  visibilityState?: string;
};

const createHarness = ({
  appVersion = "app-under-test",
  controller = null,
  crossOriginIsolated = true,
  enabled = true,
  getRegistrationsError,
  hasCrossOriginIsolated = true,
  hasDocument = true,
  hasLocationReload = true,
  hasServiceWorker = true,
  hasWindow = true,
  onBeforeReload,
  onConfirmReload = async () => true,
  ready = "missing",
  registrations = [],
  sessionStorageFailOn = [],
  sessionStorageSeed = {},
  shouldAutoApplyUpdate,
  visibilityState = "visible",
}: HarnessOptions = {}) => {
  const sessionStorage = createSessionStorage(sessionStorageSeed, sessionStorageFailOn);
  const reload = vi.fn();
  const windowListeners = new Map<string, Array<() => void>>();
  const documentListeners = new Map<string, Array<() => void>>();
  const intervals: Array<{ handler: () => void; ms: number }> = [];
  const addTo = (map: Map<string, Array<() => void>>) => (type: string, listener: () => void) => {
    const existing = map.get(type);
    if (existing) existing.push(listener);
    else map.set(type, [listener]);
  };
  const browserWindow = {
    addEventListener: addTo(windowListeners),
    clearInterval: vi.fn(),
    ...(hasCrossOriginIsolated ? { crossOriginIsolated } : {}),
    location: hasLocationReload ? { href: APP_HREF, reload } : { href: APP_HREF },
    setInterval: vi.fn((handler: () => void, ms: number) => {
      intervals.push({ handler, ms });
      return intervals.length;
    }),
  };
  const registration = createRegistration();
  const serviceWorker = {
    addEventListener: addTo(documentListeners),
    controller,
    getRegistrations: vi.fn(async () => {
      if (getRegistrationsError) throw getRegistrationsError;
      return registrations;
    }),
    ...(ready === "missing" ? {} : { ready: ready === "never" ? new Promise<FakeRegistration>(() => {}) : ready }),
  };
  const states: Array<ReturnType<typeof createServiceWorkerCacheState>> = [];
  let registerOptions: RegisterOptions | undefined;
  let registerCount = 0;
  const updateServiceWorker = vi.fn(async () => undefined);
  const options = {
    appVersion,
    cachePrefix: CACHE_PREFIX,
    cacheVersionTimeoutMs: CACHE_VERSION_TIMEOUT_MS,
    document: hasDocument ? { addEventListener: addTo(documentListeners), visibilityState } : undefined,
    enabled,
    navigator: hasServiceWorker ? { serviceWorker } : {},
    onBeforeReload,
    onConfirmReload,
    onStateChange: (state: ReturnType<typeof createServiceWorkerCacheState>) => {
      states.push(state);
    },
    registerServiceWorker: (registerServiceWorkerOptions: RegisterOptions) => {
      registerOptions = registerServiceWorkerOptions;
      registerCount += 1;
      return updateServiceWorker;
    },
    sessionStorage,
    shouldAutoApplyUpdate,
    updateIntervalMs: 5000,
    window: hasWindow ? browserWindow : undefined,
  };
  const client = createPwaServiceWorkerClient(options as unknown as ClientOptions);

  return {
    client,
    controller,
    documentListeners,
    fireDocument: (type: string) => {
      for (const listener of documentListeners.get(type) ?? []) listener();
    },
    fireWindow: (type: string) => {
      for (const listener of windowListeners.get(type) ?? []) listener();
    },
    intervals,
    registerCount: () => registerCount,
    registerOptions: () => {
      if (!registerOptions) throw new Error("The client never registered a service worker");
      return registerOptions;
    },
    registration,
    reload,
    serviceWorker,
    sessionStorage,
    states,
    updateServiceWorker,
    window: browserWindow,
  };
};

const flush = async () => {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const registered = (harness: ReturnType<typeof createHarness>, registration?: FakeRegistration | null) => {
  const resolved = registration === undefined ? harness.registration : (registration ?? undefined);
  harness
    .registerOptions()
    .onRegisteredSW?.(
      "/cache-service-worker.js",
      resolved as unknown as Parameters<NonNullable<RegisterOptions["onRegisteredSW"]>>[1],
    );
};

beforeEach(() => {
  vi.stubGlobal("caches", {
    delete: vi.fn(async () => true),
    keys: vi.fn(async () => [`${CACHE_PREFIX}app`, `${CACHE_PREFIX}runtime`, "unrelated-cache"]),
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("disabled service worker cache", () => {
  it("unregisters the rom-weaver worker and deletes its caches", async () => {
    const other = createRegistration({
      active: { scriptURL: "https://example.com/other-sw.js", state: "activated" },
      scope: "https://example.com/other/",
    });
    const mine = createRegistration();
    const harness = createHarness({ enabled: false, registrations: [mine, other] });

    harness.client.initialize();
    await flush();

    expect(mine.unregister).toHaveBeenCalledTimes(1);
    expect(other.unregister).not.toHaveBeenCalled();
    const cacheStorage = globalThis.caches as unknown as { delete: ReturnType<typeof vi.fn> };
    expect(cacheStorage.delete.mock.calls.flat()).toEqual([`${CACHE_PREFIX}app`, `${CACHE_PREFIX}runtime`]);
    expect(harness.client.getState().serviceWorkerStatus).toBe("off");
    expect(harness.client.getState().label).toBe("cache off");
  });

  it("matches a rom-weaver worker by its scope when no script URL looks familiar", async () => {
    const byScope = createRegistration({
      active: { scriptURL: "https://example.com/webapp/some-other-worker.js", state: "activated" },
      installing: null,
      scope: APP_SCOPE,
      waiting: null,
    });
    createHarness({ enabled: false, registrations: [byScope] }).client.initialize();
    await flush();

    expect(byScope.unregister).toHaveBeenCalledTimes(1);
  });

  it("matches a rom-weaver worker still installing", async () => {
    const installing = createRegistration({
      active: null,
      installing: { scriptURL: "https://example.com/dev-sw.js?dev-sw", state: "installing" },
      scope: "https://example.com/elsewhere/",
    });
    createHarness({ enabled: false, registrations: [installing] }).client.initialize();
    await flush();

    expect(installing.unregister).toHaveBeenCalledTimes(1);
  });

  it("still clears the caches when there is no service worker container", async () => {
    createHarness({ enabled: false, hasServiceWorker: false }).client.initialize();
    await flush();

    const cacheStorage = globalThis.caches as unknown as { delete: ReturnType<typeof vi.fn> };
    expect(cacheStorage.delete).toHaveBeenCalledTimes(2);
  });

  it("skips cache deletion when CacheStorage is unavailable", async () => {
    vi.unstubAllGlobals();
    const harness = createHarness({ enabled: false, hasServiceWorker: false });

    harness.client.initialize();
    await flush();

    expect(harness.client.getState().serviceWorkerStatus).toBe("off");
  });

  it("still reports the disabled state when unregistering fails", async () => {
    const broken = createRegistration({
      unregister: vi.fn(async () => {
        throw new Error("unregister is not allowed");
      }),
    });
    const harness = createHarness({ enabled: false, registrations: [broken] });

    harness.client.initialize();
    await flush();

    expect(harness.client.getState().title).toBe("Service worker cache is disabled");
  });

  it("refuses a forced cache reload while the cache is disabled", async () => {
    const harness = createHarness({ enabled: false });

    await expect(harness.client.forceCacheAndReload()).resolves.toBe(false);
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("reports the disabled state from a cache version refresh", () => {
    const harness = createHarness({ enabled: false });

    harness.client.refreshCacheVersion();

    expect(harness.client.getState().title).toBe("Service worker cache is disabled");
  });
});

describe("initialize", () => {
  it("registers the worker only once", () => {
    const harness = createHarness();

    harness.client.initialize();
    harness.client.initialize();

    expect(harness.registerCount()).toBe(1);
  });

  it("reports an unavailable service worker instead of registering one", () => {
    const harness = createHarness({ hasServiceWorker: false });

    harness.client.initialize();

    expect(() => harness.registerOptions()).toThrow();
    expect(harness.client.getState().title).toBe("Service worker is not available in this browser");
    expect(harness.client.getState().serviceWorkerStatus).toBe("off");
  });

  it("reports a registration that resolved to nothing", () => {
    const harness = createHarness({ controller: createController() });
    harness.client.initialize();

    registered(harness, null);

    expect(harness.client.getState().title).toBe("Service worker registration is unavailable");
  });

  it("reports a registration failure and hints at an untrusted certificate", () => {
    const harness = createHarness();
    harness.client.initialize();

    harness.registerOptions().onRegisterError?.(new Error("SSL certificate problem"));

    expect(harness.client.getState().serviceWorkerStatus).toBe("off");
    expect(harness.client.getState().title).toBe("Service worker registration failed");
  });

  it("refreshes the cache version once the offline cache is ready", () => {
    const controller = createController();
    const harness = createHarness({ controller });
    harness.client.initialize();
    controller.postMessage.mockClear();

    harness.registerOptions().onOfflineReady?.();

    expect(controller.postMessage).toHaveBeenCalledWith({ action: "get-service-worker-cache-version" }, [
      expect.anything(),
    ]);
  });

  it("starts periodic update checks once an isolated page is registered", () => {
    const harness = createHarness({ controller: createController(), crossOriginIsolated: true });
    harness.client.initialize();

    registered(harness);

    expect(harness.intervals).toHaveLength(1);
    expect(harness.intervals[0]?.ms).toBe(5000);
  });

  it("logs but swallows a failing update check and stops the interval on unload", async () => {
    const registration = createRegistration({
      update: vi.fn(async () => {
        throw new Error("update check failed");
      }),
    });
    const harness = createHarness({ controller: createController() });
    harness.client.initialize();
    registered(harness, registration);
    await flush();

    harness.fireWindow("focus");
    harness.fireWindow("online");
    harness.fireDocument("visibilitychange");
    await flush();

    expect(registration.update).toHaveBeenCalled();
    harness.fireWindow("beforeunload");
    expect(harness.window.clearInterval).toHaveBeenCalledTimes(1);
  });

  it("does not run an update check while the document is hidden", async () => {
    const registration = createRegistration();
    const harness = createHarness({ controller: createController(), visibilityState: "hidden" });
    harness.client.initialize();
    registered(harness, registration);
    await flush();
    vi.mocked(registration.update ?? (() => Promise.resolve())).mockClear();

    harness.fireDocument("visibilitychange");

    expect(registration.update).not.toHaveBeenCalled();
  });
});

describe("cache version refresh", () => {
  it("reads the version the controller reports", async () => {
    const harness = createHarness({ controller: createController() });

    harness.client.initialize();
    await flush();

    expect(harness.client.getState().label).toBe("cache test");
    expect(harness.client.getState().title).toBe("Loaded service worker cache: precache-rom-weaver-test");
  });

  it("gives up after the timeout when the controller never answers", async () => {
    const harness = createHarness({ controller: createController({ reply: null }) });

    harness.client.initialize();
    await new Promise((resolve) => setTimeout(resolve, CACHE_VERSION_TIMEOUT_MS + 20));

    expect(harness.client.getState().label).toBe("cache unknown");
    expect(harness.client.getState().title).toBe("The loaded service worker did not report a cache version");
  });

  it("reports a controller that rejects the query", async () => {
    const harness = createHarness({ controller: createController({ throwOnPost: true }) });

    harness.client.initialize();
    await flush();

    expect(harness.client.getState().title).toBe("Could not query the loaded service worker cache version");
  });

  it("reports a browser with no MessageChannel", () => {
    vi.stubGlobal("MessageChannel", undefined);
    const harness = createHarness({ controller: createController() });

    harness.client.initialize();

    expect(harness.client.getState().label).toBe("cache unknown");
    expect(harness.client.getState().title).toBe("This browser cannot query the loaded service worker cache version");
  });

  it("reports a registered but uncontrolled page as network-served", () => {
    const harness = createHarness({ controller: null, crossOriginIsolated: true });
    harness.client.initialize();

    registered(harness);

    expect(harness.client.getState().label).toBe("cache network");
    expect(harness.client.getState().title).toBe("This page is not controlled by a service worker");
  });
});

describe("pending update reload", () => {
  it("does nothing when no update is waiting", async () => {
    const harness = createHarness({ controller: createController() });
    harness.client.initialize();

    await expect(harness.client.reloadPendingUpdate()).resolves.toBe(false);
    expect(harness.updateServiceWorker).not.toHaveBeenCalled();
  });

  it("stops when the user declines the reload", async () => {
    const harness = createHarness({ controller: createController(), onConfirmReload: async () => false });
    harness.client.initialize();
    harness.registerOptions().onNeedRefresh?.();

    await expect(harness.client.reloadPendingUpdate()).resolves.toBe(false);
    expect(harness.client.getState().updateReady).toBe(true);
    expect(harness.updateServiceWorker).not.toHaveBeenCalled();
  });

  it("reloads through the registrar callback once the incoming worker takes control", async () => {
    const onBeforeReload = vi.fn();
    const harness = createHarness({ controller: createController(), onBeforeReload });
    harness.client.initialize();
    harness.registerOptions().onNeedRefresh?.();

    await expect(harness.client.reloadPendingUpdate()).resolves.toBe(true);
    expect(onBeforeReload).toHaveBeenCalledTimes(1);
    expect(harness.reload).not.toHaveBeenCalled();

    harness.registerOptions().onNeedReload?.();

    expect(harness.reload).toHaveBeenCalledTimes(1);
  });

  it("cannot reload a page whose location has no reload", async () => {
    const harness = createHarness({ controller: createController(), hasLocationReload: false });
    harness.client.initialize();
    harness.registerOptions().onNeedRefresh?.();

    await expect(harness.client.reloadPendingUpdate()).resolves.toBe(true);
    harness.registerOptions().onNeedReload?.();

    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("does not reload when the incoming worker takes control on its own", () => {
    const harness = createHarness({ controller: createController() });
    harness.client.initialize();

    harness.registerOptions().onNeedReload?.();

    expect(harness.reload).not.toHaveBeenCalled();
  });
});

describe("forced cache reload", () => {
  it("reloads a controlled page after re-syncing the worker", async () => {
    const controller = createController();
    const harness = createHarness({ controller });
    harness.client.initialize();
    registered(harness);
    await flush();

    await expect(harness.client.forceCacheAndReload()).resolves.toBe(true);

    expect(harness.registration.update).toHaveBeenCalled();
    expect(harness.reload).toHaveBeenCalledTimes(1);
  });

  it("reloads to gain control when the page has no controller", async () => {
    const harness = createHarness({ controller: null });

    await expect(harness.client.forceCacheAndReload()).resolves.toBe(true);

    expect(harness.sessionStorage.state.get(COI_RELOADED_BY_SELF_KEY)).toBe("notcontrolling");
    expect(harness.reload).toHaveBeenCalledTimes(1);
  });

  it("refuses when the page cannot reload itself", async () => {
    const harness = createHarness({ controller: null, hasLocationReload: false });

    await expect(harness.client.forceCacheAndReload()).resolves.toBe(false);
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("refuses without a service worker container", async () => {
    const harness = createHarness({ hasServiceWorker: false });

    await expect(harness.client.forceCacheAndReload()).resolves.toBe(false);
  });

  it("continues after a failing update check", async () => {
    const registration = createRegistration({
      update: vi.fn(async () => {
        throw new Error("update check failed");
      }),
    });
    const harness = createHarness({ controller: createController() });
    harness.client.initialize();
    registered(harness, registration);
    await flush();

    await expect(harness.client.forceCacheAndReload()).resolves.toBe(true);
    expect(harness.reload).toHaveBeenCalledTimes(1);
  });
});

describe("waiting for the ready registration", () => {
  it("uses the registration the ready promise resolves to", async () => {
    const readyRegistration = createRegistration({ scope: "https://example.com/ready/" });
    const harness = createHarness({
      controller: createController(),
      ready: Promise.resolve(readyRegistration),
    });

    await expect(harness.client.forceCacheAndReload()).resolves.toBe(true);
    expect(harness.reload).toHaveBeenCalledTimes(1);
  });

  it("falls back to the registered worker when the ready promise rejects", async () => {
    const harness = createHarness({
      controller: createController(),
      ready: Promise.reject("ready never settled"),
    });

    await expect(harness.client.forceCacheAndReload()).resolves.toBe(true);
  });

  it("gives up on the ready promise after the timeout and snapshots the registrations", async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      controller: createController(),
      ready: "never",
      registrations: [
        createRegistration({ installing: { scriptURL: "https://example.com/sw.js", state: "installing" } }),
      ],
    });

    const pending = harness.client.forceCacheAndReload();
    await vi.advanceTimersByTimeAsync(8000);

    await expect(pending).resolves.toBe(true);
    expect(harness.serviceWorker.getRegistrations).toHaveBeenCalledTimes(1);
  });

  it("still reports a snapshot when enumerating registrations fails", async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      controller: createController(),
      getRegistrationsError: new Error("registrations are unavailable"),
      ready: "never",
    });

    const pending = harness.client.forceCacheAndReload();
    await vi.advanceTimersByTimeAsync(8000);

    await expect(pending).resolves.toBe(true);
  });
});

describe("reload to gain control", () => {
  it("schedules one reload and skips a second request", async () => {
    const readyRegistration = createRegistration();
    const harness = createHarness({
      controller: null,
      crossOriginIsolated: false,
      ready: Promise.resolve(readyRegistration),
    });
    harness.client.initialize();

    registered(harness);
    registered(harness);
    await flush();

    expect(harness.reload).toHaveBeenCalledTimes(1);
    expect(harness.sessionStorage.state.get(COI_RELOADED_BY_SELF_KEY)).toBe("notcontrolling");
  });

  it("skips the reload when a controller arrives while waiting", async () => {
    let resolveReady: (registration: FakeRegistration) => void = () => undefined;
    const ready = new Promise<FakeRegistration>((resolve) => {
      resolveReady = resolve;
    });
    const harness = createHarness({ controller: null, crossOriginIsolated: false, ready });
    harness.client.initialize();
    registered(harness);

    harness.serviceWorker.controller = createController();
    resolveReady(harness.registration);
    await flush();

    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("does not reload again when the page already reloaded for control", async () => {
    const harness = createHarness({
      controller: null,
      crossOriginIsolated: false,
      ready: Promise.resolve(createRegistration()),
      sessionStorageSeed: { [COI_RELOADED_BY_SELF_KEY]: "notcontrolling" },
    });
    harness.client.initialize();

    registered(harness);
    await flush();

    expect(harness.reload).not.toHaveBeenCalled();
  });
});

describe("best-effort session storage", () => {
  it("keeps working when every session storage call throws", async () => {
    const harness = createHarness({
      controller: null,
      crossOriginIsolated: false,
      ready: Promise.resolve(createRegistration()),
      sessionStorageFailOn: ["get", "remove", "set"],
    });

    harness.client.initialize();
    registered(harness);
    await flush();

    expect(harness.reload).toHaveBeenCalledTimes(1);
  });

  it("keeps the reload reason readable when clearing it throws", () => {
    const controller = createController();
    const harness = createHarness({
      controller,
      crossOriginIsolated: false,
      sessionStorageFailOn: ["remove"],
      sessionStorageSeed: { [COI_RELOADED_BY_SELF_KEY]: "coepdegrade" },
    });

    harness.client.initialize();

    expect(controller.postMessage).toHaveBeenCalledWith({ action: "set-coep-credentialless", value: false });
    expect(harness.reload).not.toHaveBeenCalled();
  });
});

describe("COEP mode sync", () => {
  it("skips the sync while cross-origin isolation is unknown", () => {
    const controller = createController();
    const harness = createHarness({ controller, hasCrossOriginIsolated: false });

    harness.client.initialize();

    expect(harness.registerOptions().immediate).toBe(true);
    expect(controller.postMessage.mock.calls.some(([message]) => message.action === "set-coep-credentialless")).toBe(
      false,
    );
  });

  it("keeps require-corp once a session has already failed with credentialless", () => {
    const controller = createController();
    const harness = createHarness({
      controller,
      crossOriginIsolated: true,
      sessionStorageSeed: { "rom-weaver-coi-coep-has-failed": "true" },
    });

    harness.client.initialize();

    expect(controller.postMessage).toHaveBeenCalledWith({ action: "set-coep-credentialless", value: false });
  });

  it("does not degrade twice when the page already reloaded to degrade", () => {
    const controller = createController();
    const harness = createHarness({
      controller,
      crossOriginIsolated: false,
      sessionStorageSeed: { [COI_RELOADED_BY_SELF_KEY]: "coepdegrade" },
    });

    harness.client.initialize();

    expect(controller.postMessage).toHaveBeenCalledWith({ action: "set-coep-credentialless", value: false });
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("re-syncs when the controller changes", () => {
    const controller = createController();
    const harness = createHarness({ controller, crossOriginIsolated: true });
    harness.client.initialize();
    controller.postMessage.mockClear();

    harness.fireDocument("controllerchange");

    expect(controller.postMessage).toHaveBeenCalledWith({ action: "set-coep-credentialless", value: true });
  });
});

describe("automatic update apply", () => {
  it("activates silently when the page already runs the incoming version", async () => {
    const harness = createHarness({ controller: createController(), shouldAutoApplyUpdate: () => true });
    harness.client.initialize();
    await flush();

    harness.registerOptions().onNeedRefresh?.();

    expect(harness.updateServiceWorker).toHaveBeenCalledTimes(1);
    expect(harness.client.getState().updateReady).toBe(false);
    expect(harness.sessionStorage.state.get("rom-weaver-sw-auto-apply-reloads")).toBe("1");

    harness.registerOptions().onNeedReload?.();
    expect(harness.reload).not.toHaveBeenCalled();
  });

  it("reloads when the page still runs the outgoing controller's code", async () => {
    const onBeforeReload = vi.fn();
    const harness = createHarness({
      appVersion: "test",
      controller: createController(),
      onBeforeReload,
      shouldAutoApplyUpdate: () => true,
    });
    harness.client.initialize();
    await flush();

    harness.registerOptions().onNeedRefresh?.();

    expect(onBeforeReload).toHaveBeenCalledTimes(1);
    harness.registerOptions().onNeedReload?.();
    expect(harness.reload).toHaveBeenCalledTimes(1);
  });

  it("falls back to the manual prompt once the per-session budget is spent", async () => {
    const harness = createHarness({
      controller: createController(),
      sessionStorageSeed: { "rom-weaver-sw-auto-apply-reloads": "3" },
      shouldAutoApplyUpdate: () => true,
    });
    harness.client.initialize();
    await flush();

    harness.registerOptions().onNeedRefresh?.();

    expect(harness.updateServiceWorker).not.toHaveBeenCalled();
    expect(harness.client.getState().updateReady).toBe(true);
  });
});
