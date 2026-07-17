import type { ChecksumVariant } from "./checksum.ts";
import type { SelectionCandidate } from "./selection.ts";
import type { WorkflowWarning } from "./workflow-controller.ts";

type CreateWorkflowSourceStatus = "empty" | "failed" | "loading" | "needsSelection" | "ready";

type CreateWorkflowParentCompression = {
  depth: number;
  kind: string;
  fileName: string;
  sourceSize?: number;
  outputSize?: number;
  decompressionTimeMs?: number;
};

type CreateWorkflowSourceState = {
  id: string;
  fileName?: string;
  status: CreateWorkflowSourceStatus;
  candidates: SelectionCandidate[];
  parentCompressions: CreateWorkflowParentCompression[];
  selectedCandidateId?: string;
  size?: number;
  sourceSize?: number;
  chdMode?: string;
  checksums?: Record<string, string>;
  checksumVariants?: ChecksumVariant[];
  checksumTimeMs?: number;
  decompressionTimeMs?: number;
  wasDecompressed?: boolean;
  warnings: WorkflowWarning[];
};

export type { CreateWorkflowParentCompression, CreateWorkflowSourceState };
