import type { WorkerProgressEvent } from "../../protocol/worker-runtime-payloads.ts";

const createToolNumericProgressMapper = (
  ignoredLabels: ReadonlySet<string>,
  mapProgress: (percent: number | null | undefined) => void,
) => {
  return (progress: WorkerProgressEvent) => {
    const label = String(progress?.label || "")
      .trim()
      .toLowerCase();
    if (typeof progress?.percent === "number" && label && !ignoredLabels.has(label)) mapProgress(progress.percent);
  };
};

export { createToolNumericProgressMapper };
