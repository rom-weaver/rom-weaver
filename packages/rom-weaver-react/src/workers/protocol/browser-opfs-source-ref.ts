import { emitTraceLog } from "../../lib/logging.ts";
import { getBrowserSourceBlob, getBrowserSourceHandle } from "../../storage/browser/browser-source-primitives.ts";
import {
  getNamedSource,
  getNamedSourceFileName,
  getNamedSourceSize,
} from "../../storage/shared/binary/source-file-utils.ts";
import type { LogRecord } from "../../types/logging.ts";
import type { WorkerStorageBucket } from "../shared/worker-storage/storage-layout.ts";
import { getWorkerStorageBucketPath, WORKER_OPFS_MOUNTPOINT } from "../shared/worker-storage/storage-layout.ts";
import { requestBrowserOpfsStorage } from "./browser-opfs-worker-client.ts";
import { registerBrowserVirtualFile } from "./browser-virtual-files.ts";
import { getManagedOpfsFileHandle } from "./opfs-path.ts";

type BrowserOpfsSourceRef = {
  cleanup: () => Promise<void>;
  fileName: string;
  filePath: string;
  kind: "path";
  size?: number;
  storageKind: "opfs";
  virtual?: boolean;
};
type BrowserOpfsSourceTraceContext = {
  logLevel?: string;
  onLog?: (record: Pick<LogRecord, "details" | "level" | "message" | "namespace" | "timestamp">) => void;
};
type BrowserOpfsSourceRefOptions = {
  bucket?: WorkerStorageBucket;
  mountPoint: string;
  pathPrefix: string;
  trace?: BrowserOpfsSourceTraceContext;
};

const isFileLike = (source: unknown): source is File =>
  typeof File !== "undefined" && source instanceof File && typeof source.slice === "function";

const getRecordValue = (source: unknown, key: string) =>
  source && typeof source === "object" ? (source as Record<string, unknown>)[key] : undefined;

const getStringRecordValue = (source: unknown, key: string) => {
  const value = getRecordValue(source, key);
  return typeof value === "string" && value.trim() ? value : "";
};

const toFileLike = (source: Blob, fileName: string): File => {
  if (isFileLike(source)) return source;
  if (typeof File !== "function") throw new Error("Browser worker Blob inputs require File support");
  return new File([source], fileName || "input.bin", {
    lastModified:
      typeof (source as Blob & { lastModified?: unknown }).lastModified === "number"
        ? (source as Blob & { lastModified: number }).lastModified
        : undefined,
    type: source.type || "application/octet-stream",
  });
};

const LEADING_DOTS_REGEX = /^\.+/;
const PATH_SEPARATOR_REGEX = /[\\/]+/g;
// Strips C0 control characters and DEL from file names. Built via String.fromCharCode so the control
// characters never appear as a regex literal (lint/suspicious/noControlCharactersInRegex forbids that);
// the compiled pattern is identical to the original control-character class.
const CONTROL_FILE_CHARS_REGEX = new RegExp(
  `[${String.fromCharCode(0x00)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]+`,
  "g",
);
const NON_ASCII_CHARS_REGEX = /[^\x20-\x7e]+/g;
const RESERVED_FILE_CHARS_REGEX = /[:*?"<>|]+/g;
const EDGE_WHITESPACE_OR_UNDERSCORES_REGEX = /^[_\s]+|[_\s]+$/g;
const TRAILING_SLASHES_REGEX = /\/+$/;
const allocatedVirtualInputPaths = new Set<string>();
// Smallest collision suffix still available per normalized file name. This only ever advances, so a
// freed path is never handed back out: re-staging a same-named source (e.g. uploading the same
// archive again to pick a different entry) always lands on a brand-new path. Reusing a freed path
// races a prior instance whose OPFS access handle may still be open, which fails the next
// createSyncAccessHandle with "Access Handles cannot be created ... another open Access Handle".
const nextVirtualInputPathSuffix = new Map<string, number>();
// Inputs at or below this size are copied into OPFS up front; larger inputs stay on the zero-copy
// virtual-Blob path. See the trade-off note at the use site in createBrowserOpfsSourceRef.
const STAGE_INPUT_TO_OPFS_MAX_BYTES = 400 * 1024 * 1024;

// Reference-counted registry of inputs already staged into OPFS this session, keyed by a content
// signature (mount + normalized name + size + a head/tail byte fingerprint). Re-staging an identical
// source — e.g. re-uploading the same archive to pick a different entry — reuses the existing staged
// file instead of writing a second copy under a "-N" suffix, so the input keeps its name and we skip
// the re-stage I/O. The staged file lives until the last reference releases. A same-named file with
// different bytes produces a different fingerprint, misses here, and still lands on a fresh suffixed
// path (see allocateVirtualInputPath). The fingerprint samples the head and tail rather than hashing
// the whole input, so the residual false-reuse case (same name + size + sampled regions, differing
// only in the middle) is astronomically unlikely for real archives and never seen in practice.
type StagedInputEntry = {
  allocatedPath: string;
  refCount: number;
  result: Promise<{ size?: number; stagedPath: string }>;
};
const stagedInputsByContentKey = new Map<string, StagedInputEntry>();

const STAGED_INPUT_KEY_SEPARATOR = String.fromCharCode(0x00);
const STAGED_INPUT_FINGERPRINT_SAMPLE_BYTES = 64 * 1024;

// FNV-1a over a byte sample. Cheap (a few KiB read), and only used to tell same-named inputs apart, so
// reuse never hands one input the bytes of another.
const hashStageSampleBytes = (bytes: Uint8Array, seed: number) => {
  let hash = seed >>> 0;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash >>> 0;
};

const fingerprintStageSource = async (source: Blob) => {
  const size = source.size;
  const headEnd = Math.min(size, STAGED_INPUT_FINGERPRINT_SAMPLE_BYTES);
  let hash = hashStageSampleBytes(new Uint8Array(await source.slice(0, headEnd).arrayBuffer()), 0x811c9dc5);
  if (size > STAGED_INPUT_FINGERPRINT_SAMPLE_BYTES * 2) {
    const tail = new Uint8Array(await source.slice(size - STAGED_INPUT_FINGERPRINT_SAMPLE_BYTES, size).arrayBuffer());
    hash = hashStageSampleBytes(tail, hash);
  }
  return hash.toString(16);
};

const createStagedInputContentKey = (mountPoint: string, fileName: string, size: number, fingerprint: string) =>
  [mountPoint, fileName, size, fingerprint].join(STAGED_INPUT_KEY_SEPARATOR);

const getBrowserSourceTraceKind = (source: unknown) => {
  if (typeof File !== "undefined" && source instanceof File) return "file";
  if (typeof Blob !== "undefined" && source instanceof Blob) return "blob";
  if (source instanceof Uint8Array) return "uint8array";
  if (source instanceof ArrayBuffer) return "arraybuffer";
  if (
    source &&
    typeof source === "object" &&
    "getFile" in source &&
    typeof (source as { getFile?: unknown }).getFile === "function"
  )
    return "file-handle";
  if (typeof source === "string") return "path-string";
  if (source && typeof source === "object") return "object";
  return typeof source;
};

const emitBrowserSourceRefTrace = (
  trace: BrowserOpfsSourceTraceContext | undefined,
  message: string,
  details?: Record<string, unknown>,
) =>
  emitTraceLog(
    {
      logLevel: trace?.logLevel,
      namespace: "runtime:browser-opfs-source-ref",
      onLog: trace?.onLog,
    },
    message,
    details || {},
  );

const normalizeVirtualFileName = (fileName: string | null | undefined, fallback = "input.bin") =>
  String(fileName || fallback)
    .replace(PATH_SEPARATOR_REGEX, "_")
    .replace(CONTROL_FILE_CHARS_REGEX, "_")
    .replace(NON_ASCII_CHARS_REGEX, "_")
    .replace(RESERVED_FILE_CHARS_REGEX, "_")
    .replace(LEADING_DOTS_REGEX, "")
    .replace(EDGE_WHITESPACE_OR_UNDERSCORES_REGEX, "") || fallback;

const splitVisibleFileName = (fileName: string) => {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0) return { extension: "", stem: fileName };
  return {
    extension: fileName.slice(dotIndex),
    stem: fileName.slice(0, dotIndex),
  };
};

const createVisibleCollisionFileName = (fileName: string, suffixIndex: number) => {
  if (suffixIndex <= 1) return fileName;
  const { extension, stem } = splitVisibleFileName(fileName);
  return `${stem}-${suffixIndex}${extension}`;
};

const allocateVirtualInputPath = (mountPoint: string, fileName: string) => {
  const normalizedMountPoint = String(mountPoint || WORKER_OPFS_MOUNTPOINT).replace(TRAILING_SLASHES_REGEX, "");
  const startSuffix = nextVirtualInputPathSuffix.get(fileName) ?? 1;
  for (let suffixIndex = startSuffix; suffixIndex < Number.MAX_SAFE_INTEGER; suffixIndex += 1) {
    const candidateName = createVisibleCollisionFileName(fileName, suffixIndex);
    const candidatePath = getWorkerStorageBucketPath(normalizedMountPoint, "input", candidateName, candidateName);
    if (allocatedVirtualInputPaths.has(candidatePath)) continue;
    allocatedVirtualInputPaths.add(candidatePath);
    nextVirtualInputPathSuffix.set(fileName, suffixIndex + 1);
    return candidatePath;
  }
  throw new Error(`Unable to allocate browser input path for ${fileName}`);
};

const releaseVirtualInputPath = (filePath: string) => {
  allocatedVirtualInputPaths.delete(filePath);
};

const reuseStagedInput = async (
  contentKey: string,
  fileName: string,
  trace: BrowserOpfsSourceTraceContext | undefined,
) => {
  const entry = stagedInputsByContentKey.get(contentKey);
  if (!entry) return null;
  // Reserve our reference before awaiting the in-flight stage so an overlapping release can't tear the
  // entry down to zero and delete the staged file while we wait on it.
  entry.refCount += 1;
  const result = await entry.result.then(
    (value) => value,
    () => null,
  );
  if (result && stagedInputsByContentKey.get(contentKey) === entry) {
    emitBrowserSourceRefTrace(trace, "reused staged input", {
      fileName,
      filePath: result.stagedPath,
      refCount: entry.refCount,
      size: result.size,
    });
    return result;
  }
  // The stage this entry tracked failed, or it was torn down while we awaited — undo the reservation
  // and let the caller fall through to a fresh stage.
  entry.refCount -= 1;
  return null;
};

const releaseStagedInput = async (contentKey: string, trace: BrowserOpfsSourceTraceContext | undefined) => {
  const entry = stagedInputsByContentKey.get(contentKey);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount > 0) return;
  // Drop the registry entry before the async OPFS removal so a concurrent re-stage misses the registry
  // and allocates a fresh suffixed path instead of reusing a file mid-teardown. The allocated path
  // stays reserved until removal completes, so the fresh stage can't reclaim the same path either.
  stagedInputsByContentKey.delete(contentKey);
  const resolved = await entry.result.then(
    (value) => value,
    () => null,
  );
  const stagedPath = resolved?.stagedPath ?? entry.allocatedPath;
  const cleanedUp = await requestBrowserOpfsStorage({ action: "cleanup", filePaths: [stagedPath] }).then(
    (value) => value.success,
    () => false,
  );
  releaseVirtualInputPath(entry.allocatedPath);
  emitBrowserSourceRefTrace(trace, "released staged input", {
    filePath: stagedPath,
    success: cleanedUp,
  });
};

const createVirtualInputPath = (options: BrowserOpfsSourceRefOptions, fileName: string) => {
  const mountPoint = String(options.mountPoint || WORKER_OPFS_MOUNTPOINT).replace(TRAILING_SLASHES_REGEX, "");
  const normalizedFileName = normalizeVirtualFileName(fileName);
  return allocateVirtualInputPath(mountPoint, normalizedFileName);
};

const getOpfsPathSize = async (
  filePath: string,
  trace?: BrowserOpfsSourceTraceContext,
): Promise<number | undefined> => {
  try {
    const handle = await getManagedOpfsFileHandle(filePath, { navigatorObject: navigator, trace });
    const file = await handle?.getFile();
    return typeof file?.size === "number" ? file.size : undefined;
  } catch (_error) {
    return undefined;
  }
};

const createBrowserOpfsSourceRef = async (
  source: unknown,
  fallbackFileName: string,
  options: BrowserOpfsSourceRefOptions,
): Promise<BrowserOpfsSourceRef> => {
  const directSource = getNamedSource(source as Parameters<typeof getNamedSource>[0]);
  const fileName = getNamedSourceFileName(source as Parameters<typeof getNamedSource>[0], {
    fallback: fallbackFileName,
  });
  const sizeHint = getNamedSourceSize(source as Parameters<typeof getNamedSourceSize>[0]);
  emitBrowserSourceRefTrace(options.trace, "create source ref started", {
    directSourceKind: getBrowserSourceTraceKind(directSource),
    fallbackFileName,
    fileName,
    pathPrefix: options.pathPrefix,
    sizeHint,
    sourceKind: getBrowserSourceTraceKind(source),
  });
  const filePath =
    (typeof directSource === "string" && directSource.trim() ? directSource : "") ||
    getStringRecordValue(directSource, "filePath") ||
    getStringRecordValue(source, "filePath");
  if (filePath) {
    emitBrowserSourceRefTrace(options.trace, "using existing OPFS path source", {
      fileName,
      filePath,
      sizeHint,
    });
    return {
      cleanup: async () => undefined,
      fileName,
      filePath,
      kind: "path",
      size: sizeHint ?? (await getOpfsPathSize(filePath, options.trace)),
      storageKind: "opfs",
    };
  }
  const fileHandle = getBrowserSourceHandle(directSource) || getBrowserSourceHandle(source);
  const blob = getBrowserSourceBlob(directSource) || getBrowserSourceBlob(source);
  let virtualSource: Blob | null = null;
  let virtualSize = sizeHint ?? undefined;
  if (fileHandle) {
    const sourceFile = await fileHandle.getFile();
    virtualSource = toFileLike(sourceFile, fileName || fallbackFileName);
    virtualSize = sourceFile.size;
    emitBrowserSourceRefTrace(options.trace, "using FileSystemFileHandle source", {
      fileName: sourceFile.name || fileName || fallbackFileName,
      size: sourceFile.size,
    });
  } else if (blob) {
    const resolvedFileName = fileName || fallbackFileName;
    virtualSource = toFileLike(blob, resolvedFileName);
    virtualSize = blob.size;
    emitBrowserSourceRefTrace(options.trace, "using Blob source", {
      fileName: resolvedFileName,
      size: blob.size,
      sourceKind: getBrowserSourceTraceKind(blob),
    });
  }
  if (!virtualSource) {
    emitBrowserSourceRefTrace(options.trace, "source ref unsupported", {
      directSourceKind: getBrowserSourceTraceKind(directSource),
      fallbackFileName,
      fileName,
      sourceKind: getBrowserSourceTraceKind(source),
    });
    throw new Error("Browser worker inputs must be File, Blob, FileSystemFileHandle, or OPFS path values");
  }

  const virtualFileName = normalizeVirtualFileName(fileName || fallbackFileName, fallbackFileName || "input.bin");
  const stageBytes = typeof virtualSize === "number" && Number.isFinite(virtualSize) ? virtualSize : virtualSource.size;

  // Before allocating a fresh path, reuse an identical input already staged this session (same mount +
  // name + size + content fingerprint). Re-uploading the same archive to pick another entry then keeps
  // its original name and skips the re-stage instead of landing on a "-N" suffix. Only OPFS-staged
  // inputs are shared; the large-input virtual-Blob path below stays per-instance.
  const stagedContentKey =
    stageBytes <= STAGE_INPUT_TO_OPFS_MAX_BYTES
      ? createStagedInputContentKey(
          String(options.mountPoint || WORKER_OPFS_MOUNTPOINT).replace(TRAILING_SLASHES_REGEX, ""),
          virtualFileName,
          stageBytes,
          await fingerprintStageSource(virtualSource),
        )
      : null;
  if (stagedContentKey) {
    const reused = await reuseStagedInput(stagedContentKey, virtualFileName, options.trace);
    if (reused) {
      return {
        cleanup: async () => releaseStagedInput(stagedContentKey, options.trace),
        fileName: virtualFileName,
        filePath: reused.stagedPath,
        kind: "path",
        size: reused.size ?? stageBytes,
        storageKind: "opfs",
      };
    }
  }

  const virtualPath = createVirtualInputPath(options, virtualFileName);

  // Trade-off: small inputs are copied into OPFS up front; large inputs stay on the virtual-Blob path.
  //
  // The virtual-Blob path is zero-copy, but it hands every wasm decode thread a reference to the same
  // File-backed Blob, and each thread reads it synchronously with FileReaderSync. On Safari, concurrent
  // FileReaderSync reads of one file-backed Blob serialize at the file layer, so the decode threads
  // starve waiting on each other (measured ~10x throughput gap between the fastest and the stalled
  // threads on a 4-thread RVZ extract). Copying the input into OPFS once lets each thread read it back
  // through its own SyncAccessHandle, which removes that contention, and keeps the bytes off the
  // JS/wasm heap (important on memory-constrained Safari/iOS).
  //
  // The cost is one up-front read + write. OPFS writes run ~2.7 GiB/s, so the Blob read dominates and
  // the staging time is small relative to the contention it removes. We only pay it below the
  // threshold: above it a full staged copy would cost too much I/O and OPFS storage for large discs,
  // and the per-read contention is a smaller share of a long-running job, so the zero-copy virtual-Blob
  // path wins there. Staging failures fall back to the virtual-Blob path so input handling stays robust.
  if (stagedContentKey) {
    // Register the in-flight stage before awaiting it so a concurrent re-stage of the same input
    // reuses this one copy instead of writing its own. The promise rejects on a failed stage, which
    // reuseStagedInput treats as "no reusable copy" so the waiter falls through to its own attempt.
    const stagePromise = requestBrowserOpfsStorage({
      action: "stage",
      file: virtualSource,
      fileName: virtualFileName,
      filePath: virtualPath,
      mountPoint: options.mountPoint,
    }).then((staged) => {
      if (!staged?.success) throw new Error(staged?.error?.message || "Browser OPFS input staging failed");
      return { size: staged.size ?? stageBytes, stagedPath: staged.filePath ?? virtualPath };
    });
    stagedInputsByContentKey.set(stagedContentKey, { allocatedPath: virtualPath, refCount: 1, result: stagePromise });
    const staged = await stagePromise.then(
      (value) => value,
      (error: unknown) => {
        emitBrowserSourceRefTrace(options.trace, "input OPFS staging failed, using virtual blob", {
          error: error instanceof Error ? error.message : String(error),
          filePath: virtualPath,
        });
        return null;
      },
    );
    if (staged) {
      emitBrowserSourceRefTrace(options.trace, "staged input to OPFS", {
        fileName: virtualFileName,
        filePath: staged.stagedPath,
        size: staged.size,
      });
      return {
        cleanup: async () => releaseStagedInput(stagedContentKey, options.trace),
        fileName: virtualFileName,
        filePath: staged.stagedPath,
        kind: "path",
        size: staged.size,
        storageKind: "opfs",
      };
    }
    // Staging failed: drop the registry entry and any partial OPFS file so it can't shadow the virtual
    // registration below. virtualPath stays allocated for the virtual-Blob fallback.
    stagedInputsByContentKey.delete(stagedContentKey);
    await requestBrowserOpfsStorage({ action: "cleanup", filePaths: [virtualPath] }).catch(() => undefined);
  }

  emitBrowserSourceRefTrace(options.trace, "registering virtual input", {
    fileName: virtualFileName,
    size: virtualSize,
    sourceKind: getBrowserSourceTraceKind(virtualSource),
    virtualPath,
  });
  let unregister: (() => void) | null = null;
  try {
    unregister = registerBrowserVirtualFile({
      path: virtualPath,
      source: virtualSource,
      trace: options.trace,
    });
  } catch (error) {
    releaseVirtualInputPath(virtualPath);
    throw error;
  }
  emitBrowserSourceRefTrace(options.trace, "registered virtual input", {
    fileName: virtualFileName,
    size: virtualSize,
    virtualPath,
  });
  return {
    cleanup: async () => {
      unregister?.();
      releaseVirtualInputPath(virtualPath);
    },
    fileName: virtualFileName,
    filePath: virtualPath,
    kind: "path",
    size: virtualSize,
    storageKind: "opfs",
    virtual: true,
  };
};

export type { BrowserOpfsSourceRef };
export { createBrowserOpfsSourceRef };
