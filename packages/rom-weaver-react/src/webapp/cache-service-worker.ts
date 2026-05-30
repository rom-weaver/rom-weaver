/// <reference lib="webworker" />

const MANIFEST_PATH_REGEX = /\/manifest\.json$/i;
const INDEX_HTML_PATH_REGEX = /\/index\.html$/i;
const VITE_INTERNAL_PATH_REGEX = /\/(@fs|@id|@vite)\//;
const SOURCE_OR_NODE_MODULES_PATH_REGEX = /\/(src|node_modules)\//;
const SOURCE_MODULE_EXTENSION_REGEX = /\.(?:[cm]?js|jsx|ts|tsx|css)$/i;

import { cacheNames, setCacheNameDetails } from "workbox-core";
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from "workbox-precaching";
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
let coepCredentialless = true;

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

const getCrossOriginIsolationHeaders = (sourceHeaders: HeadersInit = {}) => {
  const headers = new Headers(sourceHeaders);
  headers.set(COI_HEADER_COOP, "same-origin");
  headers.set(COI_HEADER_COEP, coepCredentialless ? "credentialless" : "require-corp");
  if (coepCredentialless) headers.delete(COI_HEADER_CORP);
  else headers.set(COI_HEADER_CORP, "cross-origin");
  return headers;
};

const withCrossOriginIsolationHeaders = (response: Response | undefined | null) => {
  if (!response || response.status === 0) return response ?? undefined;
  return new Response(response.body, {
    headers: getCrossOriginIsolationHeaders(response.headers),
    status: response.status,
    statusText: response.statusText,
  });
};

const toCredentiallessNoCorsRequest = (request: Request) => {
  if (!coepCredentialless || request.mode !== "no-cors") return request;
  return new Request(request, { credentials: "omit" });
};

const fetchAndUpdateCache = async (request: Request): Promise<Response> => {
  const fetchedResponse = await fetch(toCredentiallessNoCorsRequest(request));
  const response = withCrossOriginIsolationHeaders(fetchedResponse) || fetchedResponse;
  if (response.ok) {
    const cache = await caches.open(RUNTIME_CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
};

const matchCachedResponse = async (request: Request, url: URL) => {
  const cachedResponse = await caches.match(request);
  if (cachedResponse) return withCrossOriginIsolationHeaders(cachedResponse) || cachedResponse;
  if (isManifestRequest(request, url)) {
    const manifest = await matchPrecache("manifest.json");
    return withCrossOriginIsolationHeaders(manifest) || manifest;
  }
  if (isHtmlRequest(request, url)) {
    const html = (await matchPrecache("index.html")) || (await matchPrecache("/"));
    return withCrossOriginIsolationHeaders(html) || html;
  }
  return undefined;
};

registerRoute(
  ({ request, url }) => shouldUseNetworkFirst(request, url),
  async ({ request, url }) => {
    try {
      return await fetchAndUpdateCache(request);
    } catch (_err) {
      return (await matchCachedResponse(request, url)) || Response.error();
    }
  },
);

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

self.addEventListener("install", () => {
  self.skipWaiting();
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
      .then((cachesToDelete) => Promise.all(cachesToDelete.map((cacheName) => caches.delete(cacheName))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (!event.data) return;

  if (event.data.action === "skip-waiting") {
    self.skipWaiting();
    return;
  }

  if (event.data.action === COI_COEP_CREDENTIALLESS_ACTION) {
    coepCredentialless = event.data.value !== false;
    return;
  }

  if (event.data.action !== "get-service-worker-cache-version") return;

  const response = {
    action: "service-worker-cache-version",
    precacheId: PRECACHE_ID,
    precacheName: PRECACHE_NAME,
    precacheVersion: PRECACHE_VERSION,
  };

  if (event.ports?.[0]) event.ports[0].postMessage(response);
  else if (event.source && "postMessage" in event.source) event.source.postMessage(response);
});
