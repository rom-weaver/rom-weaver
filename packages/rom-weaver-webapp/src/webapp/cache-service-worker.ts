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
import { routeDocumentCandidates } from "./pwa/route-documents.ts";
import { createServiceWorkerCachePolicy, findStaleServiceWorkerCaches } from "./pwa/service-worker-cache-policy.ts";

declare const __EMULATORJS_VERSION__: string;
declare const __IDENTIFY_OPTIONAL_PACK_GROUPS__: Array<{
  id: string;
  label: string;
  packs: Array<{ sha256: string; sizeBytes?: number; url: string }>;
  required?: boolean;
}>;

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { revision?: string | null; url: string }>;
};

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
const CACHE_POLICY = createServiceWorkerCachePolicy({
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

const logServiceWorker = (message: string, details?: Record<string, unknown>) => {
  if (details) console.info(SW_LOG_PREFIX, message, details);
  else console.info(SW_LOG_PREFIX, message);
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
  // A response that already names a COEP came from a host that serves the isolation trio itself
  // (the deployed _headers file, or a self-host configured per docs/hosting/self-hosting.md). Pass it
  // through untouched: rewriting a served require-corp to credentialless would un-isolate the page
  // in browsers that cannot parse credentialless and send them into the reload dance for nothing.
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

// First-install precache progress, broadcast to the (still uncontrolled)
// pages so the "installing" chip shows a percent instead of a bare spinner
// through the largest download of the offline set. Only file counts are known
// at this stage - the workbox manifest carries no sizes. Broadcasts are
// throttled; the final count always goes out. Update installs stay silent:
// the page there is already offline-ready and shows no install progress.
// vite-plugin-pwa injects the manifest at the single `self.__WB_MANIFEST`
// occurrence, so every other use MUST go through this binding.
const PRECACHE_MANIFEST = self.__WB_MANIFEST;

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
  const [sizes, cache] = await Promise.all([loadPrecacheSizes(), caches.open(PRECACHE_NAME)]);
  const cachedPaths = new Set((await cache.keys()).map((request) => new URL(request.url).pathname));
  let cachedBytes = 0;
  let cachedFiles = 0;
  let totalBytes = 0;
  for (const entry of PRECACHE_MANIFEST) {
    const path = precacheEntryPath(typeof entry === "string" ? entry : entry.url);
    const size = sizes.get(path) ?? 0;
    totalBytes += size;
    if (cachedPaths.has(path)) {
      cachedBytes += size;
      cachedFiles += 1;
    }
  }
  return { cachedBytes, cachedFiles, totalBytes, totalFiles: PRECACHE_MANIFEST.length };
};

let firstInstallInProgress = false;
let precacheInstalledCount = 0;
let lastPrecacheBroadcast = 0;

// The install-time readout runs the same combined totals the warm-up reports
// later, so one percentage covers both stages instead of each filling its own.
const broadcastPrecacheProgress = async () => {
  const state = await offlineWarmup.getReadyState();
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
    const done = precacheInstalledCount >= PRECACHE_MANIFEST.length;
    const now = Date.now();
    if (!done && now - lastPrecacheBroadcast < PRECACHE_PROGRESS_THROTTLE_MS) return;
    lastPrecacheBroadcast = now;
    await broadcastPrecacheProgress();
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
  // Cache the raw network response, not the stamped one: the stored entry then carries the
  // server's true headers, so a later COEP-mode flip re-stamps it correctly at serve time instead
  // of replaying a stale injected mode.
  if (fetchedResponse.ok) {
    const cache = await caches.open(RUNTIME_CACHE_NAME);
    await cache.put(request, fetchedResponse.clone());
  }
  return withCrossOriginIsolationHeaders(fetchedResponse, credentialless) || fetchedResponse;
};

const matchRouteDocument = async (url: URL) => {
  for (const candidate of routeDocumentCandidates(url.pathname)) {
    const response = await matchPrecache(candidate);
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

  const fetchedResponse = await fetch(toCredentiallessNoCorsRequest(request, credentialless));
  if (fetchedResponse.ok) await cache.put(request, fetchedResponse.clone());
  return withCrossOriginIsolationHeaders(fetchedResponse, credentialless) || fetchedResponse;
};

registerRoute(({ request, url }) => isEmulatorJsAssetRequest(request, url), serveEmulatorJsAsset);

/* Every pack now enters the same cache through the background warm-up, an
   explicit group install, or an on-demand single-pack fetch during an identify
   run. Identify requests MUST stay local once cached. */
const isIdentifyPackRequest = (url: URL) =>
  url.origin === self.location.origin && /\/assets\/identify-.*\.pack$/u.test(url.pathname);

// `priority: "low"` is a fetch priority hint (Chromium); other engines ignore
// the field. It keeps warm-up traffic behind interactive requests.
const fetchForWarmup = (input: Request | string, init?: RequestInit) =>
  fetch(input, { ...init, priority: "low" } as RequestInit);

const offlineWarmup = createOfflineWarmup({
  emulatorJsCacheName: EMULATORJS_CACHE_NAME,
  emulatorJsVersion: __EMULATORJS_VERSION__,
  fetchForWarmup,
  // On-demand pack serves and settings-triggered installs block a waiting
  // user, so they fetch without the low-priority hint.
  fetchForInteractive: (input, init) => fetch(input, init),
  identifyOptionalCacheName: IDENTIFY_OPTIONAL_CACHE_NAME,
  identifyOptionalGroups: __IDENTIFY_OPTIONAL_PACK_GROUPS__,
  log: logServiceWorker,
  precacheState,
  scope: self.registration.scope,
});

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

addPlugins([precachePlugin]);
precacheAndRoute(PRECACHE_MANIFEST, { ignoreURLParametersMatching: [/^sha256$/] });
cleanupOutdatedCaches();

self.addEventListener("install", () => {
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
      // Restore the persisted COEP mode so a respawned worker keeps serving require-corp if a prior
      // session already degraded to it, instead of resetting to the credentialless default.
      .then(() => ensureCoepModeHydrated())
      .then(() => {
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
    const pump = offlineWarmup
      .runNextUnit((interim) => replyTo({ action: "offline-warmup-interim", ...interim }))
      .then((progress) => ({ action: "offline-warmup-progress", ...progress }))
      .catch((error) => ({ action: "offline-warmup-failed", error: formatError(error) }));
    event.waitUntil(pump.then(replyTo));
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
