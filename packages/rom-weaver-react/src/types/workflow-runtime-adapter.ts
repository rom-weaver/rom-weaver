import type { LargeFileVfs } from "../storage/vfs/types.ts";
import type {
  PatchApplyCommand,
  PatchCreateCandidatesCommand,
  PatchCreateCommand,
  PatchValidateCommand,
  ThreadBudget,
} from "../wasm/index.ts";
import type { ChecksumResult, ChecksumVariant, RomTypeTag } from "./checksum.ts";
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
  TrimResult,
} from "./workflow-runtime-types.ts";

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
  checksumVariants?: ChecksumVariant[];
  cleanup?: () => Promise<void> | void;
  cueText?: string;
  discGroupId?: string;
  file?: Blob;
  fileName?: string;
  filePath?: string;
  gdiText?: string;
  outputRef?: WorkerOutputRef;
  patchFile?: Blob;
  patchFileName?: string;
  patchFilePath?: string;
  romType?: RomTypeTag;
  size?: number;
  timing?: PublicOutput["timing"];
  trackNumber?: number;
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
type RuntimeRomSpecificCreateInputBase = Extract<CompressionCreateInput, { source: unknown }>;
type RuntimeRomSpecificCreateOptions = NonNullable<RuntimeRomSpecificCreateInputBase["romSpecific"]>;
type RuntimeRomSpecificCreateChdOptions = NonNullable<RuntimeRomSpecificCreateOptions["chd"]>;
type RuntimeRomSpecificCreateRvzOptions = NonNullable<RuntimeRomSpecificCreateOptions["rvz"]>;
type RuntimeRomSpecificCreateZ3dsOptions = NonNullable<RuntimeRomSpecificCreateOptions["z3ds"]>;

type RuntimeRomSpecificProgress = {
  label?: string;
  message?: string;
  percent?: number | null;
};

type RuntimeRomSpecificHooks = {
  logLevel?: LogLevel;
  onLog?: (log: WorkflowRuntimeLog) => void;
  onProgress?: (progress: RuntimeRomSpecificProgress) => void;
  signal?: AbortSignal;
  threads?: RuntimeThreadBudgetInput;
};

type RuntimeRomSpecificCreateChdInput = RuntimeRomSpecificHooks & {
  compressionCodecs?: RuntimeRomSpecificCreateChdOptions["compressionCodecs"];
  cueFilePath?: RuntimeRomSpecificCreateChdOptions["cueFilePath"];
  fileName?: RuntimeRomSpecificCreateInputBase["fileName"];
  imageFiles?: RuntimeRomSpecificCreateChdOptions["imageFiles"];
  mode?: RuntimeRomSpecificCreateChdOptions["mode"];
  outputName: RuntimeRomSpecificCreateInputBase["outputName"];
  source: RuntimeRomSpecificCreateInputBase["source"];
  sourceMode?: RuntimeRomSpecificCreateChdOptions["sourceMode"];
};

type RuntimeRomSpecificCreateRvzInput = RuntimeRomSpecificHooks & {
  blockSize?: RuntimeRomSpecificCreateRvzOptions["blockSize"];
  codec?: RuntimeRomSpecificCreateRvzOptions["codec"];
  compressionLevel?: RuntimeRomSpecificCreateRvzOptions["compressionLevel"];
  fileName?: RuntimeRomSpecificCreateInputBase["fileName"];
  mode?: RuntimeRomSpecificCreateRvzOptions["mode"];
  outputName: RuntimeRomSpecificCreateInputBase["outputName"];
  scrub?: RuntimeRomSpecificCreateRvzOptions["scrub"];
  sourceFileName?: RuntimeRomSpecificCreateRvzOptions["sourceFileName"];
  source: RuntimeRomSpecificCreateInputBase["source"];
};

type RuntimeRomSpecificCreateZ3dsInput = RuntimeRomSpecificHooks & {
  compressionLevel?: RuntimeRomSpecificCreateZ3dsOptions["compressionLevel"];
  fileName?: RuntimeRomSpecificCreateInputBase["fileName"];
  metadata?: RuntimeRomSpecificCreateZ3dsOptions["metadata"];
  outputName: RuntimeRomSpecificCreateInputBase["outputName"];
  sourceFileName?: RuntimeRomSpecificCreateZ3dsOptions["sourceFileName"];
  source: RuntimeRomSpecificCreateInputBase["source"];
  underlyingMagic?: RuntimeRomSpecificCreateZ3dsOptions["underlyingMagic"];
};

type RuntimeRomSpecificExtractChdInput = RuntimeRomSpecificHooks & {
  fileName: string;
  mode?: RuntimeRomSpecificCreateChdOptions["mode"];
  outputName?: CompressionExtractInput["outputName"];
  source: CompressionExtractInput["source"];
  splitBin?: boolean;
};

type RuntimeRomSpecificExtractRvzInput = RuntimeRomSpecificHooks & {
  fileName: string;
  outputName?: CompressionExtractInput["outputName"];
  source: CompressionExtractInput["source"];
};

type RuntimeRomSpecificExtractZ3dsInput = RuntimeRomSpecificHooks & {
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

type RuntimeThreadBudgetInput = ThreadBudget | string | number | null;

type RuntimePatchValidationRequirement = {
  minimumSourceSize?: string | number | null;
  minimum_source_size?: string | number | null;
  sourceCrc32?: string | number | null;
  sourceSize?: string | number | null;
  source_crc32?: string | number | null;
  source_size?: string | number | null;
};

type RuntimeChecksumCacheInput =
  | PatchValidateCommand["checksum_cache"]
  | Record<string, string | number | null | undefined>;

type RuntimePatchApplyOptions = Partial<Omit<PatchApplyCommand, "input" | "output" | "patches">> & {
  addHeader?: PatchApplyCommand["add_header"];
  appendOutputSuffix?: boolean;
  fixChecksum?: PatchApplyCommand["repair_checksum"];
  n64ByteOrder?: PatchApplyCommand["n64_byte_order"];
  outputExtension?: string | null | undefined;
  outputName?: string | null | undefined;
  ppfUndoAware?: PatchApplyCommand["ppf_undo_aware"];
  removeHeader?: PatchApplyCommand["strip_header"];
  requireInputChecksumMatch?: boolean;
  requireOutputChecksumMatch?: boolean;
  validateWithChecksums?: PatchApplyCommand["validate_with_checksums"];
  validateWithOutputChecksums?: PatchApplyCommand["validate_with_output_checksums"];
  workerThreads?: RuntimeThreadBudgetInput;
};

type RuntimePatchValidateOptions = Partial<Omit<PatchValidateCommand, "input" | "patches">> & {
  checksumCache?: RuntimeChecksumCacheInput;
  ignoreChecksumValidation?: PatchValidateCommand["ignore_checksum_validation"];
  n64ByteOrder?: PatchValidateCommand["n64_byte_order"];
  removeHeader?: PatchValidateCommand["strip_header"];
  validateWithChecksums?: PatchValidateCommand["validate_with_checksums"];
  validationRequirements?: RuntimePatchValidationRequirement | RuntimePatchValidationRequirement[];
  workerThreads?: RuntimeThreadBudgetInput;
};

type RuntimePatchApplyWorkerInput = {
  inputSize?: number;
  logLevel?: LogLevel;
  options?: RuntimePatchApplyOptions;
  patchFormat?: string;
  patchFileName?: string;
  patchFilePath?: string;
  patchFiles: Array<{ patchFileName: string; patchFilePath: string; patchFormat?: string }>;
  romFileName: string;
  romFilePath: string;
  signal?: AbortSignal;
};

type RuntimePatchValidateWorkerInput = {
  inputSize?: number;
  logLevel?: LogLevel;
  options?: RuntimePatchValidateOptions;
  patchFiles: Array<{ patchFileName: string; patchFilePath: string; patchFormat?: string }>;
  romFileName: string;
  romFilePath: string;
  signal?: AbortSignal;
};

type RuntimePatchCreateWorkerInput = {
  checksumName?: PatchCreateCommand["checksum_name"];
  format: NonNullable<PatchCreateCommand["format"]>;
  logLevel?: LogLevel;
  metadata: Record<string, JsonValue>;
  modifiedFileName: string;
  modifiedFilePath: PatchCreateCommand["modified"];
  originalFileName: string;
  originalFilePath: PatchCreateCommand["original"];
  outputName: PatchCreateCommand["output"];
  signal?: AbortSignal;
  sourceCrc32?: PatchCreateCommand["source_crc32"];
  workerThreads?: RuntimeThreadBudgetInput;
};

type RuntimePatchCreateCandidatesWorkerInput = {
  logLevel?: LogLevel;
  modifiedFileName: string;
  modifiedFilePath: PatchCreateCandidatesCommand["modified"];
  originalFileName: string;
  originalFilePath: PatchCreateCandidatesCommand["original"];
  signal?: AbortSignal;
  workerThreads?: RuntimeThreadBudgetInput;
};

type RuntimePatchCreateFormatCandidates = {
  defaultFormat: string;
  formats: string[];
  limits?: Record<string, number>;
  sourceValues?: Record<string, unknown>;
};

type RuntimeTrimWorkerInput = {
  extension?: string;
  logLevel?: LogLevel;
  outputName: string;
  signal?: AbortSignal;
  sourceFileName: string;
  sourceFilePath: string;
  workerThreads?: RuntimeThreadBudgetInput;
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
    options?: RuntimePatchApplyOptions;
    logLevel?: LogLevel;
    onLog?: (log: WorkflowRuntimeLog) => void;
    onProgress?: (progress: WorkflowCreatePatchProgress) => void;
    signal?: AbortSignal;
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
    options?: RuntimePatchValidateOptions;
    logLevel?: LogLevel;
    onLog?: (log: WorkflowRuntimeLog) => void;
    onProgress?: (progress: WorkflowCreatePatchProgress) => void;
    signal?: AbortSignal;
  }) => Promise<{
    message?: string;
    status: "passed";
  }>;
  probePatch?: (input: {
    patch: SourceRef;
    patchFileName?: string;
    logLevel?: LogLevel;
    onLog?: (log: WorkflowRuntimeLog) => void;
    onProgress?: (progress: WorkflowRuntimeProgress) => void;
    signal?: AbortSignal;
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
    format: NonNullable<PatchCreateCommand["format"]>;
    metadata: JsonObject;
    outputName: PatchCreateCommand["output"];
    checksumName?: PatchCreateCommand["checksum_name"];
    sourceCrc32?: PatchCreateCommand["source_crc32"];
    workerThreads?: RuntimeThreadBudgetInput;
    logLevel?: LogLevel;
    onLog?: (log: WorkflowRuntimeLog) => void;
    onProgress?: (progress: WorkflowCreatePatchProgress) => void;
    signal?: AbortSignal;
  }) => Promise<CreatePatchResult>;
  createPatchCandidates?: (input: {
    original: SourceRef;
    modified: SourceRef;
    workerThreads?: RuntimeThreadBudgetInput;
    logLevel?: LogLevel;
    onLog?: (log: WorkflowRuntimeLog) => void;
    onProgress?: (progress: WorkflowCreatePatchProgress) => void;
    signal?: AbortSignal;
  }) => Promise<RuntimePatchCreateFormatCandidates>;
};

type WorkflowRuntimeTrim = {
  trim?: (input: {
    source: SourceRef;
    extension?: string;
    outputName: string;
    workerThreads?: RuntimeThreadBudgetInput;
    logLevel?: LogLevel;
    onLog?: (log: WorkflowRuntimeLog) => void;
    onProgress?: (progress: WorkflowCreatePatchProgress) => void;
    signal?: AbortSignal;
  }) => Promise<TrimResult>;
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
    options?: { workerThreads?: RuntimeThreadBudgetInput },
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
  trim: WorkflowRuntimeTrim;
  preload?: WorkflowRuntimePreload;
  sidecars: WorkflowRuntimeSidecars;
  vfs: LargeFileVfs;
  workerIo: RuntimeWorkerIo;
};

export type {
  RuntimeArchiveCreateInput,
  RuntimePatchApplyWorkerInput,
  RuntimePatchCreateCandidatesWorkerInput,
  RuntimePatchCreateFormatCandidates,
  RuntimePatchCreateWorkerInput,
  RuntimePatchValidateWorkerInput,
  RuntimePatchWorkerProgress,
  RuntimePublicOutputAdapter,
  RuntimeRomSpecificCreateChdInput,
  RuntimeRomSpecificCreateRvzInput,
  RuntimeRomSpecificCreateZ3dsInput,
  RuntimeRomSpecificExtractChdInput,
  RuntimeRomSpecificExtractRvzInput,
  RuntimeRomSpecificExtractZ3dsInput,
  RuntimeThreadBudgetInput,
  RuntimeTrimWorkerInput,
  RuntimeWorkerIo,
  RuntimeWorkerPathSource,
  RuntimeWorkerSourceRequest,
  RuntimeWorkerSourceScope,
  WorkflowRuntime,
  WorkflowRuntimeLog,
  WorkflowRuntimePreload,
  WorkflowRuntimePreloadEvent,
  WorkflowRuntimeProgress,
};
