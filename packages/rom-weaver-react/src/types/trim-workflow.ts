import type { ChecksumRomProbe } from "./checksum.ts";
import type { SelectionCandidate } from "./selection.ts";
import type { WorkflowWarning } from "./workflow-controller.ts";

type TrimWorkflowSourceStatus = "empty" | "failed" | "loading" | "needsSelection" | "ready";

type TrimWorkflowChecksums = Record<string, string>;

type TrimWorkflowParentCompression = {
  depth: number;
  kind: string;
  fileName: string;
  sourceSize?: number;
  outputSize?: number;
  decompressionTimeMs?: number;
};

type TrimWorkflowSourceState = {
  id: string;
  fileName?: string;
  status: TrimWorkflowSourceStatus;
  candidates: SelectionCandidate[];
  checksums?: TrimWorkflowChecksums;
  checksumTimeMs?: number;
  parentCompressions: TrimWorkflowParentCompression[];
  romProbe?: ChecksumRomProbe;
  selectedCandidateId?: string;
  size?: number;
  sourceSize?: number;
  chdMode?: string;
  decompressionTimeMs?: number;
  wasDecompressed?: boolean;
  warnings: WorkflowWarning[];
};

export type { TrimWorkflowChecksums, TrimWorkflowParentCompression, TrimWorkflowSourceState, TrimWorkflowSourceStatus };
