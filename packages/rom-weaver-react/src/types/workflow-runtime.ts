import type {
  ArchiveCompressionFormat,
  RomSpecificCompressionFormat,
} from "../lib/compression/container-format-registry.ts";
import type { InputAsset } from "../lib/input/input-assets.ts";
import type { VfsOutputRef } from "../storage/vfs/types.ts";
import type { ROM_WEAVER_COMPRESSION_METADATA } from "../wasm/generated/rom-weaver-format-metadata.ts";
import type { ParsedPatchLike, PatchFileInstance } from "../workers/protocol/patch-engine.ts";
import type { ChecksumVariant } from "./checksum.ts";
import type { LogLevel, LogRecord } from "./logging.ts";
import type { RuntimeTiming } from "./output.ts";
import type { CandidateSelectionRequest } from "./selection.ts";
import type { ApplySettings, CreateSettings, DecompressionLimits } from "./settings.ts";
import type { SourceRef } from "./source.ts";
import type { ChdCompressionCodecs } from "./workflow-compression.ts";

type JsonPrimitive = string | number | boolean | null;
type CompressionProfile = (typeof ROM_WEAVER_COMPRESSION_METADATA)["profiles"][number]["name"];
type ZipCodec = (typeof ROM_WEAVER_COMPRESSION_METADATA)["codecFields"]["zipCodec"]["codecs"][number];
type SevenZipCodec = (typeof ROM_WEAVER_COMPRESSION_METADATA)["codecFields"]["sevenZipCodec"]["codecs"][number];
type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue | undefined }
  | Blob
  | ArrayBufferLike
  | Uint8Array;

type RuntimeCompressionEntryInput = {
  fileName?: string;
  filename?: string;
  name?: string;
  text?: number | string;
  u8array?: Uint8Array;
  arrayBuffer?: ArrayBufferLike | Uint8Array;
  data?: ArrayBufferLike | Uint8Array;
  file?: File;
  filePath?: string;
  lastModified?: number;
  mtime?: number;
  cleanup?: () => Promise<void> | void;
};

type ProgressEvent = {
  stage: "input" | "apply" | "create" | "output";
  label: string;
  message?: string;
  percent?: number | null;
  hasProgress?: boolean;
  indeterminate?: boolean;
  timingText?: string;
  details?: JsonValue;
};

type WorkflowRuntimeHooks = {
  onLog?: (record: Pick<LogRecord, "details" | "level" | "message" | "namespace" | "timestamp">) => void;
  onProgress?: (event: ProgressEvent) => void;
  onCandidatesFound?: (request: CandidateSelectionRequest) => void;
  signal?: AbortSignal;
  trace?: {
    operationId?: string | null;
    workflow?: "apply" | "create" | "trim";
    workflowId?: string;
  };
};

type ApplyWorkflowOptions = ApplySettings &
  WorkflowRuntimeHooks & {
    patchTargets?: Array<"auto" | string>;
    sidecarPatchOutputLabels?: Record<number, string>;
  };

/** Per-patch options the user can set in the patch "Options" panel, aligned by patch index. */
type PatchApplyUserOptions = {
  /** Raw hex checksum to validate the target input before apply (algorithm auto-detected by length). */
  validateInputChecksum?: string;
  /** Raw hex checksum to validate the patched output after apply (algorithm auto-detected by length). */
  validateOutputChecksum?: string;
  /** Enable PPF undo-aware apply for this patch (only meaningful for PPF patches). */
  ppfUndo?: boolean;
};

type PatchInput = {
  inputs: Array<SourceRef> | SourceRef;
  patches?: Array<SourceRef> | SourceRef;
  patchTargets?: Array<"auto" | string>;
  patchOptions?: PatchApplyUserOptions[];
  preparedInputAssets?: InputAsset[];
  preparedPatchFiles?: PatchFileInstance[];
  parsedPatches?: ParsedPatchLike[];
  selectedInputEntryName?: string;
  selectedPatchEntryNames?: Record<number, string>;
  options?: ApplyWorkflowOptions;
};

type CreateWorkflowOptions = Omit<CreateSettings, "format" | "patch"> &
  WorkflowRuntimeHooks & {
    format?: string;
    patch?: {
      metadata?: Record<string, unknown>;
    };
  };

type CreatePatchInput = {
  original: SourceRef;
  modified: SourceRef;
  selectedModifiedEntryName?: string;
  selectedOriginalEntryName?: string;
  /** crc32 of the resolved original source, embedded into the patch output name
   * (`[crc32:<hex>]`) so it round trips back into apply/validate. */
  originalCrc32?: string;
  options?: CreateWorkflowOptions;
};

type TrimWorkflowOptions = CreateWorkflowOptions;

type TrimInput = {
  source: SourceRef;
  selectedSourceEntryName?: string;
  options?: TrimWorkflowOptions;
};

type TrimResult = {
  output: PublicOutput;
  sizeSummary?: {
    inputSize?: number;
    outputSize?: number;
    rawSize?: number;
    compressionTimeMs?: number;
    trimTimeMs?: number;
  };
};

type PublicOutput = VfsOutputRef & {
  checksums?: Record<string, string>;
  checksumVariants?: ChecksumVariant[];
  chdCuePath?: string;
  cleanup?: () => Promise<void> | void;
  timing?: RuntimeTiming | null;
};

type CompressionEntryInfo = {
  filename: string;
  fileName?: string;
  name?: string;
  fileType?: string;
  size?: number;
  mtime?: number;
  lastModified?: number;
};

type CompressionEntryInput = RuntimeCompressionEntryInput;

type CompressionWorkflowOptions = {
  workerThreads?: number | string;
  chdSplitBin?: boolean;
  limits?: DecompressionLimits;
  romFilter?: boolean;
  patchFilter?: boolean;
  /** When false, suppress the host selection prompt for ambiguous containers so a multi-branch
   * archive auto-extracts every branch instead of pausing for input. */
  interactiveSelectionEnabled?: boolean;
  logLevel?: LogLevel;
  extractChecksumAlgorithms?: string[];
  onLog?: (record: Pick<LogRecord, "details" | "level" | "message" | "namespace" | "timestamp">) => void;
  onProgress?: (event: ProgressEvent) => void;
  signal?: AbortSignal;
};

type CompressionListInput = {
  source: SourceRef;
  format?: string;
  options?: CompressionWorkflowOptions;
};

type CompressionExtractInput = {
  source: SourceRef;
  entries: string[];
  format?: string;
  outputName?: string;
  options?: CompressionWorkflowOptions;
  /** Extract the whole container as a single recursive descent (the Rust core resolves one payload
   * per nested level via the interactive selection callback), ignoring `entries`. Returns the bottom
   * leaf output(s). Used by input discovery to avoid a separate `list` + per-entry extract. */
  descendSinglePayload?: boolean;
};

type SevenZipZstdCompressionOptions = CompressionWorkflowOptions & {
  compression?: ArchiveCompressionFormat;
  outputName?: string;
  compressionProfile?: CompressionProfile;
  zipCodec?: ZipCodec;
  zipLevel?: number | string;
  sevenZipCodec?: SevenZipCodec;
  sevenZipLevel?: number | string;
};

type CompressionCreateImageFileInput = {
  source: SourceRef;
  fileName?: string;
};

type CompressionCreateChdOptions = {
  compressionCodecs?: ChdCompressionCodecs | null;
  cueFilePath?: string | null;
  imageFiles?: CompressionCreateImageFileInput[];
  mode?: string | null;
  sourceMode?: string | null;
};

type CompressionCreateRvzOptions = {
  blockSize?: string | number | null;
  codec?: string | null;
  compressionLevel?: string | number | null;
  mode?: string | null;
  scrub?: boolean | string | number | null;
  sourceFileName?: string | null;
};

type CompressionCreateZ3dsOptions = {
  compressionLevel?: string | number | null;
  metadata?: JsonValue | null;
  sourceFileName?: string | null;
  underlyingMagic?: string | null;
};

type CompressionCreateRomSpecificOptions = {
  chd?: CompressionCreateChdOptions;
  rvz?: CompressionCreateRvzOptions;
  z3ds?: CompressionCreateZ3dsOptions;
};

type CompressionCreateInput =
  | {
      entries: CompressionEntryInput[];
      format?: ArchiveCompressionFormat;
      options?: SevenZipZstdCompressionOptions;
    }
  | {
      source: SourceRef;
      fileName: string;
      outputName: string;
      format: RomSpecificCompressionFormat;
      romSpecific?: CompressionCreateRomSpecificOptions;
      options?: CompressionWorkflowOptions;
    };

type CompressionListResult = {
  chdMediaKind?: string;
  entries: CompressionEntryInfo[];
};

type CompressionExtractResult = {
  entries: CompressionEntryInfo[];
  outputs: PublicOutput[];
  output: PublicOutput;
};

type CompressionCreateResult = {
  output: PublicOutput;
};

type ApplyWorkflowResult = {
  output: PublicOutput;
  outputs: PublicOutput[];
  sizeSummary?: {
    applyTimeMs?: number;
    compressionTimeMs?: number;
    inputCompressedSize?: number;
    inputDecompressionTimeMs?: number;
    inputSize: number;
    patchCompressedSize?: number;
    patchSize?: number;
    rawSize: number;
    outputSize: number;
  };
  rom: {
    fileName: string;
    size: number;
  };
  inputs: Array<{
    id: string;
    fileName: string;
    kind: string;
    size: number;
    patchable: boolean;
  }>;
  patches: Array<{
    fileName: string;
    format: string;
    targetInputId?: string;
  }>;
};

type CreatePatchResult = {
  output: PublicOutput;
  format: string;
  sizeSummary?: {
    compressionTimeMs?: number;
    createTimeMs?: number;
    outputSize?: number;
    rawSize?: number;
  };
};

export type {
  ApplyWorkflowOptions,
  ApplyWorkflowResult,
  CompressionCreateInput,
  CompressionCreateResult,
  CompressionEntryInput,
  CompressionExtractInput,
  CompressionExtractResult,
  CompressionListInput,
  CompressionListResult,
  CompressionWorkflowOptions,
  CreatePatchInput,
  CreatePatchResult,
  CreateWorkflowOptions,
  JsonValue,
  PatchInput,
  ProgressEvent,
  PublicOutput,
  SevenZipZstdCompressionOptions,
  TrimInput,
  TrimResult,
  TrimWorkflowOptions,
};
