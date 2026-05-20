import { WORKER_OPFS_MOUNTPOINT } from "../../shared/worker-storage/storage-layout.ts";

type HashProgressCallback = (loadedBytes: number, totalBytes: number) => void;

const HASH_CHUNK_SIZE = 1024 * 1024;
const WORKER_DIGEST_STREAM_CHUNK_SIZE = 16 * 1024 * 1024;
const ADLER32_MOD = 65521;
const IS_WORKER_SCOPE =
  (typeof self === "object" &&
    self === globalThis &&
    typeof (globalThis as { location?: { href?: unknown } }).location?.href === "string") ||
  typeof (globalThis as { importScripts?: unknown }).importScripts === "function";

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    table[i] = crc >>> 0;
  }
  return table;
})();

type ReadablePatchFileLike = {
  fileSize: number;
  fileName?: string;
  filePath?: string;
  _readViewOffset?: number;
  _readViewSource?: ReadablePatchFileLike;
  readIntoAt?: (
    buffer: ArrayBuffer | ArrayBufferView,
    bufferOffset?: number,
    len?: number,
    fileOffset?: number,
  ) => number;
  readBytesAt?: (offset: number, len: number) => Uint8Array | number[] | ArrayBuffer | ArrayBufferView;
  readU8At?: (offset: number) => number;
};

type PathChecksumSource = {
  fileName: string;
  filePath: string;
  fileSize: number;
  startOffset: number;
};

type BrowserChecksumProgress = {
  label: string;
  percent: number;
};

type BrowserChecksumWorkerClient = {
  reset: (err?: Error) => void;
  run: (
    input: {
      checksumAlgorithms?: string[];
      checksumStartOffset?: number;
      fileName?: string;
      filePath?: string;
      fileSize?: number;
      u8array?: Uint8Array;
    },
    onProgress?: (progress: BrowserChecksumProgress) => void,
  ) => Promise<{ md5?: string; sha1?: string }>;
  stream: (
    input: {
      checksumAlgorithms?: string[];
      checksumStartOffset?: number;
      fileName?: string;
      readChunk: (offset: number, chunkLength: number) => Promise<Uint8Array> | Uint8Array;
      streamTotalBytes: number;
    },
    onProgress?: (progress: BrowserChecksumProgress) => void,
  ) => Promise<{ md5?: string; sha1?: string }>;
};

let sharedWorkerScopeChecksumClient: BrowserChecksumWorkerClient | null = null;

const normalizeRange = (file: { fileSize: number }, start?: number, len?: number) => {
  const fileSize = typeof file.fileSize === "number" ? Math.max(0, Math.floor(file.fileSize)) : 0;
  const offset = typeof start === "number" && start > 0 ? Math.min(fileSize, Math.floor(start)) : 0;
  const available = fileSize - offset;
  const length = typeof len === "number" ? Math.max(0, Math.min(available, Math.floor(len))) : available;
  return { len: length, offset };
};

const reportProgress = (
  onProgress: HashProgressCallback | undefined,
  loaded: number,
  total: number,
  force?: boolean,
) => {
  if (typeof onProgress !== "function") return;
  if (force || loaded === 0 || loaded === total || loaded % HASH_CHUNK_SIZE === 0) onProgress(loaded, total);
};

const isWorkerUnavailableError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error || "");
  return /worker constructor is not available|worker support/i.test(message);
};

const isSharedChecksumWorkerPath = (filePath: string) =>
  typeof filePath === "string" && filePath.startsWith(WORKER_OPFS_MOUNTPOINT);

const getWorkerScopeChecksumClient = async (): Promise<BrowserChecksumWorkerClient> => {
  if (sharedWorkerScopeChecksumClient) return sharedWorkerScopeChecksumClient;
  const { createBrowserChecksumWorkerClient } = await import("../../protocol/checksum-worker.ts");
  sharedWorkerScopeChecksumClient = createBrowserChecksumWorkerClient();
  return sharedWorkerScopeChecksumClient;
};

const resetWorkerScopeChecksumClient = (error?: unknown) => {
  const nextError = error instanceof Error ? error : error ? new Error(String(error)) : undefined;
  sharedWorkerScopeChecksumClient?.reset(nextError);
  sharedWorkerScopeChecksumClient = null;
};

const readChunk = (file: ReadablePatchFileLike, offset: number, len: number, scratch: Uint8Array): Uint8Array => {
  if (typeof file.readBytesAt === "function") {
    const bytes = file.readBytesAt(offset, len);
    if (bytes instanceof Uint8Array) return bytes;
    if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    return Uint8Array.from(bytes);
  }
  if (typeof file.readIntoAt === "function") {
    const bytesRead = file.readIntoAt(scratch, 0, len, offset);
    return scratch.subarray(0, Math.max(0, bytesRead));
  }
  if (typeof file.readU8At === "function") {
    for (let i = 0; i < len; i++) scratch[i] = file.readU8At(offset + i) ?? 0;
    return scratch.subarray(0, len);
  }
  throw new Error("File does not support checksum reads");
};

const resolvePathSource = (file: ReadablePatchFileLike, offset: number, len: number): PathChecksumSource | null => {
  const readViewOffset = typeof file._readViewOffset === "number" ? Math.max(0, Math.floor(file._readViewOffset)) : 0;
  const readViewSource = file._readViewSource;
  const sourcePath = (() => {
    if (typeof file.filePath === "string" && file.filePath) return file.filePath;
    if (typeof readViewSource?.filePath === "string" && readViewSource.filePath) return readViewSource.filePath;
    return "";
  })();
  if (!sourcePath) return null;
  const fileName = (() => {
    if (typeof file.fileName === "string" && file.fileName) return file.fileName;
    if (typeof readViewSource?.fileName === "string" && readViewSource.fileName) return readViewSource.fileName;
    return "file.bin";
  })();
  return {
    fileName,
    filePath: sourcePath,
    fileSize: readViewOffset + offset + len,
    startOffset: readViewOffset + offset,
  };
};

const processChecksumChunks = (
  file: ReadablePatchFileLike,
  start: number | undefined,
  len: number | undefined,
  onProgress: HashProgressCallback | undefined,
  processChunk: (chunk: Uint8Array, loaded: number) => void,
) => {
  const range = normalizeRange(file, start, len);
  let loaded = 0;
  const scratch = new Uint8Array(Math.max(1, Math.min(HASH_CHUNK_SIZE, range.len || 1)));
  reportProgress(onProgress, 0, range.len, true);
  while (loaded < range.len) {
    const readLength = Math.min(scratch.byteLength, range.len - loaded);
    const chunk = readChunk(file, range.offset + loaded, readLength, scratch);
    if (!chunk.byteLength) break;
    processChunk(chunk, loaded);
    loaded += chunk.byteLength;
    reportProgress(onProgress, loaded, range.len);
  }
  reportProgress(onProgress, loaded, range.len, true);
  return loaded;
};

const computeCRC32 = async (
  file: ReadablePatchFileLike,
  start?: number,
  len?: number,
  onProgress?: HashProgressCallback,
): Promise<number> => {
  let crc = 0xffffffff;
  processChecksumChunks(file, start, len, onProgress, (chunk) => {
    for (let i = 0; i < chunk.byteLength; i++) crc = (crc >>> 8) ^ (CRC32_TABLE[(crc ^ (chunk[i] ?? 0)) & 0xff] ?? 0);
  });
  return (crc ^ 0xffffffff) >>> 0;
};

const computeAdler32 = async (
  file: ReadablePatchFileLike,
  start?: number,
  len?: number,
  onProgress?: HashProgressCallback,
): Promise<number> => {
  let a = 1;
  let b = 0;
  processChecksumChunks(file, start, len, onProgress, (chunk) => {
    for (let i = 0; i < chunk.byteLength; i++) {
      a = (a + (chunk[i] ?? 0)) % ADLER32_MOD;
      b = (b + a) % ADLER32_MOD;
    }
  });
  return ((b << 16) | a) >>> 0;
};

const materializeRange = (file: ReadablePatchFileLike, start?: number, len?: number): Uint8Array => {
  const range = normalizeRange(file, start, len);
  const output = new Uint8Array(range.len);
  if (!range.len) return output;
  const loaded = processChecksumChunks(file, start, len, undefined, (chunk, chunkOffset) => {
    output.set(chunk, chunkOffset);
  });
  return loaded === output.byteLength ? output : output.subarray(0, loaded);
};

const computeDigestHex = async (
  algorithm: "MD5" | "SHA-1",
  file: ReadablePatchFileLike,
  start?: number,
  len?: number,
): Promise<string> => {
  const hashAlgorithm = algorithm === "MD5" ? "md5" : "sha1";
  const range = normalizeRange(file, start, len);
  const fileName = typeof file.fileName === "string" && file.fileName ? file.fileName : "file.bin";

  if (IS_WORKER_SCOPE) {
    const pathSource = resolvePathSource(file, range.offset, range.len);
    const streamScratch = new Uint8Array(Math.max(1, Math.min(WORKER_DIGEST_STREAM_CHUNK_SIZE, range.len || 1)));
    const client = await getWorkerScopeChecksumClient();
    try {
      const result =
        pathSource && isSharedChecksumWorkerPath(pathSource.filePath)
          ? await client.run({
              checksumAlgorithms: [hashAlgorithm],
              checksumStartOffset: pathSource.startOffset,
              fileName: pathSource.fileName,
              filePath: pathSource.filePath,
              fileSize: pathSource.fileSize,
            })
          : await client.stream({
              checksumAlgorithms: [hashAlgorithm],
              checksumStartOffset: 0,
              fileName,
              readChunk: (offset, chunkLength) => readChunk(file, range.offset + offset, chunkLength, streamScratch),
              streamTotalBytes: range.len,
            });
      return hashAlgorithm === "md5" ? result.md5 || "" : result.sha1 || "";
    } catch (error) {
      resetWorkerScopeChecksumClient(error);
      if (!isWorkerUnavailableError(error)) throw error;
      const { runChecksumDirect } = await import("../checksum-worker-core.ts");
      const checksums = await runChecksumDirect({
        checksumAlgorithms: [hashAlgorithm],
        checksumStartOffset: 0,
        fileName,
        u8array: materializeRange(file, range.offset, range.len),
      });
      return hashAlgorithm === "md5" ? checksums.md5 || "" : checksums.sha1 || "";
    }
  }
  const { calculateChecksumsInBrowserWorker } = await import("../../protocol/checksum-worker.ts");
  const pathSource = resolvePathSource(file, range.offset, range.len);
  if (pathSource && isSharedChecksumWorkerPath(pathSource.filePath)) {
    const result = await calculateChecksumsInBrowserWorker({
      checksumAlgorithms: [hashAlgorithm],
      checksumStartOffset: pathSource.startOffset,
      fileName: pathSource.fileName,
      filePath: pathSource.filePath,
      fileSize: pathSource.fileSize,
    });
    return hashAlgorithm === "md5" ? result.checksums.md5 || "" : result.checksums.sha1 || "";
  }

  const { createBrowserOpfsSourceRef } = await import("../../protocol/browser-opfs-source-ref.ts");
  const bytes = materializeRange(file, range.offset, range.len);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const workerSource = await createBrowserOpfsSourceRef(new File([copy.buffer], fileName), fileName, {
    mountPoint: WORKER_OPFS_MOUNTPOINT,
    pathPrefix: "checksum-input",
  });
  try {
    const result = await calculateChecksumsInBrowserWorker({
      checksumAlgorithms: [hashAlgorithm],
      fileName: workerSource.fileName,
      filePath: workerSource.filePath,
      fileSize: workerSource.size,
    });

    return hashAlgorithm === "md5" ? result.checksums.md5 || "" : result.checksums.sha1 || "";
  } finally {
    await workerSource.cleanup().catch(() => undefined);
  }
};

const computeMD5 = (file: ReadablePatchFileLike, start?: number, len?: number) =>
  computeDigestHex("MD5", file, start, len);
const computeSHA1 = (file: ReadablePatchFileLike, start?: number, len?: number) =>
  computeDigestHex("SHA-1", file, start, len);

export type { ReadablePatchFileLike };
export { computeAdler32, computeCRC32, computeMD5, computeSHA1 };
