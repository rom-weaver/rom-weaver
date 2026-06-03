import type { SelectionCandidate } from "./selection.ts";
import type { WorkflowWarning } from "./workflow-controller.ts";

type TrimWorkflowSourceStatus = "empty" | "failed" | "loading" | "needsSelection" | "ready";

type TrimWorkflowSourceState = {
  id: string;
  fileName?: string;
  status: TrimWorkflowSourceStatus;
  candidates: SelectionCandidate[];
  selectedCandidateId?: string;
  size?: number;
  sourceSize?: number;
  decompressionTimeMs?: number;
  wasDecompressed?: boolean;
  warnings: WorkflowWarning[];
};

export type { TrimWorkflowSourceState, TrimWorkflowSourceStatus };
