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
      release: async () => undefined,
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
      release: async () => undefined,
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
      release: async () => undefined,
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
      release: async () => undefined,
      scope: SCOPE,
    });
    expect(await revised.state()).toMatchObject({ cachedBytes: 0, cachedFiles: 0 });
    expect(await (await revised.serve("assets/one.js")).text()).toBe("new");
  });

  it("commits each successful file when a later batch file fails", async () => {
    const released: string[] = [];
    const queue = createDeferredPrecache({
      cacheName: CACHE_NAME,
      download: async (request) =>
        request.url.endsWith("one.js") ? new Response("one") : new Response("failed", { status: 500 }),
      entries,
      release: async (request) => {
        released.push(request.url);
      },
      scope: SCOPE,
    });

    await expect(queue.runNextBatch()).rejects.toThrow("HTTP 500");

    expect(await queue.state()).toMatchObject({ cachedBytes: 3, cachedFiles: 1, totalBytes: 7, totalFiles: 2 });
    expect(released).toEqual([new URL("assets/one.js", SCOPE).href]);
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
      release: async () => undefined,
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
      release: async () => undefined,
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
