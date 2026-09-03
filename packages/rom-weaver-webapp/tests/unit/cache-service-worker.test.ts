import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PrecacheManifestEntry = string | { revision?: string | null; url: string };

type CapturedRoute = {
  handler: (options: { event?: { type: string }; request: Request; url: URL }) => Promise<Response>;
  match: (options: { request: Request; url: URL }) => boolean;
};

type CapturedPlugin = {
  cacheWillUpdate?: (options: { request: Request; response: Response }) => Promise<Response | null | undefined>;
  handlerDidComplete?: (options: { event: { type: string } }) => Promise<void>;
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
  registerRoute: (match: unknown, handler: unknown) => {
    hoisted.routes.push({ handler: handler as CapturedRoute["handler"], match: match as CapturedRoute["match"] });
  },
}));

vi.mock("workbox-precaching", () => ({
  addPlugins: (plugins: unknown[]) => {
    hoisted.plugins.push(...(plugins as CapturedPlugin[]));
  },
  cleanupOutdatedCaches: hoisted.cleanupOutdatedCaches,
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
const SW_HREF = `${APP_ORIGIN}/cache-service-worker.js?build=${BUILD_TOKEN}`;
const EMULATORJS_VERSION = "4.2.3";
const PRECACHE_NAME = "precache-rom-weaver";
const RUNTIME_CACHE_NAME = `precache-rom-weaver-runtime-${BUILD_TOKEN}`;
const EMULATORJS_CACHE_NAME = `precache-rom-weaver-emulatorjs-${EMULATORJS_VERSION}`;
const IDENTIFY_CACHE_NAME = "precache-rom-weaver-identify-optional";
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
  async match(request: RequestInfo | URL) {
    for (const cache of this.caches.values()) {
      const hit = await cache.match(request);
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
  unparsableHref = false,
}: {
  hasActiveWorker?: boolean;
  href?: string;
  manifest?: PrecacheManifestEntry[];
  unparsableHref?: boolean;
} = {}) => {
  const listeners = new Map<string, Array<(event: SwEvent) => void>>();
  const clientMessages: unknown[] = [];
  const clientList = [{ postMessage: (message: unknown) => clientMessages.push(message) }];
  return {
    __WB_MANIFEST: manifest,
    addEventListener(type: string, listener: (event: SwEvent) => void) {
      const existing = listeners.get(type);
      if (existing) existing.push(listener);
      else listeners.set(type, [listener]);
    },
    clientMessages,
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => clientList),
    },
    listeners,
    location: unparsableHref ? { href, origin: APP_ORIGIN } : new URL(href),
    performance: globalThis.performance,
    registration: { active: hasActiveWorker ? { scriptURL: href } : null, scope: APP_SCOPE },
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
    seedCaches?: (cacheStorage: FakeCacheStorage) => Promise<void> | void;
    unparsableHref?: boolean;
  } = {},
): Promise<Harness> => {
  hoisted.routes.length = 0;
  hoisted.plugins.length = 0;
  hoisted.matchPrecache.mockReset();
  hoisted.matchPrecache.mockResolvedValue(undefined);
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
  vi.stubGlobal("__IDENTIFY_OPTIONAL_PACK_GROUPS__", [
    { id: "computers", label: "Computers", packs: [{ sha256: "aa", url: "assets/identify-computers.pack" }] },
  ]);

  vi.resetModules();
  await import("../../src/webapp/cache-service-worker.ts");

  const plugin = hoisted.plugins[0];
  if (!plugin) throw new Error("The service worker registered no precache plugin");
  const warmupConfig = hoisted.warmup.config;
  if (!warmupConfig) throw new Error("The service worker created no offline warm-up");

  return {
    cacheStorage,
    emulatorJsRoute: requireRoute(1),
    fetchStub,
    identifyPackRoute: requireRoute(2),
    networkFirstRoute: requireRoute(0),
    plugin,
    scope,
    warmup,
    warmupConfig,
  };
};

const routed = (harness: Harness, route: CapturedRoute, request: Request, event?: { type: string }) => {
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

describe("service worker bootstrap", () => {
  it("registers the three runtime routes, the precache plugin and the warm-up", async () => {
    const harness = await loadWorker();

    expect(hoisted.routes).toHaveLength(3);
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

  it("broadcasts throttled install progress to uncontrolled pages", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const harness = await loadWorker();
    await dispatch(harness.scope, "install");

    await harness.plugin.handlerDidComplete?.({ event: { type: "install" } });
    await harness.plugin.handlerDidComplete?.({ event: { type: "install" } });
    expect(precacheMessages(harness.scope)).toHaveLength(1);

    vi.setSystemTime(1_000_500);
    await harness.plugin.handlerDidComplete?.({ event: { type: "install" } });

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

    await harness.plugin.handlerDidComplete?.({ event: { type: "fetch" } });
    await harness.plugin.handlerDidComplete?.({ event: { type: "install" } });

    expect(precacheMessages(harness.scope)).toEqual([]);
  });
});

describe("install and activate", () => {
  it("takes control immediately on a first install", async () => {
    const harness = await loadWorker();

    await dispatch(harness.scope, "install");

    expect(harness.scope.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it("waits when an active worker is already installed", async () => {
    const harness = await loadWorker({ hasActiveWorker: true });

    await dispatch(harness.scope, "install");

    expect(harness.scope.skipWaiting).not.toHaveBeenCalled();
  });

  it("deletes stale managed caches and claims the open clients", async () => {
    const harness = await loadWorker({
      seedCaches: async (cacheStorage) => {
        await cacheStorage.open(PRECACHE_NAME);
        await cacheStorage.open(RUNTIME_CACHE_NAME);
        await cacheStorage.open(EMULATORJS_CACHE_NAME);
        await cacheStorage.open("precache-rom-weaver-emulatorjs-0.0.1");
        await cacheStorage.open("precache-rom-weaver-runtime-older");
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

describe("skip waiting messages", () => {
  it("accepts both the registrar type and the app action", async () => {
    const harness = await loadWorker();

    await dispatch(harness.scope, "message", { data: { type: "SKIP_WAITING" } });
    await dispatch(harness.scope, "message", { data: { action: "skip-waiting" } });

    expect(harness.scope.skipWaiting).toHaveBeenCalledTimes(2);
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

  it("streams interim progress and the final unit result for a pump", async () => {
    const harness = await loadWorker();
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
    const harness = await loadWorker();
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

describe("precache state reported to the warm-up", () => {
  it("combines the build's size table with what the precache already holds", async () => {
    const harness = await loadWorker({
      seedCaches: async (cacheStorage) => {
        const cache = await cacheStorage.open(PRECACHE_NAME);
        await cache.put(new Request(`${APP_ORIGIN}/index.html`), new Response("<html>"));
      },
    });
    harness.fetchStub.handlers.set(
      PRECACHE_SIZES_URL,
      () => new Response(JSON.stringify({ "assets/app.js": 20, "index.html": 10, "no-size.js": "big" })),
    );

    await expect(harness.warmupConfig.precacheState()).resolves.toEqual({
      cachedBytes: 10,
      cachedFiles: 1,
      totalBytes: 30,
      totalFiles: 3,
    });
    expect(harness.fetchStub.calls[0]?.init).toMatchObject({ priority: "low" });
  });

  it("falls back to entry counts when the size table is missing", async () => {
    const harness = await loadWorker();
    harness.fetchStub.handlers.set(PRECACHE_SIZES_URL, () => new Response("not found", { status: 404 }));

    await expect(harness.warmupConfig.precacheState()).resolves.toEqual({
      cachedBytes: 0,
      cachedFiles: 0,
      totalBytes: 0,
      totalFiles: 3,
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
