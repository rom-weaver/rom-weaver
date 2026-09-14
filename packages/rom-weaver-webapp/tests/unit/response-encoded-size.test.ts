import { describe, expect, it, vi } from "vitest";
import {
  createCachedTransferSizeReader,
  ENCODED_SIZE_HEADER,
  keepResourceTimingsRecording,
  withMeasuredEncodedSize,
} from "../../src/webapp/pwa/response-encoded-size.ts";

const URL_UNDER_TEST = "https://example.test/index.html";

describe("cached transfer sizes", () => {
  it("reads measured compressed size without consuming or repeatedly fetching the cached body", async () => {
    const response = new Response("decoded body", {
      headers: {
        "content-encoding": "br",
        "content-length": "7",
        [ENCODED_SIZE_HEADER]: "5",
      },
    });
    const match = vi.fn(async () => response);
    const cache = { match } as unknown as Cache;
    const sizes = createCachedTransferSizeReader();
    expect(await sizes.read(cache, URL_UNDER_TEST, 12)).toBe(5);
    expect(await sizes.read(cache, URL_UNDER_TEST, 12)).toBe(5);
    expect(match).toHaveBeenCalledOnce();
    expect(response.bodyUsed).toBe(false);
    sizes.forget(URL_UNDER_TEST);
    match.mockResolvedValue(new Response("updated", { headers: { "content-length": "3" } }));
    expect(await sizes.read(cache, URL_UNDER_TEST, 7)).toBe(3);
  });

  it("keeps unknown compressed sizes distinct from identity sizes and real zero bytes", async () => {
    const sizes = createCachedTransferSizeReader();
    const match = vi.fn(async () => new Response("body", { headers: { "content-encoding": "br" } }));
    const cache = { match } as unknown as Cache;
    expect(await sizes.read(cache, "compressed", 400)).toBeNull();
    match.mockResolvedValue(new Response("body"));
    expect(await sizes.read(cache, "identity", 400)).toBe(400);
    expect(await sizes.read(cache, "unknown")).toBeNull();
    match.mockResolvedValue(new Response(null, { headers: { "content-length": "0" } }));
    expect(await sizes.read(cache, "empty", 400)).toBe(0);
    match.mockRejectedValue(new Error("cache unavailable"));
    expect(await sizes.read(cache, "failed", 400)).toBeNull();
  });
});

describe("withMeasuredEncodedSize", () => {
  it("leaves a response the caches can already measure untouched", async () => {
    const cases = [
      new Response("body", { headers: { "content-length": "4" } }),
      new Response("body"),
      new Response("body", { headers: { "content-encoding": "br", [ENCODED_SIZE_HEADER]: "2" } }),
    ];
    for (const response of cases) {
      expect(await withMeasuredEncodedSize(URL_UNDER_TEST, response)).toBe(response);
    }
  });

  it("keeps the body, status, and headers of a compressed response it measures", async () => {
    const response = new Response("compressed-body", {
      headers: { "content-encoding": "br", "content-type": "text/html" },
      status: 203,
      statusText: "Transformed",
    });

    const measured = await withMeasuredEncodedSize(URL_UNDER_TEST, response);

    expect(measured).not.toBe(response);
    expect(await measured.text()).toBe("compressed-body");
    expect(measured.status).toBe(203);
    expect(measured.statusText).toBe("Transformed");
    expect(measured.headers.get("content-type")).toBe("text/html");
  });

  it("stamps the size Resource Timing recorded for the download", async () => {
    const entry = { encodedBodySize: 512 } as PerformanceResourceTiming;
    vi.spyOn(performance, "getEntriesByName").mockReturnValue([entry]);

    const measured = await withMeasuredEncodedSize(
      URL_UNDER_TEST,
      new Response("compressed-body", { headers: { "content-encoding": "gzip" } }),
    );

    expect(measured.headers.get(ENCODED_SIZE_HEADER)).toBe("512");
    vi.restoreAllMocks();
  });

  it("leaves a compressed response unstamped rather than reporting its decoded size", async () => {
    const measured = await withMeasuredEncodedSize(
      URL_UNDER_TEST,
      new Response("compressed-body", { headers: { "content-encoding": "br" } }),
    );

    expect(measured.headers.has(ENCODED_SIZE_HEADER)).toBe(false);
  });
});

describe("keepResourceTimingsRecording", () => {
  it("raises the buffer and empties it when it fills", () => {
    const listeners: Record<string, () => void> = {};
    const clearResourceTimings = vi.fn();
    const setResourceTimingBufferSize = vi.fn();

    keepResourceTimingsRecording({
      addEventListener: (type: string, listener: () => void) => {
        listeners[type] = listener;
      },
      performance: { clearResourceTimings, setResourceTimingBufferSize } as unknown as Performance,
    });
    listeners.resourcetimingbufferfull?.();

    expect(setResourceTimingBufferSize).toHaveBeenCalledWith(1000);
    expect(clearResourceTimings).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the worker has no Resource Timing", () => {
    expect(() => keepResourceTimingsRecording({})).not.toThrow();
  });
});
