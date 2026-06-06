import type { BrowserSaveDestination, PublicOutput, SaveDestination } from "./output.ts";
import type { WorkflowProgress } from "./progress.ts";
import type { CandidateSelectionRequest, SelectFile } from "./selection.ts";
import type { ApplySettings, CreateSettings, PatchFormat } from "./settings.ts";
import type { BrowserSourceRef, SourceRef } from "./source.ts";

type WorkflowSizeSummary = {
  applyTimeMs?: number;
  compressionTimeMs?: number;
  createTimeMs?: number;
  inputCompressedSize?: number;
  inputDecompressionTimeMs?: number;
  inputSize?: number;
  outputSize?: number;
  patchCompressedSize?: number;
  patchSize?: number;
  rawSize?: number;
  trimTimeMs?: number;
};

type SelectedInputInfo = {
  fileName: string;
  id: string;
  kind: string;
  selectedCandidateId?: string;
  selectedCandidateType?: "file" | "group";
  size?: number;
};

type AppliedPatchInfo = {
  fileName: string;
  format: PatchFormat | string;
  targetInputId?: string;
};

type ApplyInput<TSource> = {
  inputs: TSource | TSource[];
  onCandidates?: (request: CandidateSelectionRequest) => void;
  onProgress?: (event: WorkflowProgress) => void;
  outputName: string;
  patches?: TSource | TSource[];
  selectFile?: SelectFile;
  settings?: ApplySettings;
  signal?: AbortSignal;
};

type CreateInput<TSource> = {
  modified: TSource | TSource[];
  onCandidates?: (request: CandidateSelectionRequest) => void;
  onProgress?: (event: WorkflowProgress) => void;
  original: TSource | TSource[];
  outputName: string;
  selectFile?: SelectFile;
  settings?: CreateSettings;
  signal?: AbortSignal;
  type: PatchFormat;
};

type ApplyResult<TDestination> = {
  inputs: SelectedInputInfo[];
  output: PublicOutput<TDestination>;
  outputs: PublicOutput<TDestination>[];
  patches: AppliedPatchInfo[];
  sizeSummary?: WorkflowSizeSummary;
};

type CreateResult<TDestination> = {
  modified: SelectedInputInfo;
  original: SelectedInputInfo;
  output: PublicOutput<TDestination>;
  sizeSummary?: WorkflowSizeSummary;
  type: PatchFormat;
};

type TrimResult<TDestination> = {
  input: SelectedInputInfo;
  output: PublicOutput<TDestination>;
  sizeSummary?: WorkflowSizeSummary;
};

type UnifiedApplyInput = ApplyInput<SourceRef>;
type UnifiedCreateInput = CreateInput<SourceRef>;
type UnifiedApplyResult = ApplyResult<SaveDestination>;
type UnifiedCreateResult = CreateResult<SaveDestination>;
type BrowserApplyInput = ApplyInput<BrowserSourceRef>;
type BrowserCreateInput = CreateInput<BrowserSourceRef>;
type BrowserApplyResult = ApplyResult<BrowserSaveDestination>;
type BrowserCreateResult = CreateResult<BrowserSaveDestination>;
type BrowserTrimResult = TrimResult<BrowserSaveDestination>;

export type {
  AppliedPatchInfo,
  ApplyInput,
  ApplyResult,
  BrowserApplyInput,
  BrowserApplyResult,
  BrowserCreateInput,
  BrowserCreateResult,
  BrowserTrimResult,
  CreateInput,
  CreateResult,
  SelectedInputInfo,
  TrimResult,
  UnifiedApplyInput,
  UnifiedApplyResult,
  UnifiedCreateInput,
  UnifiedCreateResult,
  WorkflowSizeSummary,
};
