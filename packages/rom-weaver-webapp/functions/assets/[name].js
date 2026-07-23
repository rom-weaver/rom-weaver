// Cloudflare Pages Function that serves sidecar-backed assets from their
// precompressed quality-11 brotli siblings. Pages has no precompressed-sibling
// convention and recompresses on the fly at a lower quality (~640 KB larger on
// the wasm, ~50 KB on the main JS bundle, per cold load), so this hands
// br-capable clients the exact bytes the build produced.
//
// The build writes a `_routes.json` scoping invocation to the URLs it staged
// sidecars for (see writePagesBrotliSidecars in vite.config.mjs); every other
// request stays on Pages' unmetered static path and never invokes this.

const ACCEPTS_BR = /(^|[\s,])br($|[\s,;])/;

// A request Pages cannot resolve surfaces as the SPA fallback (200 text/html),
// not a 404, so content-type is the reliable missing-asset signal.
const isSpaFallback = (response) => !response.ok || (response.headers.get("Content-Type") ?? "").includes("text/html");

export const onRequestGet = async ({ request, env, next }) => {
  if (!ACCEPTS_BR.test(request.headers.get("Accept-Encoding") ?? "")) return next();
  const url = new URL(request.url);
  // The content type comes from the static asset itself (headers only, no
  // body) rather than a hand-kept extension map, so any sidecar-backed file
  // type the build stages is served with exactly the type Pages would use.
  const asset = await env.ASSETS.fetch(new URL(url.pathname, url), { method: "HEAD" });
  if (isSpaFallback(asset)) return next();
  const contentType = asset.headers.get("Content-Type");
  if (!contentType) return next();
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
