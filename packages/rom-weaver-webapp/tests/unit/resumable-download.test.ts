import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResumableDownloader, type DownloadChunk } from "../../src/webapp/pwa/resumable-download.ts";

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

const utf8 = new TextEncoder();

const sha256 = async (text: string) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const gzip = async (text: string) => {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
};

const chunk = async (url: string, text: string, encoding?: "gzip"): Promise<DownloadChunk> => ({
  ...(encoding ? { encoding } : {}),
  sha256: await sha256(text),
  sizeBytes: text.length,
  url,
});

let cacheStorage: FakeCacheStorage;

beforeEach(() => {
  cacheStorage = new FakeCacheStorage();
  vi.stubGlobal("caches", cacheStorage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resumable offline downloads", () => {
  it("persists verified gzip chunks and resumes them after a recreated downloader", async () => {
    const chunks = [
      await chunk("https://example.test/offline/0.gz", "abcd", "gzip"),
      await chunk("https://example.test/offline/1.gz", "efgh", "gzip"),
    ];
    const firstFetcher = vi.fn(async (request: Request) => {
      if (request.url.endsWith("0.gz")) return new Response(await gzip("abcd"));
      throw new Error("worker terminated");
    });
    const first = createResumableDownloader({
      cacheName: "partial-assets",
      fetcher: firstFetcher,
      maxConcurrentChunks: 1,
    });
    await expect(
      first.download("https://example.test/assets/app.wasm", { chunks, revision: "build-a" }),
    ).rejects.toThrow("worker terminated");

    const progress: Array<[number, number | undefined]> = [];
    const resumedFetcher = vi.fn(
      async (request: Request) => new Response(await gzip(request.url.endsWith("1.gz") ? "efgh" : "unexpected")),
    );
    const resumed = createResumableDownloader({ cacheName: "partial-assets", fetcher: resumedFetcher });
    const response = await resumed.download("https://example.test/assets/app.wasm", {
      chunks,
      headers: { "content-type": "application/wasm" },
      onBytes: (loaded, total) => progress.push([loaded, total]),
      revision: "build-a",
    });

    expect(await response.text()).toBe("abcdefgh");
    expect(response.headers.get("content-type")).toBe("application/wasm");
    expect(resumedFetcher.mock.calls.map(([request]) => request.url)).toEqual([chunks[1]?.url]);
    expect(progress).toEqual([
      [4, 8],
      [8, 8],
    ]);

    await resumed.release("https://example.test/assets/app.wasm");
    expect(await (await cacheStorage.open("partial-assets")).keys()).toEqual([]);
  });

  it("discards chunks when an immutable revision or chunk plan changes", async () => {
    const firstChunks = [await chunk("https://example.test/offline/0", "old")];
    const nextChunks = [await chunk("https://example.test/offline/0", "new")];
    const first = createResumableDownloader({
      cacheName: "partial-assets",
      fetcher: async () => new Response("old"),
    });
    expect(
      await (
        await first.download("https://example.test/assets/app.js", { chunks: firstChunks, revision: "one" })
      ).text(),
    ).toBe("old");

    const fetcher = vi.fn(async () => new Response("new"));
    const second = createResumableDownloader({ cacheName: "partial-assets", fetcher });
    expect(
      await (
        await second.download("https://example.test/assets/app.js", { chunks: nextChunks, revision: "two" })
      ).text(),
    ).toBe("new");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed chunk before it reaches persistent storage", async () => {
    const chunks = [await chunk("https://example.test/offline/0", "expected")];
    const downloader = createResumableDownloader({
      cacheName: "partial-assets",
      fetcher: async () => new Response("wrong"),
    });
    await expect(downloader.download("https://example.test/assets/app.js", { chunks })).rejects.toThrow("size failed");

    const entries = await (await cacheStorage.open("partial-assets")).keys();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.url).toContain("kind=manifest");
  });

  it("uses an ordinary streamed response when no immutable chunk plan exists", async () => {
    const fetcher = vi.fn(async (request: Request) => {
      expect(request.headers.get("range")).toBeNull();
      return new Response("data");
    });
    const progress: Array<[number, number | undefined]> = [];
    const downloader = createResumableDownloader({ cacheName: "partial-assets", fetcher });
    const response = await downloader.download("https://example.test/assets/plain.bin", {
      onBytes: (loaded, total) => progress.push([loaded, total]),
    });

    expect(await response.text()).toBe("data");
    expect(progress).toEqual([
      [0, undefined],
      [4, undefined],
    ]);
    expect(await (await cacheStorage.open("partial-assets")).keys()).toEqual([]);
  });

  it("deduplicates callers and limits concurrent chunk requests", async () => {
    const chunks = await Promise.all(
      ["a", "b", "c", "d"].map((text, index) => chunk(`https://example.test/offline/${index}`, text)),
    );
    let active = 0;
    let peak = 0;
    const fetcher = vi.fn(async (request: Request) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      const index = Number(request.url.slice(-1));
      return new Response(["a", "b", "c", "d"][index]);
    });
    const downloader = createResumableDownloader({ cacheName: "partial-assets", fetcher, maxConcurrentChunks: 2 });
    const options = { chunks, revision: "build-a" };
    const [left, right] = await Promise.all([
      downloader.download("https://example.test/assets/app.bin", options),
      downloader.download("https://example.test/assets/app.bin", options),
    ]);

    await downloader.release("https://example.test/assets/app.bin");
    expect(await left.text()).toBe("abcd");
    expect(await right.text()).toBe("abcd");
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(peak).toBe(2);
  });

  it("does not return an assembled response while a required chunk is still downloading", async () => {
    const chunks = [await chunk("/offline/0", "a"), await chunk("/offline/1", "b")];
    let finishSecond: ((response: Response) => void) | undefined;
    const fetcher = vi.fn((request: Request) => {
      if (request.url.endsWith("/0")) return Promise.resolve(new Response("a"));
      return new Promise<Response>((resolve) => {
        finishSecond = resolve;
      });
    });
    const downloader = createResumableDownloader({ cacheName: "partial-assets", fetcher });
    const downloading = downloader.download("https://example.test/assets/app.bin", { chunks });
    let finished = false;
    void downloading.then(() => {
      finished = true;
    });

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(finished).toBe(false);
    finishSecond?.(new Response("b"));
    expect(await (await downloading).text()).toBe("ab");
  });

  it("reports decoded bytes before a chunk has finished downloading", async () => {
    const chunks = [await chunk("/offline/0", "abcd")];
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        controller.enqueue(utf8.encode("ab"));
      },
    });
    const fetcher = vi.fn(async () => new Response(body));
    const progress: Array<[number, number | undefined]> = [];
    const downloader = createResumableDownloader({ cacheName: "partial-assets", fetcher });
    const downloading = downloader.download("https://example.test/assets/app.bin", {
      chunks,
      onBytes: (loaded, total) => progress.push([loaded, total]),
    });

    await vi.waitFor(() => expect(progress).toContainEqual([2, 4]));
    controller?.enqueue(utf8.encode("cd"));
    controller?.close();
    expect(await (await downloading).text()).toBe("abcd");
  });

  it("deduplicates ordinary downloads until their response body is buffered", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
      },
    });
    const fetcher = vi.fn(async () => new Response(body));
    const downloader = createResumableDownloader({ cacheName: "partial-assets", fetcher });
    const [first, second] = [
      downloader.download("https://example.test/assets/plain.bin"),
      downloader.download("https://example.test/assets/plain.bin"),
    ];

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller?.enqueue(utf8.encode("data"));
    controller?.close();
    expect(await (await first).text()).toBe("data");
    expect(await (await second).text()).toBe("data");
  });
});
