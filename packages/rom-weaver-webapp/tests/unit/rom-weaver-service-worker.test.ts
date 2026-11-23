import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PrecacheManifestEntry = string | { revision?: string | null; url: string; install?: boolean; sizeBytes?: number };

type CapturedRoute = {
  handler: (options: { event?: { type: string }; request: Request; url: URL }) => Promise<Response>;
  match: (options: { request: Request; url: URL }) => boolean;
  method: string;
};

type CapturedPlugin = {
  fetchDidSucceed?: (options: { event: { type: string }; request: Request; response: Response }) => Promise<Response>;
  cacheDidUpdate?: (options: { request: Request }) => Promise<void>;
  cacheWillUpdate?: (options: {
    event?: { type: string };
    request: Request;
    response: Response;
  }) => Promise<Response | null | undefined>;
  handlerDidComplete?: (options: {
    event: { type: string };
    request: Request;
    response?: Response;
    error?: Error;
  }) => Promise<void>;
  handlerWillRespond?: (options: { response: Response }) => Promise<Response>;
  requestWillFetch?: (options: { event: { type: string }; request: Request }) => Promise<Request>;
};

type ReadyState = {
  cachedBytes: number;
  cachedFiles: number;
  pendingUnits: number;
  ready: boolean;
  totalBytes: number;
  totalFiles: number;
};

type WarmupStub = {
  bumpPriority: (target: { groupIds?: string[]; kind: string }) => void;
  getCachedFiles: (onProgress?: () => void) => Promise<Array<{ cache: string; path: string }>>;
  getIdentifyGroupState: () => Promise<Array<{ id: string }>>;
  getReadyState: () => Promise<ReadyState>;
  installIdentifyGroup: (groupId: string) => Promise<{ id: string; installed: boolean }>;
  runNextUnit: (onInterim?: (interim: { bytes: number }) => void) => Promise<{ bytes: number; files: number }>;
  reset: () => void;
  serveOptionalIdentifyPack: (request: Request) => Promise<Response>;
  setIdentifyGroupWanted: (groupId: string, wanted: boolean) => Promise<Array<{ id: string }>>;
};

type WarmupConfig = {
  emulatorJsCacheName: string;
  emulatorJsVersion: string;
  fetchForInteractive: (input: Request | string, init?: RequestInit) => Promise<Response>;
  fetchForWarmup: (input: Request | string, init?: RequestInit) => Promise<Response>;
  identifyOptionalCacheName: string;
  log: (message: string, details?: Record<string, unknown>) => void;
  precacheState: () => Promise<{
    cachedBytes: number;
    cachedFiles: number;
    totalBytes: number;
    totalFiles: number;
  }>;
  scope: string;
};

const hoisted = vi.hoisted(() => ({
  cleanupOutdatedCaches: vi.fn(),
  getCacheKeyForURL: vi.fn(),
  matchPrecache: vi.fn(),
  plugins: [] as CapturedPlugin[],
  precacheAndRoute: vi.fn(),
  routes: [] as CapturedRoute[],
  warmup: {
    config: null as WarmupConfig | null,
    instance: null as WarmupStub | null,
  },
}));

vi.mock("workbox-routing", () => ({
  registerRoute: (match: unknown, handler: unknown, method = "GET") => {
    hoisted.routes.push({
      handler: handler as CapturedRoute["handler"],
      match: match as CapturedRoute["match"],
      method,
    });
  },
}));

vi.mock("workbox-precaching", () => ({
  addPlugins: (plugins: unknown[]) => {
    hoisted.plugins.push(...(plugins as CapturedPlugin[]));
  },
  cleanupOutdatedCaches: hoisted.cleanupOutdatedCaches,
  getCacheKeyForURL: hoisted.getCacheKeyForURL,
  matchPrecache: hoisted.matchPrecache,
  precacheAndRoute: hoisted.precacheAndRoute,
}));

vi.mock("../../src/webapp/offline-warmup.ts", () => ({
  createOfflineWarmup: (config: unknown) => {
    hoisted.warmup.config = config as WarmupConfig;
    return hoisted.warmup.instance;
  },
}));

const APP_ORIGIN = "https://app.test";
const APP_SCOPE = `${APP_ORIGIN}/`;
const BUILD_TOKEN = "build-token-1";
const SW_HREF = `${APP_ORIGIN}/rom-weaver-service-worker.js?build=${BUILD_TOKEN}`;
const EMULATORJS_VERSION = "4.2.3";
const PRECACHE_NAME = "precache-rom-weaver";
const RUNTIME_CACHE_NAME = `precache-rom-weaver-runtime-${BUILD_TOKEN}`;
const EMULATORJS_CACHE_NAME = `precache-rom-weaver-emulatorjs-${EMULATORJS_VERSION}`;
const IDENTIFY_CACHE_NAME = "precache-rom-weaver-identify-optional";
const DEFERRED_CACHE_NAME = "precache-rom-weaver-app-deferred";
const OUTGOING_BUILD_CACHE_NAME = "precache-rom-weaver-outgoing-build";
const COEP_MODE_URL = `${APP_ORIGIN}/__rom-weaver-coep-mode__`;
const PRECACHE_SIZES_URL = `${APP_ORIGIN}/precache-sizes.json`;

const DEFAULT_MANIFEST: PrecacheManifestEntry[] = [
  { revision: "r1", url: "index.html" },
  "assets/app.js",
  { revision: null, url: "404.html" },
];

class FakeCache {
  entries = new Map<string, Response>();
  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }
  async match(request: RequestInfo | URL) {
    const hit = this.entries.get(urlOf(request));
    return hit ? hit.clone() : undefined;
  }
  async put(request: RequestInfo | URL, response: Response) {
    this.entries.set(urlOf(request), response);
  }
  async delete(request: RequestInfo | URL) {
    return this.entries.delete(urlOf(request));
  }
}

const urlOf = (request: RequestInfo | URL) =>
  typeof request === "string" ? request : request instanceof URL ? request.href : request.url;

class FakeCacheStorage {
  caches = new Map<string, FakeCache>();
  deleted: string[] = [];
  async keys() {
    return [...this.caches.keys()];
  }
  async has(name: string) {
    return this.caches.has(name);
  }
  async open(name: string) {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(name, cache);
    }
    return cache as unknown as Cache;
  }
  async delete(name: string) {
    this.deleted.push(name);
    return this.caches.delete(name);
  }
  async match(request: RequestInfo | URL, options?: MultiCacheQueryOptions) {
    const names = options?.cacheName ? [options.cacheName] : [...this.caches.keys()];
    for (const name of names) {
      const hit = await this.caches.get(name)?.match(request);
      if (hit) return hit;
    }
    return undefined;
  }
}

type SwEvent = {
  data?: unknown;
  ports?: Array<{ postMessage: (message: unknown) => void }>;
  source?: { postMessage: (message: unknown) => void };
  type: string;
  waitUntil: (promise: Promise<unknown>) => void;
};

const createScope = ({
  hasActiveWorker = false,
  href = SW_HREF,
  manifest = DEFAULT_MANIFEST,
  scope = APP_SCOPE,
  unparsableHref = false,
}: {
  hasActiveWorker?: boolean;
  href?: string;
  manifest?: PrecacheManifestEntry[];
  scope?: string;
  unparsableHref?: boolean;
} = {}) => {
  const listeners = new Map<string, Array<(event: SwEvent) => void>>();
  const clientMessages: unknown[] = [];
  const client = { postMessage: (message: unknown) => clientMessages.push(message) };
  // Mutable so a test can start with no window client and connect one later,
  // which is what the worker's log backlog exists for.
  const clientList: Array<typeof client> = [client];
  return {
    __WB_MANIFEST: manifest,
    addEventListener(type: string, listener: (event: SwEvent) => void) {
      const existing = listeners.get(type);
      if (existing) existing.push(listener);
      else listeners.set(type, [listener]);
    },
    client,
    clientList,
    clientMessages,
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => clientList),
    },
    listeners,
    location: unparsableHref ? { href, origin: APP_ORIGIN } : new URL(href),
    performance: globalThis.performance,
    registration: {
      active: hasActiveWorker ? { scriptURL: href } : null,
      navigationPreload: undefined as { enable: () => Promise<void> } | undefined,
      scope,
      update: vi.fn(async () => undefined),
      waiting: null as { scriptURL: string } | null,
    },
    skipWaiting: vi.fn(async () => undefined),
  };
};

type Scope = ReturnType<typeof createScope>;

const dispatch = async (scope: Scope, type: string, init: Partial<SwEvent> = {}) => {
  const pending: Array<Promise<unknown>> = [];
  const event: SwEvent = {
    ...init,
    type,
    waitUntil: (promise) => {
      pending.push(promise);
    },
  };
  for (const listener of scope.listeners.get(type) ?? []) listener(event);
  await Promise.all(pending);
};

const createWarmupStub = (): WarmupStub => ({
  bumpPriority: vi.fn(),
  getCachedFiles: vi.fn(async () => [{ cache: PRECACHE_NAME, path: "/index.html" }]),
  getIdentifyGroupState: vi.fn(async () => [{ id: "computers" }]),
  getReadyState: vi.fn(async () => ({
    cachedBytes: 40,
    cachedFiles: 2,
    pendingUnits: 1,
    ready: false,
    totalBytes: 100,
    totalFiles: 5,
  })),
  installIdentifyGroup: vi.fn(async (groupId: string) => ({ id: groupId, installed: true })),
  runNextUnit: vi.fn(async () => ({ bytes: 12, files: 1 })),
  reset: vi.fn(),
  serveOptionalIdentifyPack: vi.fn(async () => new Response("pack-bytes")),
  setIdentifyGroupWanted: vi.fn(async () => [{ id: "computers" }]),
});

type FetchStub = {
  calls: Array<{ credentials: string; init?: RequestInit; url: string }>;
  handlers: Map<string, () => Response>;
  stub: ReturnType<typeof vi.fn>;
};

const createFetchStub = (): FetchStub => {
  const calls: FetchStub["calls"] = [];
  const handlers = new Map<string, () => Response>();
  const stub = vi.fn(async (input: Request | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ credentials: typeof input === "string" ? "" : input.credentials, init, url });
    const handler = handlers.get(url);
    if (!handler) throw new TypeError(`Failed to fetch ${url}`);
    return handler();
  });
  return { calls, handlers, stub };
};

const asDocumentRequest = (url: string) => {
  const request = new Request(url, { headers: { accept: "text/html,*/*" } });
  Object.defineProperty(request, "destination", { value: "document" });
  return request;
};

const asNavigationRequest = (url: string, headers: Record<string, string> = { accept: "text/html,*/*" }) => {
  const request = new Request(url, { headers });
  Object.defineProperty(request, "mode", { value: "navigate" });
  Object.defineProperty(request, "destination", { value: "document" });
  return request;
};

const setPrecache = (entries: Record<string, () => Response>) => {
  hoisted.matchPrecache.mockImplementation(async (request: string | Request) => {
    const key = typeof request === "string" ? request : request.url;
    return entries[key]?.();
  });
};

type Harness = {
  cacheStorage: FakeCacheStorage;
  emulatorJsRoute: CapturedRoute;
  fetchStub: FetchStub;
  identifyPackRoute: CapturedRoute;
  networkFirstRoute: CapturedRoute;
  plugin: CapturedPlugin;
  scope: Scope;
  warmup: WarmupStub;
  warmupConfig: WarmupConfig;
};

const requireRoute = (index: number): CapturedRoute => {
  const route = hoisted.routes[index];
  if (!route) throw new Error(`No route registered at index ${index}`);
  return route;
};

const loadWorker = async (
  options: {
    hasActiveWorker?: boolean;
    href?: string;
    manifest?: PrecacheManifestEntry[];
    omitRedirectList?: boolean;
    redirectSourcePaths?: string[];
    scope?: string;
    seedCaches?: (cacheStorage: FakeCacheStorage) => Promise<void> | void;
    unparsableHref?: boolean;
  } = {},
): Promise<Harness> => {
  hoisted.routes.length = 0;
  hoisted.plugins.length = 0;
  hoisted.matchPrecache.mockReset();
  hoisted.matchPrecache.mockResolvedValue(undefined);
  hoisted.getCacheKeyForURL.mockReset();
  hoisted.precacheAndRoute.mockClear();
  hoisted.cleanupOutdatedCaches.mockClear();

  const scope = createScope(options);
  const cacheStorage = new FakeCacheStorage();
  const fetchStub = createFetchStub();
  const warmup = createWarmupStub();
  hoisted.warmup.instance = warmup;
  hoisted.warmup.config = null;

  await options.seedCaches?.(cacheStorage);

  vi.stubGlobal("self", scope);
  vi.stubGlobal("caches", cacheStorage);
  vi.stubGlobal("fetch", fetchStub.stub);
  vi.stubGlobal("__EMULATORJS_VERSION__", EMULATORJS_VERSION);
  // The test build defines the real list as a global, so fail-closed needs an explicit undefined.
  if (options.omitRedirectList) vi.stubGlobal("__REDIRECT_SOURCE_PATHS__", undefined);
  else if (options.redirectSourcePaths) vi.stubGlobal("__REDIRECT_SOURCE_PATHS__", options.redirectSourcePaths);
  vi.stubGlobal("__IDENTIFY_OPTIONAL_PACK_GROUPS__", [
    { id: "computers", label: "Computers", packs: [{ sha256: "aa", url: "assets/identify-computers.pack" }] },
  ]);

  vi.resetModules();
  await import("../../src/webapp/rom-weaver-service-worker.ts");

  const plugin = hoisted.plugins[0];
  if (!plugin) throw new Error("The service worker registered no precache plugin");
  const warmupConfig = hoisted.warmup.config;
  if (!warmupConfig) throw new Error("The service worker created no offline warm-up");

  return {
    cacheStorage,
    emulatorJsRoute: requireRoute(1),
    fetchStub,
    identifyPackRoute: requireRoute(4),
    networkFirstRoute: requireRoute(0),
    plugin,
    scope,
    warmup,
    warmupConfig,
  };
};

type RoutedEvent = {
  clientId?: string;
  preloadResponse?: Promise<Response | undefined>;
  resultingClientId?: string;
  type: string;
  waitUntil?: (promise: Promise<unknown>) => void;
};

const routed = (harness: Harness, route: CapturedRoute, request: Request, event?: RoutedEvent) => {
  const url = new URL(request.url);
  if (!route.match({ request, url })) throw new Error(`Route did not match ${request.url}`);
  void harness;
  return route.handler({ event, request, url });
};

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("worker log relay", () => {
  const logMessages = (scope: { clientMessages: unknown[] }) =>
    scope.clientMessages.filter((message) => (message as { action?: string }).action === "service-worker-log");

  it("sends every log line to the window clients and to the console", async () => {
    const harness = await loadWorker();

    harness.scope.clientMessages.length = 0;
    await dispatch(harness.scope, "install");
    await Promise.resolve();

    expect(logMessages(harness.scope)).toContainEqual(
      expect.objectContaining({ action: "service-worker-log", message: "install event", queued: false }),
    );
    expect(console.info).toHaveBeenCalledWith(
      expect.stringContaining("rom-weaver-sw"),
      "install event",
      expect.any(Object),
    );
  });

  it("holds lines written with no window client and replays them when one asks", async () => {
    const harness = await loadWorker();
    await Promise.resolve();
    harness.scope.clientList.length = 0;
    harness.scope.clientMessages.length = 0;

    await dispatch(harness.scope, "install");
    await Promise.resolve();
    expect(logMessages(harness.scope)).toEqual([]);

    harness.scope.clientList.push(harness.scope.client);
    await dispatch(harness.scope, "message", { data: { action: "flush-service-worker-log" } });
    await Promise.resolve();

    const replayed = logMessages(harness.scope) as Array<{ message: string; queued: boolean; timestamp: string }>;
    expect(replayed.map((entry) => entry.message)).toContain("install event");
    expect(replayed.every((entry) => entry.queued)).toBe(true);
    expect(replayed[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it("replays a held line before the line being logged now", async () => {
    const harness = await loadWorker();
    await Promise.resolve();
    harness.scope.clientList.length = 0;
    await dispatch(harness.scope, "install");
    await Promise.resolve();

    harness.scope.clientList.push(harness.scope.client);
    harness.scope.clientMessages.length = 0;
    await dispatch(harness.scope, "activate");
    await Promise.resolve();

    const relayed = logMessages(harness.scope) as Array<{ queued: boolean }>;
    expect(relayed.length).toBeGreaterThan(1);
    expect(relayed[0].queued).toBe(true);
    expect(relayed.at(-1)?.queued).toBe(false);
  });
});

describe("service worker bootstrap", () => {
  it("ends the page's download loop when an update starts waiting mid-batch", async () => {
    const urls = Array.from({ length: 6 }, (_, index) => `${APP_ORIGIN}/assets/${index}.bin`);
    const harness = await loadWorker({ manifest: urls.map((url) => ({ url, install: false, sizeBytes: 1 })) });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const url of urls) harness.fetchStub.handlers.set(url, () => new Response("x"));
    harness.fetchStub.stub.mockImplementation(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      harness.fetchStub.calls.push({ credentials: "", url });
      if (urls.includes(url)) await gate;
      return harness.fetchStub.handlers.get(url)?.() ?? Response.error();
    });
    const replies: Array<Record<string, unknown>> = [];
    const pumpOnce = () =>
      dispatch(harness.scope, "message", {
        data: { action: "offline-warmup-pump" },
        ports: [{ postMessage: (message: unknown) => replies.push(message as Record<string, unknown>) }],
      });
    const downloads = () => harness.fetchStub.calls.filter(({ url }) => urls.includes(url)).length;

    const running = pumpOnce();
    await vi.waitFor(() => expect(downloads()).toBeGreaterThan(0));
    const started = downloads();
    harness.scope.registration.waiting = { scriptURL: SW_HREF };
    release();
    await running;

    expect(downloads()).toBe(started);
    expect(started).toBeLessThan(urls.length);
    expect(harness.warmup.runNextUnit).not.toHaveBeenCalled();
    expect(replies.at(-1)).toEqual({ action: "offline-warmup-progress", enabled: false, ready: false });
  });

  it("pauses a restarted worker's downloads without reading cache state while an update waits", async () => {
    const url = `${APP_ORIGIN}/assets/0.bin`;
    const harness = await loadWorker({ manifest: [{ url, install: false, sizeBytes: 1 }] });
    harness.fetchStub.handlers.set(url, () => new Response("x"));
    harness.scope.registration.waiting = { scriptURL: SW_HREF };
    const readState = vi.mocked(harness.warmup.getReadyState).mockClear();
    const replies: Array<Record<string, unknown>> = [];

    await dispatch(harness.scope, "message", {
      data: { action: "offline-warmup-pump" },
      ports: [{ postMessage: (message: unknown) => replies.push(message as Record<string, unknown>) }],
    });

    expect(replies).toEqual([{ action: "offline-warmup-progress", enabled: false, ready: false }]);
    expect(readState).not.toHaveBeenCalled();
    expect(harness.fetchStub.calls).toHaveLength(0);
  });

  it("starts no warm-up unit when an update starts waiting before the app files are checked", async () => {
    const urls = Array.from({ length: 3 }, (_, index) => `${APP_ORIGIN}/assets/${index}.bin`);
    const harness = await loadWorker({ manifest: urls.map((url) => ({ url, install: false, sizeBytes: 1 })) });
    for (const url of urls) harness.fetchStub.handlers.set(url, () => new Response("x"));
    const state = await harness.warmup.getReadyState();
    let release: () => void = () => undefined;
    const gate = new Promise<ReadyState>((resolve) => {
      release = () => resolve(state);
    });
    const readState = vi
      .mocked(harness.warmup.getReadyState)
      .mockClear()
      .mockImplementationOnce(() => gate);
    const replies: Array<Record<string, unknown>> = [];
    const pump = dispatch(harness.scope, "message", {
      data: { action: "offline-warmup-pump" },
      ports: [{ postMessage: (message: unknown) => replies.push(message as Record<string, unknown>) }],
    });
    try {
      await vi.waitFor(() => expect(readState).toHaveBeenCalledTimes(1));
      harness.scope.registration.waiting = { scriptURL: SW_HREF };
      release();
      await pump;
      expect(harness.warmup.runNextUnit).not.toHaveBeenCalled();
      expect(harness.fetchStub.calls.filter(({ url }) => urls.includes(url))).toHaveLength(0);
      expect(replies.at(-1)).toEqual({ action: "offline-warmup-progress", enabled: false, ready: false });
    } finally {
      release();
      await pump;
    }
  });

  it("honors a pause received while the pump is waiting for its initial cache state", async () => {
    const urls = Array.from({ length: 6 }, (_, index) => `${APP_ORIGIN}/assets/${index}.bin`);
    const harness = await loadWorker({ manifest: urls.map((url) => ({ url, install: false, sizeBytes: 1 })) });
    for (const url of urls) harness.fetchStub.handlers.set(url, () => new Response("x"));
    const state = await harness.warmup.getReadyState();
    let release: () => void = () => undefined;
    const gate = new Promise<ReadyState>((resolve) => {
      release = () => resolve(state);
    });
    const readState = vi
      .mocked(harness.warmup.getReadyState)
      .mockClear()
      .mockImplementationOnce(() => gate);
    const pump = dispatch(harness.scope, "message", { data: { action: "offline-warmup-pump" } });
    try {
      await vi.waitFor(() => expect(readState).toHaveBeenCalledTimes(1));
      await dispatch(harness.scope, "message", { data: { action: "offline-warmup-pause" } });
      release();
      await pump;
      expect(harness.fetchStub.calls.filter(({ url }) => urls.includes(url))).toHaveLength(0);
      expect(harness.warmup.runNextUnit).not.toHaveBeenCalled();
      await dispatch(harness.scope, "message", { data: { action: "offline-warmup-pump" } });
      expect(harness.fetchStub.calls.filter(({ url }) => urls.includes(url))).toHaveLength(6);
    } finally {
      release();
      await pump;
    }
  });

  it("updates transferred sizes when a file is cached while another batch file is still downloading", async () => {
    const first = `${APP_ORIGIN}/assets/first.bin`;
    const second = `${APP_ORIGIN}/assets/second.bin`;
    const harness = await loadWorker({
      manifest: [
        { url: first, install: false, sizeBytes: 3 },
        { url: second, install: false, sizeBytes: 10 },
      ],
    });
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    harness.fetchStub.handlers.set(
      first,
      () => new Response("one", { headers: { "content-length": "2", "content-encoding": "br" } }),
    );
    harness.fetchStub.handlers.set(
      second,
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              stream = controller;
            },
          }),
        ),
    );
    vi.mocked(harness.warmup.getReadyState).mockImplementation(async () => {
      const state = await harness.warmupConfig.precacheState();
      return {
        ...state,
        ready: state.cachedFiles === state.totalFiles,
        pendingUnits: state.totalFiles - state.cachedFiles,
      };
    });
    const replies: unknown[] = [];
    const pump = dispatch(harness.scope, "message", {
      data: { action: "offline-warmup-pump" },
      ports: [{ postMessage: (reply) => replies.push(reply) }],
    });
    try {
      await vi.waitFor(() =>
        expect(replies).toContainEqual(expect.objectContaining({ cachedFiles: 1, transferredBytes: 2, ready: false })),
      );
      stream?.enqueue(new Uint8Array(4));
      await vi.waitFor(() =>
        expect(replies.at(-1)).toMatchObject({ cachedBytes: 7, transferredBytes: 2, ready: false }),
      );
      stream?.enqueue(new Uint8Array(6));
      stream?.close();
      await pump;
      expect(replies.at(-1)).toMatchObject({ cachedFiles: 2, transferredBytes: 12, ready: true });
    } finally {
      stream?.error(new Error("test stream cleanup"));
      await pump.catch(() => undefined);
    }
  });

  it("counts a shared download once and streams progress while cache snapshots are blocked", async () => {
    const url = `${APP_ORIGIN}/assets/shared.bin`;
    const harness = await loadWorker({ manifest: [{ url, install: false, sizeBytes: 10 }] });
    const body = new TransformStream<Uint8Array, Uint8Array>();
    const writer = body.writable.getWriter();
    harness.fetchStub.handlers.set(url, () => new Response(body.readable));
    vi.mocked(harness.warmup.getReadyState).mockImplementation(async () => {
      const state = await harness.warmupConfig.precacheState();
      return {
        ...state,
        ready: state.cachedFiles === state.totalFiles,
        pendingUnits: state.totalFiles - state.cachedFiles,
      };
    });
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const interactive = routed(harness, requireRoute(2), new Request(url));
    const replies: Array<{ action: string; cachedBytes: number; ready: boolean }> = [];
    let releaseSnapshot: () => void = () => undefined;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let pump: Promise<void> | undefined;
    try {
      await writer.write(new Uint8Array(3));
      expect(await harness.warmup.getReadyState()).toMatchObject({ cachedBytes: 3, ready: false });
      pump = dispatch(harness.scope, "message", {
        data: { action: "offline-warmup-pump" },
        ports: [{ postMessage: (reply) => replies.push(reply as (typeof replies)[number]) }],
      });
      await vi.waitFor(() => expect(replies.at(-1)).toMatchObject({ cachedBytes: 3, ready: false }));
      const readState = vi.mocked(harness.warmup.getReadyState).getMockImplementation();
      vi.mocked(harness.warmup.getReadyState).mockImplementation(async () => {
        await snapshotGate;
        if (!readState) throw new Error("Missing ready state reader");
        return readState();
      });
      now += 50;
      await writer.write(new Uint8Array(4));
      await vi.waitFor(() => expect(replies.at(-1)).toMatchObject({ cachedBytes: 7, ready: false }));
      releaseSnapshot();
      await writer.write(new Uint8Array(3));
      await writer.close();
      await Promise.all([interactive, pump]);
      expect(replies.map((reply) => reply.cachedBytes)).toEqual([3, 7, 10, 10, 10]);
      expect(replies.at(-1)).toMatchObject({ action: "offline-warmup-progress", ready: true });
    } finally {
      releaseSnapshot();
      await writer.abort(new Error("test stream cleanup"));
      await Promise.allSettled([interactive, pump]);
      writer.releaseLock();
    }
  });

  it("installs only essential entries and includes deferred files in offline totals", async () => {
    const initial = { install: true, revision: "root", sizeBytes: 10, url: "index.html" };
    const deferred = { install: false, revision: "docs", sizeBytes: 20, url: "docs/index.html" };
    const harness = await loadWorker({ manifest: [initial, deferred] });
    expect(hoisted.precacheAndRoute).toHaveBeenCalledWith([initial], expect.anything());
    await expect(harness.warmupConfig.precacheState()).resolves.toEqual({
      cachedBytes: 0,
      deferredCachedBytes: 0,
      cachedFiles: 0,
      totalBytes: 30,
      totalFiles: 2,
      transferredBytes: 0,
      transferBytesIncomplete: false,
    });
    harness.fetchStub.handlers.set(`${APP_ORIGIN}/docs/`, () => new Response("docs"));
    await routed(harness, requireRoute(2), new Request(`${APP_ORIGIN}/docs/index.html`));
    await expect(harness.warmupConfig.precacheState()).resolves.toEqual({
      cachedBytes: 20,
      deferredCachedBytes: 20,
      cachedFiles: 1,
      totalBytes: 30,
      totalFiles: 2,
      transferredBytes: 20,
      transferBytesIncomplete: false,
    });
    harness.fetchStub.handlers.delete(`${APP_ORIGIN}/docs/`);
    const response = await routed(harness, harness.networkFirstRoute, asDocumentRequest(`${APP_ORIGIN}/docs`));
    expect(await response.text()).toBe("docs");
  });
  it("registers the runtime and deferred routes, the precache plugin and the warm-up", async () => {
    const harness = await loadWorker();

    expect(hoisted.routes).toHaveLength(7);
    expect(hoisted.precacheAndRoute).toHaveBeenCalledWith(DEFAULT_MANIFEST, {
      ignoreURLParametersMatching: [/^sha256$/],
    });
    expect(hoisted.cleanupOutdatedCaches).toHaveBeenCalledTimes(1);
    expect(harness.warmupConfig.emulatorJsCacheName).toBe(EMULATORJS_CACHE_NAME);
    expect(harness.warmupConfig.emulatorJsVersion).toBe(EMULATORJS_VERSION);
    expect(harness.warmupConfig.identifyOptionalCacheName).toBe(IDENTIFY_CACHE_NAME);
    expect(harness.warmupConfig.scope).toBe(APP_SCOPE);
  });

  it("reports the dev build token from its own script URL as the precache version", async () => {
    const harness = await loadWorker();
    const replies: unknown[] = [];

    await dispatch(harness.scope, "message", {
      data: { action: "get-service-worker-cache-version" },
      ports: [{ postMessage: (message: unknown) => replies.push(message) }],
    });

    expect(replies).toEqual([
      {
        action: "service-worker-cache-version",
        precacheId: "rom-weaver",
        precacheName: PRECACHE_NAME,
        precacheVersion: BUILD_TOKEN,
      },
    ]);
  });

  it("falls back to the resolved build version when the script URL cannot be parsed", async () => {
    const harness = await loadWorker({ href: SW_HREF.replace(`?build=${BUILD_TOKEN}`, "") });
    const replies: Array<{ precacheVersion?: string }> = [];

    await dispatch(harness.scope, "message", {
      data: { action: "get-service-worker-cache-version" },
      ports: [{ postMessage: (message: unknown) => replies.push(message as { precacheVersion?: string }) }],
    });

    expect(replies[0]?.precacheVersion).not.toBe(BUILD_TOKEN);
    expect(replies[0]?.precacheVersion).toBeTruthy();
  });

  it("falls back to the resolved build version when the script URL is not a URL at all", async () => {
    const harness = await loadWorker({ href: "::: not a url", unparsableHref: true });
    const replies: Array<{ precacheVersion?: string }> = [];

    await dispatch(harness.scope, "message", {
      data: { action: "get-service-worker-cache-version" },
      ports: [{ postMessage: (message: unknown) => replies.push(message as { precacheVersion?: string }) }],
    });

    expect(replies[0]?.precacheVersion).not.toBe(BUILD_TOKEN);
    expect(replies[0]?.precacheVersion).toBeTruthy();
  });

  it("replies through the event source when the message carries no port", async () => {
    const harness = await loadWorker();
    const replies: unknown[] = [];

    await dispatch(harness.scope, "message", {
      data: { action: "get-service-worker-cache-version" },
      source: { postMessage: (message: unknown) => replies.push(message) },
    });

    expect(replies).toHaveLength(1);
  });

  it("ignores messages with no data and unknown actions", async () => {
    const harness = await loadWorker();
    const replies: unknown[] = [];
    const ports = [{ postMessage: (message: unknown) => replies.push(message) }];

    await dispatch(harness.scope, "message", { data: null, ports });
    await dispatch(harness.scope, "message", { data: { action: "not-a-real-action" }, ports });

    expect(replies).toEqual([]);
  });
});

describe("network-first route matching", () => {
  it("matches same-origin documents, manifests and dev sources", async () => {
    const harness = await loadWorker();
    const { match } = harness.networkFirstRoute;
    const matches = (request: Request) => match({ request, url: new URL(request.url) });

    expect(matches(asDocumentRequest(`${APP_ORIGIN}/docs/guide`))).toBe(true);
    expect(matches(new Request(`${APP_ORIGIN}/`))).toBe(true);
    expect(matches(new Request(`${APP_ORIGIN}/nested/index.html`))).toBe(true);
    expect(matches(new Request(`${APP_ORIGIN}/manifest.json`))).toBe(true);
    expect(matches(new Request(`${APP_ORIGIN}/src/main.tsx`))).toBe(true);
    expect(matches(new Request(`${APP_ORIGIN}/@vite/client`))).toBe(true);
    expect(matches(new Request(`${APP_ORIGIN}/assets/app.css`))).toBe(true);
  });

  it("skips cross-origin, non-GET and EmulatorJS requests", async () => {
    const harness = await loadWorker();
    const { match } = harness.networkFirstRoute;
    const matches = (request: Request) => match({ request, url: new URL(request.url) });

    expect(matches(new Request("https://other.test/index.html"))).toBe(false);
    expect(matches(new Request(`${APP_ORIGIN}/index.html`, { method: "POST" }))).toBe(false);
    expect(matches(new Request(`${APP_ORIGIN}/emulatorjs/manifest.json`))).toBe(false);
    expect(matches(new Request(`${APP_ORIGIN}/assets/app.png`))).toBe(false);
  });
});

describe("network-first handler", () => {
  it("stores the network response in the runtime cache and stamps isolation headers", async () => {
    const harness = await loadWorker();
    harness.fetchStub.handlers.set(`${APP_ORIGIN}/index.html`, () => new Response("<html>", { status: 200 }));

    const response = await routed(harness, harness.networkFirstRoute, new Request(`${APP_ORIGIN}/index.html`));

    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBeNull();
    const runtimeCache = harness.cacheStorage.caches.get(RUNTIME_CACHE_NAME);
    expect(runtimeCache?.entries.has(`${APP_ORIGIN}/index.html`)).toBe(true);
    const stored = await runtimeCache?.match(`${APP_ORIGIN}/index.html`);
    expect(stored?.headers.get("Cross-Origin-Embedder-Policy")).toBeNull();
  });

  it("does not cache a failed network response", async () => {
    const harness = await loadWorker();
    harness.fetchStub.handlers.set(`${APP_ORIGIN}/index.html`, () => new Response("nope", { status: 503 }));

    const response = await routed(harness, harness.networkFirstRoute, new Request(`${APP_ORIGIN}/index.html`));

    expect(response.status).toBe(503);
    expect(harness.cacheStorage.caches.get(RUNTIME_CACHE_NAME)?.entries.size ?? 0).toBe(0);
  });

  it("falls back to a cached response when the network is unreachable", async () => {
    const harness = await loadWorker({
      seedCaches: async (cacheStorage) => {
        const cache = await cacheStorage.open(RUNTIME_CACHE_NAME);
        await cache.put(new Request(`${APP_ORIGIN}/index.html`), new Response("cached", { status: 200 }));
      },
    });
    const response = await routed(harness, harness.networkFirstRoute, new Request(`${APP_ORIGIN}/index.html`));

    await expect(response.text()).resolves.toBe("cached");
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
  });

  it("falls back to the precached web manifest", async () => {
    const harness = await loadWorker();
    setPrecache({ "manifest.json": () => new Response('{"name":"rom-weaver"}', { status: 200 }) });

    const response = await routed(harness, harness.networkFirstRoute, new Request(`${APP_ORIGIN}/manifest.json`));

    await expect(response.text()).resolves.toBe('{"name":"rom-weaver"}');
  });

  it("falls back to the prerendered route document for a deep link", async () => {
    const harness = await loadWorker();
    setPrecache({ "docs/guide/index.html": () => new Response("guide", { status: 200 }) });

    const response = await routed(harness, harness.networkFirstRoute, asDocumentRequest(`${APP_ORIGIN}/docs/guide`));

    await expect(response.text()).resolves.toBe("guide");
  });

  it("falls back to the precached index for the site root", async () => {
    const harness = await loadWorker();
    setPrecache({ "index.html": () => new Response("root", { status: 200 }) });

    const response = await routed(harness, harness.networkFirstRoute, new Request(`${APP_ORIGIN}/`));

    await expect(response.text()).resolves.toBe("root");
  });

  it("falls back to the precached 404 document for an unknown route", async () => {
    const harness = await loadWorker();
    setPrecache({ "404.html": () => new Response("missing", { status: 200 }) });

    const response = await routed(harness, harness.networkFirstRoute, asDocumentRequest(`${APP_ORIGIN}/nope`));

    await expect(response.text()).resolves.toBe("missing");
  });

  it("re-roots the precached 404 document on a sub-path scope", async () => {
    const harness = await loadWorker({ scope: `${APP_ORIGIN}/rom-weaver/` });
    const html =
      '<base href="/" /><a href="/apply-rom-patches">Apply</a><a href="//cdn.test/x">CDN</a><img src="./logo.svg">';
    setPrecache({
      "404.html": () => new Response(html, { headers: { "content-length": String(html.length) }, status: 200 }),
    });

    const response = await routed(
      harness,
      harness.networkFirstRoute,
      asDocumentRequest(`${APP_ORIGIN}/rom-weaver/nope`),
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe(
      '<base href="/rom-weaver/" /><a href="/rom-weaver/apply-rom-patches">Apply</a><a href="//cdn.test/x">CDN</a><img src="./logo.svg">',
    );
  });

  it("answers an offline miss with the 404 status at the root too", async () => {
    const harness = await loadWorker();
    setPrecache({ "404.html": () => new Response('<base href="/" /><a href="/docs">Docs</a>', { status: 200 }) });

    const response = await routed(harness, harness.networkFirstRoute, asDocumentRequest(`${APP_ORIGIN}/nope`));

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe('<base href="/" /><a href="/docs">Docs</a>');
  });

  it("does not prefix a 404 document that is already re-rooted", async () => {
    const harness = await loadWorker({ scope: `${APP_ORIGIN}/rom-weaver/` });
    const html = '<base href="/rom-weaver/" /><a href="/rom-weaver/docs">Docs</a>';
    setPrecache({ "404.html": () => new Response(html, { status: 200 }) });

    const response = await routed(
      harness,
      harness.networkFirstRoute,
      asDocumentRequest(`${APP_ORIGIN}/rom-weaver/nope`),
    );

    await expect(response.text()).resolves.toBe(html);
  });

  it("looks routes up without the sub-path prefix", async () => {
    const harness = await loadWorker({ scope: `${APP_ORIGIN}/rom-weaver/` });
    setPrecache({
      "404.html": () => new Response("not-found", { status: 200 }),
      "apply-rom-patches/index.html": () => new Response("apply-route", { status: 200 }),
      "index.html": () => new Response("app-root", { status: 200 }),
    });

    for (const [path, body] of [
      ["/rom-weaver/apply-rom-patches", "apply-route"],
      ["/rom-weaver/apply-rom-patches/", "apply-route"],
      ["/rom-weaver/", "app-root"],
      ["/rom-weaver", "app-root"],
    ] as const) {
      const response = await routed(harness, harness.networkFirstRoute, asDocumentRequest(`${APP_ORIGIN}${path}`));
      expect(response.status, path).toBe(200);
      await expect(response.text(), path).resolves.toBe(body);
    }
  });

  it("keeps a $ in the sub-path scope literal when re-rooting the 404 document", async () => {
    const harness = await loadWorker({ scope: `${APP_ORIGIN}/a$$b/` });
    setPrecache({ "404.html": () => new Response('<base href="/" /><a href="/docs">Docs</a>', { status: 200 }) });

    const response = await routed(harness, harness.networkFirstRoute, asDocumentRequest(`${APP_ORIGIN}/a$$b/nope`));

    await expect(response.text()).resolves.toBe('<base href="/a$$b/" /><a href="/a$$b/docs">Docs</a>');
  });

  it("falls back to the scope root when every other precache lookup misses", async () => {
    const harness = await loadWorker();
    setPrecache({ "/": () => new Response("scope-root", { status: 200 }) });

    const response = await routed(harness, harness.networkFirstRoute, asDocumentRequest(`${APP_ORIGIN}/deep/page`));

    await expect(response.text()).resolves.toBe("scope-root");
  });

  it("returns a network error when nothing can answer the request", async () => {
    const harness = await loadWorker();

    const response = await routed(harness, harness.networkFirstRoute, new Request(`${APP_ORIGIN}/src/main.tsx`));

    expect(response.status).toBe(0);
    expect(response.type).toBe("error");
  });
});

describe("navigation requests", () => {
  const DEFERRED_URL = `${APP_ORIGIN}/assets/deferred.js`;
  const COMPLETE_MANIFEST: PrecacheManifestEntry[] = [
    { revision: "r1", url: "index.html" },
    "assets/app.js",
    { install: false, url: "assets/deferred.js" },
  ];
  // A worker whose core precache and deferred entries are all stored.
  const loadCompleteWorker = (options: {
    hasActiveWorker?: boolean;
    missingCore?: boolean;
    missingDeferred?: boolean;
    omitRedirectList?: boolean;
    redirectSourcePaths?: string[];
    runtimeEntries?: Record<string, string>;
    scope?: string;
  }) =>
    loadWorker({
      hasActiveWorker: options.hasActiveWorker,
      manifest: COMPLETE_MANIFEST,
      omitRedirectList: options.omitRedirectList,
      redirectSourcePaths: options.redirectSourcePaths,
      scope: options.scope,
      seedCaches: async (cacheStorage) => {
        // Precache keys resolve against the registration scope.
        const base = options.scope ?? APP_SCOPE;
        const core = await cacheStorage.open(PRECACHE_NAME);
        await core.put(`${base}index.html?__WB_REVISION__=r1`, new Response("x"));
        if (!options.missingCore) await core.put(`${base}assets/app.js`, new Response("x"));
        if (!options.missingDeferred) {
          await (await cacheStorage.open(DEFERRED_CACHE_NAME)).put(`${base}assets/deferred.js`, new Response("x"));
        }
        const runtime = await cacheStorage.open(RUNTIME_CACHE_NAME);
        for (const [url, body] of Object.entries(options.runtimeEntries ?? {}))
          await runtime.put(url, new Response(body));
      },
    });
  const precachedDocs = () =>
    setPrecache({
      "docs/guide/index.html": () => new Response("guide", { status: 200 }),
      "index.html": () => new Response("root", { status: 200 }),
    });

  const GUIDE_URL = `${APP_ORIGIN}/docs/guide`;
  const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const deferredNetwork = () => {
    let resolve: (response: Response) => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const promise = new Promise<Response>((resolveResponse, rejectResponse) => {
      resolve = resolveResponse;
      reject = rejectResponse;
    });
    return { promise, reject, resolve };
  };
  // Makes the precached documents ready only on release, so a test decides whether the network or the offline copy finishes first.
  const holdPrecacheUntilReleased = (entries: Record<string, () => Response>) => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    hoisted.matchPrecache.mockImplementation(async (request: string | Request) => {
      await gate;
      return entries[typeof request === "string" ? request : request.url]?.();
    });
    return release;
  };
  const guideEntries = (buildInfo = "precached") => ({
    "build-info.js": () => new Response(buildInfo, { status: 200 }),
    "docs/guide/index.html": () => new Response("guide", { status: 200 }),
  });
  const fetchEvent = (init: Partial<RoutedEvent> = {}): RoutedEvent => ({
    resultingClientId: "page",
    type: "fetch",
    waitUntil: () => undefined,
    ...init,
  });
  const navigateToGuide = (harness: Harness, event: RoutedEvent = fetchEvent()) =>
    routed(harness, harness.networkFirstRoute, asNavigationRequest(GUIDE_URL), event);
  const requestBuildInfo = (harness: Harness) =>
    routed(harness, requireRoute(5), new Request(`${APP_ORIGIN}/build-info.js`), { clientId: "page", type: "fetch" });
  const fetchedUrls = (harness: Harness) =>
    harness.fetchStub.stub.mock.calls.map(([input]: [Request | string]) =>
      typeof input === "string" ? input : input.url,
    );

  it("serves the network page and its build-info.js when the network finishes before the offline copy answers", async () => {
    const harness = await loadCompleteWorker({ redirectSourcePaths: [] });
    const release = holdPrecacheUntilReleased(guideEntries());
    harness.fetchStub.handlers.set(GUIDE_URL, () => new Response("deployed guide", { status: 200 }));
    harness.fetchStub.handlers.set(`${APP_ORIGIN}/build-info.js`, () => new Response("deployed", { status: 200 }));

    const pending = navigateToGuide(harness);
    await flushMicrotasks();
    release();
    const response = await pending;

    await expect(response.text()).resolves.toBe("deployed guide");
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
    const runtime = await harness.cacheStorage.open(RUNTIME_CACHE_NAME);
    await expect((await runtime.match(GUIDE_URL))?.text()).resolves.toBe("deployed guide");
    await expect((await requestBuildInfo(harness)).text()).resolves.toBe("deployed");
  });

  it("serves the precached page and build-info.js when the network body is identical", async () => {
    const harness = await loadCompleteWorker({ redirectSourcePaths: [] });
    const release = holdPrecacheUntilReleased(guideEntries());
    harness.fetchStub.handlers.set(
      GUIDE_URL,
      () => new Response("guide", { headers: { "x-source": "network" }, status: 200 }),
    );

    const pending = navigateToGuide(harness);
    await flushMicrotasks();
    release();
    const response = await pending;

    await expect(response.text()).resolves.toBe("guide");
    expect(response.headers.get("x-source")).toBeNull();
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
    await expect((await requestBuildInfo(harness)).text()).resolves.toBe("precached");
    expect(fetchedUrls(harness)).toEqual([GUIDE_URL]);
  });

  it("serves the precached page at once while the network is pending, then refreshes the runtime cache", async () => {
    const harness = await loadCompleteWorker({ redirectSourcePaths: [] });
    setPrecache(guideEntries());
    const network = deferredNetwork();
    harness.fetchStub.stub.mockImplementation(() => network.promise);
    const pending: Array<Promise<unknown>> = [];

    const response = await navigateToGuide(harness, fetchEvent({ waitUntil: (promise) => void pending.push(promise) }));

    await expect(response.text()).resolves.toBe("guide");
    await expect((await requestBuildInfo(harness)).text()).resolves.toBe("precached");
    network.resolve(new Response("newer guide", { status: 200 }));
    await Promise.all(pending);
    const runtime = await harness.cacheStorage.open(RUNTIME_CACHE_NAME);
    await expect((await runtime.match(GUIDE_URL))?.text()).resolves.toBe("newer guide");
  });

  it("handles a network failure that arrives after the precached page was served", async () => {
    const harness = await loadCompleteWorker({ redirectSourcePaths: [] });
    setPrecache(guideEntries());
    const network = deferredNetwork();
    harness.fetchStub.stub.mockImplementation(() => network.promise);
    const pending: Array<Promise<unknown>> = [];

    await navigateToGuide(harness, fetchEvent({ waitUntil: (promise) => void pending.push(promise) }));
    network.reject(new TypeError("offline"));

    await expect(Promise.all(pending)).resolves.toBeDefined();
    expect(console.info).toHaveBeenCalledWith("[rom-weaver-sw]", "navigation network response unavailable", {
      error: "TypeError: offline",
    });
  });

  it("serves the precached page when the network fails at once", async () => {
    const harness = await loadCompleteWorker({ redirectSourcePaths: [] });
    const release = holdPrecacheUntilReleased(guideEntries());
    harness.fetchStub.stub.mockImplementation(() => Promise.reject(new TypeError("offline")));

    const pending = navigateToGuide(harness);
    await flushMicrotasks();
    release();
    const response = await pending;

    await expect(response.text()).resolves.toBe("guide");
    await expect((await requestBuildInfo(harness)).text()).resolves.toBe("precached");
  });

  const redirectedResponse = () => {
    const response = new Response("elsewhere", { status: 200 });
    Object.defineProperty(response, "redirected", { value: true });
    return response;
  };
  it.each([
    ["404", () => new Response("not found page", { status: 404 })],
    ["500", () => new Response("server error page", { status: 500 })],
    ["a redirected response", redirectedResponse],
  ])("keeps a valid precached page over a network answer that is %s", async (_label, answer) => {
    const harness = await loadCompleteWorker({ redirectSourcePaths: [] });
    const release = holdPrecacheUntilReleased(guideEntries());
    harness.fetchStub.handlers.set(GUIDE_URL, answer);

    const pending = navigateToGuide(harness);
    await flushMicrotasks();
    release();
    const response = await pending;

    await expect(response.text()).resolves.toBe("guide");
    await expect((await requestBuildInfo(harness)).text()).resolves.toBe("precached");
  });

  it("waits for the network while the offline copy is incomplete, with one request", async () => {
    const harness = await loadCompleteWorker({ missingDeferred: true, redirectSourcePaths: [] });
    setPrecache(guideEntries());
    const network = deferredNetwork();
    harness.fetchStub.stub.mockImplementation(() => network.promise);
    let settled = false;

    const pending = navigateToGuide(harness).finally(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);
    network.resolve(new Response("deployed guide", { status: 200 }));

    await expect((await pending).text()).resolves.toBe("deployed guide");
    expect(fetchedUrls(harness)).toEqual([GUIDE_URL]);
  });

  it("falls back to the precached page after the stall timeout while the offline copy is incomplete", async () => {
    vi.useFakeTimers();
    const harness = await loadCompleteWorker({ missingDeferred: true, redirectSourcePaths: [] });
    setPrecache(guideEntries());
    harness.fetchStub.stub.mockImplementation(() => new Promise<Response>(() => undefined));

    const pending = navigateToGuide(harness);
    await vi.advanceTimersByTimeAsync(4000);

    await expect((await pending).text()).resolves.toBe("guide");
    expect(fetchedUrls(harness)).toEqual([GUIDE_URL]);
  });

  describe.each([
    {
      label: "the offline copy is disabled",
      path: "/docs/guide",
      prepare: async () => {
        const harness = await loadCompleteWorker({ hasActiveWorker: true, redirectSourcePaths: [] });
        await dispatch(harness.scope, "message", {
          data: { action: "set-offline-copy-enabled", enabled: false },
          ports: [],
        });
        // Disabling clears the caches; refill them so only the disabled flag can send the navigation to the network.
        const core = await harness.cacheStorage.open(PRECACHE_NAME);
        await core.put(`${APP_ORIGIN}/index.html?__WB_REVISION__=r1`, new Response("x"));
        await core.put(`${APP_ORIGIN}/assets/app.js`, new Response("x"));
        await (await harness.cacheStorage.open(DEFERRED_CACHE_NAME)).put(DEFERRED_URL, new Response("x"));
        return harness;
      },
    },
    {
      label: "the path is a redirect alias",
      path: "/apply/",
      prepare: () => loadCompleteWorker({ redirectSourcePaths: ["/apply", "/apply/"] }),
    },
    {
      label: "the client prefers Markdown",
      accept: "text/markdown, text/html;q=0.5",
      path: "/docs/guide",
      prepare: () => loadCompleteWorker({ redirectSourcePaths: [] }),
    },
  ])("when $label", ({ accept, path, prepare }) => {
    it("answers from the network, never from a race with the precached page", async () => {
      const harness = await prepare();
      setPrecache({ ...guideEntries(), "apply/index.html": () => new Response("legacy", { status: 200 }) });
      const network = deferredNetwork();
      harness.fetchStub.stub.mockImplementation(() => network.promise);
      let settled = false;

      const pending = routed(
        harness,
        harness.networkFirstRoute,
        asNavigationRequest(`${APP_ORIGIN}${path}`, accept ? { accept } : undefined),
        fetchEvent(),
      ).finally(() => {
        settled = true;
      });
      await flushMicrotasks();
      expect(settled).toBe(false);
      network.resolve(new Response("from the network", { status: 200 }));

      await expect((await pending).text()).resolves.toBe("from the network");
      expect(fetchedUrls(harness)).toHaveLength(1);
    });
  });

  it.each([
    ["undefined", undefined],
    ["a promise of undefined", Promise.resolve(undefined)],
  ])("fetches once when preloadResponse is %s", async (_label, preloadResponse) => {
    const harness = await loadCompleteWorker({ redirectSourcePaths: [] });
    harness.fetchStub.handlers.set(`${APP_ORIGIN}/newer`, () => new Response("from fetch", { status: 200 }));

    const response = await routed(
      harness,
      harness.networkFirstRoute,
      asNavigationRequest(`${APP_ORIGIN}/newer`),
      fetchEvent({ preloadResponse }),
    );

    await expect(response.text()).resolves.toBe("from fetch");
    expect(harness.fetchStub.calls).toHaveLength(1);
  });

  it("uses the preload response as the network answer without fetching, and still caches it", async () => {
    const harness = await loadCompleteWorker({ redirectSourcePaths: [] });
    const newer = `${APP_ORIGIN}/newer`;

    const response = await routed(
      harness,
      harness.networkFirstRoute,
      asNavigationRequest(newer),
      fetchEvent({ preloadResponse: Promise.resolve(new Response("preloaded", { status: 200 })) }),
    );

    await expect(response.text()).resolves.toBe("preloaded");
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
    expect(harness.fetchStub.calls).toHaveLength(0);
    const runtime = await harness.cacheStorage.open(RUNTIME_CACHE_NAME);
    await expect((await runtime.match(newer))?.text()).resolves.toBe("preloaded");
  });

  it("treats a failed preload as the network failing, without a second request", async () => {
    const harness = await loadCompleteWorker({ redirectSourcePaths: [] });
    const preloadResponse = Promise.reject<Response | undefined>(new TypeError("offline"));
    preloadResponse.catch(() => undefined);

    const response = await routed(
      harness,
      harness.networkFirstRoute,
      asNavigationRequest(`${APP_ORIGIN}/newer`),
      fetchEvent({ preloadResponse }),
    );

    expect(response.type).toBe("error");
    expect(harness.fetchStub.calls).toHaveLength(0);
  });

  it("serves the precached build-info.js after a network redirect lands on a precached page", async () => {
    const harness = await loadCompleteWorker({ redirectSourcePaths: ["/apply"] });
    setPrecache({
      "build-info.js": () => new Response("precached", { status: 200 }),
      "docs/guide/index.html": () => new Response("guide", { status: 200 }),
    });
    harness.fetchStub.handlers.set(`${APP_ORIGIN}/apply`, () => new Response(null, { status: 301 }));
    harness.fetchStub.handlers.set(`${APP_ORIGIN}/build-info.js`, () => new Response("deployed", { status: 200 }));
    const hop = { resultingClientId: "page", type: "fetch" };
    await routed(harness, harness.networkFirstRoute, asNavigationRequest(`${APP_ORIGIN}/apply`), hop);
    await routed(harness, harness.networkFirstRoute, asNavigationRequest(`${APP_ORIGIN}/docs/guide`), hop);

    const buildInfo = await routed(harness, requireRoute(5), new Request(`${APP_ORIGIN}/build-info.js`), {
      clientId: "page",
      type: "fetch",
    });

    await expect(buildInfo.text()).resolves.toBe("precached");
  });

  it.each([
    ["stalls", () => new Promise<Response>(() => undefined)],
    ["fails", () => Promise.reject(new TypeError("offline"))],
  ])("prefers the precached page and its build-info.js when the network %s", async (_failure, network) => {
    vi.useFakeTimers();
    const guide = `${APP_ORIGIN}/docs/guide`;
    const harness = await loadCompleteWorker({
      missingDeferred: true,
      redirectSourcePaths: [],
      runtimeEntries: { [guide]: "newer deploy" },
    });
    setPrecache({
      "build-info.js": () => new Response("precached", { status: 200 }),
      "docs/guide/index.html": () => new Response("guide", { status: 200 }),
    });
    harness.fetchStub.stub.mockImplementation(network);
    const pending = routed(harness, harness.networkFirstRoute, asNavigationRequest(guide), {
      resultingClientId: "page",
      type: "fetch",
    });
    await vi.advanceTimersByTimeAsync(4000);

    await expect((await pending).text()).resolves.toBe("guide");
    const buildInfo = routed(harness, requireRoute(5), new Request(`${APP_ORIGIN}/build-info.js`), {
      clientId: "page",
      type: "fetch",
    });
    await expect((await buildInfo).text()).resolves.toBe("precached");
  });

  it("does not answer from the runtime cache, which may hold a newer deploy", async () => {
    const harness = await loadCompleteWorker({
      redirectSourcePaths: [],
      runtimeEntries: { [`${APP_ORIGIN}/newer`]: "newer-cached" },
    });
    harness.fetchStub.handlers.set(`${APP_ORIGIN}/newer`, () => new Response("newer-network", { status: 200 }));

    const response = await routed(harness, harness.networkFirstRoute, asNavigationRequest(`${APP_ORIGIN}/newer`));

    await expect(response.text()).resolves.toBe("newer-network");
  });

  it("serves a route offline under a sub-path scope with its base re-rooted on the scope", async () => {
    const harness = await loadCompleteWorker({ redirectSourcePaths: [], scope: `${APP_ORIGIN}/rom-weaver/` });
    harness.fetchStub.stub.mockImplementation(() => Promise.reject(new TypeError("offline")));
    setPrecache({
      "docs/guide/index.html": () =>
        new Response('<base href="../../" /><a href="/docs">Docs</a><script src="./assets/app.js"></script>', {
          headers: { "content-length": "999" },
          status: 200,
        }),
      "index.html": () => new Response("root", { status: 200 }),
    });

    const response = await routed(
      harness,
      harness.networkFirstRoute,
      asNavigationRequest(`${APP_ORIGIN}/rom-weaver/docs/guide`),
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe(
      '<base href="/rom-weaver/" /><a href="/rom-weaver/docs">Docs</a><script src="./assets/app.js"></script>',
    );
  });

  it("serves the scope root from index.html offline under a sub-path scope", async () => {
    const harness = await loadCompleteWorker({ redirectSourcePaths: [], scope: `${APP_ORIGIN}/rom-weaver/` });
    harness.fetchStub.stub.mockImplementation(() => Promise.reject(new TypeError("offline")));
    precachedDocs();

    const response = await routed(harness, harness.networkFirstRoute, asNavigationRequest(`${APP_ORIGIN}/rom-weaver/`));

    await expect(response.text()).resolves.toBe("root");
  });

  it("leaves a redirect alias under a sub-path scope to the server", async () => {
    const harness = await loadCompleteWorker({
      redirectSourcePaths: ["/apply", "/apply/"],
      scope: `${APP_ORIGIN}/rom-weaver/`,
    });
    precachedDocs();
    setPrecache({ "apply/index.html": () => new Response("legacy", { status: 200 }) });
    harness.fetchStub.handlers.set(
      `${APP_ORIGIN}/rom-weaver/apply/`,
      () => new Response(null, { headers: { location: "/rom-weaver/apply-rom-patches" }, status: 301 }),
    );

    const response = await routed(
      harness,
      harness.networkFirstRoute,
      asNavigationRequest(`${APP_ORIGIN}/rom-weaver/apply/`),
    );

    expect(response.status).toBe(301);
    expect(harness.fetchStub.calls).toHaveLength(1);
  });

  it("keeps an unknown path network-first so the server decides", async () => {
    const harness = await loadCompleteWorker({ redirectSourcePaths: ["/apply", "/apply/"] });
    precachedDocs();
    harness.fetchStub.handlers.set(`${APP_ORIGIN}/unknown`, () => new Response("server-404", { status: 404 }));

    const response = await routed(harness, harness.networkFirstRoute, asNavigationRequest(`${APP_ORIGIN}/unknown`));

    expect(response.status).toBe(404);
    expect(harness.fetchStub.calls.map((call) => call.url)).toEqual([`${APP_ORIGIN}/unknown`]);
  });

  it("leaves a redirect alias to the server even when its legacy document is precached", async () => {
    const harness = await loadCompleteWorker({ redirectSourcePaths: ["/apply", "/apply/"] });
    precachedDocs();
    setPrecache({ "apply/index.html": () => new Response("legacy", { status: 200 }) });
    harness.fetchStub.handlers.set(
      `${APP_ORIGIN}/apply/`,
      () => new Response(null, { headers: { location: "/apply-rom-patches" }, status: 301 }),
    );

    const response = await routed(harness, harness.networkFirstRoute, asNavigationRequest(`${APP_ORIGIN}/apply/`));

    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/apply-rom-patches");
    expect(harness.fetchStub.calls).toHaveLength(1);
  });

  it("goes to the network when the offline copy is disabled", async () => {
    const harness = await loadCompleteWorker({ hasActiveWorker: true, redirectSourcePaths: [] });
    precachedDocs();
    await dispatch(harness.scope, "message", {
      data: { action: "set-offline-copy-enabled", enabled: false },
      ports: [],
    });
    // Disabling clears the caches; refill them so only the disabled flag can send the navigation to the network.
    await (
      await harness.cacheStorage.open(PRECACHE_NAME)
    ).put(`${APP_ORIGIN}/index.html?__WB_REVISION__=r1`, new Response("x"));
    await (await harness.cacheStorage.open(PRECACHE_NAME)).put(`${APP_ORIGIN}/assets/app.js`, new Response("x"));
    await (await harness.cacheStorage.open(DEFERRED_CACHE_NAME)).put(DEFERRED_URL, new Response("x"));
    harness.fetchStub.handlers.set(`${APP_ORIGIN}/docs/guide`, () => new Response("fresh", { status: 200 }));

    const response = await routed(harness, harness.networkFirstRoute, asNavigationRequest(`${APP_ORIGIN}/docs/guide`));

    await expect(response.text()).resolves.toBe("fresh");
  });

  it("fails closed and uses the network when the redirect list was not injected", async () => {
    const harness = await loadCompleteWorker({ omitRedirectList: true });
    precachedDocs();
    harness.fetchStub.handlers.set(`${APP_ORIGIN}/docs/guide`, () => new Response("fresh", { status: 200 }));

    const response = await routed(harness, harness.networkFirstRoute, asNavigationRequest(`${APP_ORIGIN}/docs/guide`));

    await expect(response.text()).resolves.toBe("fresh");
  });

  it("goes to the network when the client prefers Markdown", async () => {
    const harness = await loadCompleteWorker({ redirectSourcePaths: ["/apply", "/apply/"] });
    precachedDocs();
    harness.fetchStub.handlers.set(`${APP_ORIGIN}/docs/guide`, () => new Response("# md", { status: 200 }));

    const response = await routed(
      harness,
      harness.networkFirstRoute,
      asNavigationRequest(`${APP_ORIGIN}/docs/guide`, { accept: "text/markdown, text/html;q=0.5" }),
    );

    await expect(response.text()).resolves.toBe("# md");
  });

  it("does not serve non-navigation HTML requests from the precache", async () => {
    const harness = await loadCompleteWorker({ redirectSourcePaths: ["/apply", "/apply/"] });
    precachedDocs();
    harness.fetchStub.handlers.set(`${APP_ORIGIN}/docs/guide`, () => new Response("fresh", { status: 200 }));

    const response = await routed(harness, harness.networkFirstRoute, asDocumentRequest(`${APP_ORIGIN}/docs/guide`));

    await expect(response.text()).resolves.toBe("fresh");
  });

  it("serves the exact cached copy when the network stalls past the timeout", async () => {
    vi.useFakeTimers();
    const harness = await loadWorker({
      seedCaches: async (cacheStorage) => {
        const cache = await cacheStorage.open(RUNTIME_CACHE_NAME);
        await cache.put(new Request(`${APP_ORIGIN}/newer`), new Response("cached", { status: 200 }));
      },
    });
    harness.fetchStub.stub.mockImplementation(() => new Promise<Response>(() => undefined));

    const pending = routed(harness, harness.networkFirstRoute, asNavigationRequest(`${APP_ORIGIN}/newer`));
    await vi.advanceTimersByTimeAsync(4000);

    await expect((await pending).text()).resolves.toBe("cached");
  });

  it("falls back at once when the fetch rejects before headers, without waiting out the timeout", async () => {
    vi.useFakeTimers();
    const harness = await loadWorker({
      seedCaches: async (cacheStorage) => {
        const cache = await cacheStorage.open(RUNTIME_CACHE_NAME);
        await cache.put(new Request(`${APP_ORIGIN}/newer`), new Response("cached", { status: 200 }));
      },
    });
    harness.fetchStub.stub.mockImplementation(() => Promise.reject(new TypeError("offline")));

    const pending = routed(harness, harness.networkFirstRoute, asNavigationRequest(`${APP_ORIGIN}/newer`));
    await vi.advanceTimersByTimeAsync(10);

    expect(vi.getTimerCount()).toBe(0);
    await expect((await pending).text()).resolves.toBe("cached");
  });

  it("measures the timeout to the response headers, not the body or the cache write", async () => {
    vi.useFakeTimers();
    const harness = await loadWorker({
      seedCaches: async (cacheStorage) => {
        const cache = await cacheStorage.open(RUNTIME_CACHE_NAME);
        await cache.put(new Request(`${APP_ORIGIN}/newer`), new Response("cached", { status: 200 }));
      },
    });
    const cache = await harness.cacheStorage.open(RUNTIME_CACHE_NAME);
    let finishWrite: () => void = () => undefined;
    const originalPut = cache.put.bind(cache);
    vi.spyOn(cache, "put").mockImplementation(
      (request, response) =>
        new Promise<void>((resolve) => (finishWrite = () => resolve(originalPut(request, response)))),
    );
    harness.fetchStub.handlers.set(`${APP_ORIGIN}/newer`, () => new Response("network", { status: 200 }));

    const pending = routed(harness, harness.networkFirstRoute, asNavigationRequest(`${APP_ORIGIN}/newer`));
    await vi.advanceTimersByTimeAsync(10_000);
    finishWrite();

    await expect((await pending).text()).resolves.toBe("network");
  });

  it("hands the background refresh after a timeout to waitUntil", async () => {
    vi.useFakeTimers();
    const harness = await loadWorker({
      seedCaches: async (cacheStorage) => {
        const cache = await cacheStorage.open(RUNTIME_CACHE_NAME);
        await cache.put(new Request(`${APP_ORIGIN}/newer`), new Response("cached", { status: 200 }));
      },
    });
    let release: (response: Response) => void = () => undefined;
    harness.fetchStub.stub.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
    const pending: Array<Promise<unknown>> = [];
    const event = { type: "fetch", waitUntil: (promise: Promise<unknown>) => void pending.push(promise) };

    const response = harness.networkFirstRoute.handler({
      event,
      request: asNavigationRequest(`${APP_ORIGIN}/newer`),
      url: new URL(`${APP_ORIGIN}/newer`),
    });
    await vi.advanceTimersByTimeAsync(4000);
    await expect((await response).text()).resolves.toBe("cached");
    // The refresh, plus the outgoing-build cleanup the page load runs.
    expect(pending).toHaveLength(2);

    release(new Response("fresh", { status: 200 }));
    await Promise.all(pending);
    const runtime = await harness.cacheStorage.open(RUNTIME_CACHE_NAME);
    await expect((await runtime.match(`${APP_ORIGIN}/newer`))?.text()).resolves.toBe("fresh");
  });

  it("waits for the network when a stalled navigation has no exact cached copy", async () => {
    vi.useFakeTimers();
    const harness = await loadWorker({ redirectSourcePaths: ["/apply", "/apply/"] });
    setPrecache({ "404.html": () => new Response("missing", { status: 200 }) });
    let release: (response: Response) => void = () => undefined;
    harness.fetchStub.stub.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));

    const pending = routed(harness, harness.networkFirstRoute, asNavigationRequest(`${APP_ORIGIN}/newer`));
    await vi.advanceTimersByTimeAsync(10_000);
    release(new Response("late", { status: 200 }));

    await expect((await pending).text()).resolves.toBe("late");
  });
  describe("offline copy completeness memo", () => {
    const send = (harness: Harness, data: unknown) => dispatch(harness.scope, "message", { data, ports: [] });
    // True when a navigation is answered from the offline copy while the network never answers.
    const isServedFromOfflineCopy = async (harness: Harness) => {
      const network = deferredNetwork();
      const original = harness.fetchStub.stub.getMockImplementation();
      harness.fetchStub.stub.mockImplementation((input: Request | string, init?: RequestInit) =>
        (typeof input === "string" ? input : input.url) === GUIDE_URL ? network.promise : original?.(input, init),
      );
      const pending = navigateToGuide(harness);
      const outcome = await Promise.race([pending.then(() => "served"), flushMicrotasks().then(() => "waiting")]);
      network.resolve(new Response("deployed guide", { status: 200 }));
      await pending;
      harness.fetchStub.stub.mockImplementation(original);
      return outcome === "served";
    };
    const holdOnce = (isHeld: (key: string) => boolean) => {
      let release: () => void = () => undefined;
      let markReached: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      let held = false;
      const hold = async (key: string) => {
        if (held || !isHeld(key)) return;
        held = true;
        markReached();
        await gate;
      };
      return { hold, reached, release };
    };
    const asFakeCache = async (harness: Harness, name: string) =>
      (await harness.cacheStorage.open(name)) as unknown as FakeCache;
    const holdCacheCall = async (
      harness: Harness,
      name: string,
      method: "delete" | "put",
      isHeld: (key: string) => boolean,
    ) => {
      const cache = await asFakeCache(harness, name);
      const original = cache[method].bind(cache);
      const hold = holdOnce(isHeld);
      vi.spyOn(cache, method).mockImplementation(async (request: RequestInfo | URL, response?: Response) => {
        await hold.hold(urlOf(request));
        return method === "put" && response ? original(request, response) : (original(request) as Promise<never>);
      });
      return hold;
    };
    const POLICY_CACHE_NAME = "precache-rom-weaver-offline-policy";

    it("serves from the offline copy once a pump stores the last missing deferred entry", async () => {
      const harness = await loadCompleteWorker({ missingDeferred: true, redirectSourcePaths: [] });
      setPrecache(guideEntries());
      expect(await isServedFromOfflineCopy(harness)).toBe(false);
      harness.fetchStub.handlers.set(DEFERRED_URL, () => new Response("js", { status: 200 }));

      await dispatch(harness.scope, "message", {
        data: { action: "offline-warmup-pump" },
        ports: [{ postMessage: () => undefined }],
      });

      expect(await harness.cacheStorage.caches.get(DEFERRED_CACHE_NAME)?.match(DEFERRED_URL)).toBeDefined();
      expect(await isServedFromOfflineCopy(harness)).toBe(true);
    });

    it("serves from the offline copy once an on-demand download stores the missing deferred entry", async () => {
      const harness = await loadCompleteWorker({ missingDeferred: true, redirectSourcePaths: [] });
      setPrecache(guideEntries());
      expect(await isServedFromOfflineCopy(harness)).toBe(false);
      harness.fetchStub.handlers.set(DEFERRED_URL, () => new Response("js", { status: 200 }));

      await routed(harness, requireRoute(2), new Request(DEFERRED_URL));

      expect(await isServedFromOfflineCopy(harness)).toBe(true);
    });

    it("keeps the completeness answer across a deferred cache hit", async () => {
      const harness = await loadCompleteWorker({ redirectSourcePaths: [] });
      setPrecache(guideEntries());
      expect(await isServedFromOfflineCopy(harness)).toBe(true);
      const open = vi.spyOn(harness.cacheStorage, "open");

      await routed(harness, requireRoute(2), new Request(DEFERRED_URL));
      expect(await isServedFromOfflineCopy(harness)).toBe(true);

      expect(open.mock.calls.filter(([name]) => name === PRECACHE_NAME)).toHaveLength(0);
    });

    it("waits for the network while the core precache is incomplete", async () => {
      const harness = await loadCompleteWorker({ missingCore: true, redirectSourcePaths: [] });
      setPrecache(guideEntries());

      expect(await isServedFromOfflineCopy(harness)).toBe(false);
    });

    it("waits for the network while a deferred entry is not cached yet, even for a precached document", async () => {
      const harness = await loadCompleteWorker({ missingDeferred: true, redirectSourcePaths: [] });
      setPrecache(guideEntries());

      expect(await isServedFromOfflineCopy(harness)).toBe(false);
    });

    it("checks the offline copy again on activation", async () => {
      const harness = await loadCompleteWorker({ hasActiveWorker: true, redirectSourcePaths: [] });
      setPrecache(guideEntries());
      expect(await isServedFromOfflineCopy(harness)).toBe(true);
      await (await asFakeCache(harness, DEFERRED_CACHE_NAME)).delete(DEFERRED_URL);

      await dispatch(harness.scope, "activate");

      expect(await isServedFromOfflineCopy(harness)).toBe(false);
    });

    it("checks the offline copy again when it is switched off and on while its files are being removed", async () => {
      const harness = await loadCompleteWorker({ hasActiveWorker: true, redirectSourcePaths: [] });
      setPrecache(guideEntries());
      expect(await isServedFromOfflineCopy(harness)).toBe(true);
      // Hold the removal after the core precache is gone, with the copy already switched back on.
      const reached = holdOnce(() => true);
      const originalDelete = harness.cacheStorage.delete.bind(harness.cacheStorage);
      vi.spyOn(harness.cacheStorage, "delete").mockImplementation(async (name: string) => {
        const deleted = await originalDelete(name);
        await reached.hold(name);
        return deleted;
      });
      const switchedOff = send(harness, { action: "set-offline-copy-enabled", enabled: false });
      const switchedOn = send(harness, { action: "set-offline-copy-enabled", enabled: true });
      await reached.reached;

      expect(await isServedFromOfflineCopy(harness)).toBe(false);
      reached.release();
      await Promise.all([switchedOff, switchedOn]);
    });

    it("checks the offline copy again once its files have been removed", async () => {
      const harness = await loadCompleteWorker({ hasActiveWorker: true, redirectSourcePaths: [] });
      setPrecache(guideEntries());
      // Hold the removal before it starts, with the copy already switched back on and its files intact.
      const held = await holdCacheCall(harness, POLICY_CACHE_NAME, "put", () => true);
      const switchedOff = send(harness, { action: "set-offline-copy-enabled", enabled: false });
      const switchedOn = send(harness, { action: "set-offline-copy-enabled", enabled: true });
      await held.reached;
      expect(await isServedFromOfflineCopy(harness)).toBe(true);

      held.release();
      await Promise.all([switchedOff, switchedOn]);

      expect(await isServedFromOfflineCopy(harness)).toBe(false);
    });

    it("checks the offline copy again when the documentation image format changes", async () => {
      const harness = await loadWorker({
        hasActiveWorker: true,
        manifest: [
          { revision: "r1", url: "index.html" },
          "assets/app.js",
          { install: false, url: "docs/screenshots/a.avif" },
          { install: false, url: "docs/screenshots/a.webp" },
        ],
        redirectSourcePaths: [],
        seedCaches: async (cacheStorage) => {
          const core = await cacheStorage.open(PRECACHE_NAME);
          await core.put(`${APP_SCOPE}index.html?__WB_REVISION__=r1`, new Response("x"));
          await core.put(`${APP_SCOPE}assets/app.js`, new Response("x"));
          await (
            await cacheStorage.open(DEFERRED_CACHE_NAME)
          ).put(`${APP_SCOPE}docs/screenshots/a.webp`, new Response("x"));
          await (
            await cacheStorage.open(POLICY_CACHE_NAME)
          ).put(`${APP_SCOPE}__rom-weaver-docs-image-format__`, new Response("webp"));
        },
      });
      setPrecache(guideEntries());
      // Queue the format change behind a held transition, so the memo is set before the format is stored,
      // then hold the cleanup that the new format triggers.
      const queued = await holdCacheCall(harness, POLICY_CACHE_NAME, "put", () => true);
      const cleanup = await holdCacheCall(harness, DEFERRED_CACHE_NAME, "delete", () => true);
      const first = send(harness, { action: "set-offline-copy-enabled", enabled: true });
      const second = send(harness, { action: "set-offline-copy-enabled", docImageFormat: "avif", enabled: true });
      await queued.reached;
      expect(await isServedFromOfflineCopy(harness)).toBe(true);

      queued.release();
      await cleanup.reached;

      expect(await isServedFromOfflineCopy(harness)).toBe(false);
      cleanup.release();
      await Promise.all([first, second]);
    });
  });
});

describe("EmulatorJS route", () => {
  it("matches the EmulatorJS manifest and data assets only", async () => {
    const harness = await loadWorker();
    const { match } = harness.emulatorJsRoute;
    const matches = (request: Request) => match({ request, url: new URL(request.url) });

    expect(matches(new Request(`${APP_ORIGIN}/emulatorjs/manifest.json`))).toBe(true);
    expect(matches(new Request(`${APP_ORIGIN}/emulatorjs/data/core.wasm`))).toBe(true);
    expect(matches(new Request(`${APP_ORIGIN}/emulatorjs/other.js`))).toBe(false);
    expect(matches(new Request("https://other.test/emulatorjs/data/core.wasm"))).toBe(false);
  });

  it("serves a cached EmulatorJS asset without touching the network", async () => {
    const harness = await loadWorker({
      seedCaches: async (cacheStorage) => {
        const cache = await cacheStorage.open(EMULATORJS_CACHE_NAME);
        await cache.put(new Request(`${APP_ORIGIN}/emulatorjs/data/core.wasm`), new Response("core", { status: 200 }));
      },
    });

    const response = await routed(
      harness,
      harness.emulatorJsRoute,
      new Request(`${APP_ORIGIN}/emulatorjs/data/core.wasm`),
    );

    await expect(response.text()).resolves.toBe("core");
    expect(harness.fetchStub.stub).not.toHaveBeenCalled();
  });

  it("downloads and caches a missing EmulatorJS asset with omitted credentials", async () => {
    const harness = await loadWorker();
    harness.fetchStub.handlers.set(
      `${APP_ORIGIN}/emulatorjs/data/core.wasm`,
      () => new Response("core", { status: 200 }),
    );

    const response = await routed(
      harness,
      harness.emulatorJsRoute,
      new Request(`${APP_ORIGIN}/emulatorjs/data/core.wasm`, { mode: "no-cors" }),
    );

    expect(response.status).toBe(200);
    expect(harness.fetchStub.calls[0]?.credentials).toBe("omit");
    expect(harness.cacheStorage.caches.get(EMULATORJS_CACHE_NAME)?.entries.size).toBe(1);
  });

  it("does not cache an EmulatorJS asset the host could not serve", async () => {
    const harness = await loadWorker();
    harness.fetchStub.handlers.set(
      `${APP_ORIGIN}/emulatorjs/data/core.wasm`,
      () => new Response("missing", { status: 404 }),
    );

    const response = await routed(
      harness,
      harness.emulatorJsRoute,
      new Request(`${APP_ORIGIN}/emulatorjs/data/core.wasm`),
    );

    expect(response.status).toBe(404);
    expect(harness.cacheStorage.caches.get(EMULATORJS_CACHE_NAME)?.entries.size ?? 0).toBe(0);
  });
});

describe("identify pack route", () => {
  const PACK_URL = `${APP_ORIGIN}/assets/identify-computers.pack`;

  it("matches only same-origin identify pack asset URLs", async () => {
    const harness = await loadWorker();
    const { match } = harness.identifyPackRoute;
    const matches = (request: Request) => match({ request, url: new URL(request.url) });

    expect(matches(new Request(PACK_URL))).toBe(true);
    expect(matches(new Request(`${APP_ORIGIN}/assets/identify-checksum-routes.bin`))).toBe(true);
    expect(matches(new Request(`${APP_ORIGIN}/assets/identify-cheats-nintendo-game-boy.json?sha256=aa`))).toBe(true);
    expect(matches(new Request(`${APP_ORIGIN}/assets/identify-title-index.json?sha256=aa`))).toBe(true);
    expect(matches(new Request(`${APP_ORIGIN}/assets/identify-index.json`))).toBe(false);
    expect(matches(new Request(`${APP_ORIGIN}/assets/other.pack`))).toBe(false);
    expect(matches(new Request("https://other.test/assets/identify-computers.pack"))).toBe(false);
  });

  it("prefers a pack left behind in the precache", async () => {
    const harness = await loadWorker();
    setPrecache({ [PACK_URL]: () => new Response("precached-pack", { status: 200 }) });

    const response = await routed(harness, harness.identifyPackRoute, new Request(PACK_URL));

    await expect(response.text()).resolves.toBe("precached-pack");
    expect(harness.warmup.serveOptionalIdentifyPack).not.toHaveBeenCalled();
  });

  it("delegates to the warm-up when the precache misses", async () => {
    const harness = await loadWorker();

    const response = await routed(harness, harness.identifyPackRoute, new Request(PACK_URL));

    await expect(response.text()).resolves.toBe("pack-bytes");
    expect(harness.warmup.serveOptionalIdentifyPack).toHaveBeenCalledTimes(1);
  });

  it("returns a network error when the warm-up cannot serve the pack", async () => {
    const harness = await loadWorker();
    vi.mocked(harness.warmup.serveOptionalIdentifyPack).mockRejectedValue(new Error("pack digest mismatch"));

    const response = await routed(harness, harness.identifyPackRoute, new Request(PACK_URL));

    expect(response.type).toBe("error");
  });
});

describe("precache plugin", () => {
  it("logs install completion and activation stages when updating an existing worker", async () => {
    const harness = await loadWorker({ hasActiveWorker: true, manifest: ["index.html"] });
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    await dispatch(harness.scope, "install");
    now = 350;
    await harness.plugin.handlerDidComplete?.({
      event: { type: "install" },
      request: new Request(APP_SCOPE),
      response: new Response("ok"),
    });
    expect(harness.scope.clientMessages).toContainEqual(
      expect.objectContaining({
        action: "service-worker-log",
        message: "precache install complete",
        details: { files: 1, elapsedMs: 250 },
      }),
    );
    harness.scope.clients.claim.mockImplementation(async () => {
      now += 75;
    });
    await dispatch(harness.scope, "activate");
    expect(harness.scope.clientMessages).toContainEqual(
      expect.objectContaining({
        message: "service worker phase complete",
        details: { phase: "claim clients", elapsedMs: 75 },
      }),
    );
    expect(harness.scope.clientMessages).toContainEqual(
      expect.objectContaining({
        message: "service worker phase complete",
        details: { phase: "activate", elapsedMs: 75 },
      }),
    );
  });

  it("logs an install failure without labeling it complete", async () => {
    const harness = await loadWorker({ manifest: ["index.html"] });
    await dispatch(harness.scope, "install");
    await harness.plugin.handlerDidComplete?.({
      event: { type: "install" },
      request: new Request(APP_SCOPE),
      error: new Error("cache write failed"),
    });
    expect(harness.scope.clientMessages).toContainEqual(
      expect.objectContaining({ message: "precache install failed" }),
    );
    expect(harness.scope.clientMessages).not.toContainEqual(
      expect.objectContaining({ message: "precache install complete" }),
    );
  });

  it("logs a rejected Workbox response before the remaining install entries run", async () => {
    const harness = await loadWorker();
    await dispatch(harness.scope, "install");
    vi.stubGlobal("FetchEvent", Event);
    vi.stubGlobal("ExtendableEvent", Event);
    vi.stubGlobal("location", harness.scope.location);
    harness.fetchStub.stub.mockRejectedValue(new Error("network lost"));
    const { PrecacheStrategy } = await import("workbox-precaching/PrecacheStrategy.js");
    const strategy = new PrecacheStrategy({ plugins: [{ handlerDidComplete: harness.plugin.handlerDidComplete }] });
    const event = Object.assign(new Event("install"), { waitUntil: vi.fn() });
    const [response, done] = strategy.handleAll({ event, request: new Request(APP_SCOPE) });
    await expect(response).rejects.toThrow();
    await done;
    expect(harness.scope.clientMessages).toContainEqual(
      expect.objectContaining({
        message: "precache install failed",
        details: expect.objectContaining({ files: 1, error: "No precache response" }),
      }),
    );
    expect(harness.scope.clientMessages).not.toContainEqual(
      expect.objectContaining({ message: "precache install complete" }),
    );
  });

  it("reports incoming bytes before an install response finishes", async () => {
    const harness = await loadWorker();
    await dispatch(harness.scope, "install", {});
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const source = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          streamController = controller;
        },
      }),
    );
    const response = await harness.plugin.fetchDidSucceed?.({
      event: { type: "install" },
      request: new Request(`${APP_ORIGIN}/assets/app.js`),
      response: source,
    });
    const reader = response?.body?.getReader();
    streamController?.enqueue(new Uint8Array(12));
    expect((await reader?.read())?.value?.byteLength).toBe(12);
    await vi.waitFor(() =>
      expect(harness.scope.clientMessages).toContainEqual(
        expect.objectContaining({ action: "offline-precache-progress", cachedBytes: 52, ready: false }),
      ),
    );
    streamController?.close();
    await reader?.read();
    await harness.plugin.cacheDidUpdate?.({ request: new Request(`${APP_ORIGIN}/assets/app.js`) });
  });
  it("lowers the fetch priority of install-time requests only", async () => {
    const harness = await loadWorker();
    const request = new Request(`${APP_ORIGIN}/assets/app.js`);

    const installRequest = await harness.plugin.requestWillFetch?.({ event: { type: "install" }, request });
    const fetchRequest = await harness.plugin.requestWillFetch?.({ event: { type: "fetch" }, request });

    expect(installRequest).not.toBe(request);
    expect(fetchRequest).toBe(request);
  });

  it("refuses to precache an error response and passes a good one through", async () => {
    const harness = await loadWorker();
    const request = new Request(`${APP_ORIGIN}/assets/app.js`);
    const good = new Response("ok", { status: 200 });

    await expect(
      harness.plugin.cacheWillUpdate?.({ request, response: new Response("boom", { status: 500 }) }),
    ).resolves.toBeNull();
    await expect(harness.plugin.cacheWillUpdate?.({ request, response: good })).resolves.toBe(good);
  });

  it("stamps isolation headers on precache responses", async () => {
    const harness = await loadWorker();

    const response = await harness.plugin.handlerWillRespond?.({ response: new Response("body") });

    expect(response?.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
    expect(response?.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
  });

  it("leaves a response that already declares its own COEP untouched", async () => {
    const harness = await loadWorker();
    const served = new Response("body", { headers: { "Cross-Origin-Embedder-Policy": "require-corp" } });

    const response = await harness.plugin.handlerWillRespond?.({ response: served });

    expect(response?.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(response?.headers.get("Cross-Origin-Opener-Policy")).toBeNull();
  });

  // Every worker log line is broadcast to the window clients too (the page log
  // relays them), so a precache assertion has to name the messages it means.
  const precacheMessages = (scope: { clientMessages: unknown[] }) =>
    scope.clientMessages.filter((message) => (message as { action?: string }).action === "offline-precache-progress");

  it("suppresses unchanged percentages but always broadcasts install completion to uncontrolled pages", async () => {
    const harness = await loadWorker();
    await dispatch(harness.scope, "install");

    await harness.plugin.handlerDidComplete?.({
      event: { type: "install" },
      request: new Request(APP_SCOPE),
      response: new Response("ok"),
    });
    await harness.plugin.handlerDidComplete?.({
      event: { type: "install" },
      request: new Request(APP_SCOPE),
      response: new Response("ok"),
    });
    expect(precacheMessages(harness.scope)).toHaveLength(1);

    await harness.plugin.handlerDidComplete?.({
      event: { type: "install" },
      request: new Request(APP_SCOPE),
      response: new Response("ok"),
    });

    expect(precacheMessages(harness.scope)).toHaveLength(2);
    expect(precacheMessages(harness.scope)[0]).toMatchObject({
      action: "offline-precache-progress",
      cachedFiles: 2,
      phase: "precache",
      ready: false,
      totalFiles: 5,
    });
  });

  it("stays silent for non-install completions and for update installs", async () => {
    const harness = await loadWorker({ hasActiveWorker: true });
    await dispatch(harness.scope, "install");

    await harness.plugin.handlerDidComplete?.({
      event: { type: "fetch" },
      request: new Request(APP_SCOPE),
      response: new Response("ok"),
    });
    await harness.plugin.handlerDidComplete?.({
      event: { type: "install" },
      request: new Request(APP_SCOPE),
      response: new Response("ok"),
    });

    expect(precacheMessages(harness.scope)).toEqual([]);
  });
});

describe("install and activate", () => {
  it.each([
    { hasActiveWorker: false, label: "a first install" },
    { hasActiveWorker: true, label: "an update" },
  ])("takes control without waiting on $label", async ({ hasActiveWorker }) => {
    const harness = await loadWorker({ hasActiveWorker });

    await dispatch(harness.scope, "install");

    expect(harness.scope.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("deletes stale managed caches and claims the open clients", async () => {
    const harness = await loadWorker({
      seedCaches: async (cacheStorage) => {
        await cacheStorage.open(PRECACHE_NAME);
        await cacheStorage.open(RUNTIME_CACHE_NAME);
        await cacheStorage.open(EMULATORJS_CACHE_NAME);
        await cacheStorage.open("precache-rom-weaver-emulatorjs-0.0.1");
        await cacheStorage.open("precache-rom-weaver-runtime-older");
        await cacheStorage.open(OUTGOING_BUILD_CACHE_NAME);
        await cacheStorage.open("unrelated-cache");
      },
    });

    await dispatch(harness.scope, "activate");

    expect(harness.cacheStorage.deleted.sort()).toEqual([
      "precache-rom-weaver-emulatorjs-0.0.1",
      "precache-rom-weaver-runtime-older",
    ]);
    expect(harness.scope.clients.claim).toHaveBeenCalledTimes(1);
  });

  it("enables navigation preload when it activates", async () => {
    const harness = await loadWorker();
    const enable = vi.fn(async () => undefined);
    harness.scope.registration.navigationPreload = { enable };

    await dispatch(harness.scope, "activate");

    expect(enable).toHaveBeenCalledTimes(1);
    expect(harness.scope.clients.claim).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["is missing", undefined],
    [
      "refuses to enable",
      {
        enable: async () => {
          throw new Error("preload refused");
        },
      },
    ],
  ])("still activates when the navigation preload API %s", async (_label, navigationPreload) => {
    const harness = await loadWorker();
    harness.scope.registration.navigationPreload = navigationPreload;

    await dispatch(harness.scope, "activate");

    expect(harness.scope.clients.claim).toHaveBeenCalledTimes(1);
    expect(console.info).toHaveBeenCalledWith(
      "[rom-weaver-sw]",
      expect.stringContaining("navigation preload"),
      ...(navigationPreload ? [{ error: "Error: preload refused" }] : []),
    );
  });
});

describe("COEP mode", () => {
  it("persists a require-corp downgrade and serves it on the next response", async () => {
    const harness = await loadWorker();

    await dispatch(harness.scope, "message", { data: { action: "set-coep-credentialless", value: false } });

    const stored = await harness.cacheStorage.caches.get(RUNTIME_CACHE_NAME)?.match(COEP_MODE_URL);
    await expect(stored?.text()).resolves.toBe("require-corp");

    const response = await harness.plugin.handlerWillRespond?.({ response: new Response("body") });
    expect(response?.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(response?.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
  });

  it("persists credentialless when the message omits a value", async () => {
    const harness = await loadWorker();

    await dispatch(harness.scope, "message", { data: { action: "set-coep-credentialless" } });

    const stored = await harness.cacheStorage.caches.get(RUNTIME_CACHE_NAME)?.match(COEP_MODE_URL);
    await expect(stored?.text()).resolves.toBe("credentialless");
  });

  it("hydrates a persisted require-corp mode after a worker restart", async () => {
    const harness = await loadWorker({
      seedCaches: async (cacheStorage) => {
        const cache = await cacheStorage.open(RUNTIME_CACHE_NAME);
        await cache.put(COEP_MODE_URL, new Response("require-corp"));
      },
    });

    await dispatch(harness.scope, "activate");
    const response = await harness.plugin.handlerWillRespond?.({ response: new Response("body") });

    expect(response?.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
  });

  it("still applies the mode in memory when it cannot be persisted", async () => {
    const harness = await loadWorker();
    vi.spyOn(harness.cacheStorage, "open").mockRejectedValue(new Error("CacheStorage is unavailable"));

    await dispatch(harness.scope, "message", { data: { action: "set-coep-credentialless", value: false } });
    const response = await harness.plugin.handlerWillRespond?.({ response: new Response("body") });

    expect(response?.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
  });

  it("keeps the credentialless default when the persisted mode cannot be read", async () => {
    const harness = await loadWorker();
    vi.spyOn(harness.cacheStorage, "open").mockRejectedValue(new Error("CacheStorage is unavailable"));

    const response = await harness.plugin.handlerWillRespond?.({ response: new Response("body") });

    expect(response?.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
  });
});

describe("outgoing build files", () => {
  const OLD_CHUNK_URL = `${APP_ORIGIN}/assets/old-chunk.js`;
  const OLD_LAZY_URL = `${APP_ORIGIN}/assets/old-lazy.js`;
  const outgoingRoute = () => requireRoute(6);
  const keptUrls = (harness: Harness) => [
    ...(harness.cacheStorage.caches.get(OUTGOING_BUILD_CACHE_NAME)?.entries.keys() ?? []),
  ];
  const missingFileMessages = (harness: Harness) =>
    harness.scope.clientMessages.filter((message) => (message as { action?: string }).action === "build-file-missing");
  const keepOldChunk = async (cacheStorage: FakeCacheStorage) => {
    const outgoing = await cacheStorage.open(OUTGOING_BUILD_CACHE_NAME);
    await outgoing.put(new Request(OLD_CHUNK_URL), new Response("old chunk"));
  };

  it("keeps the outgoing build's hashed files this build lacks when an update installs", async () => {
    const harness = await loadWorker({
      hasActiveWorker: true,
      seedCaches: async (cacheStorage) => {
        const precache = await cacheStorage.open(PRECACHE_NAME);
        await precache.put(new Request(OLD_CHUNK_URL), new Response("old chunk"));
        await precache.put(new Request(`${APP_ORIGIN}/assets/app.js`), new Response("shared chunk"));
        await precache.put(new Request(`${APP_ORIGIN}/index.html?__WB_REVISION__=r0`), new Response("old page"));
        const deferred = await cacheStorage.open(DEFERRED_CACHE_NAME);
        await deferred.put(new Request(OLD_LAZY_URL), new Response("old lazy chunk"));
      },
    });

    await dispatch(harness.scope, "install");

    expect(keptUrls(harness).sort()).toEqual([OLD_CHUNK_URL, OLD_LAZY_URL]);
  });

  it("still installs an update when the outgoing build's files cannot be kept", async () => {
    const harness = await loadWorker({
      hasActiveWorker: true,
      seedCaches: async (cacheStorage) => {
        const precache = await cacheStorage.open(PRECACHE_NAME);
        await precache.put(new Request(OLD_CHUNK_URL), new Response("old chunk"));
        const outgoing = (await cacheStorage.open(OUTGOING_BUILD_CACHE_NAME)) as unknown as FakeCache;
        outgoing.put = async () => {
          throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
        };
      },
    });

    await expect(dispatch(harness.scope, "install")).resolves.toBeUndefined();
  });

  it("serves a kept file to a tab still running the outgoing build", async () => {
    const harness = await loadWorker({ seedCaches: keepOldChunk });

    const response = await routed(harness, outgoingRoute(), new Request(OLD_CHUNK_URL));

    await expect(response.text()).resolves.toBe("old chunk");
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
    expect(harness.fetchStub.calls).toEqual([]);
  });

  it("fetches an outgoing build file it did not keep", async () => {
    const harness = await loadWorker();
    harness.fetchStub.handlers.set(OLD_CHUNK_URL, () => new Response("network chunk"));

    const response = await routed(harness, outgoingRoute(), new Request(OLD_CHUNK_URL));

    await expect(response.text()).resolves.toBe("network chunk");
    expect(missingFileMessages(harness)).toEqual([]);
  });

  it("tells the open tabs when the host no longer has an outgoing build file", async () => {
    const harness = await loadWorker();
    harness.fetchStub.handlers.set(OLD_CHUNK_URL, () => new Response("gone", { status: 404 }));

    const response = await routed(harness, outgoingRoute(), new Request(OLD_CHUNK_URL));

    expect(response.status).toBe(404);
    expect(missingFileMessages(harness)).toEqual([{ action: "build-file-missing", url: OLD_CHUNK_URL }]);
  });

  it("tells the open tabs when the network cannot fetch an outgoing build file", async () => {
    const harness = await loadWorker();

    await expect(routed(harness, outgoingRoute(), new Request(OLD_CHUNK_URL))).rejects.toThrow("Failed to fetch");

    expect(missingFileMessages(harness)).toEqual([{ action: "build-file-missing", url: OLD_CHUNK_URL }]);
  });

  it.each([
    { label: "a file this build precaches", url: `${APP_ORIGIN}/assets/app.js` },
    { label: "a file this build downloads later", url: `${APP_ORIGIN}/assets/deferred.js` },
    { label: "a file outside the hashed folder", url: `${APP_ORIGIN}/docs/old.md` },
    { label: "another origin's file", url: "https://cdn.test/assets/old-chunk.js" },
  ])("leaves $label to the other routes", async ({ url }) => {
    await loadWorker({
      manifest: [...DEFAULT_MANIFEST, { install: false, revision: null, url: "assets/deferred.js" }],
    });
    hoisted.getCacheKeyForURL.mockImplementation((href: string) =>
      href === `${APP_ORIGIN}/assets/app.js` ? href : undefined,
    );

    expect(outgoingRoute().match({ request: new Request(url), url: new URL(url) })).toBe(false);
  });

  describe("after a page load", () => {
    const tab = (id: string) => ({ id, postMessage: () => undefined }) as unknown as Scope["client"];
    const loadPage = async (harness: Harness) => {
      harness.fetchStub.handlers.set(`${APP_ORIGIN}/docs/guide`, () => new Response("page", { status: 200 }));
      const pending: Array<Promise<unknown>> = [];
      await harness.networkFirstRoute.handler({
        event: {
          resultingClientId: "new",
          type: "fetch",
          waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
        },
        request: asNavigationRequest(`${APP_ORIGIN}/docs/guide`),
        url: new URL(`${APP_ORIGIN}/docs/guide`),
      });
      return pending;
    };

    it("removes the files once a reloading tab's new page is the only tab", async () => {
      vi.useFakeTimers();
      const harness = await loadWorker({ seedCaches: keepOldChunk });
      harness.scope.clientList.splice(0, harness.scope.clientList.length, tab("old"));
      const pending = await loadPage(harness);

      await vi.advanceTimersByTimeAsync(500);
      expect(keptUrls(harness)).toEqual([OLD_CHUNK_URL]);

      harness.scope.clientList.splice(0, 1, tab("new"));
      await vi.advanceTimersByTimeAsync(250);
      await Promise.all(pending);

      expect(keptUrls(harness)).toEqual([]);
    });

    it("removes the files at once when no tab is open", async () => {
      const harness = await loadWorker({ seedCaches: keepOldChunk });
      harness.scope.clientList.length = 0;

      await Promise.all(await loadPage(harness));

      expect(keptUrls(harness)).toEqual([]);
    });

    it("keeps the files while another tab stays open", async () => {
      vi.useFakeTimers();
      const harness = await loadWorker({ seedCaches: keepOldChunk });
      harness.scope.clientList.splice(0, harness.scope.clientList.length, tab("other"), tab("new"));
      const pending = await loadPage(harness);

      await vi.advanceTimersByTimeAsync(6000);
      await Promise.all(pending);

      expect(keptUrls(harness)).toEqual([OLD_CHUNK_URL]);
    });
  });
});

describe("offline warm-up messages", () => {
  const collect = async (harness: Harness, data: unknown) => {
    const replies: unknown[] = [];
    await dispatch(harness.scope, "message", {
      data,
      ports: [{ postMessage: (message: unknown) => replies.push(message) }],
    });
    return replies;
  };

  it("routes a group-only pump without downloading the app precache", async () => {
    const harness = await loadWorker();
    const replies = await collect(harness, {
      action: "offline-warmup-pump",
      identifyGroupIds: ["optional-computers", 7, null],
    });
    expect(harness.warmup.runNextUnit).toHaveBeenCalledWith(expect.any(Function), ["optional-computers"]);
    expect(harness.fetchStub.calls).toEqual([]);
    expect(replies.at(-1)).toMatchObject({ action: "offline-warmup-progress" });
  });

  it("discards a queued group-only pump after a pause", async () => {
    const harness = await loadWorker();
    let release: () => void = () => undefined;
    vi.mocked(harness.warmup.runNextUnit).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ bytes: 12, files: 1 });
        }),
    );
    const request = { action: "offline-warmup-pump", identifyGroupIds: ["optional-computers"] };
    const first = collect(harness, request);
    await vi.waitFor(() => expect(harness.warmup.runNextUnit).toHaveBeenCalledOnce());
    const queued = collect(harness, request);
    try {
      await dispatch(harness.scope, "message", { data: { action: "offline-warmup-pause" } });
      release();
      await Promise.all([first, queued]);
      expect(harness.warmup.runNextUnit).toHaveBeenCalledOnce();
      expect(harness.fetchStub.calls).toEqual([]);
    } finally {
      release();
      await Promise.all([first, queued]);
    }
  });

  it("streams interim progress and the final unit result for a pump", async () => {
    const harness = await loadWorker({ manifest: [] });
    vi.mocked(harness.warmup.runNextUnit).mockImplementation(async (onInterim) => {
      onInterim?.({ bytes: 5 });
      return { bytes: 12, files: 1 };
    });

    const replies = await collect(harness, { action: "offline-warmup-pump" });

    expect(replies).toEqual([
      { action: "offline-warmup-interim", bytes: 5 },
      { action: "offline-warmup-progress", bytes: 12, files: 1 },
    ]);
  });

  it("reports a failed pump", async () => {
    const harness = await loadWorker({ manifest: [] });
    vi.mocked(harness.warmup.runNextUnit).mockRejectedValue(new Error("disk full"));

    const replies = await collect(harness, { action: "offline-warmup-pump" });

    expect(replies).toEqual([{ action: "offline-warmup-failed", error: "Error: disk full" }]);
  });

  it("bumps the EmulatorJS unit and filters non-string identify group ids", async () => {
    const harness = await loadWorker();

    await dispatch(harness.scope, "message", {
      data: { action: "offline-warmup-bump", target: { kind: "emulatorjs" } },
    });
    await dispatch(harness.scope, "message", {
      data: { action: "offline-warmup-bump", target: { groupIds: ["computers", 7, null], kind: "identify-groups" } },
    });
    await dispatch(harness.scope, "message", { data: { action: "offline-warmup-bump", target: { kind: "other" } } });
    await dispatch(harness.scope, "message", { data: { action: "offline-warmup-bump" } });

    expect(harness.warmup.bumpPriority).toHaveBeenNthCalledWith(1, { kind: "emulatorjs" });
    expect(harness.warmup.bumpPriority).toHaveBeenNthCalledWith(2, {
      groupIds: ["computers"],
      kind: "identify-groups",
    });
    expect(harness.warmup.bumpPriority).toHaveBeenCalledTimes(2);
  });

  it("answers and reports failures for the ready-state query", async () => {
    const harness = await loadWorker();

    await expect(collect(harness, { action: "get-offline-ready-state" })).resolves.toEqual([
      {
        action: "offline-ready-state",
        cachedBytes: 40,
        cachedFiles: 2,
        enabled: true,
        pendingUnits: 1,
        ready: false,
        totalBytes: 100,
        totalFiles: 5,
      },
    ]);

    vi.mocked(harness.warmup.getReadyState).mockRejectedValue("no cache");
    await expect(collect(harness, { action: "get-offline-ready-state" })).resolves.toEqual([
      { action: "offline-ready-state-failed", error: "no cache" },
    ]);
  });

  it("throttles the cached-files heartbeat and returns the inventory", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const harness = await loadWorker();
    vi.mocked(harness.warmup.getCachedFiles).mockImplementation(async (onProgress) => {
      onProgress?.();
      onProgress?.();
      vi.setSystemTime(1_000_400);
      onProgress?.();
      return [{ cache: PRECACHE_NAME, path: "/index.html" }];
    });

    const replies = await collect(harness, { action: "get-offline-cached-files" });

    expect(replies).toEqual([
      { action: "offline-warmup-interim" },
      { action: "offline-warmup-interim" },
      { action: "offline-cached-files", files: [{ cache: PRECACHE_NAME, path: "/index.html" }] },
    ]);
  });

  it("reports a failed cached-files query", async () => {
    const harness = await loadWorker();
    vi.mocked(harness.warmup.getCachedFiles).mockRejectedValue(new Error("read failed"));

    await expect(collect(harness, { action: "get-offline-cached-files" })).resolves.toEqual([
      { action: "offline-cached-files-failed", error: "Error: read failed" },
    ]);
  });

  it("answers and reports failures for the identify group state query", async () => {
    const harness = await loadWorker();

    await expect(collect(harness, { action: "get-identify-pack-group-state" })).resolves.toEqual([
      { action: "identify-pack-group-state", groups: [{ id: "computers" }] },
    ]);

    vi.mocked(harness.warmup.getIdentifyGroupState).mockRejectedValue(new Error("state failed"));
    await expect(collect(harness, { action: "get-identify-pack-group-state" })).resolves.toEqual([
      { action: "identify-pack-group-state-failed", error: "Error: state failed" },
    ]);
  });

  it("normalizes a missing group id when setting the wanted flag", async () => {
    const harness = await loadWorker();

    await collect(harness, { action: "set-identify-pack-group-wanted", groupId: "computers", wanted: true });
    await collect(harness, { action: "set-identify-pack-group-wanted", groupId: 7, wanted: "yes" });

    expect(harness.warmup.setIdentifyGroupWanted).toHaveBeenNthCalledWith(1, "computers", true);
    expect(harness.warmup.setIdentifyGroupWanted).toHaveBeenNthCalledWith(2, "", false);
  });

  it("reports a failed wanted-flag update", async () => {
    const harness = await loadWorker();
    vi.mocked(harness.warmup.setIdentifyGroupWanted).mockRejectedValue(new Error("write failed"));

    await expect(
      collect(harness, { action: "set-identify-pack-group-wanted", groupId: "computers", wanted: false }),
    ).resolves.toEqual([{ action: "identify-pack-group-state-failed", error: "Error: write failed" }]);
  });

  it("installs an identify group and names the group in an install failure", async () => {
    const harness = await loadWorker();

    await expect(collect(harness, { action: "install-identify-pack-group", groupId: "computers" })).resolves.toEqual([
      { action: "identify-pack-group-installed", id: "computers", installed: true },
    ]);

    vi.mocked(harness.warmup.installIdentifyGroup).mockRejectedValue(new Error("download failed"));
    await expect(collect(harness, { action: "install-identify-pack-group", groupId: "computers" })).resolves.toEqual([
      { action: "identify-pack-group-install-failed", error: "Error: download failed", id: "computers" },
    ]);
  });
});

describe("offline copy policy", () => {
  const send = async (harness: Harness, data: unknown) => {
    const replies: unknown[] = [];
    await dispatch(harness.scope, "message", {
      data,
      ports: [{ postMessage: (message: unknown) => replies.push(message) }],
    });
    return replies;
  };

  it("rejects a malformed setting without removing files", async () => {
    const harness = await loadWorker();
    await (await harness.cacheStorage.open(PRECACHE_NAME)).put(`${APP_ORIGIN}/index.html`, new Response("app"));
    expect(await send(harness, { action: "set-offline-copy-enabled", enabled: "false" })).toEqual([
      { action: "offline-copy-state-failed", error: "Error: Offline copy enabled value must be a boolean" },
    ]);
    expect(await harness.cacheStorage.caches.get(PRECACHE_NAME)?.match(`${APP_ORIGIN}/index.html`)).toBeDefined();
  });

  it("blocks Workbox cache repair while disabled and drops install entries without failing the install", async () => {
    const harness = await loadWorker();
    await send(harness, { action: "set-offline-copy-enabled", enabled: false });
    const request = new Request(`${APP_ORIGIN}/assets/app.js`);
    const response = new Response("app");
    expect(await harness.plugin.cacheWillUpdate?.({ event: { type: "fetch" }, request, response })).toBeNull();
    expect(await harness.plugin.cacheWillUpdate?.({ event: { type: "install" }, request, response })).toBeDefined();
    await (await harness.cacheStorage.open(PRECACHE_NAME)).put(request, response);
    await harness.plugin.cacheDidUpdate?.({ request });
    expect(await harness.cacheStorage.caches.get(PRECACHE_NAME)?.match(request)).toBeUndefined();
  });

  it("removes managed files while keeping COEP, identify choices, and unrelated caches", async () => {
    const deferredUrl = `${APP_ORIGIN}/assets/deferred.bin`;
    const wantedUrl = `${APP_ORIGIN}/__rom-weaver-identify-wanted__`;
    const harness = await loadWorker({
      manifest: [
        { url: "index.html", sizeBytes: 3 },
        { url: "assets/app.js", revision: "r1", sizeBytes: 2 },
        { url: deferredUrl, install: false, sizeBytes: 4 },
      ],
      seedCaches: async (storage) => {
        await (await storage.open(PRECACHE_NAME)).put(`${APP_ORIGIN}/index.html`, new Response("app"));
        await (await storage.open(RUNTIME_CACHE_NAME)).put(COEP_MODE_URL, new Response("require-corp"));
        await (await storage.open(RUNTIME_CACHE_NAME)).put(`${APP_ORIGIN}/page`, new Response("page"));
        await (await storage.open(IDENTIFY_CACHE_NAME)).put(wantedUrl, new Response('["computers"]'));
        await (
          await storage.open(IDENTIFY_CACHE_NAME)
        ).put(`${APP_ORIGIN}/assets/identify-computers.pack`, new Response("pack"));
        await (await storage.open("unrelated-cache")).put(`${APP_ORIGIN}/save`, new Response("save"));
      },
    });
    vi.mocked(harness.warmup.getReadyState).mockImplementation(async () => {
      const state = await harness.warmupConfig.precacheState();
      return {
        ...state,
        pendingUnits: state.totalFiles - state.cachedFiles,
        ready: state.cachedFiles === state.totalFiles,
      };
    });
    harness.fetchStub.handlers.set(APP_SCOPE, () => new Response("app"));
    harness.fetchStub.handlers.set(`${APP_ORIGIN}/assets/app.js`, () => new Response("js"));
    harness.fetchStub.handlers.set(deferredUrl, () => new Response("file"));
    await (await harness.cacheStorage.open("precache-rom-weaver-app-deferred")).put(deferredUrl, new Response("old"));

    const reply = await send(harness, { action: "set-offline-copy-enabled", enabled: false });
    expect(reply).toEqual([expect.objectContaining({ action: "offline-copy-state", enabled: false, ready: false })]);
    expect(await harness.cacheStorage.caches.get(RUNTIME_CACHE_NAME)?.match(COEP_MODE_URL)).toBeDefined();
    expect(await harness.cacheStorage.caches.get(RUNTIME_CACHE_NAME)?.match(`${APP_ORIGIN}/page`)).toBeUndefined();
    expect(await harness.cacheStorage.caches.get(IDENTIFY_CACHE_NAME)?.match(wantedUrl)).toBeDefined();
    expect(
      await harness.cacheStorage.caches.get(IDENTIFY_CACHE_NAME)?.match(`${APP_ORIGIN}/assets/identify-computers.pack`),
    ).toBeUndefined();
    expect(await harness.cacheStorage.caches.get("unrelated-cache")?.match(`${APP_ORIGIN}/save`)).toBeDefined();
    expect(await harness.cacheStorage.caches.get(PRECACHE_NAME)?.match(`${APP_ORIGIN}/index.html`)).toBeUndefined();
    expect(
      await harness.cacheStorage.caches.get("precache-rom-weaver-app-deferred")?.match(deferredUrl),
    ).toBeUndefined();
    expect(harness.scope.clients.claim).not.toHaveBeenCalled();

    await send(harness, { action: "offline-warmup-pump" });
    expect(harness.fetchStub.calls.some(({ url }) => url === deferredUrl)).toBe(false);
    expect(await (await routed(harness, requireRoute(2), new Request(deferredUrl))).text()).toBe("file");
    expect(
      await harness.cacheStorage.caches.get("precache-rom-weaver-app-deferred")?.match(deferredUrl),
    ).toBeUndefined();
    const emulatorUrl = `${APP_ORIGIN}/emulatorjs/data/game.js`;
    harness.fetchStub.handlers.set(emulatorUrl, () => new Response("game"));
    expect(await (await routed(harness, harness.emulatorJsRoute, new Request(emulatorUrl))).text()).toBe("game");
    expect(await harness.cacheStorage.caches.get(EMULATORJS_CACHE_NAME)?.match(emulatorUrl)).toBeUndefined();
    harness.fetchStub.handlers.set(`${APP_ORIGIN}/page`, () => new Response("page"));
    const page = await routed(harness, harness.networkFirstRoute, asDocumentRequest(`${APP_ORIGIN}/page`));
    expect(page.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(await harness.cacheStorage.caches.get(RUNTIME_CACHE_NAME)?.match(`${APP_ORIGIN}/page`)).toBeUndefined();
    await send(harness, { action: "set-offline-copy-enabled", enabled: true });
    expect(await send(harness, { action: "offline-warmup-pump" })).toContainEqual(
      expect.objectContaining({ action: "offline-warmup-progress" }),
    );
    expect(await harness.cacheStorage.caches.get(PRECACHE_NAME)?.match(`${APP_ORIGIN}/index.html`)).toBeDefined();
    expect(
      await harness.cacheStorage.caches.get(PRECACHE_NAME)?.match(`${APP_ORIGIN}/assets/app.js?__WB_REVISION__=r1`),
    ).toBeDefined();
    const complete = await send(harness, { action: "offline-warmup-pump" });
    expect(harness.fetchStub.calls.some(({ url }) => url === deferredUrl)).toBe(true);
    expect(await harness.cacheStorage.caches.get("precache-rom-weaver-app-deferred")?.match(deferredUrl)).toBeDefined();
    expect(complete).toContainEqual(expect.objectContaining({ action: "offline-warmup-progress", ready: true }));
    expect(await harness.warmupConfig.precacheState()).toMatchObject({
      cachedBytes: 9,
      cachedFiles: 3,
      totalBytes: 9,
      totalFiles: 3,
    });
  });

  it("resumes missing core files after restarting an enabled but incomplete copy", async () => {
    const harness = await loadWorker({
      hasActiveWorker: true,
      manifest: [{ url: "index.html", revision: "root", sizeBytes: 3 }],
      seedCaches: async (storage) => {
        await (
          await storage.open("precache-rom-weaver-offline-policy")
        ).put(`${APP_ORIGIN}/__rom-weaver-offline-copy-enabled__`, new Response("true"));
      },
    });
    harness.fetchStub.handlers.set(APP_SCOPE, () => new Response("app"));
    await send(harness, { action: "set-offline-copy-enabled", enabled: true });
    await send(harness, { action: "offline-warmup-pump" });
    expect(
      await harness.cacheStorage.caches.get(PRECACHE_NAME)?.match(`${APP_ORIGIN}/index.html?__WB_REVISION__=root`),
    ).toBeDefined();
    expect(await harness.warmupConfig.precacheState()).toMatchObject({ cachedBytes: 3, cachedFiles: 1, totalFiles: 1 });
  });

  it("hydrates the disabled choice after a worker restart", async () => {
    const first = await loadWorker();
    await send(first, { action: "set-offline-copy-enabled", enabled: false });
    const metadata = await first.cacheStorage.caches
      .get("precache-rom-weaver-offline-policy")
      ?.match(`${APP_ORIGIN}/__rom-weaver-offline-copy-enabled__`);
    expect(await metadata?.clone().text()).toBe("false");
    const restarted = await loadWorker({
      seedCaches: async (storage) => {
        if (metadata) {
          await (
            await storage.open("precache-rom-weaver-offline-policy")
          ).put(`${APP_ORIGIN}/__rom-weaver-offline-copy-enabled__`, metadata.clone());
        }
        await (await storage.open(PRECACHE_NAME)).put(`${APP_ORIGIN}/index.html`, new Response("install"));
        await (
          await storage.open("precache-rom-weaver-runtime-old-build")
        ).put(COEP_MODE_URL, new Response("require-corp"));
        await (await storage.open("precache-rom-weaver-app-deferred")).put(`${APP_ORIGIN}/asset`, new Response("file"));
      },
    });
    restarted.scope.clients.claim.mockImplementation(async () => {
      expect(await restarted.cacheStorage.caches.get(PRECACHE_NAME)?.match(`${APP_ORIGIN}/index.html`)).toBeUndefined();
      expect(
        await restarted.cacheStorage.caches.get("precache-rom-weaver-app-deferred")?.match(`${APP_ORIGIN}/asset`),
      ).toBeUndefined();
      expect(await restarted.cacheStorage.caches.get(RUNTIME_CACHE_NAME)?.match(COEP_MODE_URL)).toBeDefined();
    });
    await dispatch(restarted.scope, "activate");
    expect(restarted.cacheStorage.caches.has("precache-rom-weaver-offline-policy")).toBe(true);
    expect(restarted.scope.clients.claim).toHaveBeenCalledTimes(1);
    const page = await restarted.plugin.handlerWillRespond?.({ response: new Response("page") });
    expect(page?.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(await send(restarted, { action: "get-offline-ready-state" })).toEqual([
      expect.objectContaining({ action: "offline-ready-state", enabled: false, ready: false }),
    ]);
    await send(restarted, { action: "offline-warmup-pump" });
    expect(restarted.warmup.runNextUnit).not.toHaveBeenCalled();
  });
});

describe("precache state reported to the warm-up", () => {
  it("does not count a cached file from a different revision", async () => {
    const harness = await loadWorker({
      manifest: [{ url: "index.html", revision: "new", sizeBytes: 10 }],
      seedCaches: async (storage) => {
        const cache = await storage.open(PRECACHE_NAME);
        await cache.put(`${APP_ORIGIN}/index.html?__WB_REVISION__=old`, new Response("old"));
      },
    });
    expect(await harness.warmupConfig.precacheState()).toEqual({
      cachedBytes: 0,
      deferredCachedBytes: 0,
      cachedFiles: 0,
      totalBytes: 10,
      totalFiles: 1,
      transferredBytes: 0,
      transferBytesIncomplete: false,
    });
  });
  it("combines the build's size table with what the precache already holds", async () => {
    const harness = await loadWorker({
      seedCaches: async (cacheStorage) => {
        const cache = await cacheStorage.open(PRECACHE_NAME);
        await cache.put(new Request(`${APP_ORIGIN}/index.html?__WB_REVISION__=r1`), new Response("<html>"));
      },
    });
    harness.fetchStub.handlers.set(
      PRECACHE_SIZES_URL,
      () => new Response(JSON.stringify({ "assets/app.js": 20, "index.html": 10, "no-size.js": "big" })),
    );

    await expect(harness.warmupConfig.precacheState()).resolves.toEqual({
      cachedBytes: 10,
      deferredCachedBytes: 0,
      cachedFiles: 1,
      totalBytes: 30,
      totalFiles: 3,
      transferredBytes: 10,
      transferBytesIncomplete: false,
    });
    expect(harness.fetchStub.calls[0]?.init).toMatchObject({ priority: "low" });
  });

  it("falls back to entry counts when the size table is missing", async () => {
    const harness = await loadWorker();
    harness.fetchStub.handlers.set(PRECACHE_SIZES_URL, () => new Response("not found", { status: 404 }));

    await expect(harness.warmupConfig.precacheState()).resolves.toEqual({
      cachedBytes: 0,
      deferredCachedBytes: 0,
      cachedFiles: 0,
      totalBytes: 0,
      totalFiles: 3,
      transferredBytes: 0,
      transferBytesIncomplete: false,
    });
  });

  it("loads the size table once per worker", async () => {
    const harness = await loadWorker();
    harness.fetchStub.handlers.set(PRECACHE_SIZES_URL, () => new Response(JSON.stringify({ "index.html": 10 })));

    await harness.warmupConfig.precacheState();
    await harness.warmupConfig.precacheState();

    expect(harness.fetchStub.calls.filter((call) => call.url === PRECACHE_SIZES_URL)).toHaveLength(1);
  });

  it("fetches interactive warm-up traffic without the low-priority hint", async () => {
    const harness = await loadWorker();
    harness.fetchStub.handlers.set(`${APP_ORIGIN}/assets/identify-computers.pack`, () => new Response("pack"));

    await harness.warmupConfig.fetchForInteractive(`${APP_ORIGIN}/assets/identify-computers.pack`);

    expect(harness.fetchStub.calls[0]?.init).toBeUndefined();
  });
});

describe("BIOS HEAD route", () => {
  const BIOS_URL = `${APP_ORIGIN}/emulatorjs/bios/saturn_bios.bin`;
  const loadBiosWorker = (cachedBios?: Response) =>
    loadWorker({
      manifest: [
        "index.html",
        { install: false, url: "emulatorjs/bios/saturn_bios.bin" },
        { install: false, url: "assets/deferred.js" },
      ],
      seedCaches: async (cacheStorage) => {
        if (cachedBios) await (await cacheStorage.open(DEFERRED_CACHE_NAME)).put(BIOS_URL, cachedBios);
      },
    });
  const head = (url: string) => new Request(url, { method: "HEAD" });

  it("registers for HEAD only", async () => {
    await loadBiosWorker();

    expect(requireRoute(3).method).toBe("HEAD");
    expect(hoisted.routes.filter((route) => route.method === "HEAD")).toHaveLength(1);
  });

  it("answers from the offline copy without a body or a network request", async () => {
    const harness = await loadBiosWorker(new Response("bios", { headers: { "content-length": "4" }, status: 200 }));

    const response = await routed(harness, requireRoute(3), head(BIOS_URL));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("4");
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
    await expect(response.text()).resolves.toBe("");
    expect(harness.fetchStub.calls).toHaveLength(0);
  });

  it("matches the versioned BIOS URL the page requests", async () => {
    const harness = await loadBiosWorker(new Response("bios", { headers: { "content-length": "4" }, status: 200 }));

    const response = await routed(harness, requireRoute(3), head(`${BIOS_URL}?sha256=${"a".repeat(64)}`));

    expect(response.headers.get("content-length")).toBe("4");
    expect(harness.fetchStub.calls).toHaveLength(0);
  });

  it("passes a successful network answer through when the file is not cached", async () => {
    const harness = await loadBiosWorker();
    harness.fetchStub.handlers.set(
      BIOS_URL,
      () => new Response(null, { headers: { "content-length": "4" }, status: 200 }),
    );

    const response = await routed(harness, requireRoute(3), head(BIOS_URL));

    expect(response.headers.get("content-length")).toBe("4");
  });

  it.each([
    ["the network fails", undefined],
    ["the host answers with an error status", () => new Response(null, { status: 503 })],
  ])("answers an empty 200 when %s", async (_case, handler) => {
    const harness = await loadBiosWorker();
    if (handler) harness.fetchStub.handlers.set(BIOS_URL, handler);

    const response = await routed(harness, requireRoute(3), head(BIOS_URL));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBeNull();
    expect(harness.fetchStub.calls.map((call) => call.url)).toEqual([BIOS_URL]);
  });

  it("leaves GET and other deferred files to the other routes", async () => {
    await loadBiosWorker();
    const route = requireRoute(3);
    const other = `${APP_ORIGIN}/assets/deferred.js`;

    expect(route.match({ request: new Request(BIOS_URL), url: new URL(BIOS_URL) })).toBe(false);
    expect(route.match({ request: head(other), url: new URL(other) })).toBe(false);
  });
});
