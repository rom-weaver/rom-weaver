import { describe, expect, it } from "vitest";
import { onRequestGet } from "../../functions/assets/[name].js";

const BROTLI = { "Accept-Encoding": "gzip, br" };

// Pages' ASSETS binding, reduced to the two answers the function reads: the asset
// itself and the SPA fallback that stands in for a missing one.
const assetsFor = (files: Record<string, string>, etag?: string) => ({
  fetch: async (input: Request | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    const pathname = new URL(request.url).pathname;
    const body = files[pathname];
    if (body === undefined) return new Response("<!doctype html>", { headers: { "Content-Type": "text/html" } });
    // Pages answers a matching validator with a bodyless 304, exactly as the static path does.
    if (etag && request.headers.get("If-None-Match") === etag) {
      return new Response(null, { headers: { ETag: etag }, status: 304 });
    }
    return new Response(body, {
      headers: { "Content-Type": "application/octet-stream", ...(etag ? { ETag: etag } : {}) },
    });
  },
});

const NEXT = new Response("next", { headers: { "X-Handler": "static" } });

const get = (
  pathname: string,
  files: Record<string, string>,
  headers: Record<string, string> = BROTLI,
  etag?: string,
) =>
  onRequestGet({
    env: { ASSETS: assetsFor(files, etag) },
    next: () => NEXT,
    request: new Request(`https://rom-weaver.com${pathname}`, { headers }),
  });

describe("assets function", () => {
  it("serves a sidecar with the immutable cache rule and the isolation headers", async () => {
    const response = await get("/assets/index-abc.js", { "/assets/index-abc.js.br": "compressed" });
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("Content-Encoding")).toBe("br");
    expect(response.headers.get("Content-Type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("Cross-Origin-Embedder-Policy")).toBe("require-corp");
  });

  it("revalidates the identify manifests instead of freezing them", async () => {
    for (const name of ["identify-index.json", "identify-catalog.json"]) {
      const response = await get(`/assets/${name}`, { [`/assets/${name}.br`]: "compressed" });
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
      expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    }
  });

  // Falling through would put the manifest on Pages' static path, where _headers does
  // not apply to a URL this function claims and the response carries no Cache-Control.
  it("keeps a manifest on the function path when the client takes no brotli", async () => {
    const response = await get("/assets/identify-index.json", { "/assets/identify-index.json": "{}" }, {});
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("Content-Encoding")).toBeNull();
    expect(await response.text()).toBe("{}");
  });

  // The app fetches both manifests with cache: "no-cache" on every page load, so the
  // revalidation is the common request, not the exception.
  it("answers a matching validator with a 304 that still carries no-cache", async () => {
    for (const accept of [BROTLI, {}]) {
      const response = await get(
        "/assets/identify-index.json",
        { "/assets/identify-index.json": "{}", "/assets/identify-index.json.br": "compressed" },
        { ...accept, "If-None-Match": '"v1"' },
        '"v1"',
      );
      expect(response.status).toBe(304);
      expect(response.headers.get("Cache-Control")).toBe("no-cache");
      expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
      expect(response.headers.get("Content-Encoding")).toBeNull();
    }
  });

  // An immutable asset is never revalidated, so its validators are not worth a
  // conditional subrequest - it must keep answering with the sidecar body.
  it("ignores a validator on an immutable asset", async () => {
    const response = await get(
      "/assets/index-abc.js",
      { "/assets/index-abc.js.br": "compressed" },
      { ...BROTLI, "If-None-Match": '"v1"' },
      '"v1"',
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("compressed");
  });

  // Relabelling a 206 as 200 would hand the client a partial manifest marked complete.
  it("keeps a partial response partial", async () => {
    const response = await onRequestGet({
      env: {
        ASSETS: {
          fetch: async () => new Response('{"fo', { headers: { "Content-Range": "bytes 0-3/100" }, status: 206 }),
        },
      },
      next: () => NEXT,
      request: new Request("https://rom-weaver.com/assets/identify-index.json", { headers: { Range: "bytes=0-3" } }),
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 0-3/100");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
  });

  it("hands anything else back to the static path", async () => {
    expect(await get("/assets/index-abc.js", {}, {})).toBe(NEXT);
    expect(await get("/assets/index-abc.js", {})).toBe(NEXT);
    expect(await get("/assets/sitemap.xml", {})).toBe(NEXT);
    expect(await get("/assets/identify-index.json", {})).toBe(NEXT);
  });
});
