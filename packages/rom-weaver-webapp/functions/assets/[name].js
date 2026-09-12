// Serve build-produced quality-11 Brotli sidecars to clients that accept br.
// writeBrotliSidecars in vite.config.mjs scopes this function through _routes.json.

import { sidecarContentType } from "./content-types.js";

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

export const onRequestGet = async ({ request, env, next }) => {
  if (!acceptsBrotli(request.headers.get("Accept-Encoding") ?? "")) return next();
  const url = new URL(request.url);
  // The build-checked type table avoids a separate request for the raw asset.
  // Unknown types fall through to Pages' static response.
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
