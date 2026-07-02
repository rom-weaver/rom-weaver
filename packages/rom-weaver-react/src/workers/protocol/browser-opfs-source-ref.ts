import { emitTraceLog } from "../../lib/logging.ts";
import { isAppleMobileWebKit, isWebKitDesktopSafari } from "../../platform/shared/webkit-runtime.ts";
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
// Visible names currently handed out to live (not-yet-cleaned-up) staged sources. A name is added on
// allocate and removed in the source ref's `cleanup`, so membership means "still in use right now".
const allocatedVirtualInputPaths = new Set<string>();
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
      // Consume the entry: stagingMs is read back exactly once per command (to surface it on the [perf]
      // line), so the ledger must drop the record here or it grows unbounded across a long session.
      stagedInputMsByPath.delete(path);
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

// Hand out the smallest visible name not currently in use: the bare name when it is free, otherwise
// the first `name-N` whose path is unallocated. The suffix is collision-driven, not monotonic — once a
// source is cleaned up its name is reclaimed, so a same-named re-stage reuses the bare name instead of
// forever climbing `-2`/`-3`. Safe because a name is only released in `cleanup`, which runs after the
// staged source's command has finished and dropped its (read-only, Blob-backed) proxy handle, so reuse
// never races a still-open handle. Concurrently-live same-named stages still get distinct names: the
// live one is still in `allocatedVirtualInputPaths`, so the next one lands on `-2`.
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

// At/above this size a WebKit input is decoded multi-threaded, so the per-thread fast path contends and
// the single-reader OPFS proxy wins; below it the input is effectively single-threaded (a patch, a small
// ROM) with no contention, so the fast path's lower per-read overhead wins even on Safari. Disc images —
// the multi-threaded case the proxy targets — are far larger. See the use site in createBrowserOpfsSourceRef.
const PROXY_HANDLE_INPUT_MIN_BYTES = 64 * 1024 * 1024;

// WebKit (desktop Safari + every iOS/iPadOS browser) serializes concurrent FileReaderSync reads of one
// File at the file layer, so the per-thread fast path stalls there; such inputs read through the OPFS
// proxy worker instead. Primitives are shared with isMobileSafariLike via platform/shared/webkit-runtime.ts;
// this site's desktop-Safari exclusion set (Edg/OPR/SamsungBrowser) deliberately differs and INCLUDES
// desktop Safari, so it is composed from isWebKitDesktopSafari, not isSafariBrowser.
const isWebKitInputRuntime = () => {
  const nav = typeof navigator === "object" ? navigator : null;
  // An empty UA must classify as non-WebKit even when platform/touch would
  // otherwise match (preserves the original early return).
  if (!nav?.userAgent) return false;
  const environment = { maxTouchPoints: nav.maxTouchPoints, platform: nav.platform, userAgent: nav.userAgent };
  return isAppleMobileWebKit(environment) || isWebKitDesktopSafari(environment);
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

  // Browser-gated input read strategy. There are two ways to feed a Blob/File input to the wasm decode
  // threads, and the right one is decided per-engine:
  //
  //   fast path (useProxyHandle=false): each decode thread opens its OWN FileReaderSync and reads its own
  //     slice of the File directly, behind a per-thread LRU cache (BrowserVirtualRandomAccessFile). N
  //     readers run at once.
  //   proxy handle (useProxyHandle=true): one dedicated OPFS proxy worker owns the File and serves every
  //     decode thread's reads over a SharedArrayBuffer (BrowserProxyRandomAccessFile). Exactly ONE reader.
  //
  // Which is faster comes down to one thing: does the browser actually run concurrent reads of the SAME
  // File in parallel? That is decided in the engine's file-I/O layer, BELOW JavaScript, so no amount of
  // thread coordination (Atomics/SharedArrayBuffer) can change it — the proxy already uses both and is
  // still a single reader.
  //
  //   * Chrome/Firefox genuinely serve those N reads in parallel, so the fast path scales ~Nx and beats a
  //     single proxy reader. Measured (CHD extract, 8 threads): fast path ~4395ms vs proxy ~5472ms.
  //   * WebKit (desktop Safari + every iOS/iPadOS browser) serializes concurrent FileReaderSync reads of
  //     one File at the file layer, so the fast path's "parallel" reads queue behind each other AND burn
  //     time contending — one thread races ahead (~326 MiB/s) while the rest starve (~33 MiB/s). The
  //     single proxy reader has no contention and wins. Measured (RVZ extract, 4 threads): fast path
  //     ~5747ms with 3-of-4 threads starved (the 70/86% progress stall) vs proxy ~4612ms, balanced.
  //
  // So: WebKit + an input big enough to be decoded multi-threaded -> proxy handle; small inputs (a patch,
  // a small ROM — single-threaded, so no concurrent readers to contend) and everything on Chrome/Firefox
  // -> fast path. The size threshold keeps small Safari inputs off the proxy's per-read SAB round-trips.
  // (A SAB-preload variant — read the whole input into shared memory once, then serve in-memory reads in
  // parallel — would beat both on Safari, but it pins the entire compressed input in RAM, which OOMs
  // memory-constrained iOS; deliberately not used.) Inputs already on OPFS (extracted files, patch
  // outputs) never reach here — they return above by path. Nothing stages an input Blob into OPFS; input
  // staging is fully retired.
  const inputBytes = typeof virtualSize === "number" && Number.isFinite(virtualSize) ? virtualSize : virtualSource.size;
  const useProxyHandle = isWebKitInputRuntime() && inputBytes >= PROXY_HANDLE_INPUT_MIN_BYTES;
  emitBrowserSourceRefTrace(options.trace, "registering virtual input", {
    fileName: virtualFileName,
    size: virtualSize,
    sourceKind: getBrowserSourceTraceKind(virtualSource),
    useProxyHandle,
    virtualPath,
  });
  let unregister: (() => void) | null = null;
  try {
    unregister = registerBrowserVirtualFile({
      path: virtualPath,
      source: virtualSource,
      trace: options.trace,
      useProxyHandle,
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
