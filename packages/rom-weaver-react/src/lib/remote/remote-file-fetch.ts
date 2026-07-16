/**
 * Fetch layer for URL-session sources. Downloads stream into OPFS and the
 * resulting disk-backed `File` enters the same pipeline as dropped files.
 * Cross-origin hosts must allow CORS; a blocked fetch surfaces as
 * `RemoteFetchError` with kind `blocked` so the UI can explain the host
 * requirement.
 */

import { browserVfs } from "../../platform/browser/workflow-runtime-vfs-cleanup.ts";
import { registerBrowserSourceCleanup } from "../../storage/browser/browser-source-primitives.ts";
import { joinVfsPath } from "../../storage/vfs/path.ts";
import { createVfsPathId } from "../../storage/vfs/path-id.ts";
import { createLogger } from "../logging.ts";

const logger = createLogger("remote-fetch");

/** Hard guard against unbounded remote storage consumption. */
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const OPFS_WRITE_CHUNK_SIZE = 8 * 1024 * 1024;

type RemoteFetchErrorKind = "blocked" | "http" | "too-large" | "aborted";

class RemoteFetchError extends Error {
  readonly kind: RemoteFetchErrorKind;
  readonly url: string;
  readonly status: number | null;

  constructor(kind: RemoteFetchErrorKind, url: string, message: string, status: number | null = null) {
    super(message);
    this.name = "RemoteFetchError";
    this.kind = kind;
    this.url = url;
    this.status = status;
  }
}

type RemoteFetchProgress = {
  loadedBytes: number;
  totalBytes: number | null;
};

type FetchRemoteFileOptions = {
  /** Fallback name when neither Content-Disposition nor the URL tail has one. */
  fallbackFileName?: string;
  maxBytes?: number;
  onProgress?: (progress: RemoteFetchProgress) => void;
  signal?: AbortSignal;
};

type RemoteFile = {
  cleanup: () => Promise<void>;
  file: File;
  filePath: string;
  finalUrl: string;
};

function fileNameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const starMatch = /filename\*\s*=\s*(?:utf-8''|UTF-8'')?([^;]+)/.exec(header);
  if (starMatch?.[1]) {
    try {
      const decoded = decodeURIComponent(starMatch[1].trim().replace(/^"|"$/g, ""));
      if (decoded) return decoded;
    } catch {
      // fall through to the plain filename= form
    }
  }
  const plainMatch = /filename\s*=\s*"?([^";]+)"?/.exec(header);
  const plain = plainMatch?.[1]?.trim();
  return plain || null;
}

function fileNameFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const tail = parsed.pathname.split("/").filter(Boolean).at(-1);
    if (!tail) return null;
    try {
      return decodeURIComponent(tail);
    } catch {
      return tail;
    }
  } catch {
    return null;
  }
}

function sanitizeFileName(name: string): string {
  const sanitized = name.replace(/[/\\]/g, "-").trim();
  return sanitized || "download.bin";
}

async function fetchRemoteFile(url: string, options: FetchRemoteFileOptions = {}): Promise<RemoteFile> {
  const { fallbackFileName, maxBytes = DEFAULT_MAX_BYTES, onProgress, signal } = options;
  logger.debug(`fetching remote file: ${url}`);
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      credentials: "omit",
      mode: "cors",
      signal,
    });
  } catch (error) {
    if (signal?.aborted) {
      throw new RemoteFetchError("aborted", url, "download aborted");
    }
    // A TypeError from fetch() is the CORS/network-failure shape.
    throw new RemoteFetchError(
      "blocked",
      url,
      `the host did not allow the download (CORS or network failure): ${String(error)}`,
    );
  }
  if (!response.ok) {
    throw new RemoteFetchError("http", url, `download failed with HTTP ${response.status}`, response.status);
  }

  const contentLengthRaw = response.headers.get("content-length");
  const parsedLength = contentLengthRaw === null ? Number.NaN : Number.parseInt(contentLengthRaw, 10);
  const totalBytes = Number.isFinite(parsedLength) && parsedLength >= 0 ? parsedLength : null;
  if (totalBytes !== null && totalBytes > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new RemoteFetchError("too-large", url, `download is ${totalBytes} bytes (limit ${maxBytes})`);
  }

  const fileName = sanitizeFileName(
    fileNameFromContentDisposition(response.headers.get("content-disposition")) ??
      fileNameFromUrl(response.url || url) ??
      fallbackFileName ??
      "download.bin",
  );

  const filePath = joinVfsPath(browserVfs.rootPath, "remote-fetch", `${createVfsPathId()}.bin`);
  let loadedBytes = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    await browserVfs.truncate(filePath, 0);
    const writeBufferLimit = Math.max(1, Math.min(OPFS_WRITE_CHUNK_SIZE, maxBytes));
    let writeBuffer: Uint8Array | undefined;
    let bufferedBytes = 0;
    let writtenBytes = 0;
    const assertNotAborted = () => {
      if (signal?.aborted) throw new RemoteFetchError("aborted", url, "download aborted");
    };
    const flush = async () => {
      if (!(writeBuffer && bufferedBytes)) return;
      assertNotAborted();
      await browserVfs.write(filePath, writeBuffer.subarray(0, bufferedBytes), { fileOffset: writtenBytes });
      writtenBytes += bufferedBytes;
      bufferedBytes = 0;
      assertNotAborted();
    };
    const growWriteBuffer = (requiredBytes: number) => {
      if (writeBuffer && writeBuffer.byteLength >= requiredBytes) return;
      const initialSize = totalBytes === null ? requiredBytes : Math.min(totalBytes, writeBufferLimit);
      const nextSize = Math.min(
        writeBufferLimit,
        Math.max(requiredBytes, initialSize, writeBuffer ? writeBuffer.byteLength * 2 : 0),
      );
      const next = new Uint8Array(nextSize);
      if (writeBuffer && bufferedBytes) next.set(writeBuffer.subarray(0, bufferedBytes));
      writeBuffer = next;
    };
    const bufferNetworkChunk = async (value: Uint8Array) => {
      assertNotAborted();
      const nextLoadedBytes = loadedBytes + value.byteLength;
      if (nextLoadedBytes > maxBytes) {
        throw new RemoteFetchError("too-large", url, `download exceeded the ${maxBytes} byte limit`);
      }
      loadedBytes = nextLoadedBytes;
      onProgress?.({ loadedBytes, totalBytes });
      let sourceOffset = 0;
      while (sourceOffset < value.byteLength) {
        if (writeBuffer && bufferedBytes === writeBuffer.byteLength) {
          if (writeBuffer.byteLength === writeBufferLimit) await flush();
          else growWriteBuffer(Math.min(writeBufferLimit, bufferedBytes + value.byteLength - sourceOffset));
        }
        growWriteBuffer(Math.min(writeBufferLimit, bufferedBytes + value.byteLength - sourceOffset));
        const availableBytes = (writeBuffer?.byteLength || 0) - bufferedBytes;
        const copyBytes = Math.min(availableBytes, value.byteLength - sourceOffset);
        writeBuffer?.set(value.subarray(sourceOffset, sourceOffset + copyBytes), bufferedBytes);
        bufferedBytes += copyBytes;
        sourceOffset += copyBytes;
        if (bufferedBytes === writeBufferLimit) await flush();
      }
    };
    const body = response.body;
    if (body) {
      reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (loadedBytes + value.byteLength > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new RemoteFetchError("too-large", url, `download exceeded the ${maxBytes} byte limit`);
        }
        await bufferNetworkChunk(value);
      }
    } else {
      // Compatibility fallback for fetch implementations without a ReadableStream body.
      // This branch must materialize the response once, but still stores the retained file in OPFS.
      const buffer = await response.arrayBuffer();
      await bufferNetworkChunk(new Uint8Array(buffer));
    }
    await flush();
    assertNotAborted();
    const storedFile = await browserVfs.getFile?.(filePath);
    if (!storedFile) throw new Error(`Remote download was not stored in browser OPFS: ${fileName}`);
    const file = new File([storedFile], fileName, {
      type: response.headers.get("content-type") || storedFile.type || "application/octet-stream",
    });
    // Keep the public File shape expected by drop routing while letting worker staging reuse the OPFS
    // path directly instead of registering another virtual file view of the same bytes.
    Object.defineProperty(file, "filePath", { value: filePath });
    const cleanup = registerBrowserSourceCleanup(file, () => browserVfs.remove(filePath));
    logger.debug(`fetched remote file: ${url} (${loadedBytes} bytes as ${fileName})`);
    return {
      cleanup,
      file,
      filePath,
      finalUrl: response.url || url,
    };
  } catch (error) {
    await reader?.cancel().catch(() => undefined);
    await browserVfs.remove(filePath).catch(() => undefined);
    if (signal?.aborted && !(error instanceof RemoteFetchError)) {
      throw new RemoteFetchError("aborted", url, "download aborted");
    }
    throw error;
  }
}

type RemoteFetchEntry = {
  url: string;
  fallbackFileName?: string;
  onProgress?: (progress: RemoteFetchProgress) => void;
};

/**
 * Fetch several sources concurrently; the first hard failure aborts the rest.
 */
async function fetchRemoteFiles(entries: readonly RemoteFetchEntry[], signal?: AbortSignal): Promise<RemoteFile[]> {
  if (signal?.aborted) {
    throw new RemoteFetchError("aborted", entries[0]?.url || "", "download aborted");
  }
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const downloads = entries.map((entry) =>
      fetchRemoteFile(entry.url, {
        fallbackFileName: entry.fallbackFileName,
        onProgress: entry.onProgress,
        signal: controller.signal,
      }),
    );
    try {
      return await Promise.all(downloads);
    } catch (error) {
      controller.abort();
      const settled = await Promise.allSettled(downloads);
      await Promise.all(
        settled.map((result) => (result.status === "fulfilled" ? result.value.cleanup() : Promise.resolve())),
      );
      throw error;
    }
  } finally {
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

export type { RemoteFetchEntry, RemoteFetchErrorKind };
export { fetchRemoteFiles, RemoteFetchError };
