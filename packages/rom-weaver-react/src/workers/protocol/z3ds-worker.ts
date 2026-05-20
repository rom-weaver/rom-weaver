import type { LogRecord } from "../../types/logging.ts";
import type { ProgressCallback } from "../../types/runtime.ts";
import type { CompressionOptionValue } from "../../types/workflow-compression.ts";
import { type BinaryWorkerSource, runCompressionWorkerSourceOperation } from "./compression-worker-client.ts";
import type { CompressionWorkerResult } from "./worker-protocol.ts";

type Z3dsWorkerCreateInput = {
  fileName: string;
  source: BinaryWorkerSource;
  outputName: string;
  logLevel?: string;
  threads?: number | string | null;
  z3dsCompressionLevel?: string | number | null;
  z3dsMetadata?: RuntimeValue;
  z3dsOptions?: Record<string, CompressionOptionValue> | null;
  z3dsSourceFileName?: string | null;
  z3dsUnderlyingMagic?: string | null;
};

type Z3dsWorkerExtractInput = {
  fileName: string;
  source: BinaryWorkerSource;
  outputName?: string;
  logLevel?: string;
  threads?: number | string | null;
};

type Z3dsWorkerListInput = {
  fileName: string;
  source: BinaryWorkerSource;
  logLevel?: string;
  threads?: number | string | null;
};

const createZ3dsInWorker = (
  input: Z3dsWorkerCreateInput,
  onProgress?: ProgressCallback,
  onLog?: (record: LogRecord) => void,
): Promise<CompressionWorkerResult> =>
  runCompressionWorkerSourceOperation(
    "azahar-z3ds",
    "create",
    {
      fileName: input.fileName,
      logLevel: input.logLevel,
      outputName: input.outputName,
      source: input.source,
      threads: input.threads,
      z3dsCompressionLevel: input.z3dsCompressionLevel ?? input.z3dsOptions?.compressionLevel ?? null,
      z3dsMetadata: input.z3dsMetadata,
      z3dsOptions: input.z3dsOptions,
      z3dsSourceFileName: input.z3dsSourceFileName,
      z3dsUnderlyingMagic: input.z3dsUnderlyingMagic,
    },
    "Z3DS compression requires a filesystem path",
    onProgress,
    onLog,
  );

const extractZ3dsInWorker = (
  input: Z3dsWorkerExtractInput,
  onProgress?: ProgressCallback,
  onLog?: (record: LogRecord) => void,
): Promise<CompressionWorkerResult> =>
  runCompressionWorkerSourceOperation(
    "azahar-z3ds",
    "extract",
    {
      fileName: input.fileName,
      logLevel: input.logLevel,
      outputName: input.outputName,
      source: input.source,
      threads: input.threads,
    },
    "Z3DS extraction requires a filesystem path",
    onProgress,
    onLog,
  );

const listZ3dsInWorker = (
  input: Z3dsWorkerListInput,
  onLog?: (record: LogRecord) => void,
): Promise<CompressionWorkerResult> =>
  runCompressionWorkerSourceOperation(
    "azahar-z3ds",
    "list",
    {
      fileName: input.fileName,
      logLevel: input.logLevel,
      source: input.source,
      threads: input.threads,
    },
    "Z3DS listing requires a filesystem path",
    undefined,
    onLog,
  );

export { createZ3dsInWorker, extractZ3dsInWorker, listZ3dsInWorker };
