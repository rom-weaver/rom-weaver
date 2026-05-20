import { getSelectionFiles, getSelectionGroups } from "../../lib/input/selection-candidates.ts";
import type {
  CandidateSelectionRequest,
  SelectionCandidate,
  SelectionGroupCandidate,
  SelectionRole,
} from "../../types/selection.ts";
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

const getCandidateOptionName = (role: SelectionRole) => {
  if (role === "modified") return "--modified-candidate-id";
  if (role === "original") return "--original-candidate-id";
  if (role === "patch") return "--patch-candidate-id";
  return "--input-candidate-id";
};

const createGroupByCandidateId = (request: CandidateSelectionRequest) =>
  new Map(
    getSelectionGroups(request).flatMap((group) =>
      group.candidateIds.map((candidateId) => [candidateId, group] as const),
    ),
  );

const formatCandidateSize = (size: number | undefined, localizer: Localizer = createLocalizer()): string =>
  typeof size === "number" && Number.isFinite(size) ? localizer.formatBytes(size) : "";

const formatCandidateBreadcrumbs = (candidate: SelectionCandidate): string =>
  candidate.breadcrumbs?.length ? candidate.breadcrumbs.join(" > ") : "";

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

const formatSelectionRequest = (
  request: CandidateSelectionRequest,
  localizer: Localizer = createLocalizer(),
): string => {
  const lines = [localizer.message("candidate.selectable", { role: request.role })];
  for (const group of getSelectionGroups(request)) {
    const breadcrumbs = formatCandidateBreadcrumbs(group);
    if (group.selectable) lines.push(`  group ${group.id}: ${breadcrumbs || group.label}`);
  }
  for (const candidate of getSelectionFiles(request)) {
    const breadcrumbs = formatCandidateBreadcrumbs(candidate);
    if (candidate.selectable) lines.push(`  ${candidate.id}: ${breadcrumbs || candidate.fileName}`);
  }
  lines.push(
    localizer.message("candidate.rerun", {
      optionName: getCandidateOptionName(request.role),
    }),
  );
  return lines.join("\n");
};

const formatSelectionDialogMessage = (
  request: CandidateSelectionRequest,
  localizer: Localizer = createLocalizer(),
): string =>
  localizer.message("candidate.ambiguous", {
    role: request.role,
    sourceName: request.sourceName,
  });

export type { CandidateDisplayItem };
export {
  formatCandidateBreadcrumbs,
  formatCandidateSize,
  formatSelectionDialogMessage,
  formatSelectionRequest,
  getCandidateDisplayItems,
  getCandidateOptionName,
};
