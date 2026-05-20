import type { CompressionWorkerRequest, WorkerRequestId } from "../protocol/worker-protocol.ts";
import type { WorkerResultFile } from "../protocol/worker-runtime-payloads.ts";
import { cleanupNodeWorkerTempFiles, createNodeWorkerTempFile } from "../shared/node-worker-runtime.ts";
import { postCreatedFile, postExtractedFile } from "../shared/rpc/compression-result-posting.ts";
import { isNodeRuntime } from "../shared/runtime-env.ts";
import { encodeWorkerText, readWorkerBlobBytes } from "../shared/worker-byte-utils.ts";
import { postWorkerProgress } from "../shared/worker-message-utils.ts";
import { getWorkerStorageBucketPath, WORKER_OPFS_MOUNTPOINT } from "../shared/worker-storage/storage-layout.ts";
import { cleanupMaterializedOutputs } from "../shared/worker-storage/worker-output-materialization.ts";
import { createTimingFromStart, now, type Timing } from "../shared/worker-timing.ts";
import { baseName } from "./archive/runtime/fs-utils.ts";
import {
  cleanupFiles as cleanupArchiveFiles,
  configure as configureArchiveRuntime,
  createArchive,
  createArchiveToFile,
  extractEntryFromFile as extractArchiveEntryFromFile,
  extractEntryToFile as extractArchiveEntryToFile,
  listEntriesFromFile,
  warmup,
} from "./archive/runtime/index.ts";
import type { ArchiveSource } from "./archive/runtime/types.ts";
import { filterValidPatchEntriesFromFile } from "./shared/archive-patch-validation.ts";
import * as OutputCompression from "./shared/output-compression.ts";

type ArchiveCreateEntry = {
  data?: Blob | Uint8Array;
  filename: string;
  filePath?: string;
  mtime: number;
};
type ArchiveEntryInput = {
  arrayBuffer?: ArrayBufferLike | Uint8Array;
  file?: Blob & { name?: string; type?: string; arrayBuffer?: () => Promise<ArrayBuffer> };
  fileName?: string;
  filePath?: string;
  filename?: string;
  lastModified?: number;
  name?: string;
  text?: string | number;
  u8array?: Uint8Array;
};
type ProgressEvent = {
  label?: string;
  percent?: number | null;
  [key: string]: RuntimeValue | undefined;
};
type FilterPatchRequest = Parameters<typeof filterValidPatchEntriesFromFile>[0];
type ArchiveOperationResult = {
  cleanupPaths: string[];
  resultFile: WorkerResultFile;
  timing: Timing;
};

type WorkerScopeLike = typeof globalThis & {
  postMessage: (message: RuntimeValue, transfer?: StructuredSerializeOptions | Transferable[]) => void;
};

type WorkerArchiveSource =
  | NonNullable<CompressionWorkerRequest["file"]>
  | NonNullable<CompressionWorkerRequest["filePath"]>;

const extractEntryFromFile = (
  source: ArchiveSource,
  entryName: string | null | undefined,
  options?: Parameters<typeof extractArchiveEntryFromFile>[2],
) => extractArchiveEntryFromFile(source, entryName || "", options);

const extractEntryToFile = (
  source: ArchiveSource,
  entryName: string | null | undefined,
  options?: Parameters<typeof extractArchiveEntryToFile>[2],
) => extractArchiveEntryToFile(source, entryName || "", options);

const ArchiveFilterCapabilities: FilterPatchRequest["archiveCapabilities"] = {
  extractEntryFromFile,
  extractEntryToFile,
};

const CompressionArchiveCapabilities: Pick<
  {
    cleanupFiles: typeof cleanupArchiveFiles;
    configure: typeof configureArchiveRuntime;
    createArchive: typeof createArchive;
    createArchiveToFile: typeof createArchiveToFile;
    extractEntryFromFile: typeof extractArchiveEntryFromFile;
    extractEntryToFile: typeof extractArchiveEntryToFile;
    listEntriesFromFile: typeof listEntriesFromFile;
    warmup: typeof warmup;
  },
  | "cleanupFiles"
  | "configure"
  | "createArchive"
  | "createArchiveToFile"
  | "extractEntryFromFile"
  | "extractEntryToFile"
  | "listEntriesFromFile"
  | "warmup"
> = {
  cleanupFiles: (paths) => cleanupArchiveFiles(paths),
  configure: (options) => configureArchiveRuntime(options),
  createArchive: (entries, options) => createArchive(entries, options),
  createArchiveToFile: (entries, options) => createArchiveToFile(entries, options),
  extractEntryFromFile,
  extractEntryToFile,
  listEntriesFromFile: (source, options) => listEntriesFromFile(source, options),
  warmup: () => warmup(),
};

const ARCHIVE_OPFS_MOUNTPOINT = WORKER_OPFS_MOUNTPOINT;
let archiveCreateOutputPathId = 0;

const getArchiveCreateOutputPath = (fileName: string) =>
  getWorkerStorageBucketPath(
    ARCHIVE_OPFS_MOUNTPOINT,
    "output",
    `create/${++archiveCreateOutputPathId}/${fileName}`,
    fileName,
  );

const getSource = (data: CompressionWorkerRequest): WorkerArchiveSource | undefined =>
  typeof data.filePath === "string" && data.filePath.trim() ? data.filePath : data.file || undefined;

const getRequiredSource = (data: CompressionWorkerRequest): WorkerArchiveSource => {
  const source = getSource(data);
  if (!source) throw new Error("Archive source was not provided");
  return source;
};

const createPreparedSourceCleanup = (filePath: string) => () => {
  try {
    cleanupNodeWorkerTempFiles([filePath]);
  } catch (_err) {
    /* ignore cleanup errors */
  }
};

const getPreparedSource = async (
  data: CompressionWorkerRequest,
): Promise<{ cleanup: () => void; source: WorkerArchiveSource }> => {
  const source = getRequiredSource(data);
  if (typeof source === "string") {
    return { cleanup: () => undefined, source };
  }
  if (!isNodeRuntime()) throw new Error("Archive worker inputs must be staged into OPFS before worker execution");
  if (typeof source.arrayBuffer !== "function")
    throw new Error("Archive worker inputs must provide Blob.arrayBuffer() when staged in Node worker runtimes");
  const bytes = await readWorkerBlobBytes(source);
  const filePath = createNodeWorkerTempFile(
    "rpjs-7zip-zstd-input-",
    data.fileName || (source as { name?: string }).name || "archive.bin",
    bytes,
  );
  if (!filePath) throw new Error("Archive read APIs require a file-backed source; raw bytes are not supported");
  return {
    cleanup: createPreparedSourceCleanup(filePath),
    source: filePath,
  };
};

const progressCallback =
  (workerScope: WorkerScopeLike, requestId?: WorkerRequestId) =>
  (progress: ProgressEvent): void =>
    postWorkerProgress(workerScope as never, requestId, progress);

const runList = async (data: CompressionWorkerRequest, workerScope: WorkerScopeLike) => {
  const preparedSource = await getPreparedSource(data);
  try {
    return await CompressionArchiveCapabilities.listEntriesFromFile(preparedSource.source, {
      onProgress: progressCallback(workerScope, data.requestId),
    });
  } finally {
    preparedSource.cleanup();
  }
};

const runFilterPatches = async (data: CompressionWorkerRequest) => {
  const preparedSource = await getPreparedSource(data);
  try {
    return await filterValidPatchEntriesFromFile({
      archiveCapabilities: ArchiveFilterCapabilities,
      entries: data.entries || [],
      source: preparedSource.source,
    });
  } finally {
    preparedSource.cleanup();
  }
};

const runExtract = async (
  data: CompressionWorkerRequest,
  workerScope: WorkerScopeLike,
): Promise<ArchiveOperationResult> => {
  const preparedSource = await getPreparedSource(data);
  const startedAt = now();
  const entryName = data.entryName || "";
  try {
    const extracted = await CompressionArchiveCapabilities.extractEntryToFile(preparedSource.source, entryName, {
      onProgress: progressCallback(workerScope, data.requestId),
    });
    const fileName = extracted.fileName || baseName(entryName) || "archive-entry.bin";
    const cleanupPaths = extracted.cleanupPaths || [];
    if (extracted.filePath) {
      const isOpfsOutput = extracted.filePath.startsWith(ARCHIVE_OPFS_MOUNTPOINT);
      const resultFile: WorkerResultFile = {
        _archiveEntryName: entryName,
        fileName,
        fileSize: extracted.size,
      };
      if (isOpfsOutput) resultFile._opfsPath = extracted.filePath;
      else resultFile.filePath = extracted.filePath;
      return {
        cleanupPaths: cleanupPaths.length ? cleanupPaths : [extracted.filePath],
        resultFile,
        timing: createTimingFromStart(startedAt),
      };
    }
    throw new Error(`Archive entry extraction output was not materialized as a file-backed path: ${entryName}`);
  } finally {
    preparedSource.cleanup();
  }
};

const entryToArchiveData = async (entry: ArchiveEntryInput): Promise<Blob | Uint8Array> => {
  if (entry.filePath) throw new Error("Path-backed archive entries are handled without byte materialization");
  if (entry.text !== undefined) return encodeWorkerText(entry.text);
  if (entry.u8array) return entry.u8array;
  if (entry.arrayBuffer) return new Uint8Array(entry.arrayBuffer as ArrayBuffer);
  if (entry.file && typeof entry.file.size === "number" && typeof entry.file.slice === "function") return entry.file;
  throw new Error(`Archive entry data was not provided: ${entry.fileName || entry.filename || "entry"}`);
};

const runCreate = async (
  data: CompressionWorkerRequest,
  workerScope: WorkerScopeLike,
): Promise<ArchiveOperationResult> => {
  const startedAt = now();
  const onProgress = progressCallback(workerScope, data.requestId);
  const compression = OutputCompression.normalizeOutputCompression(data.compression || "7z");
  const sevenZipCodec =
    compression === "7z" ? OutputCompression.normalizeSevenZipCodec(data.codec || "lzma2") : "lzma2";
  const zipCodec = compression === "zip" ? OutputCompression.normalizeZipCodec(data.codec || "deflate") : "deflate";
  const archiveCodec = compression === "7z" ? sevenZipCodec : zipCodec;
  const level =
    archiveCodec === "store"
      ? null
      : OutputCompression.normalizeArchiveCompressionLevelForFormat(compression, archiveCodec, data.level, 9);
  const sourceEntries = data.entries || [];
  if (!sourceEntries.length) throw new Error("Archive entries were not provided");

  const archiveEntries: ArchiveCreateEntry[] = [];
  for (const item of sourceEntries) {
    const entry = (item || {}) as ArchiveEntryInput;
    const fileName = entry.fileName || entry.filename || entry.name;
    if (!fileName) throw new Error("Archive entry name was not provided");
    archiveEntries.push({
      filename: fileName,
      ...(entry.filePath ? { filePath: entry.filePath } : { data: await entryToArchiveData(entry) }),
      mtime: entry.lastModified || Date.now(),
    });
  }

  const firstEntry = archiveEntries[0];
  if (!firstEntry) throw new Error("Archive entries were not provided");
  const fileName =
    data.outputName ||
    OutputCompression.getCompressedFileName({ fileName: firstEntry.filename }, compression, {
      sevenZipCodec,
      sevenZipLevel: level,
      zipCodec,
      zipLevel: level,
    });
  const normalizedFileName = baseName(fileName) || "archive.bin";
  const outputPath = getArchiveCreateOutputPath(normalizedFileName);
  const createdArchive = await CompressionArchiveCapabilities.createArchiveToFile(archiveEntries, {
    format: OutputCompression.getArchiveFormat(compression),
    onProgress,
    options: OutputCompression.getArchiveWriterOptions(compression, {
      sevenZipCodec,
      sevenZipLevel: level,
      threads: data.threads,
      zipCodec,
      zipLevel: level,
    }),
    outputFileName: normalizedFileName,
    outputPath,
  });
  if (!(createdArchive && typeof createdArchive.filePath === "string" && createdArchive.filePath))
    throw new Error("Archive creation output was not materialized as a file-backed path");
  const resultFile: WorkerResultFile = {
    fileName: createdArchive.fileName || normalizedFileName,
    fileSize: createdArchive.size || 0,
  };
  if (createdArchive.filePath.startsWith(ARCHIVE_OPFS_MOUNTPOINT)) resultFile._opfsPath = createdArchive.filePath;
  else resultFile.filePath = createdArchive.filePath;
  return {
    cleanupPaths:
      createdArchive.cleanupPaths?.length && createdArchive.cleanupPaths
        ? createdArchive.cleanupPaths
        : [createdArchive.filePath],
    resultFile,
    timing: createTimingFromStart(startedAt),
  };
};

const runCleanup = (data: CompressionWorkerRequest) =>
  CompressionArchiveCapabilities.cleanupFiles(data.filePaths || []).then(() =>
    cleanupMaterializedOutputs(data.filePaths || []),
  );

const postExtractResult = (
  _workerScope: WorkerScopeLike,
  requestId: WorkerRequestId | undefined,
  result: ArchiveOperationResult,
) => postExtractedFile(requestId, result.resultFile, result.cleanupPaths, result.timing);

const postCreateResult = async (
  _workerScope: WorkerScopeLike,
  requestId: WorkerRequestId | undefined,
  result: ArchiveOperationResult,
) => postCreatedFile(requestId, result.resultFile, result.cleanupPaths, result.timing);

export {
  CompressionArchiveCapabilities,
  getSource,
  postCreateResult,
  postExtractResult,
  runCleanup,
  runCreate,
  runExtract,
  runFilterPatches,
  runList,
};
