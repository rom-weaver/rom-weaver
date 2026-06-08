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
// Inputs at or below this size are copied into OPFS up front; larger inputs stay on the zero-copy
// virtual-Blob path. See the trade-off note at the use site in createBrowserOpfsSourceRef.
const STAGE_INPUT_TO_OPFS_MAX_BYTES = 400 * 1024 * 1024;

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
  for (let suffixIndex = 1; suffixIndex < Number.MAX_SAFE_INTEGER; suffixIndex += 1) {
    const candidateName = createVisibleCollisionFileName(fileName, suffixIndex);
    const candidatePath = getWorkerStorageBucketPath(normalizedMountPoint, "input", candidateName, candidateName);
    if (allocatedVirtualInputPaths.has(candidatePath)) continue;
    allocatedVirtualInputPaths.add(candidatePath);
    return candidatePath;
  }
  throw new Error(`Unable to allocate browser input path for ${fileName}`);
};

const releaseVirtualInputPath = (filePath: string) => {
  allocatedVirtualInputPaths.delete(filePath);
};

const createVirtualInputPath = (options: BrowserOpfsSourceRefOptions, fileName: string) => {
  const mountPoint = String(options.mountPoint || WORKER_OPFS_MOUNTPOINT).replace(TRAILING_SLASHES_REGEX, "");
  const normalizedFileName = normalizeVirtualFileName(fileName);
  return allocateVirtualInputPath(mountPoint, normalizedFileName);
};

const getOpfsPathSize = async (filePath: string): Promise<number | undefined> => {
  try {
    const handle = await getManagedOpfsFileHandle(filePath, { navigatorObject: navigator });
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
      size: sizeHint ?? (await getOpfsPathSize(filePath)),
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
  const stageBytes = typeof virtualSize === "number" && Number.isFinite(virtualSize) ? virtualSize : virtualSource.size;
  if (stageBytes <= STAGE_INPUT_TO_OPFS_MAX_BYTES) {
    const staged = await requestBrowserOpfsStorage({
      action: "stage",
      file: virtualSource,
      fileName: virtualFileName,
      filePath: virtualPath,
      mountPoint: options.mountPoint,
    }).catch((error: unknown) => {
      emitBrowserSourceRefTrace(options.trace, "input OPFS staging threw, using virtual blob", {
        error: error instanceof Error ? error.message : String(error),
        filePath: virtualPath,
      });
      return null;
    });
    if (staged?.success) {
      const stagedPath = staged.filePath ?? virtualPath;
      emitBrowserSourceRefTrace(options.trace, "staged input to OPFS", {
        fileName: virtualFileName,
        filePath: stagedPath,
        size: staged.size ?? stageBytes,
      });
      return {
        cleanup: async () => {
          await requestBrowserOpfsStorage({ action: "cleanup", filePaths: [stagedPath] }).catch(() => undefined);
          releaseVirtualInputPath(virtualPath);
        },
        fileName: virtualFileName,
        filePath: stagedPath,
        kind: "path",
        size: staged.size ?? stageBytes,
        storageKind: "opfs",
      };
    }
    if (staged) {
      emitBrowserSourceRefTrace(options.trace, "input OPFS staging failed, using virtual blob", {
        error: staged.error?.message,
        filePath: virtualPath,
      });
    }
    // Drop any partial OPFS file so it can't shadow the virtual registration below.
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
