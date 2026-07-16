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
  } catch (_err) {
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
  runtime: `${PRECACHE_ID}-runtime`,
  suffix: PRECACHE_VERSION,
});

const PRECACHE_NAME = cacheNames.precache;
const RUNTIME_CACHE_NAME = cacheNames.runtime;
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
  return isHtmlRequest(request, url) || isManifestRequest(request, url) || isDevSourceRequest(request, url);
};

const getCrossOriginIsolationHeaders = (sourceHeaders: HeadersInit = {}, credentialless = coepCredentialless) => {
  const headers = new Headers(sourceHeaders);
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

const crossOriginIsolationPrecachePlugin: WorkboxPlugin = {
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
  const response = withCrossOriginIsolationHeaders(fetchedResponse, credentialless) || fetchedResponse;
  if (response.ok) {
    const cache = await caches.open(RUNTIME_CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
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
    const html = (await matchPrecache("index.html")) || (await matchPrecache("/"));
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

logServiceWorker("script initialized", {
  coepCredentialless,
  precacheName: PRECACHE_NAME,
  precacheVersion: PRECACHE_VERSION,
  runtimeCacheName: RUNTIME_CACHE_NAME,
});

addPlugins([crossOriginIsolationPrecachePlugin]);
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener("install", () => {
  // First install (no active worker yet): take control immediately so the page can gain
  // cross-origin isolation on its follow-up reload. Updates to an already-controlled page
  // must WAIT - registerType is "prompt", so activation happens only when the client sends
  // SKIP_WAITING (see the message handler). Seizing control on every update re-inits the
  // running app and reads as an involuntary reload.
  const isFirstInstall = !self.registration.active;
  logServiceWorker("install event", {
    isFirstInstall,
    precacheName: PRECACHE_NAME,
    precacheVersion: PRECACHE_VERSION,
  });
  if (isFirstInstall) self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        cacheNames.filter(
          (cacheName) =>
            cacheName.startsWith(`precache-${PRECACHE_ID}-`) && !cacheName.endsWith(`-${PRECACHE_VERSION}`),
        ),
      )
      .then((cachesToDelete) => {
        logServiceWorker("activate event; deleting old precaches", {
          cachesToDelete,
          count: cachesToDelete.length,
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
    self.skipWaiting();
    return;
  }

  if (event.data.action === COI_COEP_CREDENTIALLESS_ACTION) {
    const credentialless = event.data.value !== false;
    logServiceWorker("message received; updating COEP mode", { coepCredentialless: credentialless });
    // Persist durably (and keep the worker alive until written) so the choice survives a restart.
    event.waitUntil(persistCoepMode(credentialless));
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
  if (event.ports?.[0]) event.ports[0].postMessage(response);
  else if (event.source && "postMessage" in event.source) event.source.postMessage(response);
});
