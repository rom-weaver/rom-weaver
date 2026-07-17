import { getSelectionGroups } from "../../lib/input/selection-candidates.ts";
import type { CandidateSelectionRequest, SelectionCandidate, SelectionGroupCandidate } from "../../types/selection.ts";
import type { Localizer } from "../localization/index.ts";
import { createLocalizer } from "../localization/index.ts";

type CandidateDisplayItem = {
  candidate: SelectionCandidate;
  group?: SelectionGroupCandidate;
  metadata: string;
  sizeLabel: string;
  warningLabel: string;
  warnings: string[];
};

const createGroupByCandidateId = (request: CandidateSelectionRequest) =>
  new Map(
    getSelectionGroups(request).flatMap((group) =>
      group.candidateIds.map((candidateId) => [candidateId, group] as const),
    ),
  );

const formatCandidateSize = (size: number | undefined, localizer: Localizer = createLocalizer()): string =>
  typeof size === "number" && Number.isFinite(size) ? localizer.formatBytes(size) : "";

const getCandidateDisplayItems = (
  request: CandidateSelectionRequest,
  localizer: Localizer = createLocalizer(),
): CandidateDisplayItem[] => {
  const groupByCandidateId = createGroupByCandidateId(request);
  return request.candidates.map((candidate) => {
    const group = candidate.type === "file" ? groupByCandidateId.get(candidate.id) : candidate;
    const sizeLabel = candidate.type === "file" ? formatCandidateSize(candidate.size, localizer) : "";
    const metadata = sizeLabel;
    const warnings = [
      candidate.type === "file" ? candidate.reason : undefined,
      ...(group?.warnings || []),
      ...request.warnings,
    ].filter((warning): warning is string => typeof warning === "string" && warning.length > 0);
    return {
      candidate,
      group,
      metadata,
      sizeLabel,
      warningLabel: warnings.length
        ? localizer.message("candidate.warningCount", {
            count: warnings.length,
          })
        : "",
      warnings,
    };
  });
};

export { getCandidateDisplayItems };
