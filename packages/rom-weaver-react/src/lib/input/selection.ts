import type { CandidateSelectionRequest } from "../../types/selection.ts";
import { RomWeaverError } from "../errors.ts";
import { getSelectionFiles, getSelectionGroups } from "./selection-candidates.ts";
import type { SelectFile } from "./types.ts";

type SelectionChoice = Awaited<ReturnType<SelectFile>>;

const getSelectableEntries = (request: CandidateSelectionRequest) => {
  const selectableGroups = getSelectionGroups(request).filter((group) => group.selectable);
  const groupIds = new Set(selectableGroups.map((group) => group.id));
  const selectableCandidates = getSelectionFiles(request).filter(
    (candidate) => candidate.selectable && !groupIds.has(candidate.parentCandidateId || ""),
  );
  return { selectableCandidates, selectableGroups };
};

const resolveAutomaticSelection = (request: CandidateSelectionRequest): SelectionChoice | null => {
  const { selectableCandidates, selectableGroups } = getSelectableEntries(request);
  if (
    (request.role === "input" || request.role === "original" || request.role === "modified") &&
    selectableCandidates.length === 1 &&
    selectableCandidates[0]?.kind === "rom"
  ) {
    return { id: selectableCandidates[0].id };
  }
  const count = selectableCandidates.length + selectableGroups.length;
  if (count !== 1) return null;
  const group = selectableGroups[0];
  if (group) return { id: group.id };
  const candidate = selectableCandidates[0];
  return candidate ? { id: candidate.id } : null;
};

const assertSelectionExists = (request: CandidateSelectionRequest, selection: SelectionChoice) => {
  const candidate = request.candidates.find((entry) => entry.id === selection.id);
  if (candidate?.selectable) return;
  throw new RomWeaverError("SELECTION_NOT_FOUND", `Selection candidate was not found: ${selection.id}`);
};

const selectionToArchiveEntry = (request: CandidateSelectionRequest, selection: SelectionChoice): string => {
  assertSelectionExists(request, selection);
  const selected = request.candidates.find((entry) => entry.id === selection.id);
  if (!selected) throw new RomWeaverError("SELECTION_NOT_FOUND", "Selection candidate was not found");
  if (selected.type === "group") {
    const group = selected;
    return group.path || group.label;
  }
  return selected.path || selected.fileName;
};

const assertUnambiguousSelection = (request: CandidateSelectionRequest) => {
  if (resolveAutomaticSelection(request)) return;
  throw new RomWeaverError(
    "AMBIGUOUS_SELECTION",
    `${request.sourceName} contains multiple ${request.role} candidates`,
    { details: { request } },
  );
};

export {
  assertSelectionExists,
  assertUnambiguousSelection,
  getSelectionFiles,
  getSelectionGroups,
  resolveAutomaticSelection,
  selectionToArchiveEntry,
};
