import type {
  ArchiveEntry,
  ArchiveExtractionResult,
  BrowserFileLike,
  JsonObject,
  JsonValue,
  NormalizedArchiveExtractionResult,
  ProgressCallback,
} from "../../types/runtime.ts";
import type { DirectSource } from "../../types/source.ts";
import { extractBrowserArchiveEntry } from "./archive-extraction.ts";
import { listArchiveFileEntries } from "./archive-input.ts";
import { createArchiveSourceBlob } from "./archive-utils.ts";

type ArchiveSourceValue =
  | DirectSource
  | ArrayBufferLike
  | ArrayBufferView
  | JsonObject
  | {
      _file?: BrowserFileLike;
      _u8array?: Uint8Array;
      fileName?: string;
      name?: string;
    }
  | null
  | undefined;

type ArchiveSourceEntry = ArchiveEntry & {
  filename: string;
  archiveFileName?: string | null;
  archiveSource?: JsonObject;
  archiveBuffer?: ArrayBufferLike | null;
  archiveFile?: BrowserFileLike | null;
};

type ArchiveSourceFile = BrowserFileLike | File | FileSystemFileHandle | string;

type BrowserArchiveExtractionOptions = Parameters<typeof extractBrowserArchiveEntry>[0];
type ArchiveFileInputManager = Parameters<typeof listArchiveFileEntries>[0]["ArchiveManager"];
type ArchiveBrowserExtractionManager = BrowserArchiveExtractionOptions["ArchiveManager"];
type ArchiveManagerLike = {
  configure?: (options: { threads?: number }) => void;
  listEntriesFromFile: ArchiveFileInputManager["listEntriesFromFile"];
  extractEntryToFile: ArchiveBrowserExtractionManager["extractEntryToFile"];
};

type CompressionWorkerPayload = {
  file: BrowserFileLike;
  threads?: number;
  entries?: Array<Record<string, JsonValue | object | undefined>>;
};

type ArchiveSourceRuntime = {
  threads?: number;
  canUseWorker?: boolean;
  runWorker?: (
    action: string,
    payload: CompressionWorkerPayload | Record<string, JsonValue | object | undefined>,
    onProgress?: ProgressCallback,
  ) => Promise<ArchiveSourceEntry[] | NormalizedArchiveExtractionResult | { entries: ArchiveSourceEntry[] }>;
  onWorkerFallback?: (action: string, err: Error | object | string | number | boolean | null | undefined) => void;
  resetWorker?: () => void;
  cleanupWorkerFiles?: (filePaths: string[]) => void | Promise<void>;
};

type BrowserBackedArchiveSource = {
  _file?: BrowserFileLike | null;
};

const FILE_QUERY_OR_HASH_REGEX = /[?#].*$/;
const PATH_DIRECTORY_PREFIX_REGEX = /^.*[/\\]/;

const isBrowserBlob = (source: ArchiveSourceValue): source is BrowserFileLike =>
  !!source &&
  typeof source === "object" &&
  "size" in source &&
  "slice" in source &&
  typeof source.size === "number" &&
  typeof source.slice === "function";

const isBrowserBackedArchiveSource = (source: ArchiveSourceValue): source is BrowserBackedArchiveSource =>
  !!source && typeof source === "object" && "_file" in source;

const getArchiveSourceFileName = (source: ArchiveSourceValue, fallback = "archive.bin") => {
  if (
    source &&
    typeof source === "object" &&
    "fileName" in source &&
    typeof source.fileName === "string" &&
    source.fileName.trim()
  )
    return source.fileName.trim();
  if (source && typeof source === "object" && "name" in source && typeof source.name === "string" && source.name.trim())
    return source.name.trim();
  if (typeof source === "string" && source.trim()) {
    const normalized = source.trim().replace(FILE_QUERY_OR_HASH_REGEX, "");
    const baseName = normalized.replace(PATH_DIRECTORY_PREFIX_REGEX, "");
    return baseName || fallback;
  }
  return fallback;
};

const getArchiveSourceFile = (source: ArchiveSourceValue): ArchiveSourceFile | null => {
  if (typeof source === "string" && source.trim()) return source;
  if (typeof FileSystemFileHandle !== "undefined" && source instanceof FileSystemFileHandle) return source;
  if (isBrowserBlob(source)) return source;
  if (isBrowserBackedArchiveSource(source)) {
    const file = source._file || null;
    if (isBrowserBlob(file)) return file;
  }
  const archiveBuffer = getArchiveSourceBuffer(source);
  if (!archiveBuffer) return null;
  const archiveFile = createArchiveSourceBlob(archiveBuffer, getArchiveSourceFileName(source));
  if (
    source &&
    typeof source === "object" &&
    !(source instanceof ArrayBuffer) &&
    !ArrayBuffer.isView(source) &&
    !("slice" in source && "arrayBuffer" in source)
  )
    (source as { _file?: BrowserFileLike | null })._file = archiveFile;
  return archiveFile;
};

const getArchiveSourceBuffer = (source: ArchiveSourceValue): ArrayBufferLike | null => {
  if (source instanceof ArrayBuffer) return source;
  if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  if (source && typeof source === "object" && "_u8array" in source && source._u8array instanceof Uint8Array) {
    return source._u8array.buffer.slice(
      source._u8array.byteOffset,
      source._u8array.byteOffset + source._u8array.byteLength,
    );
  }
  return null;
};

const readBrowserFile = (file: BrowserFileLike) => {
  if (file && typeof file.arrayBuffer === "function") return file.arrayBuffer();
  throw new Error("Browser archive reads require Blob.arrayBuffer()");
};

const createCompressionWorkerPayload = (
  source: ArchiveSourceValue,
  threads?: number,
  canUseWorker?: boolean,
): CompressionWorkerPayload | null => {
  if (!canUseWorker) return null;
  const file = getArchiveSourceFile(source);
  if (!file || typeof file === "string" || !isBrowserBlob(file)) return null;
  return { file, threads };
};

const copyArchiveEntryForWorker = (entry: ArchiveSourceEntry) => {
  const copy: Record<string, JsonValue | object | undefined> = {};
  for (const key of Object.keys(entry)) {
    if (key !== "archiveSource" && key !== "archiveFile" && key !== "archiveBuffer") copy[key] = entry[key];
  }
  return copy;
};

const runCompressionWorkerWithFallback = ({
  action,
  workerPayload,
  runtime,
  runDirect,
  onProgress,
}: {
  action: string;
  workerPayload: CompressionWorkerPayload | null;
  runtime?: ArchiveSourceRuntime;
  runDirect: () =>
    | Promise<ArchiveSourceEntry[] | NormalizedArchiveExtractionResult>
    | ArchiveSourceEntry[]
    | NormalizedArchiveExtractionResult;
  onProgress?: ProgressCallback;
}) => {
  if (!(workerPayload && runtime?.canUseWorker) || typeof runtime.runWorker !== "function") {
    return Promise.resolve().then(runDirect);
  }
  return runtime.runWorker(action, workerPayload, onProgress).catch((err) => {
    runtime.onWorkerFallback?.(action, err);
    runtime.resetWorker?.();
    return Promise.resolve().then(runDirect);
  });
};

const attachArchiveSourceToEntries = ({
  archiveEntries,
  archiveSource,
  archiveFileName,
}: {
  archiveEntries: ArchiveSourceEntry[];
  archiveSource: ArchiveSourceValue;
  archiveFileName?: string | null;
}) => {
  const archiveFile = getArchiveSourceFile(archiveSource);
  for (const archiveEntry of archiveEntries) {
    archiveEntry.archiveSource = archiveSource as JsonObject;
    if (archiveFile && typeof archiveFile !== "string" && isBrowserBlob(archiveFile))
      archiveEntry.archiveFile = archiveFile;
    archiveEntry.archiveFileName = archiveFileName || undefined;
  }
  return archiveEntries;
};

const listArchiveSourceEntries = async ({
  ArchiveManager,
  source,
  runtime,
}: {
  ArchiveManager: ArchiveManagerLike;
  source: ArchiveSourceValue;
  runtime?: ArchiveSourceRuntime;
}): Promise<ArchiveSourceEntry[]> => {
  const archiveFile = getArchiveSourceFile(source);
  const workerPayload = createCompressionWorkerPayload(source, runtime?.threads, runtime?.canUseWorker);
  return runCompressionWorkerWithFallback({
    action: "list",
    runDirect: () => {
      if (typeof runtime?.threads === "number") ArchiveManager.configure?.({ threads: runtime.threads });
      if (!archiveFile) throw new Error("Archive listing requires a file-backed source");
      return listArchiveFileEntries({ ArchiveManager, file: archiveFile });
    },
    runtime,
    workerPayload,
  }).then(
    (result) =>
      (!Array.isArray(result) &&
      result &&
      typeof result === "object" &&
      "entries" in result &&
      Array.isArray(result.entries)
        ? result.entries
        : result) as ArchiveSourceEntry[],
  );
};

const extractArchiveSourceEntry = async ({
  ArchiveManager,
  source,
  entryName,
  runtime,
  onProgress,
}: {
  ArchiveManager: ArchiveManagerLike;
  source: ArchiveSourceValue;
  entryName: string;
  runtime?: ArchiveSourceRuntime;
  onProgress?: ProgressCallback;
}): Promise<NormalizedArchiveExtractionResult> => {
  const archiveFile = getArchiveSourceFile(source);
  if (!archiveFile) throw new Error("Archive extraction requires a file-backed source");
  return extractBrowserArchiveEntry({
    ArchiveManager,
    cleanupWorkerFiles: runtime?.cleanupWorkerFiles,
    entryName,
    file: archiveFile,
    onProgress,
    onWorkerFallback: runtime?.onWorkerFallback,
    resetWorker: runtime?.resetWorker,
    runWorker:
      runtime?.canUseWorker && typeof runtime.runWorker === "function"
        ? (
            action: "extract",
            payload: {
              file: BrowserFileLike | FileSystemFileHandle | string;
              entryName: string;
              threads?: number;
            },
            progress?: ProgressCallback,
          ) =>
            runtime.runWorker?.(
              action,
              payload as Record<string, JsonValue | object | undefined>,
              progress,
            ) as Promise<ArchiveExtractionResult>
        : undefined,
    threads: runtime?.threads,
  } as BrowserArchiveExtractionOptions);
};

export type { ArchiveSourceEntry, ArchiveSourceRuntime, ArchiveSourceValue, CompressionWorkerPayload };
export {
  attachArchiveSourceToEntries,
  copyArchiveEntryForWorker,
  createCompressionWorkerPayload,
  extractArchiveSourceEntry,
  getArchiveSourceBuffer,
  getArchiveSourceFile,
  isBrowserBlob,
  listArchiveSourceEntries,
  readBrowserFile,
  runCompressionWorkerWithFallback,
};
