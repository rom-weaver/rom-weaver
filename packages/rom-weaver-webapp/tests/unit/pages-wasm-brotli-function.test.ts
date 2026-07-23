import { describe, expect, it } from "vitest";
import { onRequestGet } from "../../functions/assets/[name].js";

const WASM_URL = "https://rom-weaver.com/assets/rom-weaver-app-BWS09Fxt.wasm";
const NEXT_SENTINEL = new Response("static passthrough");

type AssetsFetch = (url: URL | RequestInfo) => Promise<Response>;

const makeContext = ({
  url = WASM_URL,
  acceptEncoding = "gzip, br, zstd",
  assetsFetch,
}: {
  url?: string;
  acceptEncoding?: string | null;
  assetsFetch?: AssetsFetch;
}) => {
  const headers = new Headers();
  if (acceptEncoding !== null) headers.set("Accept-Encoding", acceptEncoding);
  const fetchedUrls: string[] = [];
  const fallbackFetch: AssetsFetch = () => {
    throw new Error("ASSETS.fetch called unexpectedly");
  };
  return {
    context: {
      env: {
        ASSETS: {
          fetch: (target: URL | RequestInfo) => {
            fetchedUrls.push(String(target));
            return (assetsFetch ?? fallbackFetch)(target);
          },
        },
      },
      next: () => Promise.resolve(NEXT_SENTINEL),
      request: new Request(url, { headers }),
    },
    fetchedUrls,
  };
};

const brSidecarResponse = (body = "brotli-bytes") =>
  new Response(body, { headers: { "Content-Type": "application/octet-stream" } });

describe("pages brotli sidecar function", () => {
  it("serves the wasm sidecar bytes with Content-Encoding br for br-capable clients", async () => {
    const { context, fetchedUrls } = makeContext({ assetsFetch: () => Promise.resolve(brSidecarResponse()) });
    const response = await onRequestGet(context);
    expect(fetchedUrls).toEqual([`${WASM_URL}.br`]);
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
  ])("serves %s from its sidecar with the mapped content type", async (url, contentType) => {
    const { context, fetchedUrls } = makeContext({
      url,
      assetsFetch: () => Promise.resolve(brSidecarResponse()),
    });
    const response = await onRequestGet(context);
    expect(fetchedUrls).toEqual([`${url}.br`]);
    expect(response.headers.get("Content-Type")).toBe(contentType);
    expect(response.headers.get("Content-Encoding")).toBe("br");
    // COEP is load-bearing for worker scripts on a cross-origin-isolated page.
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
  });

  it("falls through to static serving when the client does not accept br", async () => {
    const { context } = makeContext({ acceptEncoding: "gzip, deflate" });
    expect(await onRequestGet(context)).toBe(NEXT_SENTINEL);
  });

  it("falls through when Accept-Encoding is absent", async () => {
    const { context } = makeContext({ acceptEncoding: null });
    expect(await onRequestGet(context)).toBe(NEXT_SENTINEL);
  });

  it("does not treat a br token inside another encoding name as br support", async () => {
    const { context } = makeContext({ acceptEncoding: "libre, zbr" });
    expect(await onRequestGet(context)).toBe(NEXT_SENTINEL);
  });

  it("falls through when the sidecar is missing (SPA fallback response)", async () => {
    const spaFallback = new Response("<!doctype html>", {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
    const { context } = makeContext({ assetsFetch: () => Promise.resolve(spaFallback) });
    expect(await onRequestGet(context)).toBe(NEXT_SENTINEL);
  });

  it("falls through when the sidecar fetch is not ok", async () => {
    const { context } = makeContext({
      assetsFetch: () => Promise.resolve(new Response("nope", { status: 404 })),
    });
    expect(await onRequestGet(context)).toBe(NEXT_SENTINEL);
  });

  it("ignores extensions without sidecars without touching ASSETS", async () => {
    const { context, fetchedUrls } = makeContext({
      url: "https://rom-weaver.com/assets/archivo-var-latin-DXrUVZxZ.woff2",
    });
    expect(await onRequestGet(context)).toBe(NEXT_SENTINEL);
    expect(fetchedUrls).toEqual([]);
  });
});
