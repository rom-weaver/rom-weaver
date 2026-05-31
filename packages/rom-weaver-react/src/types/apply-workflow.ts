import type { WorkflowProgress } from "./progress.ts";
import type { SelectionCandidate } from "./selection.ts";
import type { WorkflowWarning } from "./workflow-controller.ts";

type ApplyWorkflowSourceStatus = "empty" | "failed" | "loading" | "needsSelection" | "ready";

type ApplyWorkflowChecksums = Record<string, string>;

type ApplyWorkflowParentCompression = {
  depth: number;
  kind: string;
  fileName: string;
  sourceSize?: number;
  outputSize?: number;
  decompressionTimeMs?: number;
};

type ApplyWorkflowResolvedInput = {
  id: string;
  fileName?: string;
  kind?: "rom" | "cue" | "track";
  checksums?: ApplyWorkflowChecksums;
  checksumTimeMs?: number;
  parentCompressions: ApplyWorkflowParentCompression[];
  selected: boolean;
  selectedCandidateId?: string;
  order?: number;
  groupId?: string;
  size?: number;
  sourceSize?: number;
  splitBinAvailable?: boolean;
  decompressionTimeMs?: number;
  wasDecompressed?: boolean;
};

type ApplyWorkflowInputState = {
  id: string;
  fileName?: string;
  status: ApplyWorkflowSourceStatus;
  candidates: SelectionCandidate[];
  checksums?: ApplyWorkflowChecksums;
  checksumTimeMs?: number;
  resolvedInputs?: ApplyWorkflowResolvedInput[];
  selectedCandidateId?: string;
  size?: number;
  sourceSize?: number;
  decompressionTimeMs?: number;
  wasDecompressed?: boolean;
  warnings: WorkflowWarning[];
  parentCompressions: ApplyWorkflowParentCompression[];
};

type ApplyWorkflowPatchState = {
  id: string;
  fileName?: string;
  status: ApplyWorkflowSourceStatus;
  candidates: SelectionCandidate[];
  decompressionTimeMs?: number;
  parentCompressions: ApplyWorkflowParentCompression[];
  selectedCandidateId?: string;
  targetInputId?: string;
  targetInputFileName?: string;
  size?: number;
  sourceSize?: number;
  wasDecompressed?: boolean;
  warnings: WorkflowWarning[];
};

type ApplyWorkflowProgressKind = WorkflowProgress["stage"];

type ApplyWorkflowProgressEvent = WorkflowProgress;

export type {
  ApplyWorkflowChecksums,
  ApplyWorkflowInputState,
  ApplyWorkflowParentCompression,
  ApplyWorkflowPatchState,
  ApplyWorkflowProgressEvent,
  ApplyWorkflowProgressKind,
  ApplyWorkflowResolvedInput,
  ApplyWorkflowSourceStatus,
};
