import type { Timing } from "../../lib/progress/timing.ts";
import type { WorkflowErrorCode } from "../../types/errors.ts";
import type { LogLevel } from "../../types/logging.ts";
import type { ArchiveEntry, ArchiveEntryInput, CleanupCallback, JsonValue } from "../../types/runtime.ts";
import type { WorkerCleanupRef, WorkerKind, WorkerOutputRef } from "../../types/worker-messages.ts";
import type { ChecksumResult } from "./patch-engine.ts";

type WorkerRequestId = string;
type WorkerPayloadValue = JsonValue | Blob | FileSystemFileHandle | Transferable[] | object | undefined;
type WorkerMessagePayload = Record<string, WorkerPayloadValue> | string | number | boolean | null | undefined;

type BrowserWorkerFile = Blob & {
  name?: string;
  type?: string;
};

type WorkerSuccessMessage<TAction extends string, TPayload extends object = object> = {
  action: TAction;
  requestId?: WorkerRequestId;
  success: true;
  timestamp?: number;
} & TPayload;

type WorkerReadyMessage = {
  action: "ready";
  requestId?: WorkerRequestId;
  timestamp?: number;
};

type WorkerFatalMessage = {
  action: "fatal";
  error?: { code?: WorkflowErrorCode; message?: string; details?: Record<string, unknown> };
  requestId?: WorkerRequestId;
  success?: false;
  type?: "error";
  timestamp?: number;
  workerKind: WorkerKind;
};

type WorkerProgressMessage<TProgress = object> = {
  action: "progress";
  progress: TProgress;
  requestId?: WorkerRequestId;
  type?: "progress";
  timestamp?: number;
  workerKind: WorkerKind;
};

type WorkerScopeEventMap<TRequest> = {
  message: MessageEvent<TRequest>;
  error: ErrorEvent;
  unhandledrejection: PromiseRejectionEvent;
};

type WorkerScopeLike<TRequest = object> = {
  onmessage: ((event: MessageEvent<TRequest>) => void) | null;
  postMessage(message: WorkerMessagePayload, options?: { transfer?: Transferable[] }): void;
  addEventListener<TKey extends keyof WorkerScopeEventMap<TRequest>>(
    type: TKey,
    listener: (event: WorkerScopeEventMap<TRequest>[TKey]) => void,
  ): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
};

type ChecksumDiagnostics = {
  algorithms: string[];
  bytes: number;
  chunks: number;
  digestMs: number;
  hasherInitMs: number;
  readMode: string;
  readMs: number;
  totalMs: number;
  updateMs: number;
};

type ChecksumWorkerRequest = {
  action: string;
  benchmarkFilePath?: string;
  benchmarkFileSize?: number;
  checksumAlgorithms?: string[] | string;
  checksumChunkSize?: number | string;
  checksumStartOffset?: number | string;
  file?: Blob;
  fileHandle?: FileSystemFileHandle;
  filePath?: string;
  fileName?: string;
  fileSize?: number;
  logLevel?: LogLevel | string;
  requestId?: WorkerRequestId;
  streamId?: WorkerRequestId;
  streamTotalBytes?: number | string;
  u8array?: Uint8Array;
  workerKind: WorkerKind;
};

type ChecksumProgressResponse = {
  action: "checksum-progress";
  progress: {
    label: string;
    percent: number;
  };
  requestId?: WorkerRequestId;
  type?: "progress";
  timestamp?: number;
  workerKind: WorkerKind;
};

type ChecksumErrorResponse = {
  action: "checksum-error";
  error: { code?: WorkflowErrorCode; message: string; details?: Record<string, unknown> };
  requestId?: WorkerRequestId;
  type?: "error";
  timestamp?: number;
  workerKind: WorkerKind;
};

type ChecksumCompleteResponse = {
  action: string;
  adler32?: number;
  checksumStartOffset: number;
  crc16?: number;
  crc32?: number;
  diagnostics?: ChecksumDiagnostics;
  md5?: string;
  requestId?: WorkerRequestId;
  rom: Blob | Uint8Array | string | null;
  sha1?: string;
  timing?: Partial<Timing> | null;
  u8array?: Uint8Array;
  cacheHit?: boolean;
  type?: "result";
  timestamp?: number;
  workerKind: WorkerKind;
};

type BrowserChecksumResult = {
  checksums: ChecksumResult;
  rom: Blob | Uint8Array | string | null;
  u8array?: Uint8Array;
};

type BrowserCreatePatchWorkerRequest = {
  action: "create-patch";
  format: string;
  metadata?: Record<string, JsonValue>;
  modifiedFilePath?: string;
  modifiedFileName: string;
  originalFilePath?: string;
  originalFileName: string;
  outputName: string;
  logLevel?: string;
  requestId: WorkerRequestId;
  workerThreads?: number | string;
};

type BrowserCreatePatchWorkerCleanupRequest = {
  action: "cleanup";
  filePaths: string[];
  requestId: WorkerRequestId;
};

type BrowserCreatePatchWorkerResponse = {
  action?: string;
  cleanupRef?: WorkerCleanupRef;
  error?: { code?: WorkflowErrorCode; details?: Record<string, unknown>; message?: string };
  fileName?: string;
  outputRef?: WorkerOutputRef;
  requestId?: WorkerRequestId;
  success?: boolean;
  timestamp?: number;
};

type BrowserCreatePatchWorkerInput = {
  format: string;
  metadata?: Record<string, JsonValue>;
  modifiedFilePath?: string;
  modifiedFileName: string;
  originalFilePath?: string;
  originalFileName: string;
  outputName: string;
  logLevel?: string;
  workerThreads?: number | string;
};

type BrowserCreatePatchWorkerResult = {
  cleanup?: () => Promise<void> | void;
  fileName: string;
  filePath?: string;
  outputRef?: WorkerOutputRef;
  size: number;
  timestamp?: number;
};

type BrowserApplyPatchWorkerInput = {
  logLevel?: string;
  options?: Record<string, JsonValue>;
  patchFilePath?: string;
  patchFileName?: string;
  patchFiles?: Array<{ patchFilePath: string; patchFileName?: string }>;
  romFilePath?: string;
  romFileName?: string;
};

type BrowserApplyPatchWorkerResult = {
  applySummary?: {
    outputSize?: number;
    patches?: Array<{
      fileName: string;
      format: string;
      size?: number;
    }>;
    patchSize?: number;
    rom?: {
      fileName: string;
      size?: number;
    };
    timing?: Partial<Timing> | null;
  };
  cleanup?: () => Promise<void> | void;
  fileName: string;
  filePath?: string;
  outputRef?: WorkerOutputRef;
  size: number;
  timing?: Partial<Timing> | null;
  timestamp?: number;
};

type PatchWorkerSummaryValidationInfo = {
  type?: string;
  value?: JsonValue;
  targetValue?: JsonValue;
  scope?: string;
};

type PatchWorkerSummary = {
  description?: string | null;
  validationInfo?: JsonValue | PatchWorkerSummaryValidationInfo | null;
};

type BrowserParsePatchWorkerInput = {
  patchFilePath: string;
  patchFileName?: string;
};

type BrowserParsePatchWorkerResponse = {
  action?: string;
  error?: { code?: WorkflowErrorCode; details?: Record<string, unknown>; message?: string };
  patch?: PatchWorkerSummary | null;
  requestId?: WorkerRequestId;
  success?: boolean;
  timestamp?: number;
};

type BrowserParsePatchWorkerResult = PatchWorkerSummary | null;

type CreatePatchWorkerRequest = {
  action: "cleanup" | "create-patch";
  filePaths?: string[];
  format?: string;
  metadata?: Record<string, JsonValue>;
  modifiedFile?: BrowserWorkerFile;
  modifiedFilePath?: string;
  modifiedFileName?: string;
  originalFile?: BrowserWorkerFile;
  originalFilePath?: string;
  originalFileName?: string;
  outputName?: string;
  logLevel?: string;
  requestId?: WorkerRequestId;
  workerThreads?: number | string;
};

type CompressionWorkerKind = "7zip-zstd" | "chdman" | "dolphin-rvz" | "azahar-z3ds";
type CompressionWorkerOperation = "warmup" | "list" | "extract" | "create" | "cleanup";

type CompressionWorkerRequest = {
  archiveEntryName?: string;
  archiveFileName?: string;
  arrayBuffer?: ArrayBuffer;
  chdCueText?: string;
  chdFile?: BrowserWorkerFile;
  chdFileName?: string;
  chdFilePath?: string;
  chdMode?: string;
  codec?: string;
  compression?: string;
  compressionCodecs?: string | string[] | Record<string, string | number> | null;
  cueInputFileName?: string;
  entries?: ArchiveEntryInput[];
  entryName?: string;
  file?: Blob;
  fileName?: string;
  filePath?: string;
  filePaths?: string[];
  imageFile?: BrowserWorkerFile;
  imageFilePath?: string;
  imageFiles?: Array<{ file?: BrowserWorkerFile; fileName?: string; filePath?: string }>;
  kind: CompressionWorkerKind;
  level?: number | string | null;
  logLevel?: string;
  mode?: string;
  outputName?: string;
  operation: CompressionWorkerOperation;
  requestId?: WorkerRequestId;
  rvzBlockSize?: string | number | null;
  rvzCompression?: string;
  rvzCompressionLevel?: string | number | null;
  rvzFile?: BrowserWorkerFile;
  rvzFileName?: string;
  rvzFilePath?: string;
  rvzMode?: string;
  rvzScrub?: boolean | string | number | null;
  rvzSourceFileName?: string;
  threads?: number | string | null;
  u8array?: Uint8Array;
  z3dsCompressionLevel?: string | number | null;
  z3dsFile?: BrowserWorkerFile;
  z3dsFileName?: string;
  z3dsFilePath?: string;
  z3dsMetadata?: Record<string, JsonValue | Uint8Array | null | undefined> | null;
  z3dsSourceFileName?: string;
  z3dsUnderlyingMagic?: string;
  workerKind: WorkerKind;
};

type CompressionWorkerResult = {
  archiveEntryName?: string;
  archiveEntryType?: string;
  archiveFileName?: string;
  chdCueFileName?: string;
  chdCueText?: string;
  chdMode?: string;
  chdSourceFileName?: string;
  cleanup?: CleanupCallback;
  cleanupRef?: WorkerCleanupRef;
  cleanupPaths?: string[] | null;
  entries?: ArchiveEntry[];
  entry?: ArchiveEntry;
  file?: Blob;
  fileName?: string;
  filePath?: string;
  kind: CompressionWorkerKind;
  operation: CompressionWorkerOperation;
  outputRef?: WorkerOutputRef;
  rvzMode?: string;
  rvzSourceFileName?: string;
  timing?: Partial<Timing> | null;
  timestamp?: number;
  z3dsMetadata?: JsonValue | Record<string, JsonValue | Uint8Array | null | undefined> | null;
  z3dsSourceFileName?: string;
  z3dsUnderlyingMagic?: string;
  workerKind: WorkerKind;
};

export type {
  BrowserApplyPatchWorkerInput,
  BrowserApplyPatchWorkerResult,
  BrowserChecksumResult,
  BrowserCreatePatchWorkerCleanupRequest,
  BrowserCreatePatchWorkerInput,
  BrowserCreatePatchWorkerRequest,
  BrowserCreatePatchWorkerResponse,
  BrowserCreatePatchWorkerResult,
  BrowserParsePatchWorkerInput,
  BrowserParsePatchWorkerResponse,
  BrowserParsePatchWorkerResult,
  BrowserWorkerFile,
  ChecksumCompleteResponse,
  ChecksumDiagnostics,
  ChecksumErrorResponse,
  ChecksumProgressResponse,
  ChecksumWorkerRequest,
  CompressionWorkerKind,
  CompressionWorkerOperation,
  CompressionWorkerRequest,
  CompressionWorkerResult,
  CreatePatchWorkerRequest,
  PatchWorkerSummary,
  PatchWorkerSummaryValidationInfo,
  WorkerCleanupRef,
  WorkerFatalMessage,
  WorkerOutputRef,
  WorkerProgressMessage,
  WorkerReadyMessage,
  WorkerRequestId,
  WorkerScopeEventMap,
  WorkerScopeLike,
  WorkerSuccessMessage,
};
