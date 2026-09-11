/**
 * Download immutable build chunks into CacheStorage before assembling an asset.
 * CacheStorage survives service-worker termination; OPFS is not available there.
 */

type DownloadFetcher = (request: Request) => Promise<Response>;

type DownloadChunk = {
  encoding?: "gzip";
  sha256: string;
  sizeBytes: number;
  url: string;
};

type DownloadOptions = {
  /** Immutable build identity. A changed revision removes stale partial chunks. */
  revision?: string;
  /** Independently encoded pieces of the decoded asset. Required for resumption. */
  chunks?: readonly DownloadChunk[];
  /** Headers for the assembled asset, such as its original Content-Type. */
  headers?: HeadersInit;
  sizeBytes?: number;
  /** Called with decoded bytes present and the decoded total when known. */
  onBytes?: (loadedBytes: number, totalBytes?: number) => void;
};

type ResumableDownloaderOptions = {
  cacheName: string;
  fetcher?: DownloadFetcher;
  log?: (message: string, details?: Record<string, unknown>) => void;
  /** Maximum chunk requests for one asset. Defaults to four. */
  maxConcurrentChunks?: number;
};

type StoredManifest = {
  assetUrl: string;
  chunks: readonly DownloadChunk[];
  revision?: string;
  version: 1;
};

type ChunkMaterial = {
  body: Blob;
  headers: Headers;
};

type DirectMaterial = {
  body: ArrayBuffer;
  headers: Headers;
  status: number;
  statusText: string;
};
type DownloadMaterial = ChunkMaterial | DirectMaterial;

type ResumableDownloader = {
  download: (request: RequestInfo | URL, options?: DownloadOptions) => Promise<Response>;
  /**
   * Remove the temporary chunk set after the caller has stored the assembled
   * response in its destination cache. Calling this early loses restart safety.
   */
  release: (request: RequestInfo | URL) => Promise<void>;
};

const DEFAULT_MAX_CONCURRENT_CHUNKS = 4;
const KEY_PATH = "/__rom-weaver-resumable-download__";

const asRequest = (request: RequestInfo | URL) => (request instanceof Request ? request : new Request(request));

const assetUrlOf = (request: RequestInfo | URL) => asRequest(request).url;

const keyUrl = (assetUrl: string, kind: "manifest" | "chunk", index?: number) => {
  const key = new URL(KEY_PATH, assetUrl);
  key.searchParams.set("asset", assetUrl);
  key.searchParams.set("kind", kind);
  if (index !== undefined) key.searchParams.set("index", String(index));
  return key.href;
};

const manifestKey = (assetUrl: string) => keyUrl(assetUrl, "manifest");
const chunkKey = (assetUrl: string, index: number) => keyUrl(assetUrl, "chunk", index);

const isChunk = (value: unknown): value is DownloadChunk => {
  const chunk = value as Partial<DownloadChunk> | null;
  if (!chunk) return false;
  return (
    typeof chunk.url === "string" &&
    chunk.url.length > 0 &&
    typeof chunk.sizeBytes === "number" &&
    Number.isSafeInteger(chunk.sizeBytes) &&
    chunk.sizeBytes >= 0 &&
    typeof chunk.sha256 === "string" &&
    /^[0-9a-f]{64}$/i.test(chunk.sha256) &&
    (chunk.encoding === undefined || chunk.encoding === "gzip")
  );
};

const assertChunkPlan = (chunks: readonly DownloadChunk[]) => {
  if (!(chunks.every(isChunk) && Number.isSafeInteger(chunks.reduce((total, chunk) => total + chunk.sizeBytes, 0)))) {
    throw new Error("Offline chunk plan is invalid");
  }
};

const sameChunkPlan = (left: readonly DownloadChunk[], right: readonly DownloadChunk[]) =>
  left.length === right.length &&
  left.every(
    (chunk, index) =>
      chunk.url === right[index]?.url &&
      chunk.sizeBytes === right[index]?.sizeBytes &&
      chunk.sha256 === right[index]?.sha256 &&
      chunk.encoding === right[index]?.encoding,
  );

const isManifest = (value: unknown): value is StoredManifest => {
  const manifest = value as Partial<StoredManifest> | null;
  return (
    manifest?.version === 1 &&
    typeof manifest.assetUrl === "string" &&
    Array.isArray(manifest.chunks) &&
    manifest.chunks.every((chunk) => isChunk(chunk))
  );
};

const sha256Hex = async (bytes: ArrayBuffer) => {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const readBody = async (body: ReadableStream<Uint8Array> | null, onBytes?: (delta: number) => void) => {
  if (!body) return new ArrayBuffer(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      length += value.byteLength;
      onBytes?.(value.byteLength);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
};

const decodedChunkBytes = async (response: Response, chunk: DownloadChunk, onBytes?: (delta: number) => void) => {
  if (!response.ok) throw new Error(`Offline chunk download failed with HTTP ${response.status}: ${chunk.url}`);
  if (chunk.encoding === undefined) return readBody(response.body, onBytes);
  if (!response.body) throw new Error(`Offline chunk has no body: ${chunk.url}`);
  if (typeof DecompressionStream !== "function") throw new Error("This browser cannot decompress offline gzip chunks");
  return readBody(response.body.pipeThrough(new DecompressionStream("gzip")), onBytes);
};

const assertChunkBytes = async (bytes: ArrayBuffer, chunk: DownloadChunk) => {
  if (bytes.byteLength !== chunk.sizeBytes) {
    throw new Error(`Offline chunk size failed: ${chunk.url}: expected ${chunk.sizeBytes}, got ${bytes.byteLength}`);
  }
  const actualSha256 = await sha256Hex(bytes);
  if (actualSha256 !== chunk.sha256) {
    throw new Error(`Offline chunk checksum failed: ${chunk.url}: expected ${chunk.sha256}, got ${actualSha256}`);
  }
};

const hasStoredChunk = async (cache: Cache, key: string, chunk: DownloadChunk) => {
  const response = await cache.match(key);
  if (!response) return false;
  try {
    await assertChunkBytes(await response.arrayBuffer(), chunk);
    return true;
  } catch {
    await cache.delete(key);
    return false;
  }
};

const readManifest = async (cache: Cache, assetUrl: string) => {
  const response = await cache.match(manifestKey(assetUrl));
  if (!response) return undefined;
  try {
    const manifest: unknown = await response.json();
    return isManifest(manifest) && manifest.assetUrl === assetUrl ? manifest : undefined;
  } catch {
    return undefined;
  }
};

const isAssetKey = (request: Request, assetUrl: string) => {
  const key = new URL(request.url);
  return key.pathname === KEY_PATH && key.searchParams.get("asset") === assetUrl;
};

const removeAsset = async (cache: Cache, assetUrl: string) => {
  await Promise.all((await cache.keys()).filter((key) => isAssetKey(key, assetUrl)).map((key) => cache.delete(key)));
};

const cachedChunkBody = async (cache: Cache, key: string) => {
  const response = await cache.match(key);
  if (!response) throw new Error("Offline chunk disappeared before the assembled asset was returned");
  return response.arrayBuffer();
};

const createResumableDownloader = ({
  cacheName,
  fetcher = (request) => fetch(request),
  log,
  maxConcurrentChunks = DEFAULT_MAX_CONCURRENT_CHUNKS,
}: ResumableDownloaderOptions): ResumableDownloader => {
  const limit = Number.isSafeInteger(maxConcurrentChunks) && maxConcurrentChunks > 0 ? maxConcurrentChunks : 1;
  const inFlight = new Map<string, Promise<DownloadMaterial>>();

  const downloadChunks = async (request: Request, options: DownloadOptions, chunks: readonly DownloadChunk[]) => {
    assertChunkPlan(chunks);
    const assetUrl = request.url;
    const cache = await caches.open(cacheName);
    const previous = await readManifest(cache, assetUrl);
    if (!previous || previous.revision !== options.revision || !sameChunkPlan(previous.chunks, chunks)) {
      await removeAsset(cache, assetUrl);
      const manifest: StoredManifest = { assetUrl, chunks, revision: options.revision, version: 1 };
      await cache.put(manifestKey(assetUrl), Response.json(manifest));
    }

    const plannedChunks = chunks.map((chunk, index) => ({ chunk, key: chunkKey(assetUrl, index) }));
    const complete = await Promise.all(plannedChunks.map(({ chunk, key }) => hasStoredChunk(cache, key, chunk)));
    let loaded = plannedChunks.reduce((total, { chunk }, index) => total + (complete[index] ? chunk.sizeBytes : 0), 0);
    const total = chunks.reduce((sum, chunk) => sum + chunk.sizeBytes, 0);
    options.onBytes?.(loaded, total);

    let next = 0;
    let failure: unknown;
    const inFlightBytes = new Map<number, number>();
    const reportProgress = () => {
      const inFlight = [...inFlightBytes.values()].reduce((sum, bytes) => sum + bytes, 0);
      options.onBytes?.(loaded + inFlight, total);
    };
    const downloadChunk = async (index: number) => {
      const plannedChunk = plannedChunks[index];
      if (!plannedChunk) return;
      inFlightBytes.set(index, 0);
      try {
        const response = await fetcher(new Request(new URL(plannedChunk.chunk.url, request.url)));
        const bytes = await decodedChunkBytes(response, plannedChunk.chunk, (delta) => {
          inFlightBytes.set(index, (inFlightBytes.get(index) ?? 0) + delta);
          reportProgress();
        });
        await assertChunkBytes(bytes, plannedChunk.chunk);
        await cache.put(plannedChunk.key, new Response(bytes));
        inFlightBytes.delete(index);
        loaded += plannedChunk.chunk.sizeBytes;
      } catch (error) {
        inFlightBytes.delete(index);
        failure ??= error;
        reportProgress();
      }
    };
    const worker = async () => {
      for (;;) {
        if (failure) return;
        const index = next;
        next += 1;
        if (index >= chunks.length) return;
        if (complete[index]) continue;
        await downloadChunk(index);
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(limit, chunks.length) }, worker));
    if (failure) throw failure;
    const headers = new Headers(options.headers);
    if (!headers.has("content-length")) headers.set("content-length", String(total));
    const body = new Blob(await Promise.all(plannedChunks.map(({ key }) => cachedChunkBody(cache, key))));
    log?.("offline asset chunks ready", { assetUrl, chunks: chunks.length, sizeBytes: total });
    return { body, headers } satisfies ChunkMaterial;
  };

  const downloadDirect = async (request: Request, options: DownloadOptions) => {
    const response = await fetcher(request);
    if (!response.ok)
      return {
        body: await response.arrayBuffer(),
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      };
    const contentLength = response.headers.get("content-length");
    const total = options.sizeBytes ?? (contentLength === null ? Number.NaN : Number(contentLength));
    let loaded = 0;
    options.onBytes?.(loaded, Number.isFinite(total) && total >= 0 ? total : undefined);
    const body = await readBody(response.body, (delta) => {
      loaded += delta;
      options.onBytes?.(loaded, Number.isFinite(total) && total >= 0 ? total : undefined);
    });
    return {
      body,
      headers: new Headers(response.headers),
      status: response.status,
      statusText: response.statusText,
    } satisfies DirectMaterial;
  };

  const materialFor = (request: Request, options: DownloadOptions) =>
    options.chunks === undefined ? downloadDirect(request, options) : downloadChunks(request, options, options.chunks);

  const download = async (requestInfo: RequestInfo | URL, options: DownloadOptions = {}) => {
    const request = asRequest(requestInfo);
    if (request.method !== "GET") throw new Error("Offline downloads require a GET request");
    const assetKey = `${request.url}\n${options.revision ?? ""}\n${JSON.stringify(options.chunks ?? [])}`;
    let material = inFlight.get(assetKey);
    if (!material) {
      material = materialFor(request, options).finally(() => inFlight.delete(assetKey));
      inFlight.set(assetKey, material);
    }
    const ready = await material;
    if ("status" in ready) {
      return new Response(ready.body.slice(0), {
        headers: ready.headers,
        status: ready.status,
        statusText: ready.statusText,
      });
    }
    return new Response(ready.body, { headers: ready.headers });
  };

  return {
    download,
    async release(request: RequestInfo | URL) {
      const cache = await caches.open(cacheName);
      await removeAsset(cache, assetUrlOf(request));
    },
  };
};

export { createResumableDownloader, type DownloadChunk };
