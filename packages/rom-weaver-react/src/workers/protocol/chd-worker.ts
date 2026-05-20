import type { LogRecord } from "../../types/logging.ts";
import type { ProgressCallback } from "../../types/runtime.ts";
import type { ChdCompressionCodecs } from "../../types/workflow-compression.ts";
import { type BinaryWorkerSource, runCompressionWorkerSourceOperation } from "./compression-worker-client.ts";
import type { CompressionWorkerResult } from "./worker-protocol.ts";

type ChdWorkerCreateInput = {
  fileName: string;
  source: BinaryWorkerSource;
  outputName: string;
  logLevel?: string;
  mode?: string | null;
  chdSourceMode?: string | null;
  cueText?: string | null;
  threads?: number | string | null;
  compressionCodecs?: ChdCompressionCodecs | null;
};

type ChdWorkerExtractInput = {
  fileName: string;
  source: BinaryWorkerSource;
  outputName?: string;
  logLevel?: string;
  mode?: string | null;
  threads?: number | string | null;
};

type ChdWorkerListInput = {
  fileName: string;
  source: BinaryWorkerSource;
  logLevel?: string;
  mode?: string | null;
  threads?: number | string | null;
};

const createChdInWorker = (
  input: ChdWorkerCreateInput,
  onProgress?: ProgressCallback,
  onLog?: (record: LogRecord) => void,
): Promise<CompressionWorkerResult> =>
  runCompressionWorkerSourceOperation(
    "chdman",
    "create",
    {
      chdSourceMode: input.chdSourceMode,
      compressionCodecs: input.compressionCodecs,
      cueText: input.cueText,
      fileName: input.fileName,
      logLevel: input.logLevel,
      mode: input.mode,
      outputName: input.outputName,
      source: input.source,
      threads: input.threads,
    },
    "CHD compression requires a filesystem path",
    onProgress,
    onLog,
  );

const extractChdInWorker = (
  input: ChdWorkerExtractInput,
  onProgress?: ProgressCallback,
  onLog?: (record: LogRecord) => void,
): Promise<CompressionWorkerResult> =>
  runCompressionWorkerSourceOperation(
    "chdman",
    "extract",
    {
      fileName: input.fileName,
      logLevel: input.logLevel,
      mode: input.mode,
      outputName: input.outputName,
      source: input.source,
      threads: input.threads,
    },
    "CHD extraction requires a filesystem path",
    onProgress,
    onLog,
  );

const listChdInWorker = (
  input: ChdWorkerListInput,
  onLog?: (record: LogRecord) => void,
): Promise<CompressionWorkerResult> =>
  runCompressionWorkerSourceOperation(
    "chdman",
    "list",
    {
      fileName: input.fileName,
      logLevel: input.logLevel,
      mode: input.mode,
      source: input.source,
      threads: input.threads,
    },
    "CHD listing requires a filesystem path",
    undefined,
    onLog,
  );

export { createChdInWorker, extractChdInWorker, listChdInWorker };
