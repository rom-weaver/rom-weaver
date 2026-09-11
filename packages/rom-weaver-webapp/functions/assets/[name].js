// Cloudflare Pages Function that serves sidecar-backed assets from their
// precompressed quality-11 brotli siblings. Pages has no precompressed-sibling
// convention and recompresses on the fly at a lower quality (~640 KB larger on
// the wasm, ~50 KB on the main JS bundle, per cold load), so this hands
// br-capable clients the exact bytes the build produced.
//
// The build writes a `_routes.json` scoping invocation to the URLs it staged
// sidecars for (see writeBrotliSidecars in vite.config.mjs); every other
// request stays on Pages' unmetered static path and never invokes this.

import { assetCacheControl, isMutableAsset, sidecarContentType } from "./content-types.js";

const acceptsBrotli = (value) =>
  value.split(",").some((item) => {
    const [encoding, ...parameters] = item.trim().toLowerCase().split(";");
    if (encoding !== "br") return false;
    const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
    return quality === undefined || Number.parseFloat(quality.trim().slice(2)) > 0;
  });

// Missing assets are errors now that the build publishes a top-level 404.html;
// keep the HTML check for hosts that still apply an SPA fallback.
const isSpaFallback = (response) => !response.ok || (response.headers.get("Content-Type") ?? "").includes("text/html");

// Function responses bypass the deployed _headers file, so the /assets/* cache
// rule and the cross-origin-isolation headers are restated on every response
// this function builds. COEP is load-bearing: dedicated-worker scripts on a
// cross-origin-isolated page must themselves be served with require-corp or the
// worker fails to start.
const withAssetHeaders = (source, { cacheControl, contentEncoding, contentType }) => {
  const headers = new Headers(source.headers);
  headers.set("Content-Type", contentType);
  if (contentEncoding) {
    headers.set("Content-Encoding", contentEncoding);
    headers.set("Vary", "Accept-Encoding");
  }
  headers.set("Cache-Control", cacheControl);
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return headers;
};

// The mutable manifests are fetched with `cache: "no-cache"` (see getIndex in
// src/platform/browser/identify-packs.ts), so every page load revalidates one.
// Cloudflare synthesizes no 304 for a Function response: without the validators
// forwarded and the 304 passed back, each of those revalidations would answer with
// the whole body again.
const conditionalRequest = (url, request) => {
  const headers = new Headers();
  for (const name of ["If-None-Match", "If-Modified-Since"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Request(url, { headers });
};

const notModified = (headers) => new Response(null, { headers, status: 304 });

export const onRequestGet = async ({ request, env, next }) => {
  const url = new URL(request.url);
  // The type comes from the build-verified table rather than a HEAD probe of the
  // static asset. The probe was a second subrequest that had to resolve before the
  // sidecar fetch could even start, which put a serialized round trip in front of
  // the render-critical CSS and entry module. A missing entry is not an error: the
  // request falls through to Pages' static path, which serves the asset correctly
  // and only forfeits the quality-11 sidecar.
  const contentType = sidecarContentType(url.pathname);
  if (!contentType) return next();
  const mutable = isMutableAsset(url.pathname);
  const cacheControl = assetCacheControl(url.pathname);
  if (acceptsBrotli(request.headers.get("Accept-Encoding") ?? "")) {
    // A missing asset needs no separate check - its sidecar is missing too, and the
    // fallback test below catches that. An immutable asset is never revalidated, so
    // only a mutable one pays for forwarding its validators.
    const sidecarUrl = new URL(`${url.pathname}.br`, url);
    const sidecar = await env.ASSETS.fetch(mutable ? conditionalRequest(sidecarUrl, request) : sidecarUrl);
    if (sidecar.status === 304) {
      return notModified(withAssetHeaders(sidecar, { cacheControl, contentType }));
    }
    if (!isSpaFallback(sidecar)) {
      // encodeBody "manual" marks the body as already encoded: the runtime passes
      // the brotli bytes through untouched instead of re-encoding them.
      return new Response(sidecar.body, {
        encodeBody: "manual",
        headers: withAssetHeaders(sidecar, { cacheControl, contentEncoding: "br", contentType }),
      });
    }
  }
  // A mutable manifest MUST NOT fall through: Pages would serve it from the static
  // path, where `_headers` does not apply to a URL this function claims, and the
  // response would carry Pages' default browser TTL instead of no-cache. That holds
  // for a 304 as much as for a body, so the revalidation is answered here too.
  if (!mutable) return next();
  const asset = await env.ASSETS.fetch(request);
  if (asset.status === 304) return notModified(withAssetHeaders(asset, { cacheControl, contentType }));
  if (isSpaFallback(asset)) return next();
  // Pages may answer with an encoding of its own; "manual" keeps the runtime from
  // encoding an already-encoded body a second time. The status is carried over
  // rather than defaulted: a Range request answers 206, and relabelling that 200
  // would hand the client a partial manifest marked complete.
  const contentEncoding = asset.headers.get("Content-Encoding") ?? undefined;
  return new Response(asset.body, {
    ...(contentEncoding ? { encodeBody: "manual" } : {}),
    headers: withAssetHeaders(asset, { cacheControl, contentEncoding, contentType }),
    status: asset.status,
    statusText: asset.statusText,
  });
};
