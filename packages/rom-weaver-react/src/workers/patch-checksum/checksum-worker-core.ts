import { createCRC32, createMD5, createSHA1 } from "hash-wasm";
import { getManagedOpfsFileHandle } from "../protocol/opfs-path.ts";
import type {
  ChecksumCompleteResponse,
  ChecksumDiagnostics,
  ChecksumErrorResponse,
  ChecksumProgressResponse,
  ChecksumWorkerRequest,
  WorkerScopeLike,
} from "../protocol/worker-protocol.ts";
import type { CoreRomPatchFileLike, PatchFileNameSize } from "../shared/binary/types.ts";
import PatchFile from "../shared/file-io/patch-file.ts";
import { hasNodeWorkerRuntimePathReadSupport, readNodeWorkerFileChunk } from "../shared/node-worker-runtime.ts";
import {
  getWorkerErrorMessage,
  postCloneSafeWorkerMessage,
  postWorkerLog,
  stampWorkerTransportMessage,
} from "../shared/worker-message-utils.ts";
import { createTimingFromStart, now } from "../shared/worker-timing.ts";

const HEX_DIGITS_REGEX = /^[0-9a-f]+$/i;

const CHECKSUM_CHUNK_SIZE = 16 * 1024 * 1024;
const MIN_CHECKSUM_CHUNK_SIZE = 256 * 1024;
const MAX_CHECKSUM_CHUNK_SIZE = 128 * 1024 * 1024;
const CHECKSUM_PROGRESS_MAX = 95;
const CRC16_POLYNOMIAL = 0x1021;
const ADLER32_MOD = 65521;

type HashWasmDigest = {
  digest(): Partial<{ adler32: number; crc16: number; crc32: number; md5: string; sha1: string }>;
  update(bytes: Uint8Array): void;
};
type HashWasmHasher = {
  digest(): string;
  init(): void;
  update(bytes: Uint8Array): void;
};

type ChecksumCalculationResult = {
  checksums: Partial<{
    adler32: number;
    crc16: number;
    crc32: number;
    md5: string;
    sha1: string;
  }>;
  diagnostics: ChecksumDiagnostics;
};

type PatchFileInstance = CoreRomPatchFileLike & PatchFileNameSize;
type WorkerErrorValue = Error | string | number | boolean | object | null | undefined;
type CachedChecksumValue = {
  checksums: ChecksumCalculationResult["checksums"];
  diagnostics?: ChecksumDiagnostics;
  rom: ChecksumCompleteResponse["rom"];
};
type FileChunkReader = (filePath: string, start: number, chunkLength: number) => Uint8Array;
type StreamingChecksumState = {
  algorithms: ChecksumAlgorithmSet;
  diagnostics: ChecksumDiagnostics;
  digestPromise: Promise<HashWasmDigest>;
  lastPercent: number;
  loaded: number;
  startedAt: number;
  startOffset: number;
  streamTotalBytes: number;
};

type RuntimeDiagnosticEvent = {
  context?: string;
  contextUrl?: string;
  id: string;
  kind: "wasm";
  name: string;
  reason: string;
  threaded: boolean;
  timestamp: number;
  url: string;
};

const workerScope = self as WorkerScopeLike<ChecksumWorkerRequest> & { __romWeaverWorkerKind?: "patch-checksum" };
workerScope.__romWeaverWorkerKind = "patch-checksum";

const checksumCache = new Map<string, CachedChecksumValue>();
const pendingChecksumCache = new Map<string, Promise<CachedChecksumValue>>();
const streamingChecksums = new Map<string, StreamingChecksumState>();
const warmHashWasmHashers: {
  crc32: HashWasmHasher[];
  md5: HashWasmHasher[];
  sha1: HashWasmHasher[];
} = {
  crc32: [],
  md5: [],
  sha1: [],
};
let runtimeDiagnosticSequence = 0;
const runtimeDiagnosticContextId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const getRuntimeDiagnosticContext = () => {
  const root = self as typeof self & {
    location?: { href?: string };
    name?: string;
    WorkerGlobalScope?: typeof WorkerGlobalScope;
  };
  const contextUrl = typeof root.location?.href === "string" ? root.location.href : undefined;
  const workerName = typeof root.name === "string" && root.name ? root.name : "";
  if (workerName) return { context: `worker:${workerName}#${runtimeDiagnosticContextId}`, contextUrl };
  if (typeof root.WorkerGlobalScope === "function" && root instanceof root.WorkerGlobalScope)
    return { context: `worker#${runtimeDiagnosticContextId}`, contextUrl };
  return { context: "unknown", contextUrl };
};

const emitRuntimeDiagnostic = (event: RuntimeDiagnosticEvent) => {
  try {
    if (typeof BroadcastChannel !== "function") return;
    const channel = new BroadcastChannel("rom-weaver-runtime-diagnostics");
    channel.postMessage(stampWorkerTransportMessage({ ...getRuntimeDiagnosticContext(), ...event }));
    channel.close();
  } catch (_err) {
    /* diagnostics should never affect checksum loading */
  }
};

const SEGA_GENESIS_HEADER_REGEX = /SEGA (GENESIS|MEGA DR)/;
const GAME_BOY_NINTENDO_LOGO = [
  0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0c, 0x00, 0x0d, 0x00, 0x08, 0x11,
  0x1f, 0x88, 0x89, 0x00, 0x0e, 0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99,
];

const getRomSystem = (binFile: PatchFileInstance) => {
  const extension = typeof binFile.getExtension === "function" ? binFile.getExtension().trim() : "";
  if (binFile.fileSize > 0x0200 && binFile.fileSize % 4 === 0) {
    if ((extension === "gb" || extension === "gbc") && binFile.fileSize % 0x4000 === 0) {
      binFile.seek(0x0104);
      let valid = true;
      for (let i = 0; i < GAME_BOY_NINTENDO_LOGO.length && valid; i++) {
        if (GAME_BOY_NINTENDO_LOGO[i] !== binFile.readU8()) valid = false;
      }
      if (valid) return "gb";
    } else if (extension === "md" || extension === "bin") {
      binFile.seek(0x0100);
      if (SEGA_GENESIS_HEADER_REGEX.test(binFile.readString(12))) return "smd";
    } else if (extension === "z64" && binFile.fileSize >= 0x400000) {
      return "n64";
    }
  } else if (extension === "fds" && binFile.fileSize % 65500 === 0) {
    return "fds";
  }
  return null;
};

const getRomAdditionalChecksum = (binFile: PatchFileInstance) => {
  if (getRomSystem(binFile) !== "n64") return null;
  binFile.seek(0x3c);
  const cartId = binFile.readString(3);
  binFile.seek(0x10);
  const crc = Array.from(binFile.readBytes(8)).reduce((hex: string, byte: number) => {
    if (byte < 16) return `${hex}0${byte.toString(16)}`;
    return hex + byte.toString(16);
  }, "");
  return `${cartId} (${crc})`;
};

const getCacheSourceKind = (data: ChecksumWorkerRequest): string => {
  if (data.fileHandle) return "opfs";
  if (data.filePath || data.benchmarkFilePath) return "path";
  return "blob";
};

const getCacheKey = (data: ChecksumWorkerRequest, size: number, lastModified?: number): string => {
  const components = [
    data.fileName || data.filePath || data.benchmarkFilePath || "",
    size,
    lastModified || 0,
    getCacheSourceKind(data),
    data.checksumStartOffset || 0,
    Array.isArray(data.checksumAlgorithms) ? data.checksumAlgorithms.join(",") : String(data.checksumAlgorithms || ""),
  ];
  return components.join("|");
};

const clampPercent = (percent: number): number => Math.max(0, Math.min(100, Math.floor(percent)));

const postProgress = (label: string, percent: number, requestId?: string): void => {
  const message: ChecksumProgressResponse = {
    action: "checksum-progress",
    progress: {
      label,
      percent: clampPercent(percent),
    },
    requestId,
    type: "progress",
    workerKind: "patch-checksum",
  };
  postCloneSafeWorkerMessage(workerScope, message);
};

const crc32HexToNumber = (crc32Hex: string): number => {
  if (!HEX_DIGITS_REGEX.test(crc32Hex)) throw new Error(`Invalid hash-wasm CRC32 result: ${crc32Hex}`);
  return parseInt(crc32Hex, 16) >>> 0;
};

type ChecksumAlgorithmSet = {
  adler32: boolean;
  crc16: boolean;
  crc32: boolean;
  md5: boolean;
  sha1: boolean;
};

const normalizeChecksumAlgorithms = (requestedAlgorithms: string[] | string | undefined): ChecksumAlgorithmSet => {
  const defaultAlgorithms = {
    adler32: false,
    crc16: false,
    crc32: true,
    md5: true,
    sha1: true,
  };
  if (requestedAlgorithms === undefined || requestedAlgorithms === null || requestedAlgorithms === "")
    return defaultAlgorithms;

  const values = Array.isArray(requestedAlgorithms)
    ? requestedAlgorithms
    : String(requestedAlgorithms)
        .split(",")
        .map((value) => value.trim());
  const algorithms = {
    adler32: false,
    crc16: false,
    crc32: false,
    md5: false,
    sha1: false,
  };
  for (const item of values) {
    const algorithm = String(item || "")
      .toLowerCase()
      .replace(/[-_]/g, "");
    if (algorithm === "adler32") algorithms.adler32 = true;
    else if (algorithm === "crc16") algorithms.crc16 = true;
    else if (algorithm === "crc32") algorithms.crc32 = true;
    else if (algorithm === "md5") algorithms.md5 = true;
    else if (algorithm === "sha1") algorithms.sha1 = true;
  }
  if (!(algorithms.adler32 || algorithms.crc16 || algorithms.crc32 || algorithms.md5 || algorithms.sha1))
    return defaultAlgorithms;
  return algorithms;
};

const getAlgorithmList = (algorithms: ChecksumAlgorithmSet): string[] => {
  const list: string[] = [];
  if (algorithms.adler32) list.push("adler32");
  if (algorithms.crc16) list.push("crc16");
  if (algorithms.crc32) list.push("crc32");
  if (algorithms.md5) list.push("md5");
  if (algorithms.sha1) list.push("sha1");
  return list;
};

const postChecksumTrace = (
  data: ChecksumWorkerRequest,
  message: string,
  details: Record<string, unknown> = {},
): void => {
  if (data.logLevel !== "trace") return;
  postWorkerLog(workerScope, data.requestId, "trace", "worker:checksum", message, {
    action: data.action,
    algorithms: getAlgorithmList(normalizeChecksumAlgorithms(data.checksumAlgorithms)),
    fileName: data.fileName,
    ...details,
  });
};

const createAdler32Digest = () => {
  let a = 1;
  let b = 0;
  return {
    digest: () => (((b << 16) | a) >>> 0) as number,
    update: (bytes: Uint8Array) => {
      for (let i = 0; i < bytes.byteLength; i++) {
        a = (a + (bytes[i] ?? 0)) % ADLER32_MOD;
        b = (b + a) % ADLER32_MOD;
      }
    },
  };
};

const createCrc16Digest = () => {
  let crc = 0xffff;
  return {
    digest: () => crc & 0xffff,
    update: (bytes: Uint8Array) => {
      for (let i = 0; i < bytes.byteLength; i++) {
        crc ^= (bytes[i] ?? 0) << 8;
        for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? (crc << 1) ^ CRC16_POLYNOMIAL : crc << 1;
      }
    },
  };
};

const acquireHashWasmHasher = async (
  algorithm: "crc32" | "md5" | "sha1",
): Promise<{ hasher: HashWasmHasher; loaded: boolean }> => {
  const warmed = warmHashWasmHashers[algorithm].pop();
  if (warmed) {
    warmed.init();
    return { hasher: warmed, loaded: false };
  }
  if (algorithm === "crc32") return { hasher: (await createCRC32()) as HashWasmHasher, loaded: true };
  if (algorithm === "md5") return { hasher: (await createMD5()) as HashWasmHasher, loaded: true };
  return { hasher: (await createSHA1()) as HashWasmHasher, loaded: true };
};

const releaseHashWasmHasher = (algorithm: "crc32" | "md5" | "sha1", hasher: HashWasmHasher | null): void => {
  if (!hasher) return;
  warmHashWasmHashers[algorithm].push(hasher);
};

const createHashWasmDigest = async (algorithms: ChecksumAlgorithmSet): Promise<HashWasmDigest> => {
  if ((algorithms.crc32 || algorithms.md5 || algorithms.sha1) && typeof WebAssembly === "undefined")
    throw new Error("WebAssembly is required for checksum calculation");
  try {
    const acquiredHashers = await Promise.all([
      algorithms.crc32 ? acquireHashWasmHasher("crc32") : Promise.resolve(null),
      algorithms.md5 ? acquireHashWasmHasher("md5") : Promise.resolve(null),
      algorithms.sha1 ? acquireHashWasmHasher("sha1") : Promise.resolve(null),
    ]);
    const loadedAlgorithms = getAlgorithmList({
      adler32: false,
      crc16: false,
      crc32: !!acquiredHashers[0]?.loaded,
      md5: !!acquiredHashers[1]?.loaded,
      sha1: !!acquiredHashers[2]?.loaded,
    });
    if (loadedAlgorithms.length) {
      emitRuntimeDiagnostic({
        id: `wasm:${Date.now()}:${++runtimeDiagnosticSequence}`,
        kind: "wasm",
        name: "hash-wasm",
        reason: loadedAlgorithms.join(","),
        threaded: false,
        timestamp: Date.now(),
        url: "hash-wasm",
      });
    }
    const adler32 = algorithms.adler32 ? createAdler32Digest() : null;
    const crc16 = algorithms.crc16 ? createCrc16Digest() : null;
    const crc32 = acquiredHashers[0]?.hasher || null;
    const md5 = acquiredHashers[1]?.hasher || null;
    const sha1 = acquiredHashers[2]?.hasher || null;
    let released = false;
    const releaseHashers = () => {
      if (released) return;
      released = true;
      releaseHashWasmHasher("crc32", crc32);
      releaseHashWasmHasher("md5", md5);
      releaseHashWasmHasher("sha1", sha1);
    };
    return {
      digest: () => {
        const result: Partial<{ adler32: number; crc16: number; crc32: number; md5: string; sha1: string }> = {};
        if (adler32) result.adler32 = adler32.digest();
        if (crc16) result.crc16 = crc16.digest();
        if (crc32) result.crc32 = crc32HexToNumber(crc32.digest());
        if (md5) result.md5 = md5.digest();
        if (sha1) result.sha1 = sha1.digest();
        releaseHashers();
        return result;
      },
      update: (bytes) => {
        adler32?.update(bytes);
        crc16?.update(bytes);
        crc32?.update(bytes);
        md5?.update(bytes);
        sha1?.update(bytes);
      },
    };
  } catch (err) {
    throw new Error(`Could not initialize hash-wasm checksum engine: ${getWorkerErrorMessage(err)}`);
  }
};

const warmupChecksumWasm = async (requestId: ChecksumWorkerRequest["requestId"]): Promise<void> => {
  try {
    const digest = await createHashWasmDigest(normalizeChecksumAlgorithms(undefined));
    digest.update(new Uint8Array(0));
    digest.digest();
    postCloneSafeWorkerMessage(workerScope, {
      action: "warmup-complete",
      requestId,
      success: true,
      type: "result",
      workerKind: "patch-checksum",
    });
  } catch (err) {
    const message = getWorkerErrorMessage(err);
    postCloneSafeWorkerMessage(workerScope, {
      action: "warmup-complete",
      code: "WORKER_FAILED",
      error: {
        code: "WORKER_FAILED",
        details: { requestId: String(requestId), workerKind: "patch-checksum" },
        message,
      },
      message,
      requestId,
      success: false,
      type: "error",
      workerKind: "patch-checksum",
    });
  }
};

const normalizeStartOffset = (startOffset: number | string | undefined, fileSize: number): number => {
  const parsed = typeof startOffset === "number" ? startOffset : parseInt(String(startOffset ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(fileSize, Math.floor(parsed));
};

const normalizeByteCount = (byteCount: number | string | undefined): number => {
  const parsed = typeof byteCount === "number" ? byteCount : parseInt(String(byteCount ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
};

const getChecksumProgressPercent = (loaded: number, checksumLength: number): number => {
  if (!checksumLength) return CHECKSUM_PROGRESS_MAX;
  if (loaded <= 0) return 0;
  if (loaded >= checksumLength) return CHECKSUM_PROGRESS_MAX;

  const rawPercent = Math.floor((loaded / checksumLength) * CHECKSUM_PROGRESS_MAX);
  return Math.max(1, rawPercent);
};

const getChecksumChunkSize = (requestedChunkSize: number | string | undefined): number => {
  const parsed =
    typeof requestedChunkSize === "number" ? requestedChunkSize : parseInt(String(requestedChunkSize ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return CHECKSUM_CHUNK_SIZE;
  return Math.max(MIN_CHECKSUM_CHUNK_SIZE, Math.min(MAX_CHECKSUM_CHUNK_SIZE, Math.floor(parsed)));
};

const calculateChunkedChecksums = async (
  checksumLength: number,
  readChunk: (offset: number, chunkLength: number) => Uint8Array | Promise<Uint8Array>,
  requestId?: string,
  chunkSize?: number | string,
  readMode?: string,
  algorithms?: ChecksumAlgorithmSet,
): Promise<ChecksumCalculationResult> => {
  const startedAt = now();
  const checksumAlgorithms = algorithms || normalizeChecksumAlgorithms(undefined);
  const diagnostics: ChecksumDiagnostics = {
    algorithms: getAlgorithmList(checksumAlgorithms),
    bytes: 0,
    chunks: 0,
    digestMs: 0,
    hasherInitMs: 0,
    readMode: readMode || "unknown",
    readMs: 0,
    totalMs: 0,
    updateMs: 0,
  };
  const hasherInitStartedAt = now();
  const digest = await createHashWasmDigest(checksumAlgorithms);
  diagnostics.hasherInitMs = now() - hasherInitStartedAt;
  const checksumChunkSize = getChecksumChunkSize(chunkSize);
  let lastPercent = -1;
  let loaded = 0;

  const reportProgress = () => {
    const roundedPercent = getChecksumProgressPercent(loaded, checksumLength);
    if (roundedPercent !== lastPercent) {
      lastPercent = roundedPercent;
      postProgress("Calculating checksums...", roundedPercent, requestId);
    }
  };

  postProgress("Calculating checksums...", 0, requestId);
  if (checksumLength > 0 && checksumLength <= checksumChunkSize) postProgress("Calculating checksums...", 1, requestId);
  for (let offset = 0; offset < checksumLength; offset += checksumChunkSize) {
    const chunkLength = Math.min(checksumChunkSize, checksumLength - offset);
    const readStartedAt = now();
    const bytes = await readChunk(offset, chunkLength);
    diagnostics.readMs += now() - readStartedAt;
    const updateStartedAt = now();
    digest.update(bytes);
    diagnostics.updateMs += now() - updateStartedAt;
    diagnostics.chunks++;
    diagnostics.bytes += bytes.byteLength;
    loaded += bytes.byteLength;
    reportProgress();
  }
  postProgress("Calculating checksums...", 95, requestId);
  const digestStartedAt = now();
  const checksums = digest.digest();
  diagnostics.digestMs = now() - digestStartedAt;
  diagnostics.totalMs = now() - startedAt;
  return { checksums, diagnostics };
};

const readBrowserFileChunk = async (file: Blob, start: number, end: number): Promise<Uint8Array> => {
  if (typeof FileReaderSync === "function") {
    const reader = new FileReaderSync();
    return new Uint8Array(reader.readAsArrayBuffer(file.slice(start, end)));
  }
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
};

const calculateFileChecksums = (
  file: Blob,
  startOffset: number,
  checksumLength: number,
  requestId?: string,
  chunkSize?: number | string,
  algorithms?: ChecksumAlgorithmSet,
) =>
  calculateChunkedChecksums(
    checksumLength,
    (offset, chunkLength) => {
      const chunkStart = startOffset + offset;
      return readBrowserFileChunk(file, chunkStart, chunkStart + chunkLength);
    },
    requestId,
    chunkSize,
    "blob-array-buffer",
    algorithms,
  );

const calculateOpfsChecksums = async (
  fileHandle: FileSystemFileHandle,
  startOffset: number,
  checksumLength: number,
  requestId?: string,
  chunkSize?: number | string,
  algorithms?: ChecksumAlgorithmSet,
) => {
  if (typeof fileHandle.createSyncAccessHandle !== "function") {
    throw new Error("OPFS SyncAccessHandle is not available for checksum calculation");
  }
  let accessHandle: FileSystemSyncAccessHandle;
  try {
    accessHandle = await fileHandle.createSyncAccessHandle();
  } catch (error) {
    const fileName = await fileHandle
      .getFile()
      .then((file) => file?.name || "")
      .catch(() => "");
    throw new Error(
      `OPFS checksum createSyncAccessHandle failed${fileName ? ` for ${fileName}` : ""}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  try {
    return await calculateChunkedChecksums(
      checksumLength,
      (offset, chunkLength) => {
        const buffer = new Uint8Array(chunkLength);
        const bytesRead = accessHandle.read(buffer, { at: startOffset + offset });
        return bytesRead === chunkLength ? buffer : buffer.subarray(0, bytesRead);
      },
      requestId,
      chunkSize,
      "opfs-sync-access-handle",
      algorithms,
    );
  } finally {
    accessHandle.close();
  }
};

const calculatePathChecksums = (
  filePath: string,
  startOffset: number,
  checksumLength: number,
  requestId?: string,
  chunkSize?: number | string,
  algorithms?: ChecksumAlgorithmSet,
) => {
  if (!hasNodeWorkerRuntimePathReadSupport()) {
    throw new Error("Filesystem-path checksum source is not available in this worker runtime");
  }
  return calculateChunkedChecksums(
    checksumLength,
    (offset, chunkLength) =>
      readNodeWorkerFileChunk(filePath, startOffset + offset, chunkLength) as ReturnType<FileChunkReader>,
    requestId,
    chunkSize,
    "node-file",
    algorithms,
  );
};

const calculateOpfsPathChecksums = async (
  filePath: string,
  startOffset: number,
  checksumLength: number,
  requestId?: string,
  chunkSize?: number | string,
  algorithms?: ChecksumAlgorithmSet,
) => {
  const fileHandle = await getManagedOpfsFileHandle(filePath, { navigatorObject: navigator });
  if (!fileHandle || typeof fileHandle.createSyncAccessHandle !== "function") {
    throw new Error("OPFS path checksum source is not available in this worker runtime");
  }
  let accessHandle: FileSystemSyncAccessHandle;
  try {
    accessHandle = await fileHandle.createSyncAccessHandle();
  } catch (error) {
    throw new Error(
      `OPFS path checksum createSyncAccessHandle failed for ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  try {
    return await calculateChunkedChecksums(
      checksumLength,
      (offset, chunkLength) => {
        const buffer = new Uint8Array(chunkLength);
        const bytesRead = accessHandle.read(buffer, { at: startOffset + offset });
        return bytesRead === chunkLength ? buffer : buffer.subarray(0, bytesRead);
      },
      requestId,
      chunkSize,
      "opfs-path-sync-access-handle",
      algorithms,
    );
  } finally {
    accessHandle.close();
  }
};

const getStreamKey = (data: ChecksumWorkerRequest): string => String(data.streamId ?? data.requestId ?? "");

const createStreamingDiagnostics = (algorithms: ChecksumAlgorithmSet): ChecksumDiagnostics => ({
  algorithms: getAlgorithmList(algorithms),
  bytes: 0,
  chunks: 0,
  digestMs: 0,
  hasherInitMs: 0,
  readMode: "decompression-stream",
  readMs: 0,
  totalMs: 0,
  updateMs: 0,
});

const postStreamingAck = (data: ChecksumWorkerRequest): void => {
  postCloneSafeWorkerMessage(workerScope, {
    action: data.action,
    requestId: data.requestId,
    success: true,
    type: "result",
    workerKind: "patch-checksum",
  });
};

const startStreamingChecksum = async (data: ChecksumWorkerRequest): Promise<void> => {
  const streamKey = getStreamKey(data);
  if (!streamKey) throw new Error("Checksum stream id was not provided");
  const algorithms = normalizeChecksumAlgorithms(data.checksumAlgorithms);
  const diagnostics = createStreamingDiagnostics(algorithms);
  const streamTotalBytes = normalizeByteCount(data.streamTotalBytes);
  const startOffset = normalizeByteCount(data.checksumStartOffset);
  postChecksumTrace(data, "checksum.stream.start", {
    startOffset,
    streamId: streamKey,
    streamTotalBytes,
  });
  const hasherInitStartedAt = now();
  const digestPromise = createHashWasmDigest(algorithms);
  digestPromise.then(() => {
    diagnostics.hasherInitMs = now() - hasherInitStartedAt;
  });
  streamingChecksums.set(streamKey, {
    algorithms,
    diagnostics,
    digestPromise,
    lastPercent: -1,
    loaded: 0,
    startedAt: now(),
    startOffset,
    streamTotalBytes,
  });
  postProgress("Calculating checksums...", 0, data.requestId);
  await digestPromise;
  postStreamingAck(data);
};

const updateStreamingProgress = (state: StreamingChecksumState, requestId?: string): void => {
  if (!state.streamTotalBytes) return;
  const roundedPercent = getChecksumProgressPercent(state.loaded, state.streamTotalBytes);
  if (roundedPercent === state.lastPercent) return;
  state.lastPercent = roundedPercent;
  postProgress("Calculating checksums...", roundedPercent, requestId);
};

const updateStreamingChecksum = async (data: ChecksumWorkerRequest): Promise<void> => {
  const streamKey = getStreamKey(data);
  const state = streamKey ? streamingChecksums.get(streamKey) : null;
  if (!state) throw new Error("Checksum stream was not started");
  if (!(data.u8array instanceof Uint8Array)) throw new Error("Checksum stream chunk was not provided");
  let bytes = data.u8array;
  let skippedBytes = 0;
  if (state.startOffset > 0) {
    const skipped = Math.min(state.startOffset, bytes.byteLength);
    state.startOffset -= skipped;
    skippedBytes = skipped;
    bytes = bytes.subarray(skipped);
  }
  if (bytes.byteLength > 0) {
    const digest = await state.digestPromise;
    const updateStartedAt = now();
    digest.update(bytes);
    state.diagnostics.updateMs += now() - updateStartedAt;
    state.diagnostics.chunks++;
    state.diagnostics.bytes += bytes.byteLength;
    state.loaded += bytes.byteLength;
    updateStreamingProgress(state, data.requestId);
  }
  postChecksumTrace(data, "checksum.stream.chunk", {
    algorithms: getAlgorithmList(state.algorithms),
    chunkBytes: data.u8array.byteLength,
    hashedBytes: bytes.byteLength,
    loadedBytes: state.loaded,
    skippedBytes,
    streamId: streamKey,
    streamTotalBytes: state.streamTotalBytes,
  });
  postStreamingAck(data);
};

const createChecksumCompleteMessage = ({
  cacheHit,
  checksums,
  data,
  diagnostics,
  rom,
  startedAt,
  startOffset,
  u8array,
}: {
  cacheHit?: boolean;
  checksums: ChecksumCalculationResult["checksums"];
  data: ChecksumWorkerRequest;
  diagnostics?: ChecksumDiagnostics;
  rom: ChecksumCompleteResponse["rom"];
  startedAt: number;
  startOffset: number;
  u8array?: Uint8Array;
}): ChecksumCompleteResponse => ({
  action: data.action && data.action !== "checksum" ? data.action : "checksum-complete",
  adler32: checksums.adler32,
  cacheHit,
  checksumStartOffset: startOffset,
  crc16: checksums.crc16,
  crc32: checksums.crc32,
  diagnostics,
  md5: checksums.md5,
  requestId: data.requestId,
  rom,
  sha1: checksums.sha1,
  timing: createTimingFromStart(startedAt),
  type: "result",
  u8array,
  workerKind: "patch-checksum",
});

const completeStreamingChecksum = async (data: ChecksumWorkerRequest): Promise<void> => {
  const streamKey = getStreamKey(data);
  const state = streamKey ? streamingChecksums.get(streamKey) : null;
  if (!state) throw new Error("Checksum stream was not started");
  streamingChecksums.delete(streamKey);
  postProgress("Calculating checksums...", 95, data.requestId);
  const digest = await state.digestPromise;
  const digestStartedAt = now();
  const checksums = digest.digest();
  state.diagnostics.digestMs = now() - digestStartedAt;
  state.diagnostics.totalMs = now() - state.startedAt;
  postChecksumTrace(data, "checksum.stream.finish", {
    algorithms: getAlgorithmList(state.algorithms),
    diagnostics: state.diagnostics,
    streamId: streamKey,
    streamTotalBytes: state.streamTotalBytes,
  });
  postCloneSafeWorkerMessage(
    workerScope,
    createChecksumCompleteMessage({
      checksums,
      data,
      diagnostics: state.diagnostics,
      rom: null,
      startedAt: state.startedAt,
      startOffset: normalizeByteCount(data.checksumStartOffset),
    }),
  );
};

const postChecksumError = (err: WorkerErrorValue, requestId?: string): void => {
  const failureMessage = getWorkerErrorMessage(err);
  const message: ChecksumErrorResponse = {
    action: "checksum-error",
    error: {
      code: "WORKER_FAILED",
      details: { requestId: String(requestId), workerKind: "patch-checksum" },
      message: failureMessage,
    },
    requestId,
    type: "error",
    workerKind: "patch-checksum",
  };
  postCloneSafeWorkerMessage(workerScope, message);
};

const postCachedChecksum = ({
  cacheKey,
  data,
  sourceSize,
}: {
  cacheKey: string;
  data: ChecksumWorkerRequest;
  sourceSize: number;
}): boolean => {
  if (!checksumCache.has(cacheKey)) return false;
  const cached = checksumCache.get(cacheKey);
  if (!cached) return false;
  postChecksumTrace(data, "checksum.cache.hit", {
    diagnostics: cached.diagnostics,
    sourceKind: getCacheSourceKind(data),
    sourceSize,
  });
  const message = createChecksumCompleteMessage({
    cacheHit: true,
    checksums: cached.checksums,
    data,
    diagnostics: cached.diagnostics,
    rom: cached.rom,
    startedAt: now(),
    startOffset: normalizeStartOffset(data.checksumStartOffset, sourceSize),
  });
  postCloneSafeWorkerMessage(workerScope, message);
  return true;
};

const postChecksumValue = ({
  cacheHit,
  data,
  sourceSize,
  startedAt,
  value,
}: {
  cacheHit?: boolean;
  data: ChecksumWorkerRequest;
  sourceSize: number;
  startedAt: number;
  value: CachedChecksumValue;
}): void => {
  postChecksumTrace(data, "checksum.calculate.finish", {
    cacheHit: !!cacheHit,
    diagnostics: value.diagnostics,
    sourceKind: getCacheSourceKind(data),
    sourceSize,
  });
  postProgress("Reading ROM info...", 97, data.requestId);
  const message = createChecksumCompleteMessage({
    cacheHit,
    checksums: value.checksums,
    data,
    diagnostics: value.diagnostics,
    rom: value.rom,
    startedAt,
    startOffset: normalizeStartOffset(data.checksumStartOffset, sourceSize),
  });
  postCloneSafeWorkerMessage(workerScope, message);
};

const calculateAndPostSourceChecksum = ({
  cacheKey,
  calculate,
  data,
  sourceSize,
}: {
  cacheKey: string;
  calculate: (startOffset: number, checksumLength: number) => Promise<ChecksumCalculationResult>;
  data: ChecksumWorkerRequest;
  sourceSize: number;
}) => {
  const startOffset = normalizeStartOffset(data.checksumStartOffset, sourceSize);
  const checksumLength = Math.max(0, sourceSize - startOffset);
  const startedAt = now();
  const pending = pendingChecksumCache.get(cacheKey);
  if (pending) {
    postChecksumTrace(data, "checksum.cache.pending", {
      checksumLength,
      sourceKind: getCacheSourceKind(data),
      sourceSize,
      startOffset,
    });
    return pending.then((value) => {
      postChecksumValue({ cacheHit: true, data, sourceSize, startedAt, value });
    });
  }
  postChecksumTrace(data, "checksum.calculate.start", {
    checksumChunkSize: getChecksumChunkSize(data.checksumChunkSize),
    checksumLength,
    sourceKind: getCacheSourceKind(data),
    sourceSize,
    startOffset,
  });
  const calculation = calculate(startOffset, checksumLength)
    .then((result) => {
      const value: CachedChecksumValue = {
        checksums: result.checksums,
        diagnostics: result.diagnostics,
        rom: null,
      };
      checksumCache.set(cacheKey, value);
      return value;
    })
    .finally(() => {
      if (pendingChecksumCache.get(cacheKey) === calculation) pendingChecksumCache.delete(cacheKey);
    });
  pendingChecksumCache.set(cacheKey, calculation);
  return calculation.then((value) => {
    postChecksumValue({ data, sourceSize, startedAt, value });
  });
};

const runChecksum = (data: ChecksumWorkerRequest): void => {
  const requestId = data.requestId;
  const algorithms = normalizeChecksumAlgorithms(data.checksumAlgorithms);

  if (data.action === "checksum-stream-start") {
    startStreamingChecksum(data).catch((err) => {
      postChecksumError(err, requestId);
    });
    return;
  }

  if (data.action === "checksum-stream-chunk") {
    updateStreamingChecksum(data).catch((err) => {
      postChecksumError(err, requestId);
    });
    return;
  }

  if (data.action === "checksum-stream-complete") {
    completeStreamingChecksum(data).catch((err) => {
      postChecksumError(err, requestId);
    });
    return;
  }

  const filePath = data.filePath || data.benchmarkFilePath;
  if (filePath) {
    const sourceSize = Math.max(0, Math.floor(Number(data.fileSize ?? data.benchmarkFileSize) || 0));
    const readMode = hasNodeWorkerRuntimePathReadSupport() ? "node-file" : "opfs-path-sync-access-handle";
    postChecksumTrace(data, "checksum.source.selected", {
      filePath,
      readMode,
      sourceKind: readMode === "node-file" ? "node-file-path" : "opfs-path",
      sourceSize,
    });
    const cacheKey = getCacheKey(data, sourceSize);
    if (postCachedChecksum({ cacheKey, data, sourceSize })) return;
    calculateAndPostSourceChecksum({
      cacheKey,
      calculate: (startOffset, checksumLength) =>
        hasNodeWorkerRuntimePathReadSupport()
          ? calculatePathChecksums(filePath, startOffset, checksumLength, requestId, data.checksumChunkSize, algorithms)
          : calculateOpfsPathChecksums(
              filePath,
              startOffset,
              checksumLength,
              requestId,
              data.checksumChunkSize,
              algorithms,
            ),
      data,
      sourceSize,
    }).catch((err) => {
      postChecksumError(err, requestId);
    });
    return;
  }

  if (data.fileHandle) {
    const fileHandle = data.fileHandle;
    fileHandle
      .getFile()
      .then((file) => {
        postChecksumTrace(data, "checksum.source.selected", {
          fileLastModified: file.lastModified,
          hasSyncAccessHandle: typeof fileHandle.createSyncAccessHandle === "function",
          sourceKind: "file-handle",
          sourceSize: file.size,
        });
        const cacheKey = getCacheKey(data, file.size, file.lastModified);
        if (postCachedChecksum({ cacheKey, data, sourceSize: file.size })) return;
        calculateAndPostSourceChecksum({
          cacheKey,
          calculate: (startOffset, checksumLength) =>
            calculateOpfsChecksums(
              fileHandle,
              startOffset,
              checksumLength,
              requestId,
              data.checksumChunkSize,
              algorithms,
            ),
          data,
          sourceSize: file.size,
        }).catch((err) => {
          postChecksumError(err, requestId);
        });
      })
      .catch((err) => {
        postChecksumError(err, requestId);
      });
    return;
  }

  if (data.file) {
    const sourceFile = data.file;
    postChecksumTrace(data, "checksum.source.selected", {
      fileLastModified: (sourceFile as File).lastModified,
      sourceKind: "blob",
      sourceSize: sourceFile.size,
    });
    const cacheKey = getCacheKey(data, sourceFile.size, (sourceFile as File).lastModified);
    if (postCachedChecksum({ cacheKey, data, sourceSize: sourceFile.size })) return;
    calculateAndPostSourceChecksum({
      cacheKey,
      calculate: (startOffset, checksumLength) =>
        calculateFileChecksums(sourceFile, startOffset, checksumLength, requestId, data.checksumChunkSize, algorithms),
      data,
      sourceSize: sourceFile.size,
    }).catch((err) => {
      postChecksumError(err, requestId);
    });
    return;
  }

  if (!(data.u8array instanceof Uint8Array)) throw new Error("Checksum source file was not provided");
  const sourceBytes = data.u8array;

  const binFile = new PatchFile(sourceBytes) as PatchFileInstance;
  binFile.fileName = data.fileName || "file.bin";
  const startOffset = normalizeStartOffset(data.checksumStartOffset, binFile.fileSize);
  const checksumLength = Math.max(0, binFile.fileSize - startOffset);
  const startedAt = now();
  postChecksumTrace(data, "checksum.source.selected", {
    sourceKind: "u8array",
    sourceSize: binFile.fileSize,
  });
  postChecksumTrace(data, "checksum.calculate.start", {
    checksumChunkSize: getChecksumChunkSize(data.checksumChunkSize),
    checksumLength,
    sourceKind: "u8array",
    sourceSize: binFile.fileSize,
    startOffset,
  });
  calculateChunkedChecksums(
    checksumLength,
    (offset, chunkLength) =>
      new Uint8Array(sourceBytes.buffer, sourceBytes.byteOffset + startOffset + offset, chunkLength),
    requestId,
    data.checksumChunkSize,
    "arraybuffer-view",
    algorithms,
  )
    .then((result) => {
      const checksums = result.checksums;
      postChecksumTrace(data, "checksum.calculate.finish", {
        cacheHit: false,
        diagnostics: result.diagnostics,
        sourceKind: "u8array",
        sourceSize: binFile.fileSize,
      });
      postProgress("Reading ROM info...", 97, requestId);
      const rom = getRomAdditionalChecksum(binFile);
      postCloneSafeWorkerMessage(
        workerScope,
        createChecksumCompleteMessage({
          checksums,
          data,
          diagnostics: result.diagnostics,
          rom,
          startedAt,
          startOffset,
          u8array: sourceBytes,
        }),
        { transfer: [sourceBytes.buffer as ArrayBuffer] },
      );
    })
    .catch((err) => {
      postChecksumError(err, requestId);
    });
};

const runChecksumDirect = async (
  data: Pick<ChecksumWorkerRequest, "checksumAlgorithms" | "checksumChunkSize" | "checksumStartOffset" | "fileName"> & {
    u8array: Uint8Array;
  },
) => {
  const algorithms = normalizeChecksumAlgorithms(data.checksumAlgorithms);
  const sourceBytes = data.u8array;
  const binFile = new PatchFile(sourceBytes) as PatchFileInstance;
  binFile.fileName = data.fileName || "file.bin";
  const startOffset = normalizeStartOffset(data.checksumStartOffset, binFile.fileSize);
  const checksumLength = Math.max(0, binFile.fileSize - startOffset);
  const result = await calculateChunkedChecksums(
    checksumLength,
    (offset, chunkLength) =>
      new Uint8Array(sourceBytes.buffer, sourceBytes.byteOffset + startOffset + offset, chunkLength),
    undefined,
    data.checksumChunkSize,
    "arraybuffer-view",
    algorithms,
  );
  return result.checksums;
};

export { getWorkerErrorMessage as getChecksumWorkerErrorMessage, runChecksum, runChecksumDirect, warmupChecksumWasm };
