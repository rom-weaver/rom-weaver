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

// Main-thread ledger of how long each input took to stage into OPFS, keyed by its staged OPFS path.
// Staging runs on the main thread (the runtime adapter calls stageSource before dispatching the
// command), so the main-thread command dispatcher (rom-weaver-runner) can read it back to surface
// stagingMs on the [perf] command timings line. Already-on-OPFS inputs record 0 (no copy needed);
// inputs left on the virtual-Blob path are never recorded (no staging happened).
const stagedInputMsByPath = new Map<string, number>();
const recordStagedInputMs = (filePath: string, ms: number) => {
  if (filePath) stagedInputMsByPath.set(filePath, Math.max(0, Math.round(ms)));
};
const getStagedInputMs = (paths: Iterable<string>): number | undefined => {
  let total = 0;
  let found = false;
  for (const path of paths) {
    const ms = stagedInputMsByPath.get(path);
    if (typeof ms === "number") {
      total += ms;
      found = true;
    }
  }
  return found ? total : undefined;
};

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
    emitBrowserSourceRefTrace(options.trace, "[perf] using existing OPFS path source (no staging needed)", {
      fileName,
      filePath,
      sizeHint,
      stagingMs: 0,
    });
    recordStagedInputMs(filePath, 0);
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
  const virtualPath = createVirtualInputPath(options, virtualFileName);

  // Every Blob input is served read-only through the OPFS proxy worker by guest path (the runner hands
  // the Blob to the proxy via registerBlobSource). This replaces BOTH the old up-front OPFS staging copy
  // and the per-thread FileReaderSync virtual-Blob path: one owner reads the Blob, every wasm decode
  // thread reads it like a staged OPFS handle — no copy, no FileReaderSync contention, all browsers.
  // See browser-opfs-proxy-server (Blob-backed handles) and browser-opfs-virtual-files (useProxyHandle).
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
      useProxyHandle: true,
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

export { createBrowserOpfsSourceRef, getStagedInputMs };
