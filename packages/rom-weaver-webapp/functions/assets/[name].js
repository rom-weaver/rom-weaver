// Cloudflare Pages Function that serves sidecar-backed assets from their
// precompressed quality-11 brotli siblings. Pages has no precompressed-sibling
// convention and recompresses on the fly at a lower quality (~640 KB larger on
// the wasm, ~50 KB on the main JS bundle, per cold load), so this hands
// br-capable clients the exact bytes the build produced.
//
// The build writes a `_routes.json` scoping invocation to the URLs it staged
// sidecars for (see writeBrotliSidecars in vite.config.mjs); every other
// request stays on Pages' unmetered static path and never invokes this.

import { acceptsBrotli } from "../accept-encoding.js";
import { sidecarContentType } from "./content-types.js";

// Missing assets are errors now that the build publishes a top-level 404.html;
// keep the HTML check for hosts that still apply an SPA fallback.
const isSpaFallback = (response) => !response.ok || (response.headers.get("Content-Type") ?? "").includes("text/html");

export const onRequestGet = async ({ request, env, next }) => {
  if (!acceptsBrotli(request.headers.get("Accept-Encoding"))) return next();
  const url = new URL(request.url);
  // The type comes from the build-verified table rather than a HEAD probe of the
  // static asset. The probe was a second subrequest that had to resolve before the
  // sidecar fetch could even start, which put a serialized round trip in front of
  // the render-critical CSS and entry module. A missing entry is not an error: the
  // request falls through to Pages' static path, which serves the asset correctly
  // and only forfeits the quality-11 sidecar.
  const contentType = sidecarContentType(url.pathname);
  if (!contentType) return next();
  // A missing asset needs no separate check - its sidecar is missing too, and the
  // fallback test below catches that.
  const sidecar = await env.ASSETS.fetch(new URL(`${url.pathname}.br`, url));
  if (isSpaFallback(sidecar)) return next();
  const headers = new Headers(sidecar.headers);
  headers.set("Content-Type", contentType);
  headers.set("Content-Encoding", "br");
  headers.set("Vary", "Accept-Encoding");
  // Function responses bypass the deployed _headers file, so the /assets/*
  // cache rule and the cross-origin-isolation headers are restated. COEP is
  // load-bearing: dedicated-worker scripts on a cross-origin-isolated page
  // must themselves be served with require-corp or the worker fails to start.
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  // encodeBody "manual" marks the body as already encoded: the runtime passes
  // the brotli bytes through untouched instead of re-encoding them.
  return new Response(sidecar.body, { encodeBody: "manual", headers });
};
