import { describe, expect, it } from "vitest";
import { onRequestGet } from "../../functions/assets/[name].js";

const WASM_URL = "https://rom-weaver.com/assets/rom-weaver-app-BWS09Fxt.wasm";
const NEXT_SENTINEL = new Response("static passthrough");

type FetchLogEntry = { method: string; url: string };

const spaFallback = () => new Response("<!doctype html>", { headers: { "Content-Type": "text/html; charset=utf-8" } });

const makeContext = ({
  url = WASM_URL,
  acceptEncoding = "gzip, br, zstd",
  sidecarResponse,
}: {
  url?: string;
  acceptEncoding?: string | null;
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
            return Promise.resolve(sidecarResponse ?? spaFallback());
          },
        },
      },
      next: () => Promise.resolve(NEXT_SENTINEL),
      request: new Request(url, { headers }),
    },
    fetchLog,
  };
};

const brSidecar = (body = "brotli-bytes", headers: HeadersInit = {}) => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/octet-stream");
  return new Response(body, { headers: responseHeaders });
};

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

  it("preserves a valid sidecar Content-Length as encoded-size metadata without reading its body", async () => {
    const sidecar = brSidecar("brotli-bytes", { "Content-Length": "12" });
    const { context } = makeContext({ sidecarResponse: sidecar });

    const response = await onRequestGet(context);

    expect(sidecar.bodyUsed).toBe(false);
    expect(response.headers.get("x-rom-weaver-encoded-size")).toBe("12");
    expect(await response.text()).toBe("brotli-bytes");
  });

  it.each([undefined, "", "-1", "1.5", "not-a-size", "9007199254740992"])(
    "leaves encoded-size metadata unknown when sidecar Content-Length is %j",
    async (contentLength) => {
      const headers = contentLength === undefined ? {} : { "Content-Length": contentLength };
      const { context } = makeContext({ sidecarResponse: brSidecar("brotli-bytes", headers) });

      const response = await onRequestGet(context);

      expect(response.headers.has("x-rom-weaver-encoded-size")).toBe(false);
      expect(await response.text()).toBe("brotli-bytes");
    },
  );

  it.each([
    ["https://rom-weaver.com/assets/index-DXHhOtA-.js", "text/javascript; charset=utf-8"],
    ["https://rom-weaver.com/assets/index-DqvtWSeD.css", "text/css; charset=utf-8"],
    ["https://rom-weaver.com/assets/identify-atari-2600.pack", "application/octet-stream"],
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
      url: "https://rom-weaver.com/assets/font-DXrUVZxZ.woff2",
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

  it("falls through when the client rejects br with a zero quality", async () => {
    const { context, fetchLog } = makeContext({ acceptEncoding: "gzip, br;q=0" });
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
});
