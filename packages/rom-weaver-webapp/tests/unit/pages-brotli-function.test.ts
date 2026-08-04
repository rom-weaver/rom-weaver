import { describe, expect, it } from "vitest";
import { onRequest } from "../../functions/_middleware.js";
import { onRequestGet } from "../../functions/assets/[name].js";

const WASM_URL = "https://rom-weaver.com/assets/rom-weaver-app-BWS09Fxt.wasm";
const NEXT_SENTINEL = new Response("static passthrough");

type FetchLogEntry = { method: string; url: string };
type SidecarResponse = Response | ((url: string) => Response);

const spaFallback = () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html; charset=utf-8" } });

const makeContext = ({
  url = WASM_URL,
  acceptEncoding = "gzip, br, zstd",
  requestHeaders = {},
  sidecarResponse,
}: {
  url?: string;
  acceptEncoding?: string | null;
  requestHeaders?: Record<string, string>;
  sidecarResponse?: SidecarResponse;
}) => {
  const headers = new Headers(requestHeaders);
  if (acceptEncoding !== null) headers.set("Accept-Encoding", acceptEncoding);
  const fetchLog: FetchLogEntry[] = [];
  const forwardedRequests: string[] = [];
  return {
    context: {
      env: {
        ASSETS: {
          fetch: (target: URL | RequestInfo, init?: RequestInit) => {
            const targetUrl = target instanceof Request ? target.url : String(target);
            fetchLog.push({ method: init?.method ?? "GET", url: targetUrl });
            if (target instanceof Request) forwardedRequests.push(targetUrl);
            const response = typeof sidecarResponse === "function" ? sidecarResponse(targetUrl) : sidecarResponse;
            return Promise.resolve(response ?? spaFallback());
          },
        },
      },
      next: () => Promise.resolve(NEXT_SENTINEL),
      request: new Request(url, { headers }),
    },
    fetchLog,
    forwardedRequests,
  };
};

const brSidecar = (body = "brotli-bytes") =>
  new Response(body, { headers: { "Content-Type": "application/octet-stream" } });

describe("pages brotli sidecar function", () => {
  it("serves sidecar bytes with Content-Encoding br and the extension's content type", async () => {
    const { context, fetchLog } = makeContext({ sidecarResponse: brSidecar() });
    const response = await onRequestGet(context);
    // One subrequest, not two: the type comes from the build-verified table rather
    // than a HEAD probe that the sidecar fetch would have to wait behind.
    expect(fetchLog).toEqual([{ method: "GET", url: `${WASM_URL}.br` }]);
    expect(response.headers.get("Content-Type")).toBe("application/wasm");
    expect(response.headers.get("Content-Encoding")).toBe("br");
    expect(response.headers.get("Vary")).toBe("Accept-Encoding");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(await response.text()).toBe("brotli-bytes");
  });

  it.each([
    ["https://rom-weaver.com/assets/index-DXHhOtA-.js", "text/javascript; charset=utf-8"],
    ["https://rom-weaver.com/assets/index-DqvtWSeD.css", "text/css; charset=utf-8"],
  ])("serves %s as %s", async (url, contentType) => {
    const { context } = makeContext({ url, sidecarResponse: brSidecar() });
    const response = await onRequestGet(context);
    expect(response.headers.get("Content-Type")).toBe(contentType);
    expect(response.headers.get("Content-Encoding")).toBe("br");
    // COEP is load-bearing for worker scripts on a cross-origin-isolated page.
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
  });

  it("falls through for an extension the build stages no sidecar for", async () => {
    const { context, fetchLog } = makeContext({
      sidecarResponse: brSidecar(),
      url: "https://rom-weaver.com/assets/archivo-var-latin-DXrUVZxZ.woff2",
    });
    expect(await onRequestGet(context)).toBe(NEXT_SENTINEL);
    expect(fetchLog).toEqual([]);
  });

  it("falls through to static serving when the client does not accept br", async () => {
    const { context, fetchLog } = makeContext({ acceptEncoding: "gzip, deflate" });
    expect(await onRequestGet(context)).toBe(NEXT_SENTINEL);
    expect(fetchLog).toEqual([]);
  });

  it("falls through when Accept-Encoding is absent", async () => {
    const { context } = makeContext({ acceptEncoding: null });
    expect(await onRequestGet(context)).toBe(NEXT_SENTINEL);
  });

  it("does not treat a br token inside another encoding name as br support", async () => {
    const { context } = makeContext({ acceptEncoding: "libre, zbr" });
    expect(await onRequestGet(context)).toBe(NEXT_SENTINEL);
  });

  it("honors an explicit br quality of zero", async () => {
    const { context, fetchLog } = makeContext({ acceptEncoding: "br;q=0, gzip" });
    expect(await onRequestGet(context)).toBe(NEXT_SENTINEL);
    expect(fetchLog).toEqual([]);
  });

  it("falls through when the sidecar is missing (SPA fallback response), which also covers a missing asset", async () => {
    const { context } = makeContext({ sidecarResponse: spaFallback() });
    expect(await onRequestGet(context)).toBe(NEXT_SENTINEL);
  });

  it("falls through when the sidecar fetch is not ok", async () => {
    const { context } = makeContext({ sidecarResponse: new Response("nope", { status: 404 }) });
    expect(await onRequestGet(context)).toBe(NEXT_SENTINEL);
  });

  it("serves the minified document sidecar for a clean route", async () => {
    const { context, fetchLog } = makeContext({
      url: "https://rom-weaver.com/docs/faq/",
      sidecarResponse: brSidecar(),
    });
    const response = await onRequest(context);
    expect(fetchLog).toEqual([{ method: "GET", url: "https://rom-weaver.com/docs/faq/index.html.br" }]);
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Content-Encoding")).toBe("br");
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate, no-transform");
    expect(response.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(await response.text()).toBe("brotli-bytes");
  });

  it("does not probe an HTML sidecar for an asset request", async () => {
    const { context, fetchLog } = makeContext({ sidecarResponse: brSidecar() });
    expect(await onRequest(context)).toBe(NEXT_SENTINEL);
    expect(fetchLog).toEqual([]);
  });

  it("falls back from a clean route to its extension sidecar", async () => {
    const { context, fetchLog } = makeContext({
      url: "https://rom-weaver.com/trim",
      sidecarResponse: (url) =>
        url.endsWith("/trim/index.html.br") ? new Response("missing", { status: 404 }) : brSidecar(),
    });
    const response = await onRequest(context);
    expect(fetchLog).toEqual([
      { method: "GET", url: "https://rom-weaver.com/trim/index.html.br" },
      { method: "GET", url: "https://rom-weaver.com/trim.html.br" },
    ]);
    expect(response.headers.get("Content-Encoding")).toBe("br");
  });

  it("matches a document validator without forwarding the full browser request", async () => {
    const { context, fetchLog, forwardedRequests } = makeContext({
      url: "https://rom-weaver.com/apply",
      requestHeaders: { "If-None-Match": 'W/"document"' },
      sidecarResponse: () => new Response("brotli-bytes", { headers: { ETag: '"document"' } }),
    });
    const response = await onRequest(context);
    expect(response.status).toBe(304);
    expect(response.headers.get("ETag")).toBe('"document"');
    expect(response.headers.get("Content-Encoding")).toBe("br");
    expect(fetchLog).toEqual([{ method: "GET", url: "https://rom-weaver.com/apply/index.html.br" }]);
    expect(forwardedRequests).toEqual([]);
  });

  it("matches If-Modified-Since when the sidecar has no entity tag", async () => {
    const { context } = makeContext({
      url: "https://rom-weaver.com/apply",
      requestHeaders: { "If-Modified-Since": "Tue, 04 Aug 2026 21:00:00 GMT" },
      sidecarResponse: () =>
        new Response("brotli-bytes", { headers: { "Last-Modified": "Tue, 04 Aug 2026 20:00:00 GMT" } }),
    });
    const response = await onRequest(context);
    expect(response.status).toBe(304);
  });

  it("matches a wildcard validator when the sidecar has no entity tag", async () => {
    const { context } = makeContext({
      url: "https://rom-weaver.com/apply",
      requestHeaders: { "If-None-Match": "*" },
      sidecarResponse: () => brSidecar(),
    });
    const response = await onRequest(context);
    expect(response.status).toBe(304);
  });

  it("falls through document requests without Brotli support", async () => {
    const { context, fetchLog } = makeContext({
      url: "https://rom-weaver.com/apply",
      acceptEncoding: "gzip",
      sidecarResponse: brSidecar(),
    });
    expect(await onRequest(context)).toBe(NEXT_SENTINEL);
    expect(fetchLog).toEqual([]);
  });
});
