import type { LogRecord } from "../../types/logging.ts";
import type { ProgressCallback } from "../../types/runtime.ts";
import { type BinaryWorkerSource, runCompressionWorkerSourceOperation } from "./compression-worker-client.ts";
import type { CompressionWorkerResult } from "./worker-protocol.ts";

type RvzWorkerCreateInput = {
  fileName: string;
  source: BinaryWorkerSource;
  outputName: string;
  logLevel?: string;
  threads?: number | string | null;
  rvzBlockSize?: string | number | null;
  rvzCompression?: string | null;
  rvzCompressionLevel?: string | number | null;
  rvzMode?: string | null;
  rvzScrub?: boolean | string | number | null;
  rvzSourceFileName?: string | null;
};

type RvzWorkerExtractInput = {
  fileName: string;
  source: BinaryWorkerSource;
  outputName?: string;
  logLevel?: string;
  threads?: number | string | null;
};

type RvzWorkerListInput = {
  fileName: string;
  source: BinaryWorkerSource;
  logLevel?: string;
  threads?: number | string | null;
};

const createRvzInWorker = (
  input: RvzWorkerCreateInput,
  onProgress?: ProgressCallback,
  onLog?: (record: LogRecord) => void,
): Promise<CompressionWorkerResult> =>
  runCompressionWorkerSourceOperation(
    "dolphin-rvz",
    "create",
    {
      fileName: input.fileName,
      logLevel: input.logLevel,
      outputName: input.outputName,
      rvzBlockSize: input.rvzBlockSize,
      rvzCompression: input.rvzCompression,
      rvzCompressionLevel: input.rvzCompressionLevel,
      rvzMode: input.rvzMode,
      rvzScrub: input.rvzScrub,
      rvzSourceFileName: input.rvzSourceFileName,
      source: input.source,
      threads: input.threads,
    },
    "RVZ compression requires a filesystem path",
    onProgress,
    onLog,
  );

const extractRvzInWorker = (
  input: RvzWorkerExtractInput,
  onProgress?: ProgressCallback,
  onLog?: (record: LogRecord) => void,
): Promise<CompressionWorkerResult> =>
  runCompressionWorkerSourceOperation(
    "dolphin-rvz",
    "extract",
    {
      fileName: input.fileName,
      logLevel: input.logLevel,
      outputName: input.outputName,
      source: input.source,
      threads: input.threads,
    },
    "RVZ extraction requires a filesystem path",
    onProgress,
    onLog,
  );

const listRvzInWorker = (
  input: RvzWorkerListInput,
  onLog?: (record: LogRecord) => void,
): Promise<CompressionWorkerResult> =>
  runCompressionWorkerSourceOperation(
    "dolphin-rvz",
    "list",
    {
      fileName: input.fileName,
      logLevel: input.logLevel,
      source: input.source,
      threads: input.threads,
    },
    "RVZ listing requires a filesystem path",
    undefined,
    onLog,
  );

export { createRvzInWorker, extractRvzInWorker, listRvzInWorker };
