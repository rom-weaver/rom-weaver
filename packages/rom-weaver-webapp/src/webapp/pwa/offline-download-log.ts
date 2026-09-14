type DownloadLog = (message: string, details?: Record<string, unknown>) => void;

const elapsedMs = (startedAt: number) => Math.round(performance.now() - startedAt);
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const requestPath = (request: Request | string) =>
  new URL(typeof request === "string" ? request : request.url).pathname;

const fetchWithDownloadLog = async (
  request: Request | string,
  init: RequestInit | undefined,
  log: DownloadLog,
): Promise<Response> => {
  const startedAt = performance.now();
  const url = requestPath(request);
  log("offline download started", { url, priority: init?.priority ?? "auto" });
  try {
    const response = await fetch(request, init);
    log("offline download response", {
      url,
      headersMs: elapsedMs(startedAt),
      status: response.status,
      contentLength: response.headers.get("content-length"),
      contentEncoding: response.headers.get("content-encoding"),
    });
    return response;
  } catch (error) {
    log("offline download failed", { url, elapsedMs: elapsedMs(startedAt), error: errorMessage(error) });
    throw error;
  }
};

const cacheWithDownloadLog = async (cache: Cache, request: Request | string, response: Response, log: DownloadLog) => {
  const startedAt = performance.now();
  const url = requestPath(request);
  log("offline cache write started", { url });
  try {
    await cache.put(request, response);
    log("offline cache write complete", { url, elapsedMs: elapsedMs(startedAt) });
  } catch (error) {
    log("offline cache write failed", { url, elapsedMs: elapsedMs(startedAt), error: errorMessage(error) });
    throw error;
  }
};

// Timing MUST come from the worker's network fetch, because page timings also include service-worker work.
// Transfer sizes follow https://www.w3.org/TR/resource-timing/#dom-performanceresourcetiming-transfersize.
const observeDownloadTimings = (log: DownloadLog) => {
  if (typeof PerformanceObserver === "undefined") {
    log("offline download timing unavailable");
    return;
  }
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.entryType !== "resource") continue;
      const timing = entry as PerformanceResourceTiming;
      const durationMs = timing.duration;
      const transferByteCount = timing.transferSize;
      log("offline download complete", {
        url: requestPath(timing.name),
        startMs: Math.round(timing.startTime),
        durationMs: Math.round(durationMs),
        headersMs: timing.responseStart > 0 ? Math.round(timing.responseStart - timing.startTime) : null,
        bodyMs: timing.responseStart > 0 ? Math.round(timing.responseEnd - timing.responseStart) : null,
        transferByteCount,
        encodedByteCount: timing.encodedBodySize,
        decodedByteCount: timing.decodedBodySize,
        transferMbps:
          transferByteCount > 0 && durationMs > 0
            ? Math.round(((transferByteCount * 8) / (durationMs * 1000)) * 100) / 100
            : null,
        httpCacheHit: transferByteCount === 0 && timing.decodedBodySize > 0,
        protocol: timing.nextHopProtocol,
      });
    }
  });
  try {
    observer.observe({ type: "resource", buffered: true });
    log("offline download timing enabled");
  } catch (error) {
    observer.disconnect();
    log("offline download timing unavailable", { error: errorMessage(error) });
  }
};

export { cacheWithDownloadLog, fetchWithDownloadLog, observeDownloadTimings };
