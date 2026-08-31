/**
 * Wire-size bookkeeping for responses the service worker stores. Every cache
 * entry should be able to report what it cost to download, and the browser
 * throws that number away: a host that compresses on the fly answers chunked
 * with no Content-Length, so the encoded size is only ever visible in the
 * Resource Timing entry, which is gone by the next page load. Stamping it onto
 * the response at download time keeps it with the cached file.
 */

/** Header carrying the on-the-wire size of a response we downloaded ourselves. */
const ENCODED_SIZE_HEADER = "x-rom-weaver-encoded-size";

// Resource Timing keeps 250 entries by default and then silently records no
// more. One install fetches several hundred files through this worker, so the
// entries a measurement needs would be dropped long before the set is complete.
const RESOURCE_TIMING_BUFFER_SIZE = 1000;

/**
 * Keep Resource Timing recording for the life of the worker. Each measurement
 * is read immediately after its own fetch, so emptying a full buffer costs
 * nothing and makes room for the entries still to come.
 */
const keepResourceTimingsRecording = (scope: {
  addEventListener?: (type: string, listener: () => void) => void;
  performance?: Performance;
}) => {
  try {
    scope.performance?.setResourceTimingBufferSize?.(RESOURCE_TIMING_BUFFER_SIZE);
    scope.addEventListener?.("resourcetimingbufferfull", () => scope.performance?.clearResourceTimings?.());
  } catch {
    // Resource Timing is unavailable here; sizes fall back to the headers.
  }
};

/**
 * On-the-wire bytes the browser recorded for a just-completed same-origin
 * request. Zero (its value for an unmeasured entry) and a missing entry both
 * read as unknown. Callers MUST have read the response body first: the Resource
 * Timing entry only appears once the download finishes.
 */
const encodedSizeOf = (url: string): number | undefined => {
  try {
    const entries = performance.getEntriesByName?.(url, "resource");
    const encoded = (entries?.at(-1) as PerformanceResourceTiming | undefined)?.encodedBodySize;
    return typeof encoded === "number" && encoded > 0 ? encoded : undefined;
  } catch {
    // Resource Timing is unavailable in this worker; the size stays unknown.
    return undefined;
  }
};

/** A cacheable copy of a fully read response, keeping its headers and status. */
const bufferedResponse = (source: Response, buffer: ArrayBuffer, encodedBytes?: number) => {
  const headers = new Headers(source.headers);
  if (encodedBytes !== undefined) headers.set(ENCODED_SIZE_HEADER, String(encodedBytes));
  return new Response(buffer, { headers, status: source.status, statusText: source.statusText });
};

/**
 * A response ready to cache with its wire size stamped on. Only a compressed
 * response with no Content-Length needs one: every other entry can be measured
 * from what it is stored with, so it is returned untouched rather than read
 * into memory here.
 */
const withMeasuredEncodedSize = async (url: string, response: Response): Promise<Response> => {
  if (
    response.type === "opaque" ||
    !response.body ||
    response.headers.has(ENCODED_SIZE_HEADER) ||
    response.headers.has("content-length") ||
    !response.headers.has("content-encoding")
  )
    return response;
  const buffer = await response.arrayBuffer();
  return bufferedResponse(response, buffer, encodedSizeOf(url));
};

export { bufferedResponse, ENCODED_SIZE_HEADER, encodedSizeOf, keepResourceTimingsRecording, withMeasuredEncodedSize };
