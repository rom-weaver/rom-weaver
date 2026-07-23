import { describe, expect, it } from "vitest";
import { onRequestGet } from "../../functions/assets/[name].js";

const WASM_URL = "https://rom-weaver.com/assets/rom-weaver-app-BWS09Fxt.wasm";
const NEXT_SENTINEL = new Response("static passthrough");

type FetchLogEntry = { method: string; url: string };

const spaFallback = () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html; charset=utf-8" } });

const makeContext = ({
  url = WASM_URL,
  acceptEncoding = "gzip, br, zstd",
  assetContentType = "application/wasm",
  assetResponse,
  sidecarResponse,
}: {
  url?: string;
  acceptEncoding?: string | null;
  assetContentType?: string;
  assetResponse?: Response;
  sidecarResponse?: Response;
}) => {
  const headers = new Headers();
  if (acceptEncoding !== null) headers.set("Accept-Encoding", acceptEncoding);
  const fetchLog: FetchLogEntry[] = [];
  return {
    context: {
      env: {
        ASSETS: {
          fetch: (target: URL | RequestInfo, init?: RequestInit) => {
            fetchLog.push({ method: init?.method ?? "GET", url: String(target) });
            if (String(target).endsWith(".br")) {
              return Promise.resolve(sidecarResponse ?? spaFallback());
            }
            return Promise.resolve(
              assetResponse ?? new Response(null, { headers: { "Content-Type": assetContentType } }),
            );
          },
        },
      },
      next: () => Promise.resolve(NEXT_SENTINEL),
      request: new Request(url, { headers }),
    },
    fetchLog,
  };
};

const brSidecar = (body = "brotli-bytes") =>
  new Response(body, { headers: { "Content-Type": "application/octet-stream" } });

describe("pages brotli sidecar function", () => {
  it("serves sidecar bytes with Content-Encoding br and the asset's own content type", async () => {
    const { context, fetchLog } = makeContext({ sidecarResponse: brSidecar() });
    const response = await onRequestGet(context);
    expect(fetchLog).toEqual([
      { method: "HEAD", url: WASM_URL },
      { method: "GET", url: `${WASM_URL}.br` },
    ]);
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
    ["https://rom-weaver.com/assets/archivo-var-latin-DXrUVZxZ.woff2", "font/woff2"],
  ])("passes through the static content type for %s", async (url, contentType) => {
    const { context } = makeContext({ url, assetContentType: contentType, sidecarResponse: brSidecar() });
    const response = await onRequestGet(context);
    expect(response.headers.get("Content-Type")).toBe(contentType);
    expect(response.headers.get("Content-Encoding")).toBe("br");
    // COEP is load-bearing for worker scripts on a cross-origin-isolated page.
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
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

  it("falls through when the asset itself is missing (SPA fallback response)", async () => {
    const { context, fetchLog } = makeContext({ assetResponse: spaFallback() });
    expect(await onRequestGet(context)).toBe(NEXT_SENTINEL);
    expect(fetchLog).toEqual([{ method: "HEAD", url: WASM_URL }]);
  });

  it("falls through when the sidecar is missing (SPA fallback response)", async () => {
    const { context } = makeContext({ sidecarResponse: spaFallback() });
    expect(await onRequestGet(context)).toBe(NEXT_SENTINEL);
  });

  it("falls through when the sidecar fetch is not ok", async () => {
    const { context } = makeContext({ sidecarResponse: new Response("nope", { status: 404 }) });
    expect(await onRequestGet(context)).toBe(NEXT_SENTINEL);
  });

  it("falls through when the asset probe reports no content type", async () => {
    const { context } = makeContext({ assetResponse: new Response(null, { status: 200 }) });
    expect(await onRequestGet(context)).toBe(NEXT_SENTINEL);
  });
});
