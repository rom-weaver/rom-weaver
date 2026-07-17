import type { WorkflowProgress } from "../../types/progress.ts";
import type { CandidateSelectionRequest } from "../../types/selection.ts";
import type { ApplyWorkflowOptions } from "../../types/workflow-runtime-types.ts";
import { toRomWeaverError } from "../errors.ts";
import type { InputAsset } from "../input/input-assets.ts";
import { getBaseFileName } from "../input/path-utils.ts";
import type { InternalSourceState } from "./apply-workflow-state.ts";
import { getPreparationProgressStage, isRecord } from "./controller-utils.ts";

type SourceStagingProgressEmitter = (event: {
  current?: number;
  details?: Record<string, unknown>;
  hasProgress?: boolean;
  id: string;
  label: string;
  percent?: number | null;
  role: WorkflowProgress["role"];
  stage: WorkflowProgress["stage"];
  total?: number;
  workflow: WorkflowProgress["workflow"];
}) => void;

const getPreparedAssetFileName = (asset: InputAsset | undefined, fallback?: string) =>
  getBaseFileName(asset?.file.fileName || asset?.fileName || fallback || "input.bin");

const canRecoverWithCandidateSelection = (error: unknown, requests: CandidateSelectionRequest[]) => {
  if (!requests.length) return false;
  const normalized = toRomWeaverError(error);
  if (normalized.code === "AMBIGUOUS_SELECTION") return true;
  return false;
};

const createSourceStagingOptions = (config: {
  base: ApplyWorkflowOptions;
  emitProgress: SourceStagingProgressEmitter;
  onCandidatesFound: (request: CandidateSelectionRequest) => void;
  state: InternalSourceState;
  workflowId: string;
}) =>
  ({
    ...config.base,
    onCandidatesFound: config.onCandidatesFound,
    onProgress: (progress: {
      current?: number;
      details?: unknown;
      hasProgress?: boolean;
      label?: string;
      message?: string;
      percent?: number | null;
      total?: number;
    }) => {
      const progressStage = getPreparationProgressStage(progress, config.state.role);
      config.emitProgress({
        current: progress.current,
        details: {
          ...(isRecord(progress.details) ? progress.details : {}),
          fileName: config.state.fileName,
          order: config.state.order,
          sourceId: config.state.id,
        },
        hasProgress: progress.hasProgress,
        id: `${config.workflowId}:${config.state.id}:${progressStage}`,
        label: progress.label || progress.message || "Preparing input...",
        percent: typeof progress.percent === "number" && Number.isFinite(progress.percent) ? progress.percent : null,
        role: config.state.role,
        stage: progressStage,
        total: progress.total,
        workflow: "apply",
      });
    },
  }) satisfies Partial<ApplyWorkflowOptions>;

export { canRecoverWithCandidateSelection, createSourceStagingOptions, getPreparedAssetFileName };
