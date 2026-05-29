import { getBrowserSourceBlob, getBrowserSourceHandle } from "../../storage/browser/browser-source-primitives.ts";
import {
  getNamedSource,
  getNamedSourceFileName,
  getNamedSourceSize,
} from "../../storage/shared/binary/source-file-utils.ts";
import type { WorkerStorageBucket } from "../shared/worker-storage/storage-layout.ts";
import { getWorkerStorageBucketPath, WORKER_OPFS_MOUNTPOINT } from "../shared/worker-storage/storage-layout.ts";
import { registerBrowserVirtualFile } from "./browser-virtual-files.ts";
import { requestBrowserOpfsStorage } from "./browser-opfs-worker-client.ts";
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

const isFileLike = (source: unknown): source is File =>
  typeof File !== "undefined" && source instanceof File && typeof source.slice === "function";

const getRecordValue = (source: unknown, key: string) =>
  source && typeof source === "object" ? (source as Record<string, unknown>)[key] : undefined;

const getStringRecordValue = (source: unknown, key: string) => {
  const value = getRecordValue(source, key);
  return typeof value === "string" && value.trim() ? value : "";
};

const getByteSource = (source: unknown): Uint8Array | null => {
  if (source instanceof Uint8Array) return source;
  const bytes = getRecordValue(source, "_u8array") || getRecordValue(source, "u8array");
  return bytes instanceof Uint8Array ? bytes : null;
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
const CONTROL_FILE_CHARS_REGEX = /[\u0000-\u001f\u007f]+/g;
const NON_ASCII_CHARS_REGEX = /[^\x20-\x7e]+/g;
const RESERVED_FILE_CHARS_REGEX = /[:*?"<>|]+/g;
const EDGE_WHITESPACE_OR_UNDERSCORES_REGEX = /^[_\s]+|[_\s]+$/g;
const TRAILING_SLASHES_REGEX = /\/+$/;
const EAGER_MEMORY_VIRTUAL_SOURCE_EXTENSIONS = new Set([".7z", ".rvz"]);
const EAGER_MEMORY_VIRTUAL_SOURCE_MAX_BYTES = 512 * 1024 * 1024;
const OPFS_STAGED_SOURCE_EXTENSIONS = new Set([".chd"]);
let virtualSourceId = 0;

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

const emitBrowserSourceRefTrace = (message: string, details?: Record<string, unknown>) => {
  if (typeof console === "undefined") return;
  const log = typeof console.debug === "function" ? console.debug : console.log;
  log.call(console, `[rom-weaver trace] browser-opfs-source-ref: ${message}`, details || {});
};

const normalizeVirtualFileName = (fileName: string | null | undefined, fallback = "input.bin") =>
  String(fileName || fallback)
    .replace(PATH_SEPARATOR_REGEX, "_")
    .replace(CONTROL_FILE_CHARS_REGEX, "_")
    .replace(NON_ASCII_CHARS_REGEX, "_")
    .replace(RESERVED_FILE_CHARS_REGEX, "_")
    .replace(LEADING_DOTS_REGEX, "")
    .replace(EDGE_WHITESPACE_OR_UNDERSCORES_REGEX, "") || fallback;

const lowerFileExtension = (fileName: string) => {
  const normalized = String(fileName || "").toLowerCase();
  const index = normalized.lastIndexOf(".");
  return index >= 0 ? normalized.slice(index) : "";
};

const shouldUseEagerMemoryVirtualSource = (fileName: string, size: number | undefined) =>
  typeof size === "number" &&
  size > 0 &&
  size <= EAGER_MEMORY_VIRTUAL_SOURCE_MAX_BYTES &&
  EAGER_MEMORY_VIRTUAL_SOURCE_EXTENSIONS.has(lowerFileExtension(fileName));

const shouldUseOpfsStagedSource = (fileName: string, source: Blob | Uint8Array | null) =>
  typeof Blob !== "undefined" &&
  source instanceof Blob &&
  OPFS_STAGED_SOURCE_EXTENSIONS.has(lowerFileExtension(fileName));

const createVirtualPathNonce = () => {
  const sequence = ++virtualSourceId;
  const timeToken = Date.now().toString(36);
  const randomToken = Math.random().toString(16).slice(2, 10);
  return `${timeToken}-${sequence}-${randomToken}`;
};

const createVirtualInputPath = (
  options: { bucket?: WorkerStorageBucket; mountPoint: string; pathPrefix: string },
  fileName: string,
) => {
  const mountPoint = String(options.mountPoint || WORKER_OPFS_MOUNTPOINT).replace(TRAILING_SLASHES_REGEX, "");
  const bucket = options.bucket || "input";
  const pathPrefix = normalizeVirtualFileName(options.pathPrefix || "input", "input");
  const normalizedFileName = normalizeVirtualFileName(fileName);
  return getWorkerStorageBucketPath(
    mountPoint,
    bucket,
    `${pathPrefix}-${createVirtualPathNonce()}/${normalizedFileName}`,
    normalizedFileName,
  );
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

const stageBrowserOpfsSource = async (
  source: Blob,
  fileName: string,
  size: number | undefined,
  options: { bucket?: WorkerStorageBucket; mountPoint: string; pathPrefix: string },
): Promise<BrowserOpfsSourceRef> => {
  const response = await requestBrowserOpfsStorage({
    action: "stage",
    bucket: options.bucket,
    file: source,
    fileName,
    mountPoint: options.mountPoint,
    pathPrefix: options.pathPrefix,
  });
  if (!response.success || !response.filePath) {
    throw new Error(response.error?.message || "Browser OPFS input staging failed");
  }
  const stagedPath = response.filePath;
  return {
    cleanup: async () => {
      await requestBrowserOpfsStorage({
        action: "cleanup",
        filePaths: [stagedPath],
      }).catch(() => undefined);
    },
    fileName: response.fileName || fileName,
    filePath: stagedPath,
    kind: "path",
    size: response.size ?? size,
    storageKind: "opfs",
  };
};

const createBrowserOpfsSourceRef = async (
  source: unknown,
  fallbackFileName: string,
  options: { bucket?: WorkerStorageBucket; mountPoint: string; pathPrefix: string },
): Promise<BrowserOpfsSourceRef> => {
  const directSource = getNamedSource(source as Parameters<typeof getNamedSource>[0]);
  const fileName = getNamedSourceFileName(source as Parameters<typeof getNamedSource>[0], {
    fallback: fallbackFileName,
  });
  const sizeHint = getNamedSourceSize(source as Parameters<typeof getNamedSourceSize>[0]);
  emitBrowserSourceRefTrace("create source ref started", {
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
    emitBrowserSourceRefTrace("using existing OPFS path source", {
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
  const bytes = getByteSource(directSource) || getByteSource(source);
  let virtualSource: Blob | Uint8Array | null = null;
  let virtualSize = sizeHint ?? undefined;
  if (fileHandle) {
    const sourceFile = await fileHandle.getFile();
    virtualSource = toFileLike(sourceFile, fileName || fallbackFileName);
    virtualSize = sourceFile.size;
    emitBrowserSourceRefTrace("using FileSystemFileHandle source", {
      fileName: sourceFile.name || fileName || fallbackFileName,
      size: sourceFile.size,
    });
  } else if (blob) {
    const resolvedFileName = fileName || fallbackFileName;
    if (shouldUseEagerMemoryVirtualSource(resolvedFileName, blob.size)) {
      virtualSource = new Uint8Array(await blob.arrayBuffer());
      virtualSize = virtualSource.byteLength;
      emitBrowserSourceRefTrace("using eager memory Blob source", {
        fileName: resolvedFileName,
        size: virtualSize,
        sourceKind: getBrowserSourceTraceKind(blob),
      });
    } else {
      virtualSource = toFileLike(blob, resolvedFileName);
      virtualSize = blob.size;
      emitBrowserSourceRefTrace("using Blob source", {
        fileName: resolvedFileName,
        size: blob.size,
        sourceKind: getBrowserSourceTraceKind(blob),
      });
    }
  } else if (bytes) {
    virtualSource = bytes;
    virtualSize = bytes.byteLength;
    emitBrowserSourceRefTrace("using byte source", {
      fileName: fileName || fallbackFileName,
      size: bytes.byteLength,
    });
  }
  if (!virtualSource) {
    emitBrowserSourceRefTrace("source ref unsupported", {
      directSourceKind: getBrowserSourceTraceKind(directSource),
      fallbackFileName,
      fileName,
      sourceKind: getBrowserSourceTraceKind(source),
    });
    throw new Error("Browser worker inputs must be File, Blob, Uint8Array, FileSystemFileHandle, or OPFS path values");
  }

  const virtualFileName = normalizeVirtualFileName(fileName || fallbackFileName, fallbackFileName || "input.bin");
  if (shouldUseOpfsStagedSource(virtualFileName, virtualSource)) {
    try {
      const staged = await stageBrowserOpfsSource(virtualSource as Blob, virtualFileName, virtualSize, options);
      emitBrowserSourceRefTrace("using staged OPFS input", {
        fileName: staged.fileName,
        filePath: staged.filePath,
        size: staged.size,
        sourceKind: getBrowserSourceTraceKind(virtualSource),
      });
      return staged;
    } catch (error) {
      emitBrowserSourceRefTrace("staged OPFS input failed, falling back to virtual input", {
        fileName: virtualFileName,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const virtualPath = createVirtualInputPath(options, virtualFileName);
  emitBrowserSourceRefTrace("registering virtual input", {
    fileName: virtualFileName,
    size: virtualSize,
    sourceKind: getBrowserSourceTraceKind(virtualSource),
    virtualPath,
  });
  const unregister = registerBrowserVirtualFile({
    path: virtualPath,
    source: virtualSource,
  });
  emitBrowserSourceRefTrace("registered virtual input", {
    fileName: virtualFileName,
    size: virtualSize,
    virtualPath,
  });
  return {
    cleanup: async () => unregister(),
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
