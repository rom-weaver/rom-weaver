import type { LargeFileVfs } from "../storage/vfs/types.ts";
import type { PatchApplyCommand, PatchCreateCommand, PatchValidateCommand, ThreadBudget } from "../wasm/index.ts";
import type { BundleHeaderMode, ParsedBundleCreateResult, ParsedBundleParseResult } from "./bundle.ts";
import type { ChecksumVariant, RomTypeTag } from "./checksum.ts";
import type { ParsedIngestResult } from "./ingest.ts";
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
  CompressionProbeInput,
  CompressionProbeResult,
  CreatePatchResult,
  PublicOutput,
  TrimResult,
} from "./workflow-runtime-types.ts";

type WorkflowRuntimeProgress = {
  details?: JsonValue;
  elapsed_ms?: number | null;
  label?: string;
  message?: string;
  percent?: number | null;
  stage?: string;
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
  /** Releases externally managed source storage after its workflow owner is disposed. */
  releaseOwnedSources?: (sources: unknown[]) => Promise<void>;
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
  addHeader?: boolean;
  appendOutputSuffix?: boolean;
  fixChecksum?: PatchApplyCommand["repair_checksum"];
  /** One mode per patch in chain order; a shorter list carries the last mode forward. */
  headerModes?: PatchApplyCommand["patch_header"];
  outputHeader?: PatchApplyCommand["output_header"];
  n64ByteOrder?: PatchApplyCommand["n64_byte_order"];
  outputExtension?: string | null | undefined;
  outputName?: string | null | undefined;
  removeHeader?: boolean;
  requireInputChecksumMatch?: boolean;
  validateWithChecksums?: PatchApplyCommand["validate_with_checksums"];
  validateWithOutputChecksums?: PatchApplyCommand["validate_with_output_checksums"];
  workerThreads?: RuntimeThreadBudgetInput;
};

type RuntimePatchValidateOptions = Partial<Omit<PatchValidateCommand, "input" | "patches">> & {
  checksumCache?: RuntimeChecksumCacheInput;
  ignoreChecksumValidation?: PatchValidateCommand["ignore_checksum_validation"];
  /** Validate every patch independently against the original input (no chaining) and return a
   * per-patch verdict; a single failing patch never fails the whole call. */
  independent?: boolean;
  n64ByteOrder?: PatchValidateCommand["n64_byte_order"];
  removeHeader?: PatchValidateCommand["strip_header"];
  validateWithChecksums?: PatchValidateCommand["validate_with_checksums"];
  validationRequirements?: RuntimePatchValidationRequirement | RuntimePatchValidationRequirement[];
  workerThreads?: RuntimeThreadBudgetInput;
};

/** One patch's verdict from an independent-mode `patch-validate` call, index-aligned to the patches
 * passed in. `status: "failed"` carries the reason in `message`; other patches are unaffected. */
type PatchValidatePerPatchVerdict = {
  format?: string;
  index: number;
  message?: string;
  patch?: string;
  status: "passed" | "failed";
};

type PatchValidateResult = {
  message?: string;
  perPatch?: PatchValidatePerPatchVerdict[];
  status: "passed" | "mixed";
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
  modifiedFilePath: NonNullable<PatchCreateCommand["modified"]>;
  originalFileName: string;
  originalFilePath: PatchCreateCommand["original"];
  outputName: NonNullable<PatchCreateCommand["output"]>;
  signal?: AbortSignal;
  sourceCrc32?: PatchCreateCommand["source_crc32"];
  workerThreads?: RuntimeThreadBudgetInput;
};

type RuntimePatchCreateCandidatesWorkerInput = {
  logLevel?: LogLevel;
  modifiedFileName: string;
  modifiedFilePath: PatchCreateCommand["modified"];
  originalFileName: string;
  originalFilePath: PatchCreateCommand["original"];
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
  probe?: (input: CompressionProbeInput) => Promise<CompressionProbeResult>;
};

type WorkflowRuntimeBinary = {
  assertSource: (source: SourceRef, context: string) => void;
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
  }) => Promise<PatchValidateResult>;
  createPatch?: (input: {
    original: SourceRef;
    modified: SourceRef;
    format: NonNullable<PatchCreateCommand["format"]>;
    metadata: JsonObject;
    outputName: NonNullable<PatchCreateCommand["output"]>;
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

type WorkflowRuntimeIngest = {
  // Classify a dropped source as ROM or patch, nested-extract + checksum ROMs (in place for bare
  // ROMs), and describe patches - one consolidated call the drop/staging flow routes on. Archive ROM
  // leaves are adopted into `outputs` (path-backed PublicOutputs carrying the ingest checksums + disc
  // structure), aligned with `result.assets` for non-`copiedInPlace` assets, so the staging pipeline
  // reuses its existing PublicOutput→PatchFileInstance bridge. A bare ROM (`copiedInPlace`) yields no
  // output - the caller keeps its own source ref and uses the result's checksums.
  run?: (input: {
    source: unknown;
    fileName?: string;
    checksumAlgorithms?: string[];
    // Pin which archive payload(s) to extract (the resolved "keep one ROM" entry). Empty/omitted lets
    // ingest auto-pick a single logical payload or prompt the host when ambiguous.
    select?: string[];
    interactiveSelectionEnabled?: boolean;
    // For a multi-track CHD CD: force per-track split BIN (true) or single merged BIN (false). Omit
    // to let ingest ask the host interactively when the disc offers the choice.
    splitBin?: boolean;
    logLevel?: LogLevel;
    onLog?: (log: WorkflowRuntimeLog) => void;
    onProgress?: (progress: WorkflowRuntimeProgress) => void;
    signal?: AbortSignal;
    // Archive PATCH leaves are adopted into `patchOutputs` (aligned with `result.patches`), same as ROM
    // leaves into `outputs`, so the patch-staging path reuses the PublicOutput→PatchFileInstance
    // bridge. A bare patch yields no `patchOutput` (its leaf is the staged source, cleaned up here -
    // the caller keeps its own file and uses the descriptor's metadata).
  }) => Promise<{ result: ParsedIngestResult; outputs: PublicOutput[]; patchOutputs: PublicOutput[] }>;
};

type WorkflowRuntimeBundle = {
  // Parse a dropped/fetched rom-weaver-bundle.json (plain, compressed, or an archive carrying one). Bundled
  // ROM/patch members are extracted into an operation-scoped directory and exposed as OPFS-backed
  // `File`s keyed by their reported path. The caller transfers them to workflow ownership or runs
  // `cleanup` on failure/cancellation.
  parse?: (input: {
    source: unknown;
    fileName?: string;
    logLevel?: LogLevel;
    onLog?: (log: WorkflowRuntimeLog) => void;
    onProgress?: (progress: WorkflowRuntimeProgress) => void;
    signal?: AbortSignal;
  }) => Promise<{
    cleanup: () => Promise<void>;
    result: ParsedBundleParseResult;
    extractedFiles: Map<string, File>;
  }>;
  // Write a rom-weaver-bundle.json bundle (and optional everything-bundle .zip) from the current session's
  // files. Cached ROM checks avoid a second hash; outputs stay as VFS-backed runtime outputs.
  create?: (input: {
    rom?: { source: unknown; fileName?: string };
    /** Optional packaged ROM payload; checks still come from the logical `rom`. */
    bundleRom?: { source: unknown; fileName?: string };
    patches: Array<{
      source: unknown;
      fileName?: string;
      name?: string;
      description?: string;
      label?: string;
      /** Optional patches start deselected at apply time; absent/false = applied by default. */
      optional?: boolean;
      header?: BundleHeaderMode;
      /** Expected pre-apply ROM checksums for this entry ("algo=hex", comma-separable). */
      inputChecks?: string;
      /** Expected post-apply ROM checksums ("algo=hex", comma-separable). */
      outputChecks?: string;
    }>;
    outputName?: string;
    outputHeader?: BundleHeaderMode;
    /** Cached checksums from apply staging; Rust hashes only when this is absent. */
    romChecksums?: string;
    /** Cached prepared ROM byte size. */
    romSize?: number;
    /** Expected final-output checksums once the full chain is applied ("algo=hex", comma-separable). */
    outputCheck?: string;
    /** Bundle file name (base name; its extension picks the archive format, e.g. "pack.7z"). Absent = bundle only. */
    bundleFileName?: string;
    /** Leave the ROM out of the bundle and emit its bundle entry with checks only. */
    noBundleRom?: boolean;
    logLevel?: LogLevel;
    onLog?: (log: WorkflowRuntimeLog) => void;
    onProgress?: (progress: WorkflowRuntimeProgress) => void;
    signal?: AbortSignal;
  }) => Promise<{
    result: ParsedBundleCreateResult;
    bundleOutput: PublicOutput;
    archiveOutput?: PublicOutput;
  }>;
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
  ingest?: WorkflowRuntimeIngest;
  bundle?: WorkflowRuntimeBundle;
  /** Declare a simultaneous I/O drop (source sizes in bytes) so the scheduler plans the whole batch as
   * one unit even though each file is staged independently. Optional - runtimes without a batch planner
   * omit it and ops are admitted as they arrive. */
  noteIoBatch?: (jobSizes: number[]) => void;
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
  PatchValidatePerPatchVerdict,
  PatchValidateResult,
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
};
