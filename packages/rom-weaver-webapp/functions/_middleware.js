import { acceptsBrotli } from "./accept-encoding.js";
import { documentSidecarPaths } from "./document-routes.js";

const isMissingSidecar = (response) =>
  !response.ok || (response.headers.get("Content-Type") ?? "").includes("text/html");

export const onRequest = async ({ request, env, next }) => {
  if (request.method !== "GET" && request.method !== "HEAD") return next();
  if (!acceptsBrotli(request.headers.get("Accept-Encoding"))) return next();

  const sidecarPaths = documentSidecarPaths(new URL(request.url).pathname);
  for (const sidecarPath of sidecarPaths) {
    const sidecar = await env.ASSETS.fetch(new Request(new URL(sidecarPath, request.url), request));
    if (sidecar.status === 304) {
      const headers = new Headers(sidecar.headers);
      headers.delete("Content-Length");
      headers.set("Content-Type", "text/html; charset=utf-8");
      headers.set("Content-Encoding", "br");
      headers.set("Vary", "Accept-Encoding");
      headers.set("Cache-Control", "public, max-age=0, must-revalidate");
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      headers.set("Cross-Origin-Opener-Policy", "same-origin");
      headers.set("Cross-Origin-Resource-Policy", "same-origin");
      return new Response(null, { status: 304, headers });
    }
    if (isMissingSidecar(sidecar)) continue;

    const headers = new Headers(sidecar.headers);
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Content-Encoding", "br");
    headers.set("Vary", "Accept-Encoding");
    // Browsers must revalidate documents. The zone Cache Rule overrides the edge
    // TTL to five minutes, while the browser still checks for a new release.
    headers.set("Cache-Control", "public, max-age=0, must-revalidate");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    return new Response(sidecar.body, { encodeBody: "manual", headers });
  }
  return next();
};
