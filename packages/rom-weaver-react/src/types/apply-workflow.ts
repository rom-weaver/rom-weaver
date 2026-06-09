import type { ChecksumRomProbe } from "./checksum.ts";
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
  patchable?: boolean;
  checksums?: ApplyWorkflowChecksums;
  checksumTimeMs?: number;
  romProbe?: ChecksumRomProbe;
  parentCompressions: ApplyWorkflowParentCompression[];
  selected: boolean;
  selectedCandidateId?: string;
  order?: number;
  groupId?: string;
  size?: number;
  sourceSize?: number;
  chdMode?: string;
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
  romProbe?: ChecksumRomProbe;
  resolvedInputs?: ApplyWorkflowResolvedInput[];
  selectedCandidateId?: string;
  size?: number;
  sourceSize?: number;
  chdMode?: string;
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
  checksumTimeMs?: number;
  decompressionTimeMs?: number;
  parentCompressions: ApplyWorkflowParentCompression[];
  selectedCandidateId?: string;
  targetInputId?: string;
  targetInputFileName?: string;
  size?: number;
  sourceSize?: number;
  wasDecompressed?: boolean;
  warnings: WorkflowWarning[];
  requirements?: {
    format?: string;
    minimumSourceSize?: number;
    patchCrc32?: string;
    recordCount?: number;
    sourceCrc32?: string;
    sourceSize?: number;
    targetCrc32?: string;
    targetSize?: number;
  };
  checksumPreflight?: {
    actualCrc32?: string;
    actualSize?: number;
    mismatchReason?: "crc32" | "size" | "size+crc32";
    minimumSourceSize?: number;
    requiredCrc32?: string;
    requiredSize?: number;
    status: "invalid" | "pending" | "unknown" | "valid";
  };
  patchValidation?: {
    message?: string;
    status: "invalid" | "pending" | "unknown" | "valid";
    targetInputId?: string;
    validationKey?: string;
  };
  /** User-pasted checksum (raw hex) to validate the patch target input before apply. */
  validateInputChecksum?: string;
  /** User-pasted checksum (raw hex) to validate the patched output after apply. */
  validateOutputChecksum?: string;
  /** User toggle for PPF undo-aware apply; `undefined` means "default on for PPF patches". */
  ppfUndo?: boolean;
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
