import { afterEach, describe, expect, it, vi } from "vitest";
import { configureLogger, createLogger } from "../../src/lib/logging.ts";
import {
  cacheWithDownloadLog,
  fetchWithDownloadLog,
  observeDownloadTimings,
} from "../../src/webapp/pwa/offline-download-log.ts";

afterEach(() => {
  configureLogger({ level: "warn", sink: null });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mockObserver = () => {
  let deliver: (entries: PerformanceEntry[]) => void = () => undefined;
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    "PerformanceObserver",
    class {
      constructor(callback: PerformanceObserverCallback) {
        deliver = (entries) =>
          callback({ getEntries: () => entries } as PerformanceObserverEntryList, {} as PerformanceObserver);
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  return { observe, disconnect, deliver: (entries: PerformanceEntry[]) => deliver(entries) };
};

const resource = (overrides: Partial<PerformanceResourceTiming> = {}) =>
  ({
    entryType: "resource",
    name: "https://app.test/assets/identify.pack?sha256=digest",
    startTime: 400,
    duration: 2000,
    responseStart: 500,
    responseEnd: 2400,
    transferSize: 4_000_300,
    encodedBodySize: 4_000_000,
    decodedBodySize: 40_000_000,
    nextHopProtocol: "h2",
    ...overrides,
  }) as PerformanceResourceTiming;

describe("offline download logs", () => {
  it("preserves numeric transfer counts through the app logger", () => {
    const observer = mockObserver();
    const sink = vi.fn();
    configureLogger({ level: "debug", sink });
    observeDownloadTimings(createLogger("download-test").debug);
    observer.deliver([resource()]);
    expect(sink).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: "offline download complete",
        details: expect.objectContaining({
          transferByteCount: 4_000_300,
          encodedByteCount: 4_000_000,
          decodedByteCount: 40_000_000,
          transferMbps: 16,
        }),
      }),
    );
  });

  it("measures compressed transfers from worker timings without counting decoded bytes as network traffic", () => {
    const observer = mockObserver();
    const log = vi.fn();
    observeDownloadTimings(log);
    expect(observer.observe).toHaveBeenCalledWith({ type: "resource", buffered: true });
    observer.deliver([resource()]);
    expect(log).toHaveBeenLastCalledWith("offline download complete", {
      url: "/assets/identify.pack",
      startMs: 400,
      durationMs: 2000,
      headersMs: 100,
      bodyMs: 1900,
      transferByteCount: 4_000_300,
      encodedByteCount: 4_000_000,
      decodedByteCount: 40_000_000,
      transferMbps: 16,
      httpCacheHit: false,
      protocol: "h2",
    });
  });

  it("does not report network speed for HTTP cache hits or unavailable timings", () => {
    const observer = mockObserver();
    const log = vi.fn();
    observeDownloadTimings(log);
    observer.deliver([resource({ transferSize: 0 })]);
    expect(log).toHaveBeenLastCalledWith(
      "offline download complete",
      expect.objectContaining({ transferMbps: null, httpCacheHit: true }),
    );
    observer.deliver([
      resource({ duration: 0, responseStart: 0, transferSize: 0, encodedBodySize: 0, decodedBodySize: 0 }),
    ]);
    expect(log).toHaveBeenLastCalledWith(
      "offline download complete",
      expect.objectContaining({ transferMbps: null, httpCacheHit: false, headersMs: null, bodyMs: null }),
    );
    vi.stubGlobal("PerformanceObserver", undefined);
    observeDownloadTimings(log);
    expect(log).toHaveBeenLastCalledWith("offline download timing unavailable");
  });

  it("keeps installation available when resource observation is rejected", () => {
    const observer = mockObserver();
    observer.observe.mockImplementation(() => {
      throw new Error("unsupported entry type");
    });
    const log = vi.fn();
    expect(() => observeDownloadTimings(log)).not.toThrow();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(log).toHaveBeenLastCalledWith("offline download timing unavailable", { error: "unsupported entry type" });
  });

  it("logs response latency without consuming or replacing the response body", async () => {
    let now = 10;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const response = new Response("untouched", { headers: { "content-length": "9" } });
    const fetcher = vi.fn(async () => {
      now = 110;
      return response;
    });
    vi.stubGlobal("fetch", fetcher);
    const log = vi.fn();
    const request = new Request("https://app.test/asset");
    const result = await fetchWithDownloadLog(request, { priority: "low" }, log);
    expect(result).toBe(response);
    expect(result.bodyUsed).toBe(false);
    expect(fetcher).toHaveBeenCalledWith(request, { priority: "low" });
    expect(log).toHaveBeenLastCalledWith(
      "offline download response",
      expect.objectContaining({ url: "/asset", headersMs: 100, status: 200 }),
    );
    expect(await result.text()).toBe("untouched");
  });

  it("keeps fetch and cache failures intact and measures cache writes separately", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const error = new Error("connection lost");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        now += 50;
        throw error;
      }),
    );
    const log = vi.fn();
    await expect(fetchWithDownloadLog("https://app.test/asset", undefined, log)).rejects.toBe(error);
    expect(log).toHaveBeenLastCalledWith("offline download failed", {
      url: "/asset",
      elapsedMs: 50,
      error: "connection lost",
    });
    const put = vi.fn(async () => {
      now += 30;
    });
    const cache = { put } as unknown as Cache;
    const response = new Response("asset");
    await cacheWithDownloadLog(cache, "https://app.test/asset", response, log);
    expect(put).toHaveBeenCalledWith("https://app.test/asset", response);
    expect(log).toHaveBeenLastCalledWith("offline cache write complete", { url: "/asset", elapsedMs: 30 });
    put.mockRejectedValueOnce(error);
    await expect(cacheWithDownloadLog(cache, "https://app.test/asset", response, log)).rejects.toBe(error);
    expect(log).toHaveBeenLastCalledWith(
      "offline cache write failed",
      expect.objectContaining({ url: "/asset", error: "connection lost" }),
    );
  });
});
