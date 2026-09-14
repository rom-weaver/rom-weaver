import { createServer } from "node:http";
import { brotliCompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredPrecache } from "../../src/webapp/pwa/deferred-precache.ts";
import { createOfflineCopyPolicy } from "../../src/webapp/pwa/offline-copy-policy.ts";

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
  it("ignores old stream progress after removal starts a fresh download", async () => {
    const policy = createOfflineCopyPolicy("offline-policy", SCOPE);
    let oldStream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let newStream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const download = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              oldStream = controller;
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              newStream = controller;
            },
          }),
        ),
      );
    const queue = createDeferredPrecache({
      cacheName: CACHE_NAME,
      entries: entries.slice(0, 1),
      scope: SCOPE,
      policy,
      download,
    });
    const oldServe = queue.serve("assets/one.js");
    await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    await policy.setEnabled(false);
    queue.reset();
    await policy.setEnabled(true);
    const progress = vi.fn();
    const pump = queue.runNextBatch(progress);
    try {
      await vi.waitFor(() => expect(download).toHaveBeenCalledTimes(2));
      newStream?.enqueue(new Uint8Array(1));
      await vi.waitFor(() => expect(progress).toHaveBeenLastCalledWith(1));
      oldStream?.enqueue(new Uint8Array(3));
      oldStream?.close();
      await oldServe;
      expect(progress).toHaveBeenLastCalledWith(1);
      newStream?.enqueue(new Uint8Array(2));
      newStream?.close();
      await pump;
      expect(progress).toHaveBeenLastCalledWith(3);
    } finally {
      oldStream?.error(new Error("test stream cleanup"));
      newStream?.error(new Error("test stream cleanup"));
      await Promise.allSettled([oldServe, pump]);
    }
  });

  it("does not start a background fetch after removal interrupts a cache read", async () => {
    const policy = createOfflineCopyPolicy("offline-policy", SCOPE);
    const download = vi.fn(async () => new Response("one"));
    const queue = createDeferredPrecache({
      cacheName: CACHE_NAME,
      entries: entries.slice(0, 1),
      scope: SCOPE,
      policy,
      download,
    });
    const cache = await cacheStorage.open(CACHE_NAME);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const match = vi.spyOn(cache, "match").mockImplementation(async () => {
      await gate;
      return undefined;
    });
    const pump = queue.runNextBatch();
    try {
      await vi.waitFor(() => expect(match).toHaveBeenCalledTimes(1));
      await policy.setEnabled(false);
      release();
      await pump;
      expect(download).not.toHaveBeenCalled();
    } finally {
      release();
      await pump;
      match.mockRestore();
    }
  });

  it("drains a cache write before removal and rejects a stale write after enabling", async () => {
    const policy = createOfflineCopyPolicy("offline-policy", SCOPE);
    const cache = await cacheStorage.open(CACHE_NAME);
    const oldGeneration = policy.token();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = vi.fn();
    const writing = policy.write(async () => {
      started();
      await gate;
      await cache.put(new URL("assets/one.js", SCOPE), new Response("one"));
    }, oldGeneration);
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    let removed = false;
    const removal = policy.setEnabled(false).then(() => {
      cacheStorage.caches.delete(CACHE_NAME);
      removed = true;
    });
    expect(removed).toBe(false);
    release();
    await Promise.all([writing, removal]);
    expect(cacheStorage.caches.has(CACHE_NAME)).toBe(false);
    await policy.setEnabled(true);
    expect(
      await policy.write(() => cache.put(new URL("assets/two.js", SCOPE), new Response("two")), oldGeneration),
    ).toBe(false);
    expect((await cache.keys()).map((request) => request.url)).toEqual([new URL("assets/one.js", SCOPE).href]);
  });

  it("does not restore a removed file from a late download and fetches it again after enabling", async () => {
    const policy = createOfflineCopyPolicy("offline-policy", SCOPE);
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let downloads = 0;
    const queue = createDeferredPrecache({
      cacheName: CACHE_NAME,
      entries: entries.slice(0, 1),
      scope: SCOPE,
      policy,
      download: async () => {
        downloads += 1;
        if (downloads > 1) return new Response("one");
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
            },
          }),
        );
      },
    });
    const first = queue.serve("assets/one.js");
    await vi.waitFor(() => expect(stream).toBeDefined());
    await policy.setEnabled(false);
    cacheStorage.caches.delete(CACHE_NAME);
    stream?.enqueue(new TextEncoder().encode("one"));
    stream?.close();
    expect(await (await first).text()).toBe("one");
    expect(await queue.match("assets/one.js")).toBeUndefined();
    expect(await queue.runNextBatch()).toBe(false);
    await policy.setEnabled(true);
    expect(await queue.runNextBatch()).toBe(true);
    expect(await (await queue.match("assets/one.js"))?.text()).toBe("one");
    expect(downloads).toBe(2);
  });
  it("retains arrivals during its starting cache read without double counting cached files", async () => {
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const queue = createDeferredPrecache({
      cacheName: CACHE_NAME,
      entries,
      scope: SCOPE,
      download: async (request) => {
        if (request.url.endsWith("/one.js")) return new Response("one");
        return new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              stream = controller;
            },
          }),
        );
      },
    });
    await queue.serve("assets/one.js");
    const arrivals = vi.fn();
    const interactive = queue.serve("assets/two.js", arrivals);
    const cache = await cacheStorage.open(CACHE_NAME);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readKeys = cache.keys.bind(cache);
    const keys = vi.spyOn(cache, "keys").mockImplementation(async () => {
      const snapshot = await readKeys();
      await gate;
      return snapshot;
    });
    const progress: number[] = [];
    let pump: Promise<boolean> | undefined;
    try {
      await vi.waitFor(() => expect(stream).toBeDefined());
      stream?.enqueue(new Uint8Array(1));
      await vi.waitFor(() => expect(arrivals).toHaveBeenCalledTimes(1));
      pump = queue.runNextBatch((bytes) => progress.push(bytes));
      await vi.waitFor(() => expect(keys).toHaveBeenCalledTimes(1));
      stream?.enqueue(new Uint8Array(1));
      await vi.waitFor(() => expect(arrivals).toHaveBeenCalledTimes(2));
      release();
      await vi.waitFor(() => expect(progress).toContain(5));
      stream?.enqueue(new Uint8Array(2));
      stream?.close();
      await Promise.all([interactive, pump]);
      expect(progress.at(-1)).toBe(7);
      expect(progress).toEqual([...progress].sort((left, right) => left - right));
      expect(keys).toHaveBeenCalledTimes(1);
    } finally {
      release();
      stream?.error(new Error("test stream cleanup"));
      await Promise.allSettled([interactive, pump]);
      keys.mockRestore();
    }
  });

  it("reports an app download started outside the current batch and keeps its partial progress", async () => {
    const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
    const files = Array.from({ length: 17 }, (_, index) => ({ url: `assets/${index}.bin`, sizeBytes: 10 }));
    const queue = createDeferredPrecache({
      cacheName: CACHE_NAME,
      entries: files,
      scope: SCOPE,
      download: async (request) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.set(request.url, controller);
            },
          }),
        ),
    });
    const onBytes = vi.fn();
    const pump = queue.runNextBatch(onBytes);
    await vi.waitFor(() => expect(streams.size).toBe(4));
    const interactive = queue.serve("assets/16.bin");
    await vi.waitFor(() => expect(streams.size).toBe(5));
    const appStream = streams.get(new URL("assets/16.bin", SCOPE).href);
    try {
      appStream?.enqueue(new Uint8Array(3));
      await vi.waitFor(() => expect(onBytes).toHaveBeenCalledWith(3));
      expect(await queue.state()).toMatchObject({ cachedBytes: 3, cachedFiles: 0, totalBytes: 170 });
      for (const [url, stream] of streams) {
        if (url.endsWith("/16.bin")) continue;
        stream.enqueue(new Uint8Array(10));
        stream.close();
      }
      for (let index = 4; index < 16; index += 4) {
        await vi.waitFor(() => expect(streams.size).toBe(index + 5));
        for (let offset = 0; offset < 4; offset += 1) {
          const stream = streams.get(new URL(`assets/${index + offset}.bin`, SCOPE).href);
          stream?.enqueue(new Uint8Array(10));
          stream?.close();
        }
      }
      await pump;
      expect(await queue.state()).toMatchObject({ cachedBytes: 163, cachedFiles: 16 });
      onBytes.mockClear();
      appStream?.enqueue(new Uint8Array(7));
      appStream?.close();
      await interactive;
      expect(onBytes).not.toHaveBeenCalled();
      expect(await queue.state()).toMatchObject({ cachedBytes: 170, cachedFiles: 17 });
    } finally {
      for (const stream of streams.values()) stream.error(new Error("test stream cleanup"));
      await Promise.allSettled([pump, interactive]);
    }
  });

  it("refills free download slots while a slow file remains in flight", async () => {
    const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
    const queue = createDeferredPrecache({
      cacheName: CACHE_NAME,
      entries: Array.from({ length: 6 }, (_, index) => ({ url: `assets/${index}.bin`, sizeBytes: 1 })),
      scope: SCOPE,
      download: async (request) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.set(request.url, controller);
            },
          }),
        ),
    });
    const pump = queue.runNextBatch();
    try {
      await vi.waitFor(() => expect(streams.size).toBe(4));
      const finish = (index: number) => {
        const stream = streams.get(new URL(`assets/${index}.bin`, SCOPE).href);
        stream?.enqueue(new Uint8Array(1));
        stream?.close();
      };
      finish(1);
      await vi.waitFor(() => expect(streams.size).toBe(5));
      expect(await queue.state()).toMatchObject({ cachedFiles: 1 });
      finish(4);
      await vi.waitFor(() => expect(streams.size).toBe(6));
      for (const index of [0, 2, 3, 5]) finish(index);
      await pump;
      expect(await queue.state()).toMatchObject({ cachedFiles: 6 });
    } finally {
      for (const stream of streams.values()) stream.error(new Error("test stream cleanup"));
      await Promise.allSettled([pump]);
    }
  });

  it("stops refilling on pause and resumes only missing files in the next pump", async () => {
    const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
    let running = true;
    const queue = createDeferredPrecache({
      cacheName: CACHE_NAME,
      entries: Array.from({ length: 5 }, (_, index) => ({ url: `assets/${index}.bin`, sizeBytes: 1 })),
      scope: SCOPE,
      download: async (request) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.set(request.url, controller);
            },
          }),
        ),
    });
    const pump = queue.runNextBatch(undefined, undefined, () => running);
    try {
      await vi.waitFor(() => expect(streams.size).toBe(4));
      running = false;
      for (const stream of streams.values()) {
        stream.enqueue(new Uint8Array(1));
        stream.close();
      }
      await pump;
      expect(streams.size).toBe(4);
      expect(await queue.state()).toMatchObject({ cachedFiles: 4 });
      const resumed = queue.runNextBatch();
      await vi.waitFor(() => expect(streams.size).toBe(5));
      const last = streams.get(new URL("assets/4.bin", SCOPE).href);
      last?.enqueue(new Uint8Array(1));
      last?.close();
      await resumed;
      expect(await queue.state()).toMatchObject({ cachedFiles: 5 });
    } finally {
      for (const stream of streams.values()) stream.error(new Error("test stream cleanup"));
      await Promise.allSettled([pump]);
    }
  });

  it("drains active files after failure and retries without downloading completed files", async () => {
    const streams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
    const fetched: string[] = [];
    let retry = false;
    const queue = createDeferredPrecache({
      cacheName: CACHE_NAME,
      entries: Array.from({ length: 6 }, (_, index) => ({ url: `assets/${index}.bin`, sizeBytes: 1 })),
      scope: SCOPE,
      download: async (request) => {
        fetched.push(request.url);
        if (retry) return new Response("x");
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streams.set(request.url, controller);
            },
          }),
        );
      },
    });
    let settled = false;
    const pump = queue.runNextBatch().finally(() => {
      settled = true;
    });
    const failed = expect(pump).rejects.toThrow("lost connection");
    try {
      await vi.waitFor(() => expect(streams.size).toBe(4));
      streams.get(new URL("assets/0.bin", SCOPE).href)?.error(new Error("lost connection"));
      await vi.waitFor(async () => expect(await queue.state()).toMatchObject({ cachedFiles: 0 }));
      expect(settled).toBe(false);
      for (const index of [1, 2, 3]) {
        const stream = streams.get(new URL(`assets/${index}.bin`, SCOPE).href);
        stream?.enqueue(new Uint8Array(1));
        stream?.close();
      }
      await failed;
      expect(fetched).toHaveLength(4);
      expect(await queue.state()).toMatchObject({ cachedFiles: 3 });
      retry = true;
      await queue.runNextBatch();
      expect(fetched.slice(4)).toEqual([0, 4, 5].map((index) => new URL(`assets/${index}.bin`, SCOPE).href));
      expect(await queue.state()).toMatchObject({ cachedFiles: 6 });
    } finally {
      for (const stream of streams.values()) stream.error(new Error("test stream cleanup"));
      await Promise.allSettled([pump, failed]);
    }
  });

  it("fetches directory documents without redirects and retains revisioned cache keys", async () => {
    const download = vi.fn(async (_request: Request) => new Response("guide"));
    const queue = createDeferredPrecache({
      cacheName: CACHE_NAME,
      entries: [{ url: "docs/guide/index.html", revision: "guide-v1", sizeBytes: 5 }],
      scope: `${SCOPE}app/`,
      download,
    });
    await queue.runNextBatch();
    expect(download.mock.calls[0]?.[0].url).toBe(`${SCOPE}app/docs/guide/`);
    expect(await (await queue.match("docs/guide/index.html"))?.text()).toBe("guide");
    const cache = await cacheStorage.open(CACHE_NAME);
    expect((await cache.keys()).map((request) => request.url)).toEqual([
      `${SCOPE}app/docs/guide/index.html?__WB_REVISION__=guide-v1`,
    ]);
    await queue.serve("docs/guide/index.html");
    expect(download).toHaveBeenCalledTimes(1);
  });

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
      expect(await restarted.state()).toEqual({
        cachedFiles: 2,
        cachedBytes: 7,
        totalFiles: 2,
        totalBytes: 7,
        transferredBytes: encoding === "br" ? 15 : 7,
        transferBytesIncomplete: false,
      });
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
    expect(await queue.state()).toEqual({
      cachedBytes: 3,
      cachedFiles: 1,
      totalBytes: 7,
      totalFiles: 2,
      transferredBytes: 3,
      transferBytesIncomplete: false,
    });
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

  it("streams a download the app already started to a pump that joins it, and serves that file first", async () => {
    const chunk = new Uint8Array(4);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = createDeferredPrecache({
      cacheName: CACHE_NAME,
      download: async (request) => {
        if (!request.url.endsWith("/assets/two.js")) return new Response("one");
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(chunk);
            await gate;
            controller.enqueue(chunk);
            controller.close();
          },
        });
        return new Response(stream);
      },
      entries,
      scope: SCOPE,
    });
    const interactive = queue.serve("assets/two.js");
    // Let the first chunk arrive before the pump joins.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const progress: number[] = [];
    const pump = queue.runNextBatch((cachedBytes) => progress.push(cachedBytes));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(progress).toContain(4);
    release();
    await Promise.all([interactive, pump]);
    expect(progress.at(-1)).toBe(7);
    expect(progress).toEqual([...progress].sort((left, right) => left - right));
    expect(await queue.state()).toMatchObject({ cachedFiles: 2 });
  });

  it("deduplicates interactive fetches and completes state only after every batch file is stored", async () => {
    const many = Array.from({ length: 17 }, (_, index) => ({
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
    expect(await queue.state()).toMatchObject({ cachedFiles: 16, totalFiles: 17 });
    const second = await queue.runNextBatch();
    expect(second).toBe(true);
    expect(await queue.state()).toMatchObject({ cachedFiles: 17, totalFiles: 17 });
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
