import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOfflineDownloadClient } from "../../src/webapp/pwa/offline-download-client.ts";

const SCOPE = "https://example.test/";
const CACHE_NAME = "offline-download-parts";
const text = new TextEncoder();

class FakeCache {
  entries = new Map<string, Response>();

  async keys() {
    return [...this.entries.keys()].map((url) => new Request(url));
  }

  async match(request: RequestInfo | URL) {
    const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
    return this.entries.get(url)?.clone();
  }

  async put(request: RequestInfo | URL, response: Response) {
    const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
    this.entries.set(url, response.clone());
  }

  async delete(request: RequestInfo | URL) {
    const url = typeof request === "string" ? request : request instanceof URL ? request.href : request.url;
    return this.entries.delete(url);
  }
}

class FakeCacheStorage {
  caches = new Map<string, FakeCache>();

  async open(name: string) {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(name, cache);
    }
    return cache as unknown as Cache;
  }
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const gzipPlan = (url: string, value: string) => {
  const bytes = text.encode(value);
  return {
    chunk: { encoding: "gzip" as const, sha256: sha256(bytes), sizeBytes: bytes.byteLength, url },
    compressed: gzipSync(bytes),
  };
};

let cacheStorage: FakeCacheStorage;

beforeEach(() => {
  cacheStorage = new FakeCacheStorage();
  vi.stubGlobal("caches", cacheStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("offline download client", () => {
  it("resumes only a missing gzip chunk, then preserves the assembled bytes and MIME type", async () => {
    const first = gzipPlan("offline-chunks/first.gz", "first-");
    const second = gzipPlan("offline-chunks/second.gz", "second");
    const assetUrl = "assets/runtime.wasm";
    const manifest = {
      [assetUrl]: {
        chunks: [first.chunk, second.chunk],
        contentType: "application/wasm",
        revision: sha256(text.encode("first-second")),
        sizeBytes: "first-second".length,
      },
    };
    const firstRequests: string[] = [];
    const interruptedFetcher = async (request: Request | string) => {
      const url = typeof request === "string" ? request : request.url;
      firstRequests.push(url);
      if (url.endsWith("first.gz")) return new Response(first.compressed);
      throw new Error("service worker stopped");
    };
    const interrupted = createOfflineDownloadClient({
      cacheName: CACHE_NAME,
      fetcher: interruptedFetcher,
      log: () => undefined,
      manifestUrl: "offline-downloads-build.json",
      matchManifest: async () => Response.json(manifest),
      scope: SCOPE,
    });
    const request = new Request(new URL(assetUrl, SCOPE));

    await expect(interrupted.download(request)).rejects.toThrow("service worker stopped");
    expect(firstRequests).toEqual([new URL(first.chunk.url, SCOPE).href, new URL(second.chunk.url, SCOPE).href]);

    const resumedRequests: string[] = [];
    const resumed = createOfflineDownloadClient({
      cacheName: CACHE_NAME,
      fetcher: async (request) => {
        resumedRequests.push(typeof request === "string" ? request : request.url);
        return new Response(second.compressed);
      },
      log: () => undefined,
      manifestUrl: "offline-downloads-build.json",
      matchManifest: async () => Response.json(manifest),
      scope: SCOPE,
    });
    const response = await resumed.download(request);
    const destination = await cacheStorage.open("offline-destination");
    await destination.put(request, response.clone());

    expect(resumedRequests).toEqual([new URL(second.chunk.url, SCOPE).href]);
    expect(response.headers.get("content-type")).toBe("application/wasm");
    const stored = await destination.match(request);
    expect(stored).toBeDefined();
    expect(await stored?.text()).toBe("first-second");

    await resumed.release(request);
    expect(await (await cacheStorage.open(CACHE_NAME)).keys()).toEqual([]);
  });

  it("rejects foreign and size-mismatched manifests before fetching an asset", async () => {
    const fetcher = async () => new Response("unexpected");
    const foreign = createOfflineDownloadClient({
      cacheName: CACHE_NAME,
      fetcher,
      log: () => undefined,
      manifestUrl: "offline-downloads-build.json",
      matchManifest: async () =>
        Response.json({
          "https://attacker.test/asset.bin": {
            chunks: [gzipPlan("offline-chunks/asset.gz", "asset").chunk],
            contentType: "application/octet-stream",
            revision: "a".repeat(64),
            sizeBytes: 5,
          },
        }),
      scope: SCOPE,
    });
    await expect(foreign.download(new Request(new URL("assets/asset.bin", SCOPE)))).rejects.toThrow("Cross-origin");

    const mismatch = createOfflineDownloadClient({
      cacheName: CACHE_NAME,
      fetcher,
      log: () => undefined,
      manifestUrl: "offline-downloads-build.json",
      matchManifest: async () =>
        Response.json({
          "assets/asset.bin": {
            chunks: [gzipPlan("offline-chunks/asset.gz", "asset").chunk],
            contentType: "application/octet-stream",
            revision: "a".repeat(64),
            sizeBytes: 6,
          },
        }),
      scope: SCOPE,
    });
    await expect(mismatch.download(new Request(new URL("assets/asset.bin", SCOPE)))).rejects.toThrow("size mismatch");
  });

  it("streams a direct asset and reports incremental progress when it has no plan", async () => {
    const progress: number[] = [];
    const client = createOfflineDownloadClient({
      cacheName: CACHE_NAME,
      fetcher: async () => new Response("plain"),
      log: () => undefined,
      manifestUrl: "offline-downloads-build.json",
      matchManifest: async () => Response.json({}),
      scope: SCOPE,
    });

    const response = await client.download(new Request(new URL("assets/plain.bin", SCOPE)), (delta) =>
      progress.push(delta),
    );

    expect(await response.text()).toBe("plain");
    expect(progress).toEqual([0, 5]);
    expect(await (await cacheStorage.open(CACHE_NAME)).keys()).toEqual([]);
  });

  it("deduplicates active direct downloads but retries bytes rejected by a caller", async () => {
    let attempts = 0;
    const client = createOfflineDownloadClient({
      cacheName: CACHE_NAME,
      fetcher: async () => {
        attempts += 1;
        return new Response(attempts === 1 ? "corrupt" : "recovered");
      },
      log: () => undefined,
      manifestUrl: "offline-downloads-build.json",
      matchManifest: async () => Response.json({}),
      scope: SCOPE,
    });
    const request = new Request(new URL("identify/pack.bin", SCOPE));
    const [first, concurrent] = await Promise.all([client.download(request), client.download(request)]);
    expect(await first.text()).toBe("corrupt");
    expect(await concurrent.text()).toBe("corrupt");
    expect(attempts).toBe(1);
    expect(await (await client.download(request)).text()).toBe("recovered");
    expect(attempts).toBe(2);
  });

  it("retries a direct download after the server recovers", async () => {
    let attempts = 0;
    const client = createOfflineDownloadClient({
      cacheName: CACHE_NAME,
      fetcher: async () => {
        attempts += 1;
        return attempts === 1 ? new Response("unavailable", { status: 503 }) : new Response("recovered");
      },
      log: () => undefined,
      matchManifest: async () => undefined,
      scope: SCOPE,
    });
    const request = new Request(new URL("assets/plain.bin", SCOPE));
    expect((await client.download(request)).status).toBe(503);
    expect(await (await client.download(request)).text()).toBe("recovered");
    expect(attempts).toBe(2);
  });
});
