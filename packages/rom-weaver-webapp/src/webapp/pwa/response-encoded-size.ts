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
 * A response ready to cache with its wire size stamped on. Responses that
 * already carry a size - their own Content-Length, or a stamp from an earlier
 * pass - are returned untouched, so only the entries that would otherwise
 * report nothing pay the cost of being buffered.
 */
const withMeasuredEncodedSize = async (url: string, response: Response): Promise<Response> => {
  if (
    response.type === "opaque" ||
    !response.body ||
    response.headers.has(ENCODED_SIZE_HEADER) ||
    response.headers.has("content-length")
  )
    return response;
  const buffer = await response.arrayBuffer();
  // No content-encoding means the wire body was the stored body, so the read
  // size is the transfer size even when Resource Timing has nothing to say.
  const measured = encodedSizeOf(url) ?? (response.headers.has("content-encoding") ? undefined : buffer.byteLength);
  return bufferedResponse(response, buffer, measured);
};

export { bufferedResponse, ENCODED_SIZE_HEADER, encodedSizeOf, withMeasuredEncodedSize };
