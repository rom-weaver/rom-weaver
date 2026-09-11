/// <reference lib="webworker" />

const MANIFEST_PATH_REGEX = /\/manifest\.json$/i;
const INDEX_HTML_PATH_REGEX = /\/index\.html$/i;
const VITE_INTERNAL_PATH_REGEX = /\/(@fs|@id|@vite)\//;
const SOURCE_OR_NODE_MODULES_PATH_REGEX = /\/(src|node_modules)\//;
const SOURCE_MODULE_EXTENSION_REGEX = /\.(?:[cm]?js|jsx|ts|tsx|css)$/i;

import { cacheNames, setCacheNameDetails } from "workbox-core";
import type { WorkboxPlugin } from "workbox-core/types.js";
import { addPlugins, cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { APP_BUILD_VERSION, RESOLVED_APP_BUILD_VERSION } from "./build-version.ts";
import { createOfflineWarmup } from "./offline-warmup.ts";
import { prioritizePrecacheInstallRequest } from "./pwa/fetch-priority.ts";
import { createDeferredPrecache } from "./pwa/deferred-precache.ts";
import { keepResourceTimingsRecording, withMeasuredEncodedSize } from "./pwa/response-encoded-size.ts";
import { routeDocumentCandidates } from "./pwa/route-documents.ts";
import { createServiceWorkerCachePolicy, findStaleServiceWorkerCaches } from "./pwa/service-worker-cache-policy.ts";

declare const __EMULATORJS_VERSION__: string;
declare const __IDENTIFY_OPTIONAL_PACK_GROUPS__: Array<{
  id: string;
  label: string;
  packs: Array<{ sha256: string; sizeBytes?: number; url: string }>;
  required?: boolean;
}>;

type OfflinePrecacheEntry = {
  revision?: string | null;
  url: string;
  install?: boolean;
  sizeBytes?: number;
};
declare let self: ServiceWorkerGlobalScope;

const PRECACHE_ID = "rom-weaver";
const COI_COEP_CREDENTIALLESS_ACTION = "set-coep-credentialless";
const COI_HEADER_COEP = "Cross-Origin-Embedder-Policy";
const COI_HEADER_COOP = "Cross-Origin-Opener-Policy";
const COI_HEADER_CORP = "Cross-Origin-Resource-Policy";
const getDevBuildToken = () => {
  if (!import.meta.env.DEV) return "";
  try {
    const query = new URL(self.location.href).searchParams;
    return query.get("build") || "";
  } catch {
    return "";
  }
};
const DEV_BUILD_TOKEN = getDevBuildToken();
const PRECACHE_VERSION = import.meta.env.DEV
  ? DEV_BUILD_TOKEN || RESOLVED_APP_BUILD_VERSION || APP_BUILD_VERSION || "dev"
  : RESOLVED_APP_BUILD_VERSION || APP_BUILD_VERSION || "unknown";

setCacheNameDetails({
  precache: PRECACHE_ID,
  prefix: "precache",
  runtime: `${PRECACHE_ID}-runtime-${PRECACHE_VERSION}`,
});

const PRECACHE_NAME = cacheNames.precache;
const RUNTIME_CACHE_NAME = cacheNames.runtime;
const MANAGED_CACHE_PREFIX = `${cacheNames.prefix}-${PRECACHE_ID}-`;
const EMULATORJS_CACHE_PREFIX = `${MANAGED_CACHE_PREFIX}emulatorjs-`;
const EMULATORJS_CACHE_NAME = `${EMULATORJS_CACHE_PREFIX}${__EMULATORJS_VERSION__}`;
const IDENTIFY_OPTIONAL_CACHE_NAME = `${MANAGED_CACHE_PREFIX}identify-optional`;
const DEFERRED_CACHE_NAME = `${MANAGED_CACHE_PREFIX}app-deferred`;
const CACHE_POLICY = createServiceWorkerCachePolicy({
  additionalCacheNames: [DEFERRED_CACHE_NAME],
  emulatorJsCacheName: EMULATORJS_CACHE_NAME,
  emulatorJsCachePrefix: EMULATORJS_CACHE_PREFIX,
  identifyOptionalCacheName: IDENTIFY_OPTIONAL_CACHE_NAME,
  managedCachePrefix: MANAGED_CACHE_PREFIX,
  precacheName: PRECACHE_NAME,
  runtimeCacheName: RUNTIME_CACHE_NAME,
});
const SW_LOG_PREFIX = "[rom-weaver-sw]";
// In-memory COEP mode. Volatile: resets to the credentialless default whenever the worker thread is
// terminated and respawned (notably on mobile Safari). The durable copy below survives that so a page
// that already degraded to require-corp keeps isolating after a respawn instead of silently falling back.
let coepCredentialless = true;
// Synthetic cache entry that persists the discovered COEP mode across worker restarts.
const COEP_MODE_URL = new URL("/__rom-weaver-coep-mode__", self.location.origin).href;
const COEP_MODE_REQUIRE_CORP = "require-corp";
const COEP_MODE_CREDENTIALLESS = "credentialless";
let coepModeHydrated = false;
let coepModeHydration: Promise<boolean> | null = null;

// A worker logs to its own console, which a bug report from a user never
// contains: the page's exported log is the artifact that reaches us. Every
// line goes to both, and a line written while no window client exists (an
// install, a warm-up or a fetch with every tab closed) is held until one
// connects. Failures are swallowed: a log line MUST NOT be able to break the
// operation it describes.
type ServiceWorkerLogEntry = { details?: Record<string, unknown>; message: string; timestamp: string };

// The backlog covers a page that is starting up, not a whole offline session,
// so it drops its oldest entries rather than growing without bound.
const LOG_BACKLOG_LIMIT = 200;
const logBacklog: ServiceWorkerLogEntry[] = [];

const writeServiceWorkerConsole = ({ details, message }: ServiceWorkerLogEntry) => {
  if (details) console.info(SW_LOG_PREFIX, message, details);
  else console.info(SW_LOG_PREFIX, message);
};

const postServiceWorkerLog = (client: Client, entry: ServiceWorkerLogEntry, queued: boolean) => {
  try {
    client.postMessage({
      action: "service-worker-log",
      details: entry.details,
      message: entry.message,
      queued,
      timestamp: entry.timestamp,
    });
    return true;
  } catch {
    // A detail value that cannot be cloned costs this one delivery.
    return false;
  }
};

/**
 * Send the backlog, plus `entry` when one is being logged now, to every window
 * client. With no client to take them the entries go back on the backlog, in
 * order, for the next page that connects.
 */
const flushServiceWorkerLogs = async (entry?: ServiceWorkerLogEntry) => {
  const pending = [...logBacklog.splice(0), ...(entry ? [entry] : [])];
  if (!pending.length) return;
  let clients: readonly Client[] = [];
  try {
    clients = await (self.clients?.matchAll({ includeUncontrolled: true, type: "window" }) ?? []);
  } catch {
    // No client access at all (a test double, a context still starting up).
  }
  if (!clients.length) {
    logBacklog.push(...pending);
    if (logBacklog.length > LOG_BACKLOG_LIMIT) logBacklog.splice(0, logBacklog.length - LOG_BACKLOG_LIMIT);
    return;
  }
  for (const client of clients) {
    for (const queuedEntry of pending) postServiceWorkerLog(client, queuedEntry, queuedEntry !== entry);
  }
};

const logServiceWorker = (message: string, details?: Record<string, unknown>) => {
  const entry: ServiceWorkerLogEntry = { details, message, timestamp: new Date().toISOString() };
  writeServiceWorkerConsole(entry);
  void flushServiceWorkerLogs(entry).catch(() => undefined);
};

const formatError = (error: unknown) => {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
};

// Lazily load the persisted COEP mode into the in-memory flag. Only the first call after a (re)spawn
// touches CacheStorage; later calls return the cached flag, so this is cheap to call per request.
const ensureCoepModeHydrated = async (): Promise<boolean> => {
  if (coepModeHydrated) return coepCredentialless;
  if (!coepModeHydration) {
    coepModeHydration = (async () => {
      try {
        const cache = await caches.open(RUNTIME_CACHE_NAME);
        const stored = await cache.match(COEP_MODE_URL);
        if (stored) {
          coepCredentialless = (await stored.text()) !== COEP_MODE_REQUIRE_CORP;
          logServiceWorker("hydrated persisted COEP mode", { coepCredentialless });
        }
      } catch (err) {
        logServiceWorker("COEP mode hydration failed", { error: formatError(err) });
      } finally {
        coepModeHydrated = true;
      }
      return coepCredentialless;
    })();
  }
  return coepModeHydration;
};

// Update both the in-memory flag and the durable copy so the choice survives a worker restart.
const persistCoepMode = async (credentialless: boolean): Promise<void> => {
  await ensureCoepModeHydrated();
  coepCredentialless = credentialless;
  try {
    const cache = await caches.open(RUNTIME_CACHE_NAME);
    await cache.put(
      COEP_MODE_URL,
      new Response(credentialless ? COEP_MODE_CREDENTIALLESS : COEP_MODE_REQUIRE_CORP, {
        headers: { "content-type": "text/plain" },
      }),
    );
    logServiceWorker("persisted COEP mode", { coepCredentialless: credentialless });
  } catch (err) {
    logServiceWorker("COEP mode persist failed", { credentialless, error: formatError(err) });
  }
};

const isSameOriginRequest = (url: URL) => url.origin === self.location.origin;

const getAppBasePath = () => {
  try {
    return new URL("./", self.registration.scope).pathname;
  } catch {
    return "/";
  }
};

const APP_BASE_PATH = getAppBasePath().replace(/\/?$/, "/");
const EMULATORJS_MANIFEST_PATH = `${APP_BASE_PATH}emulatorjs/manifest.json`;
const EMULATORJS_DATA_PATH_PREFIX = `${APP_BASE_PATH}emulatorjs/data/`;

const isEmulatorJsAssetRequest = (request: Request, url: URL) =>
  request.method === "GET" &&
  isSameOriginRequest(url) &&
  (url.pathname === EMULATORJS_MANIFEST_PATH || url.pathname.startsWith(EMULATORJS_DATA_PATH_PREFIX));

const isManifestRequest = (request: Request, url: URL) =>
  request.destination === "manifest" || MANIFEST_PATH_REGEX.test(url.pathname);

const isHtmlRequest = (request: Request, url: URL) =>
  request.destination === "document" ||
  request.mode === "navigate" ||
  (request.headers.get("accept") || "").indexOf("text/html") !== -1 ||
  url.pathname === "/" ||
  INDEX_HTML_PATH_REGEX.test(url.pathname);

const isDevSourceRequest = (request: Request, url: URL) => {
  if (!import.meta.env.DEV) return false;
  if (request.destination === "script" || request.destination === "style") return true;
  return (
    VITE_INTERNAL_PATH_REGEX.test(url.pathname) ||
    SOURCE_OR_NODE_MODULES_PATH_REGEX.test(url.pathname) ||
    SOURCE_MODULE_EXTENSION_REGEX.test(url.pathname)
  );
};

const shouldUseNetworkFirst = (request: Request, url: URL) => {
  if (request.method !== "GET" || !isSameOriginRequest(url)) return false;
  if (isEmulatorJsAssetRequest(request, url)) return false;
  return isHtmlRequest(request, url) || isManifestRequest(request, url) || isDevSourceRequest(request, url);
};

const getCrossOriginIsolationHeaders = (sourceHeaders: HeadersInit = {}, credentialless = coepCredentialless) => {
  const headers = new Headers(sourceHeaders);
  // Preserve an explicit server COEP policy, including require-corp on hosts that do not use credentialless.
  // Replacing that policy can change whether the page becomes isolated.
  if (headers.has(COI_HEADER_COEP)) return headers;
  headers.set(COI_HEADER_COOP, "same-origin");
  headers.set(COI_HEADER_COEP, credentialless ? "credentialless" : "require-corp");
  if (credentialless) headers.delete(COI_HEADER_CORP);
  else headers.set(COI_HEADER_CORP, "cross-origin");
  return headers;
};

const withCrossOriginIsolationHeaders = (
  response: Response | undefined | null,
  credentialless = coepCredentialless,
) => {
  if (!response || response.status === 0) return response ?? undefined;
  return new Response(response.body, {
    headers: getCrossOriginIsolationHeaders(response.headers, credentialless),
    status: response.status,
    statusText: response.statusText,
  });
};

// Broadcast combined precache and warm-up progress on first install; update installs stay silent.
// Vite injects the manifest once, so other consumers MUST use this binding.
const PRECACHE_MANIFEST = self.__WB_MANIFEST as Array<string | OfflinePrecacheEntry>;
const INITIAL_MANIFEST = PRECACHE_MANIFEST.filter((entry) => typeof entry === "string" || entry.install !== false);
const DEFERRED_MANIFEST = PRECACHE_MANIFEST.filter(
  (entry): entry is OfflinePrecacheEntry => typeof entry !== "string" && entry.install === false,
);

const PRECACHE_PROGRESS_THROTTLE_MS = 200;
// Written beside the bundle by the build's manifestTransform, because workbox
// strips per-entry sizes before injecting the manifest. Absent in dev and on a
// host serving an older bundle; the warm-up then falls back to entry counts.
const PRECACHE_SIZES_URL = new URL("precache-sizes.json", self.registration.scope).href;

const precacheEntryPath = (url: string) => new URL(url, self.registration.scope).pathname;

let precacheSizesPromise: Promise<Map<string, number>> | null = null;

/** Entry path to byte size, for the entries the build could measure. */
const loadPrecacheSizes = (): Promise<Map<string, number>> => {
  if (!precacheSizesPromise) {
    precacheSizesPromise = (async () => {
      const sizes = new Map<string, number>();
      try {
        const response = await fetchForWarmup(PRECACHE_SIZES_URL);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const parsed: unknown = await response.json();
        if (parsed && typeof parsed === "object") {
          for (const [url, size] of Object.entries(parsed as Record<string, unknown>)) {
            if (typeof size === "number" && Number.isFinite(size) && size >= 0) sizes.set(precacheEntryPath(url), size);
          }
        }
      } catch (err) {
        logServiceWorker("precache sizes unavailable; install progress falls back to entry counts", {
          error: formatError(err),
        });
      }
      return sizes;
    })();
  }
  return precacheSizesPromise;
};

/**
 * Bytes and entries of the precache, and how much of it is stored right now.
 * Measured from cache contents, so it is correct while the install is still
 * filling the cache and again once it is complete.
 */
const precacheState = async () => {
  const [sizes, cache, deferred] = await Promise.all([
    loadPrecacheSizes(),
    caches.open(PRECACHE_NAME),
    deferredPrecache.state(),
  ]);
  const cachedKeys = new Set((await cache.keys()).map((request) => request.url));
  let cachedBytes = 0;
  let cachedFiles = 0;
  let totalBytes = 0;
  for (const entry of INITIAL_MANIFEST) {
    const path = precacheEntryPath(typeof entry === "string" ? entry : entry.url);
    const size = (typeof entry === "string" ? undefined : entry.sizeBytes) ?? sizes.get(path) ?? 0;
    totalBytes += size;
    const key = new URL(typeof entry === "string" ? entry : entry.url, self.registration.scope);
    if (typeof entry !== "string" && entry.revision) key.searchParams.set("__WB_REVISION__", entry.revision);
    if (cachedKeys.has(key.href)) {
      cachedBytes += size;
      cachedFiles += 1;
    }
  }
  return {
    cachedBytes: cachedBytes + deferred.cachedBytes,
    cachedFiles: cachedFiles + deferred.cachedFiles,
    totalBytes: totalBytes + deferred.totalBytes,
    totalFiles: INITIAL_MANIFEST.length + deferred.totalFiles,
  };
};

let firstInstallInProgress = false;
let precacheInstalledCount = 0;
let lastPrecacheBroadcast = 0;
const precacheIncomingBytes = new Map<string, number>();

// The install-time readout runs the same combined totals the warm-up reports
// later, so one percentage covers both stages instead of each filling its own.
const broadcastPrecacheProgress = async () => {
  const state = await offlineWarmup.getReadyState();
  state.cachedBytes = Math.min(
    state.totalBytes,
    state.cachedBytes + [...precacheIncomingBytes.values()].reduce((sum, value) => sum + value, 0),
  );
  const message = { action: "offline-precache-progress", ...state, phase: "precache", ready: false };
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: "window" });
  for (const client of clients) client.postMessage(message);
};

const precachePlugin: WorkboxPlugin = {
  async requestWillFetch({ event, request }) {
    return prioritizePrecacheInstallRequest(request, event);
  },
  async handlerDidComplete({ event }) {
    if (event.type !== "install" || !firstInstallInProgress) return;
    precacheInstalledCount += 1;
    const done = precacheInstalledCount >= INITIAL_MANIFEST.length;
    const now = Date.now();
    if (!done && now - lastPrecacheBroadcast < PRECACHE_PROGRESS_THROTTLE_MS) return;
    lastPrecacheBroadcast = now;
    await broadcastPrecacheProgress();
  },
  async fetchDidSucceed({ event, request, response }) {
    if (event.type !== "install" || !firstInstallInProgress || !response.body || !response.ok) return response;
    precacheIncomingBytes.set(request.url, 0);
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          precacheIncomingBytes.set(request.url, (precacheIncomingBytes.get(request.url) ?? 0) + chunk.byteLength);
          controller.enqueue(chunk);
          const now = Date.now();
          if (now - lastPrecacheBroadcast < PRECACHE_PROGRESS_THROTTLE_MS) return;
          lastPrecacheBroadcast = now;
          void broadcastPrecacheProgress().catch((error) =>
            logServiceWorker("precache progress failed", { error: formatError(error) }),
          );
        },
      }),
    );
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  },
  async cacheDidUpdate({ request }) {
    const url = new URL(request.url);
    url.searchParams.delete("__WB_REVISION__");
    precacheIncomingBytes.delete(url.href);
  },
  async cacheWillUpdate({ request, response }) {
    // Workbox drops its own defaultPrecacheCacheabilityPlugin as soon as any
    // other plugin defines cacheWillUpdate, so this handler MUST repeat that
    // plugin's guard: without it an error page answered during install is
    // precached under the asset's URL and served offline until the next build.
    if (!response || response.status >= 400) return null;
    // Stamp the download size onto entries the host sent without a
    // Content-Length - the prerendered documents, which are compressed on the
    // fly. Without it the cache inventory can only report what they occupy,
    // never what they cost to fetch.
    return withMeasuredEncodedSize(request.url, response);
  },
  async handlerWillRespond({ response }) {
    const credentialless = await ensureCoepModeHydrated();
    return withCrossOriginIsolationHeaders(response, credentialless) || response;
  },
};

const toCredentiallessNoCorsRequest = (request: Request, credentialless = coepCredentialless) => {
  if (!credentialless || request.mode !== "no-cors") return request;
  return new Request(request, { credentials: "omit" });
};

const fetchAndUpdateCache = async (request: Request): Promise<Response> => {
  const credentialless = await ensureCoepModeHydrated();
  const fetchedResponse = await fetch(toCredentiallessNoCorsRequest(request, credentialless));
  // Cache the network response without its isolation headers: the stored entry then carries the
  // server's true headers, so a later COEP-mode flip re-stamps it correctly at serve time instead
  // of replaying a stale injected mode. The download size is the one header added, and it says
  // nothing about isolation.
  if (fetchedResponse.ok) {
    const cache = await caches.open(RUNTIME_CACHE_NAME);
    await cache.put(request, await withMeasuredEncodedSize(request.url, fetchedResponse.clone()));
  }
  return withCrossOriginIsolationHeaders(fetchedResponse, credentialless) || fetchedResponse;
};

const matchRouteDocument = async (url: URL) => {
  for (const candidate of routeDocumentCandidates(url.pathname)) {
    const response = (await matchPrecache(candidate)) ?? (await deferredPrecache.match(candidate));
    if (response) return response;
  }
  return undefined;
};

const matchCachedResponse = async (request: Request, url: URL) => {
  const credentialless = await ensureCoepModeHydrated();
  const cachedResponse = await caches.match(request);
  if (cachedResponse) return withCrossOriginIsolationHeaders(cachedResponse, credentialless) || cachedResponse;
  if (isManifestRequest(request, url)) {
    const manifest = await matchPrecache("manifest.json");
    return withCrossOriginIsolationHeaders(manifest, credentialless) || manifest;
  }
  if (isHtmlRequest(request, url)) {
    const routeDocument = await matchRouteDocument(url);
    const fallbackDocument = url.pathname === "/" ? await matchPrecache("index.html") : await matchPrecache("404.html");
    const html = routeDocument || fallbackDocument || (await matchPrecache("index.html")) || (await matchPrecache("/"));
    return withCrossOriginIsolationHeaders(html, credentialless) || html;
  }
  return undefined;
};

registerRoute(
  ({ request, url }) => shouldUseNetworkFirst(request, url),
  async ({ request, url }) => {
    try {
      return await fetchAndUpdateCache(request);
    } catch (err) {
      const cachedResponse = await matchCachedResponse(request, url);
      logServiceWorker("network-first request failed", {
        cached: Boolean(cachedResponse),
        error: formatError(err),
        mode: request.mode,
        url: url.href,
      });
      return cachedResponse || Response.error();
    }
  },
);

// `maximumFileSizeToCacheInBytes` below governs only the precache. Runtime
// EmulatorJS assets use this dedicated cache and are intentionally unaffected.
const serveEmulatorJsAsset = async ({ request }: { request: Request }) => {
  const credentialless = await ensureCoepModeHydrated();
  const cache = await caches.open(EMULATORJS_CACHE_NAME);
  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    return withCrossOriginIsolationHeaders(cachedResponse, credentialless) || cachedResponse;
  }

  const fetchedResponse = await fetchForInteractive(toCredentiallessNoCorsRequest(request, credentialless));
  if (fetchedResponse.ok) {
    await cache.put(request, await withMeasuredEncodedSize(request.url, fetchedResponse.clone()));
  }
  return withCrossOriginIsolationHeaders(fetchedResponse, credentialless) || fetchedResponse;
};

registerRoute(({ request, url }) => isEmulatorJsAssetRequest(request, url), serveEmulatorJsAsset);

/* Every pack now enters the same cache through the background warm-up, an
   explicit group install, or an on-demand single-pack fetch during an identify
   run. Identify requests MUST stay local once cached. The checksum router
   (`identify-checksum-routes.bin`), the title index
   (`identify-title-index.json`) and the cheat shards
   (`identify-cheats-<slug>.json`) are members of their platform's group and
   take the same path. */
const isIdentifyPackRequest = (url: URL) =>
  url.origin === self.location.origin &&
  /\/assets\/identify-(?:.*\.(?:pack|bin)|cheats-.*\.json|title-index\.json)$/u.test(url.pathname);

// Use a low-priority fetch hint for background traffic; the browser decides whether to honor it.
const fetchForWarmup = (input: Request | string, init?: RequestInit) =>
  fetch(input, { ...init, priority: "low" } as RequestInit);
const fetchForInteractive = (input: Request | string, init?: RequestInit) => fetch(input, init);

const deferredPrecache = createDeferredPrecache({
  entries: DEFERRED_MANIFEST,
  cacheName: DEFERRED_CACHE_NAME,
  scope: self.registration.scope,
  download: fetchForWarmup,
});

registerRoute(
  ({ request, url }) => request.method === "GET" && deferredPrecache.has(url.href),
  async ({ url }) => {
    const credentialless = await ensureCoepModeHydrated();
    const response = await deferredPrecache.serve(url.href);
    return withCrossOriginIsolationHeaders(response, credentialless) || response;
  },
);

const offlineWarmup = createOfflineWarmup({
  emulatorJsCacheName: EMULATORJS_CACHE_NAME,
  emulatorJsVersion: __EMULATORJS_VERSION__,
  fetchForWarmup,
  // On-demand pack serves and settings-triggered installs block a waiting
  // user, so they fetch without the low-priority hint.
  fetchForInteractive,
  identifyOptionalCacheName: IDENTIFY_OPTIONAL_CACHE_NAME,
  identifyOptionalGroups: __IDENTIFY_OPTIONAL_PACK_GROUPS__,
  log: logServiceWorker,
  precacheState,
  scope: self.registration.scope,
});

let appPumpChain: Promise<unknown> = Promise.resolve();
const pumpOfflineFiles = (onInterim: (progress: unknown) => void) => {
  const process = async () => {
    const baseline = await offlineWarmup.getReadyState();
    let received = 0;
    let lastEmit = 0;
    const downloaded = await deferredPrecache.runNextBatch((delta) => {
      received += delta;
      const now = Date.now();
      if (now - lastEmit < PRECACHE_PROGRESS_THROTTLE_MS) return;
      lastEmit = now;
      onInterim({
        ...baseline,
        cachedBytes: Math.min(baseline.totalBytes, baseline.cachedBytes + received),
        ready: false,
        phase: "precache",
      });
    });
    if (!downloaded) return offlineWarmup.runNextUnit(onInterim);
    return {
      ...(await offlineWarmup.getReadyState()),
      detail: null,
      unit: "app-files",
      unitLoadedBytes: null,
      unitTotalBytes: null,
      phase: "precache",
    };
  };
  const pump = appPumpChain.then(process, process);
  appPumpChain = pump.catch(() => undefined);
  return pump;
};

// Packs are no longer precached, but a build installed before that change may
// still hold them there, so the precache is still consulted first.
const serveIdentifyPack = async ({ request }: { request: Request }) => {
  const precached = await matchPrecache(request.url);
  if (precached) return precached;
  try {
    return await offlineWarmup.serveOptionalIdentifyPack(request);
  } catch (err) {
    logServiceWorker("optional identify pack request failed", { error: formatError(err), url: request.url });
    return Response.error();
  }
};

registerRoute(({ url }) => isIdentifyPackRequest(url), serveIdentifyPack);

logServiceWorker("script initialized", {
  emulatorJsCacheName: EMULATORJS_CACHE_NAME,
  emulatorJsVersion: __EMULATORJS_VERSION__,
  coepCredentialless,
  precacheName: PRECACHE_NAME,
  precacheVersion: PRECACHE_VERSION,
  runtimeCacheName: RUNTIME_CACHE_NAME,
});

// The pack table is baked into this script, while the page reads a no-cache
// identify index. A worker that outlived a data revision therefore verifies
// packs against digests the origin no longer serves, and the only symptom is
// an unavailable database. Print the table's revision next to the index
// revision the page logs, so that skew is one comparison rather than a guess.
const IDENTIFY_PACK_TABLE = __IDENTIFY_OPTIONAL_PACK_GROUPS__.flatMap((group) =>
  group.packs.map((pack) => `${pack.url}:${pack.sha256}`),
);
crypto.subtle
  .digest("SHA-256", new TextEncoder().encode(IDENTIFY_PACK_TABLE.join("\n")))
  .then((digest) => {
    logServiceWorker("identify pack table", {
      packs: IDENTIFY_PACK_TABLE.length,
      revision: [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 16),
    });
  })
  .catch((error: unknown) => logServiceWorker("identify pack table digest failed", { error: formatError(error) }));

keepResourceTimingsRecording(self);
addPlugins([precachePlugin]);
precacheAndRoute(INITIAL_MANIFEST, { ignoreURLParametersMatching: [/^sha256$/] });
cleanupOutdatedCaches();

self.addEventListener("install", (event) => {
  // Existing complete entries MUST move before Workbox removes them on activation.
  event.waitUntil(deferredPrecache.migrate(PRECACHE_NAME));
  // First install (no active worker yet): take control immediately so the page can gain
  // cross-origin isolation on its follow-up reload. Updates to an already-controlled page
  // must WAIT - registerType is "prompt", so activation happens only when the client sends
  // SKIP_WAITING (see the message handler). Seizing control on every update re-inits the
  // running app and reads as an involuntary reload.
  const isFirstInstall = !self.registration.active;
  // Runs before workbox's async install handler touches any entry (listeners
  // fire in add order within the same task), so the plugin sees the flag.
  firstInstallInProgress = isFirstInstall;
  logServiceWorker("install event", {
    isFirstInstall,
    precacheEntries: PRECACHE_MANIFEST.length,
    precacheName: PRECACHE_NAME,
    precacheVersion: PRECACHE_VERSION,
  });
  if (isFirstInstall) void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => findStaleServiceWorkerCaches(cacheNames, CACHE_POLICY))
      .then((cachesToDelete) => {
        logServiceWorker("activate event; deleting stale caches", {
          cachesToDelete,
          count: cachesToDelete.length,
          emulatorJsCacheName: EMULATORJS_CACHE_NAME,
          precacheVersion: PRECACHE_VERSION,
        });
        return Promise.all(cachesToDelete.map((cacheName) => caches.delete(cacheName)));
      })
      .then(() => self.clients.claim())
      .then(() => deferredPrecache.cleanup())
      // Restore the persisted COEP mode so a respawned worker keeps serving require-corp if a prior
      // session already degraded to it, instead of resetting to the credentialless default.
      .then(() => ensureCoepModeHydrated())
      .then(() => {
        firstInstallInProgress = false;
        precacheIncomingBytes.clear();
        logServiceWorker("activate event; clients claimed", {
          coepCredentialless,
          precacheName: PRECACHE_NAME,
          runtimeCacheName: RUNTIME_CACHE_NAME,
        });
      }),
  );
});

self.addEventListener("message", (event) => {
  if (!event.data) return;

  // "SKIP_WAITING" (type) is what virtual:pwa-register posts on updateServiceWorker(true);
  // "skip-waiting" (action) is the app's own convention. Accept both.
  if (event.data.type === "SKIP_WAITING" || event.data.action === "skip-waiting") {
    logServiceWorker("message received; calling skipWaiting");
    void self.skipWaiting();
    return;
  }

  if (event.data.action === COI_COEP_CREDENTIALLESS_ACTION) {
    const credentialless = event.data.value !== false;
    logServiceWorker("message received; updating COEP mode", { coepCredentialless: credentialless });
    // Persist durably (and keep the worker alive until written) so the choice survives a restart.
    event.waitUntil(persistCoepMode(credentialless));
    return;
  }

  const replyTo = (response: unknown) => {
    if (event.ports?.[0]) event.ports[0].postMessage(response);
    else if (event.source && "postMessage" in event.source) event.source.postMessage(response);
  };

  if (event.data.action === "offline-warmup-pump") {
    // Interim byte-level events stream over the same reply port while the
    // unit downloads; the final "offline-warmup-progress" message ends the pump.
    const pump = pumpOfflineFiles((interim) =>
      replyTo({ action: "offline-warmup-interim", ...(interim as Record<string, unknown>) }),
    )
      .then((progress) => ({ action: "offline-warmup-progress", ...progress }))
      .catch((error) => ({ action: "offline-warmup-failed", error: formatError(error) }));
    event.waitUntil(pump.then(replyTo));
    return;
  }

  // A page subscribes to the worker's log after the worker may already have
  // written lines nobody could take, so it asks for the backlog on connect.
  if (event.data.action === "flush-service-worker-log") {
    event.waitUntil(flushServiceWorkerLogs());
    return;
  }

  if (event.data.action === "offline-warmup-bump") {
    const target = event.data.target;
    if (target?.kind === "emulatorjs") offlineWarmup.bumpPriority({ kind: "emulatorjs" });
    else if (target?.kind === "identify-groups" && Array.isArray(target.groupIds)) {
      offlineWarmup.bumpPriority({
        kind: "identify-groups",
        groupIds: target.groupIds.filter((id: unknown): id is string => typeof id === "string"),
      });
    }
    return;
  }

  if (event.data.action === "get-offline-ready-state") {
    const query = offlineWarmup
      .getReadyState()
      .then((state) => ({ action: "offline-ready-state", ...state }))
      .catch((error) => ({ action: "offline-ready-state-failed", error: formatError(error) }));
    event.waitUntil(query.then(replyTo));
    return;
  }

  if (event.data.action === "get-offline-cached-files") {
    // Measuring sizes reads every cached body, which can outlive the client's
    // reply deadline on a full offline set; throttled interim heartbeats reset
    // that deadline the same way warm-up download progress does.
    let lastHeartbeat = 0;
    const query = offlineWarmup
      .getCachedFiles(() => {
        const now = Date.now();
        if (now - lastHeartbeat < 200) return;
        lastHeartbeat = now;
        replyTo({ action: "offline-warmup-interim" });
      })
      .then((files) => ({ action: "offline-cached-files", files }))
      .catch((error) => ({ action: "offline-cached-files-failed", error: formatError(error) }));
    event.waitUntil(query.then(replyTo));
    return;
  }

  if (event.data.action === "get-identify-pack-group-state") {
    const query = offlineWarmup
      .getIdentifyGroupState()
      .then((groups) => ({ action: "identify-pack-group-state", groups }))
      .catch((error) => ({ action: "identify-pack-group-state-failed", error: formatError(error) }));
    event.waitUntil(query.then(replyTo));
    return;
  }

  if (event.data.action === "set-identify-pack-group-wanted") {
    const groupId = typeof event.data.groupId === "string" ? event.data.groupId : "";
    const update = offlineWarmup
      .setIdentifyGroupWanted(groupId, event.data.wanted === true)
      .then((groups) => ({ action: "identify-pack-group-state", groups }))
      .catch((error) => ({ action: "identify-pack-group-state-failed", error: formatError(error) }));
    event.waitUntil(update.then(replyTo));
    return;
  }

  if (event.data.action === "install-identify-pack-group") {
    const groupId = typeof event.data.groupId === "string" ? event.data.groupId : "";
    const install = offlineWarmup
      .installIdentifyGroup(groupId)
      .then((result) => ({ action: "identify-pack-group-installed", ...result }))
      .catch((error) => ({
        action: "identify-pack-group-install-failed",
        error: formatError(error),
        id: groupId,
      }));
    event.waitUntil(install.then(replyTo));
    return;
  }

  if (event.data.action !== "get-service-worker-cache-version") return;

  const response = {
    action: "service-worker-cache-version",
    precacheId: PRECACHE_ID,
    precacheName: PRECACHE_NAME,
    precacheVersion: PRECACHE_VERSION,
  };

  logServiceWorker("message received; reporting cache version", response);
  replyTo(response);
});
