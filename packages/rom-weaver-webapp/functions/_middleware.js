import { acceptsBrotli } from "./accept-encoding.js";
import { documentSidecarPaths } from "./document-routes.js";

const isMissingSidecar = (response) =>
  !response.ok ||
  ((response.headers.get("Content-Type") ?? "").includes("text/html") &&
    response.headers.get("Content-Encoding") !== "br");

const weakEntityTag = (value) => value.trim().replace(/^W\//, "");

const matchesIfNoneMatch = (value, etag) => {
  if (value.split(",").some((candidate) => candidate.trim() === "*")) return true;
  if (etag === null) return false;

  const normalizedEtag = weakEntityTag(etag);
  return value.split(",").some((candidate) => {
    const normalizedCandidate = candidate.trim();
    return normalizedCandidate === "*" || weakEntityTag(normalizedCandidate) === normalizedEtag;
  });
};

const isNotModified = (request, response) => {
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch !== null) {
    return matchesIfNoneMatch(ifNoneMatch, response.headers.get("ETag"));
  }

  const ifModifiedSince = request.headers.get("If-Modified-Since");
  const lastModified = response.headers.get("Last-Modified");
  if (ifModifiedSince === null || lastModified === null) return false;

  const modifiedAt = Date.parse(lastModified);
  const requestedAt = Date.parse(ifModifiedSince);
  return Number.isFinite(modifiedAt) && Number.isFinite(requestedAt) && modifiedAt <= requestedAt;
};

const documentHeaders = (sidecar) => {
  const headers = new Headers(sidecar.headers);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Content-Encoding", "br");
  headers.set("Vary", "Accept-Encoding");
  // Browsers must revalidate documents. The zone Cache Rule overrides the edge
  // TTL to five minutes, while the browser still checks for a new release.
  // no-transform keeps the q11 bytes and Content-Length intact at Cloudflare.
  headers.set("Cache-Control", "public, max-age=0, must-revalidate, no-transform");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return headers;
};

export const onRequest = async ({ request, next, fetch: fetchImpl = globalThis.fetch }) => {
  if (request.method !== "GET" && request.method !== "HEAD") return next();
  if (!acceptsBrotli(request.headers.get("Accept-Encoding"))) return next();

  const sidecarPaths = documentSidecarPaths(new URL(request.url).pathname);
  for (const sidecarPath of sidecarPaths) {
    // Fetch the public static sidecar directly. Pages' asset binding resolves
    // direct HTML filenames through the pretty-path fallback instead of the file.
    // Request Brotli explicitly so Cloudflare passes the encoded bytes through.
    const sidecar = await fetchImpl(new URL(sidecarPath, request.url), {
      headers: { "Accept-Encoding": "br" },
    });
    if (sidecar.status === 304) {
      const headers = documentHeaders(sidecar);
      headers.delete("Content-Length");
      return new Response(null, { status: 304, headers });
    }
    if (isMissingSidecar(sidecar)) continue;

    const headers = documentHeaders(sidecar);
    if (isNotModified(request, sidecar)) {
      headers.delete("Content-Length");
      return new Response(null, { status: 304, headers });
    }
    // The sidecar carries Content-Encoding: br in _headers. Keep its stream unread
    // so Cloudflare passes the already-compressed bytes through unchanged.
    return new Response(sidecar.body, { encodeBody: "manual", headers });
  }
  return next();
};
