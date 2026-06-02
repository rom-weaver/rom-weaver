import type { LargeFileVfs } from "../storage/vfs/types.ts";
import type { ChecksumResult } from "./checksum.ts";
import type { LogLevel, LogRecord } from "./logging.ts";
import type { OutputStorageKind } from "./output.ts";
import type { JsonObject, JsonValue } from "./runtime.ts";
import type { SourceRef } from "./source.ts";
import type { WorkerOutputRef } from "./worker-messages.ts";
import type { WorkflowCapability } from "./workflow-capability.ts";
import type {
  CompressionCreateInput,
  CompressionCreateResult,
  CompressionExtractInput,
  CompressionExtractResult,
  CompressionListInput,
  CompressionListResult,
  CreatePatchResult,
  PublicOutput,
} from "./workflow-runtime.ts";

type WorkflowRuntimeProgress = {
  label?: string;
  message?: string;
  percent?: number | null;
  [key: string]: JsonValue | undefined;
};

type WorkflowCreatePatchProgress = WorkflowRuntimeProgress & {
  loaded?: string | number | null;
  total?: string | number | null;
};

type WorkflowRuntimeLog = Pick<LogRecord, "details" | "level" | "message" | "namespace" | "timestamp">;
type RuntimeWorkerTraceContext = {
  logLevel?: string;
  onLog?: (log: WorkflowRuntimeLog) => void;
};

type RuntimeWorkerPathSource = {
  cleanup: () => Promise<void>;
  fileName: string;
  filePath: string;
  size?: number;
  virtual?: boolean;
};

type RuntimeWorkerSourceScope =
  | "apply"
  | "archive"
  | "checksum"
  | "chd"
  | "create-patch"
  | "disc-input"
  | "patch-validate"
  | "rvz"
  | "z3ds";

type RuntimeWorkerSourceRequest = {
  fallbackFileName: string;
  pathBucket?: "input" | "patches";
  pathPrefix?: string;
  scope: RuntimeWorkerSourceScope;
  source: unknown;
  trace?: RuntimeWorkerTraceContext;
};

type RuntimeWorkerOutput = {
  applySummary?: JsonObject;
  blob?: Blob;
  checksums?: Record<string, string>;
  cleanup?: () => Promise<void> | void;
  file?: Blob;
  fileName?: string;
  filePath?: string;
  outputRef?: WorkerOutputRef;
  patchFile?: Blob;
  patchFileName?: string;
  patchFilePath?: string;
  size?: number;
};

type RuntimeWorkerIo = {
  createWorkerOutput: (
    result: RuntimeWorkerOutput,
    fallbackFileName: string,
    failureMessage?: string,
  ) => Promise<PublicOutput>;
  releaseSources?: (sources: unknown[]) => Promise<void>;
  runPathWorkerToOutput: (input: {
    failureMessage?: string;
    fallbackFileName: string;
    outputName: string;
    pathPrefix?: string;
    run: (workerSource: RuntimeWorkerPathSource) => Promise<RuntimeWorkerOutput>;
    scope: RuntimeWorkerSourceScope;
    source: unknown;
    trace?: RuntimeWorkerTraceContext;
  }) => Promise<PublicOutput>;
  stageSource: (request: RuntimeWorkerSourceRequest) => Promise<RuntimeWorkerPathSource>;
  stageSources: (requests: RuntimeWorkerSourceRequest[]) => Promise<RuntimeWorkerPathSource[]>;
};

type RuntimePublicOutputAdapter = {
  getBlob: (output: PublicOutput) => Promise<Blob>;
  getSize: (output: PublicOutput) => number | undefined;
  getStorage: (output: PublicOutput) => OutputStorageKind;
  saveAs: (output: PublicOutput, destination?: unknown) => Promise<void>;
};

type RuntimeArchiveCreateInput = Extract<CompressionCreateInput, { entries: unknown }>;
type RuntimeCompressionExtractInput = CompressionExtractInput;
type RuntimeCompressionListInput = CompressionListInput;
type RuntimeDiscCreateInputBase = Extract<CompressionCreateInput, { source: unknown }>;

type RuntimeDiscProgress = {
  label?: string;
  message?: string;
  percent?: number | null;
};

type RuntimeDiscHooks = {
  logLevel?: LogLevel;
  onLog?: (log: WorkflowRuntimeLog) => void;
  onProgress?: (progress: RuntimeDiscProgress) => void;
  threads?: number | string | null;
};

type RuntimeDiscCreateChdInput = RuntimeDiscHooks & {
  chdSourceMode?: RuntimeDiscCreateInputBase["chdSourceMode"];
  compressionCodecs?: RuntimeDiscCreateInputBase["compressionCodecs"];
  cueFilePath?: RuntimeDiscCreateInputBase["cueFilePath"];
  fileName?: RuntimeDiscCreateInputBase["fileName"];
  imageFiles?: RuntimeDiscCreateInputBase["imageFiles"];
  mode?: RuntimeDiscCreateInputBase["mode"];
  outputName: RuntimeDiscCreateInputBase["outputName"];
  source: RuntimeDiscCreateInputBase["source"];
};

type RuntimeDiscCreateRvzInput = RuntimeDiscHooks & {
  fileName?: RuntimeDiscCreateInputBase["fileName"];
  outputName: RuntimeDiscCreateInputBase["outputName"];
  rvzBlockSize?: RuntimeDiscCreateInputBase["rvzBlockSize"];
  rvzCompression?: RuntimeDiscCreateInputBase["rvzCompression"];
  rvzCompressionLevel?: RuntimeDiscCreateInputBase["rvzCompressionLevel"];
  rvzMode?: RuntimeDiscCreateInputBase["rvzMode"];
  rvzScrub?: RuntimeDiscCreateInputBase["rvzScrub"];
  rvzSourceFileName?: RuntimeDiscCreateInputBase["rvzSourceFileName"];
  source: RuntimeDiscCreateInputBase["source"];
};

type RuntimeDiscCreateZ3dsInput = RuntimeDiscHooks & {
  fileName?: RuntimeDiscCreateInputBase["fileName"];
  outputName: RuntimeDiscCreateInputBase["outputName"];
  source: RuntimeDiscCreateInputBase["source"];
  z3dsCompressionLevel?: RuntimeDiscCreateInputBase["z3dsCompressionLevel"];
  z3dsMetadata?: RuntimeDiscCreateInputBase["z3dsMetadata"];
  z3dsSourceFileName?: RuntimeDiscCreateInputBase["z3dsSourceFileName"];
  z3dsUnderlyingMagic?: RuntimeDiscCreateInputBase["z3dsUnderlyingMagic"];
};

type RuntimeDiscExtractChdInput = RuntimeDiscHooks & {
  fileName: string;
  mode?: RuntimeDiscCreateInputBase["mode"];
  outputName?: CompressionExtractInput["outputName"];
  source: CompressionExtractInput["source"];
  splitBin?: boolean;
};

type RuntimeDiscExtractRvzInput = RuntimeDiscHooks & {
  fileName: string;
  outputName?: CompressionExtractInput["outputName"];
  source: CompressionExtractInput["source"];
};

type RuntimeDiscExtractZ3dsInput = RuntimeDiscHooks & {
  fileName: string;
  outputName?: CompressionExtractInput["outputName"];
  source: CompressionExtractInput["source"];
};

type RuntimePatchWorkerProgress = {
  label?: string;
  loaded?: string | number | boolean | null;
  message?: string;
  percent?: number | null;
  total?: string | number | boolean | null;
};

type RuntimePatchApplyWorkerInput = {
  logLevel?: LogLevel;
  options?: JsonObject;
  patchFormat?: string;
  patchFileName?: string;
  patchFilePath?: string;
  patchFiles: Array<{ patchFileName: string; patchFilePath: string; patchFormat?: string }>;
  romFileName: string;
  romFilePath: string;
};

type RuntimePatchValidateWorkerInput = {
  logLevel?: LogLevel;
  options?: JsonObject;
  patchFiles: Array<{ patchFileName: string; patchFilePath: string; patchFormat?: string }>;
  romFileName: string;
  romFilePath: string;
};

type RuntimePatchCreateWorkerInput = {
  format: string;
  logLevel?: LogLevel;
  metadata: Record<string, JsonValue>;
  modifiedFileName: string;
  modifiedFilePath: string;
  originalFileName: string;
  originalFilePath: string;
  outputName: string;
  workerThreads?: number | string | null;
};

type WorkflowRuntimeOutput = {
  createBytes: (bytes: Uint8Array, fileName: string) => Promise<PublicOutput>;
  createSource?: (source: SourceRef, fileName: string) => Promise<PublicOutput>;
};

type WorkflowRuntimeCompression = {
  create?: (input: CompressionCreateInput) => Promise<CompressionCreateResult | PublicOutput>;
  extract?: (input: CompressionExtractInput) => Promise<CompressionExtractResult>;
  list?: (input: CompressionListInput) => Promise<CompressionListResult>;
};

type WorkflowRuntimeBinary = {
  assertSource: (source: SourceRef, context: string) => void;
};

type WorkflowRuntimeChecksum = {
  calculate?: (input: {
    source: unknown;
    algorithms: string[];
    startOffset?: number;
    logLevel?: LogLevel;
    onLog?: (log: WorkflowRuntimeLog) => void;
    onProgress?: (progress: WorkflowRuntimeProgress) => void;
  }) => Promise<ChecksumResult>;
};

type WorkflowRuntimePatch = {
  applyPatch?: (input: {
    input: SourceRef;
    patches: Array<{
      patchFile: SourceRef;
      patchFileName?: string;
      patchFormat?: string;
    }>;
    options?: JsonObject;
    logLevel?: LogLevel;
    onLog?: (log: WorkflowRuntimeLog) => void;
    onProgress?: (progress: WorkflowCreatePatchProgress) => void;
  }) => Promise<PublicOutput>;
  validatePatch?: (input: {
    input: SourceRef;
    patches: Array<{
      patchFile: SourceRef;
      patchFileName?: string;
      patchFormat?: string;
      requirements?: {
        minimumSourceSize?: number;
        sourceCrc32?: string;
        sourceSize?: number;
      };
    }>;
    options?: JsonObject;
    logLevel?: LogLevel;
    onLog?: (log: WorkflowRuntimeLog) => void;
    onProgress?: (progress: WorkflowCreatePatchProgress) => void;
  }) => Promise<{
    message?: string;
    status: "passed";
  }>;
  inspectPatch?: (input: {
    patch: SourceRef;
    patchFileName?: string;
    logLevel?: LogLevel;
    onLog?: (log: WorkflowRuntimeLog) => void;
    onProgress?: (progress: WorkflowRuntimeProgress) => void;
  }) => Promise<{
    format?: string | null;
    minimum_source_size?: number | null;
    patch_crc32?: number | null;
    record_count?: number | null;
    source_crc32?: number | null;
    source_size?: number | null;
    source_window_count?: number | null;
    target_crc32?: number | null;
    target_size?: number | null;
    target_window_count?: number | null;
    window_checksum_count?: number | null;
  }>;
  createPatch?: (input: {
    original: SourceRef;
    modified: SourceRef;
    format: string;
    metadata: JsonObject;
    outputName: string;
    workerThreads?: number | string | null;
    logLevel?: LogLevel;
    onLog?: (log: WorkflowRuntimeLog) => void;
    onProgress?: (progress: WorkflowCreatePatchProgress) => void;
  }) => Promise<CreatePatchResult>;
};

type WorkflowRuntimeSidecars = {
  read?: (sourcePath: string, referencedName: string) => Promise<SourceRef>;
  list?: (sourcePath: string) => Promise<SourceRef[]>;
};

type WorkflowRuntimePreloadEvent =
  | {
      kind: "capability";
      data: {
        capability: WorkflowCapability;
        status: "available" | "failed" | "loading" | "ready" | "unavailable";
      };
    }
  | {
      kind: "worker";
      data: {
        capability: WorkflowCapability;
        status: "busy" | "cleanup" | "created" | "failed" | "idle" | "loading" | "ready" | "terminated";
        workerKind?: string;
      };
    }
  | {
      kind: "wasm";
      data: {
        capability: WorkflowCapability;
        status: "failed" | "instantiated" | "loaded" | "loading";
        tool?: string;
      };
    }
  | {
      kind: "log";
      data: {
        capability: WorkflowCapability;
        level: "debug" | "error" | "info" | "trace" | "warn";
        message: string;
      };
    };

type WorkflowRuntimePreload = {
  preloadCapability?: (
    capability: WorkflowCapability,
    emit: (event: WorkflowRuntimePreloadEvent) => void,
    options?: { workerThreads?: number | string | null },
  ) => Promise<void>;
};

type WorkflowRuntime = {
  name: "browser";
  useBlobOutput: boolean;
  compression: WorkflowRuntimeCompression;
  binary: WorkflowRuntimeBinary;
  checksum: WorkflowRuntimeChecksum;
  output: WorkflowRuntimeOutput;
  publicOutput: RuntimePublicOutputAdapter;
  patch: WorkflowRuntimePatch;
  preload?: WorkflowRuntimePreload;
  sidecars: WorkflowRuntimeSidecars;
  vfs: LargeFileVfs;
  workerIo: RuntimeWorkerIo;
};

export type {
  RuntimeArchiveCreateInput,
  RuntimeCompressionExtractInput,
  RuntimeCompressionListInput,
  RuntimeDiscCreateChdInput,
  RuntimeDiscCreateRvzInput,
  RuntimeDiscCreateZ3dsInput,
  RuntimeDiscExtractChdInput,
  RuntimeDiscExtractRvzInput,
  RuntimeDiscExtractZ3dsInput,
  RuntimeDiscHooks,
  RuntimeDiscProgress,
  RuntimePatchApplyWorkerInput,
  RuntimePatchCreateWorkerInput,
  RuntimePatchValidateWorkerInput,
  RuntimePatchWorkerProgress,
  RuntimePublicOutputAdapter,
  RuntimeWorkerIo,
  RuntimeWorkerOutput,
  RuntimeWorkerPathSource,
  RuntimeWorkerSourceRequest,
  RuntimeWorkerSourceScope,
  WorkflowCreatePatchProgress,
  WorkflowRuntime,
  WorkflowRuntimeBinary,
  WorkflowRuntimeChecksum,
  WorkflowRuntimeCompression,
  WorkflowRuntimeLog,
  WorkflowRuntimeOutput,
  WorkflowRuntimePatch,
  WorkflowRuntimePreload,
  WorkflowRuntimePreloadEvent,
  WorkflowRuntimeProgress,
  WorkflowRuntimeSidecars,
};
