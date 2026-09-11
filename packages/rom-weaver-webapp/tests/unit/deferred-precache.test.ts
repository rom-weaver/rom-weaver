import { createServer } from "node:http";
import { brotliCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredPrecache } from "../../src/webapp/pwa/deferred-precache.ts";

const SCOPE = "https://example.test/";
const CACHE_NAME = "deferred-precache";

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

const entries = [
  { revision: "one", sizeBytes: 3, url: "assets/one.js" },
  { revision: "two", sizeBytes: 4, url: "assets/two.js" },
];

let cacheStorage: FakeCacheStorage;

beforeEach(() => {
  cacheStorage = new FakeCacheStorage();
  vi.stubGlobal("caches", cacheStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deferred precache", () => {
  it.each(["br", "identity"])("resumes completed original files over HTTP %s after restart", async (encoding) => {
    vi.stubGlobal("DecompressionStream", undefined);
    const requests: string[] = [];
    let recovered = false;
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      if (request.url === "/assets/two.js" && !recovered) {
        response.writeHead(503).end("unavailable");
        return;
      }
      const body = Buffer.from(request.url === "/assets/one.js" ? "one" : "two!");
      response.setHeader("Content-Type", "text/javascript");
      if (encoding === "br") response.setHeader("Content-Encoding", "br");
      response.end(encoding === "br" ? brotliCompressSync(body) : body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address");
      const scope = `http://127.0.0.1:${address.port}/`;
      const options = { cacheName: CACHE_NAME, download: fetch, entries, scope };
      const first = createDeferredPrecache(options);
      await expect(first.runNextBatch()).rejects.toThrow("503");
      expect(await first.state()).toMatchObject({ cachedFiles: 1, cachedBytes: 3 });
      recovered = true;
      const restarted = createDeferredPrecache(options);
      await restarted.runNextBatch();
      expect(await restarted.state()).toEqual({ cachedFiles: 2, cachedBytes: 7, totalFiles: 2, totalBytes: 7 });
      expect(await (await restarted.match("assets/two.js"))?.text()).toBe("two!");
      expect((await restarted.match("assets/two.js"))?.headers.get("Content-Type")).toBe("text/javascript");
      expect(requests.filter((url) => url === "/assets/one.js")).toHaveLength(1);
      expect(requests.filter((url) => url === "/assets/two.js")).toHaveLength(2);
      expect([...cacheStorage.caches.keys()]).toEqual([CACHE_NAME]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("reports incoming bytes but never commits an interrupted file", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        controller.enqueue(new TextEncoder().encode("on"));
      },
    });
    let attempts = 0;
    const queue = createDeferredPrecache({
      cacheName: CACHE_NAME,
      entries: entries.slice(0, 1),
      scope: SCOPE,
      download: async () => {
        attempts += 1;
        return attempts === 1 ? new Response(body) : new Response("one");
      },
    });
    const progress: number[] = [];
    const downloading = queue.serve("assets/one.js", (delta) => progress.push(delta));
    const rejected = expect(downloading).rejects.toThrow("connection lost");
    await vi.waitFor(() => expect(progress).toEqual([2]));
    expect(await queue.state()).toMatchObject({ cachedFiles: 0 });
    controller?.error(new Error("connection lost"));
    await rejected;
    expect(await queue.match("assets/one.js")).toBeUndefined();
    expect(body.locked).toBe(false);
    expect(await (await queue.serve("assets/one.js")).text()).toBe("one");
    expect(attempts).toBe(2);
    expect(await queue.state()).toMatchObject({ cachedFiles: 1 });
  });

  it("migrates only current revisions from the former full precache", async () => {
    const source = await cacheStorage.open("old-precache");
    await source.put(new URL("assets/one.js?__WB_REVISION__=one", SCOPE), new Response("one"));
    await source.put(new URL("assets/two.js?__WB_REVISION__=old", SCOPE), new Response("old"));
    const queue = createDeferredPrecache({
      cacheName: CACHE_NAME,
      entries,
      scope: SCOPE,
      download: async () => {
        throw new Error("network must not run during migration");
      },
    });
    await queue.migrate("old-precache");
    expect(await queue.state()).toEqual({ cachedBytes: 3, cachedFiles: 1, totalBytes: 7, totalFiles: 2 });
    expect(await (await queue.match("assets/one.js"))?.text()).toBe("one");
    expect(await queue.match("assets/two.js")).toBeUndefined();
  });
  it("persists files across a recreated queue and keys a new revision separately from an old cache entry", async () => {
    const downloads: string[] = [];
    const first = createDeferredPrecache({
      cacheName: CACHE_NAME,
      download: async (request) => {
        downloads.push(request.url);
        return new Response("one");
      },
      entries: entries.slice(0, 1),
      scope: SCOPE,
    });
    await first.serve("assets/one.js");
    const restarted = createDeferredPrecache({
      cacheName: CACHE_NAME,
      download: async (request) => {
        downloads.push(request.url);
        return new Response("unexpected");
      },
      entries: entries.slice(0, 1),
      scope: SCOPE,
    });
    expect(await restarted.state()).toMatchObject({ cachedBytes: 3, cachedFiles: 1, totalFiles: 1 });
    expect(await (await restarted.serve("assets/one.js")).text()).toBe("one");
    expect(downloads).toEqual([new URL("assets/one.js", SCOPE).href]);

    const staleKey = new URL("assets/one.js", SCOPE);
    staleKey.searchParams.set("__WB_REVISION__", "old");
    await (await cacheStorage.open(CACHE_NAME)).put(staleKey, new Response("old"));
    const revised = createDeferredPrecache({
      cacheName: CACHE_NAME,
      download: async () => new Response("new"),
      entries: [{ revision: "new", sizeBytes: 3, url: "assets/one.js" }],
      scope: SCOPE,
    });
    expect(await revised.state()).toMatchObject({ cachedBytes: 0, cachedFiles: 0 });
    expect(await (await revised.serve("assets/one.js")).text()).toBe("new");
  });

  it("commits each successful file when a later batch file fails", async () => {
    const queue = createDeferredPrecache({
      cacheName: CACHE_NAME,
      download: async (request) =>
        request.url.endsWith("one.js") ? new Response("one") : new Response("failed", { status: 500 }),
      entries,
      scope: SCOPE,
    });

    await expect(queue.runNextBatch()).rejects.toThrow("HTTP 500");

    expect(await queue.state()).toMatchObject({ cachedBytes: 3, cachedFiles: 1, totalBytes: 7, totalFiles: 2 });
    expect(await (await queue.match("assets/one.js"))?.text()).toBe("one");
    expect(await queue.match("assets/two.js")).toBeUndefined();
  });

  it("deduplicates interactive fetches and completes state only after every batch file is stored", async () => {
    const many = Array.from({ length: 5 }, (_, index) => ({
      revision: `r${index}`,
      sizeBytes: index + 1,
      url: `assets/${index}.bin`,
    }));
    const fetched: string[] = [];
    const queue = createDeferredPrecache({
      cacheName: CACHE_NAME,
      download: async (request) => {
        fetched.push(request.url);
        return new Response("x");
      },
      entries: many,
      scope: SCOPE,
    });

    const first = await queue.runNextBatch();
    expect(first).toBe(true);
    expect(await queue.state()).toMatchObject({ cachedFiles: 4, totalFiles: 5 });
    const second = await queue.runNextBatch();
    expect(second).toBe(true);
    expect(await queue.state()).toMatchObject({ cachedFiles: 5, totalFiles: 5 });
    expect(await queue.runNextBatch()).toBe(false);

    const interactive = createDeferredPrecache({
      cacheName: "interactive-precache",
      download: async (request) => {
        fetched.push(request.url);
        return new Response("shared");
      },
      entries: [{ revision: "shared", sizeBytes: 6, url: "assets/shared.bin" }],
      scope: SCOPE,
    });
    const beforeInteractive = fetched.length;
    const [left, right] = await Promise.all([
      interactive.serve("assets/shared.bin"),
      interactive.serve("assets/shared.bin"),
    ]);
    expect(await left.text()).toBe("shared");
    expect(await right.text()).toBe("shared");
    expect(fetched).toHaveLength(beforeInteractive + 1);
  });
});
