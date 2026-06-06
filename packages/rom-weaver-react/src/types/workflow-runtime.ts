import type { InputAsset } from "../lib/input/input-assets.ts";
import type { VfsOutputRef } from "../storage/vfs/types.ts";
import type { ParsedPatchLike, PatchFileInstance } from "../workers/protocol/patch-engine.ts";
import type { LogLevel, LogRecord } from "./logging.ts";
import type { RuntimeTiming } from "./output.ts";
import type { CandidateSelectionRequest } from "./selection.ts";
import type { ApplySettings, CreateSettings } from "./settings.ts";
import type { SourceRef } from "./source.ts";
import type { ChdCompressionCodecs } from "./workflow-compression.ts";

type JsonPrimitive = string | number | boolean | null;
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

type PatchInput = {
  inputs: Array<SourceRef> | SourceRef;
  patches?: Array<SourceRef> | SourceRef;
  patchTargets?: Array<"auto" | string>;
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
  romFilter?: boolean;
  patchFilter?: boolean;
  logLevel?: LogLevel;
  extractChecksumAlgorithms?: string[];
  onLog?: (record: Pick<LogRecord, "details" | "level" | "message" | "namespace" | "timestamp">) => void;
  onProgress?: (event: ProgressEvent) => void;
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
};

type SevenZipZstdCompressionOptions = CompressionWorkflowOptions & {
  compression?: "zip" | "7z";
  outputName?: string;
  compressionProfile?: "min" | "very-low" | "low" | "medium" | "high" | "very-high" | "max";
  zipCodec?: "deflate" | "store" | "zstd";
  zipLevel?: number | string;
  sevenZipCodec?: "lzma2";
  sevenZipLevel?: number | string;
};

type CompressionCreateInput =
  | {
      entries: CompressionEntryInput[];
      format?: "7z" | "zip";
      options?: SevenZipZstdCompressionOptions;
    }
  | {
      source: SourceRef;
      fileName: string;
      outputName: string;
      format: "chd" | "rvz" | "z3ds";
      imageFiles?: Array<{
        source: SourceRef;
        fileName?: string;
      }>;
      mode?: string | null;
      chdSourceMode?: string | null;
      cueFilePath?: string | null;
      compressionCodecs?: ChdCompressionCodecs | null;
      rvzBlockSize?: string | number | null;
      rvzCompression?: string | null;
      rvzCompressionLevel?: string | number | null;
      rvzMode?: string | null;
      rvzScrub?: boolean | string | number | null;
      rvzSourceFileName?: string | null;
      z3dsCompressionLevel?: string | number | null;
      z3dsMetadata?: JsonValue | null;
      z3dsSourceFileName?: string | null;
      z3dsUnderlyingMagic?: string | null;
      options?: CompressionWorkflowOptions;
    };

type CompressionListResult = {
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
  CompressionEntryInfo,
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
