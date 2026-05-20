import type { WorkflowProgress, WorkflowProgressStage } from "../types/progress.ts";
import type { MessageId } from "./localization/catalog.ts";
import { createLocalizer, type Localizer } from "./localization/index.ts";

const PROGRESS_STAGES: WorkflowProgressStage[] = [
  "detect",
  "decompress",
  "select",
  "parse",
  "checksum",
  "verify",
  "apply",
  "create",
  "compress",
  "write",
];

const getProgressStageLabel = (stage: WorkflowProgressStage, localizer: Localizer = createLocalizer()): string =>
  localizer.message(`progress.${stage}` as MessageId);

const formatProgressLabel = (progress: WorkflowProgress, localizer: Localizer = createLocalizer()): string => {
  const label = progress.label || getProgressStageLabel(progress.stage, localizer);
  const percent = typeof progress.percent === "number" ? ` ${Math.round(progress.percent)}%` : "";
  return `${label}${percent}`;
};

export { formatProgressLabel, getProgressStageLabel, PROGRESS_STAGES };
