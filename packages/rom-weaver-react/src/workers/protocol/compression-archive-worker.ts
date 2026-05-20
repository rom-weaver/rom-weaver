import type { LogRecord } from "../../types/logging.ts";
import type { ArchiveEntryInput, ProgressCallback } from "../../types/runtime.ts";
import {
  buildCompressionWorkerRequest,
  runCompressionWorkerOperation,
  runCompressionWorkerSourceOperation,
} from "./compression-worker-client.ts";
import type { CompressionWorkerResult } from "./worker-protocol.ts";

type WorkerPayload = Record<string, string | number | boolean | object | null | undefined>;
type ExtractArchiveInput = {
  entryName: string;
  filePath?: string;
  fileName?: string;
  logLevel?: string;
  threads?: number | string;
};
type NodeExtractArchiveInput = ExtractArchiveInput & { filePath: string };
type BrowserExtractArchiveInput = ExtractArchiveInput & { filePath: string };

const extractArchiveEntryWithSource = (
  input: ExtractArchiveInput,
  source: string,
  onProgress?: ProgressCallback,
  onLog?: (record: LogRecord) => void,
): Promise<CompressionWorkerResult> =>
  runCompressionWorkerSourceOperation(
    "7zip-zstd",
    "extract",
    {
      entryName: input.entryName,
      fileName: input.fileName,
      logLevel: input.logLevel,
      source,
      threads: input.threads,
    },
    "Archive extraction requires a filesystem path",
    onProgress,
    onLog,
  );

const readArchiveDirectoryInNodeWorker = async (input: {
  filePath: string;
  logLevel?: string;
  onLog?: (record: LogRecord) => void;
  onProgress?: ProgressCallback;
  threads?: number | string;
}) => {
  const result = await runCompressionWorkerSourceOperation(
    "7zip-zstd",
    "list",
    {
      logLevel: input.logLevel,
      source: input.filePath,
      threads: input.threads,
    },
    "Archive listing requires a filesystem path",
    input.onProgress,
    input.onLog,
  );
  return result.entries || [];
};

const readArchiveDirectoryInBrowserWorker = async (input: {
  filePath: string;
  fileName?: string;
  logLevel?: string;
  onLog?: (record: LogRecord) => void;
  onProgress?: ProgressCallback;
  threads?: number | string;
}) => {
  const result = await runCompressionWorkerSourceOperation(
    "7zip-zstd",
    "list",
    {
      fileName: input.fileName,
      filePath: input.filePath,
      logLevel: input.logLevel,
      source: input.filePath,
      threads: input.threads,
    },
    "Archive listing requires a filesystem path",
    input.onProgress,
    input.onLog,
  );
  return result.entries || [];
};

const extractArchiveEntryInNodeWorker = async (
  input: NodeExtractArchiveInput,
  onProgress?: ProgressCallback,
  onLog?: (record: LogRecord) => void,
): Promise<CompressionWorkerResult> => extractArchiveEntryWithSource(input, input.filePath, onProgress, onLog);

const extractArchiveEntryInBrowserWorker = async (
  input: BrowserExtractArchiveInput,
  onProgress?: ProgressCallback,
  onLog?: (record: LogRecord) => void,
): Promise<CompressionWorkerResult> => extractArchiveEntryWithSource(input, input.filePath, onProgress, onLog);

const createArchiveInNodeWorker = async (
  input: {
    codec?: string;
    compression?: string;
    entries: ArchiveEntryInput[];
    fileName?: string;
    level?: number | string | null;
    logLevel?: string;
    threads?: number | string;
  },
  onProgress?: ProgressCallback,
  onLog?: (record: LogRecord) => void,
): Promise<CompressionWorkerResult> =>
  runCompressionWorkerOperation(
    "7zip-zstd",
    "create",
    buildCompressionWorkerRequest("7zip-zstd", "create", {
      codec: input.codec,
      compression: input.compression,
      entries: input.entries,
      fileName: input.fileName,
      level: input.level,
      logLevel: input.logLevel,
      outputName: input.fileName,
      threads: input.threads,
    } as WorkerPayload),
    onProgress,
    onLog,
  );

const createArchiveInBrowserWorker = createArchiveInNodeWorker;

export {
  createArchiveInBrowserWorker,
  createArchiveInNodeWorker,
  extractArchiveEntryInBrowserWorker,
  extractArchiveEntryInNodeWorker,
  readArchiveDirectoryInBrowserWorker,
  readArchiveDirectoryInNodeWorker,
};
