import type { BrowserSaveDestination, PublicOutput } from "./output.ts";
import type { PatchFormat } from "./settings.ts";

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

type BrowserApplyResult = ApplyResult<BrowserSaveDestination>;
type BrowserCreateResult = CreateResult<BrowserSaveDestination>;
type BrowserTrimResult = TrimResult<BrowserSaveDestination>;

export type {
  ApplyResult,
  BrowserApplyResult,
  BrowserCreateResult,
  BrowserTrimResult,
  CreateResult,
  SelectedInputInfo,
  TrimResult,
};
