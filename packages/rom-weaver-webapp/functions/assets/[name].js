// Cloudflare Pages Function that serves the wasm module from its precompressed
// quality-11 brotli sidecar. Pages has no precompressed-sibling convention and
// recompresses `.wasm` on the fly at a lower quality (~640 KB larger per cold
// load), so this hands br-capable clients the exact bytes the build produced.
//
// The build writes a `_routes.json` scoping invocation to the hashed wasm URL
// alone (see writePagesWasmBrotliSidecar in vite.config.mjs); every other
// request stays on Pages' unmetered static path and never invokes this.

const ACCEPTS_BR = /(^|[\s,])br($|[\s,;])/;

export const onRequestGet = async ({ request, env, next }) => {
  const url = new URL(request.url);
  if (!url.pathname.endsWith(".wasm")) return next();
  if (!ACCEPTS_BR.test(request.headers.get("Accept-Encoding") ?? "")) return next();
  const sidecar = await env.ASSETS.fetch(new URL(`${url.pathname}.br`, url));
  // A missing sidecar surfaces as the SPA fallback (200 text/html), not a 404.
  const sidecarType = sidecar.headers.get("Content-Type") ?? "";
  if (!sidecar.ok || sidecarType.includes("text/html")) return next();
  const headers = new Headers(sidecar.headers);
  headers.set("Content-Type", "application/wasm");
  headers.set("Content-Encoding", "br");
  headers.set("Vary", "Accept-Encoding");
  // Function responses bypass the deployed _headers file, so the /assets/*
  // cache rule and the cross-origin-isolation resource policy are restated.
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  // encodeBody "manual" marks the body as already encoded: the runtime passes
  // the brotli bytes through untouched instead of re-encoding them.
  return new Response(sidecar.body, { encodeBody: "manual", headers });
};
