import type { SelectionFileCandidate } from "../../types/selection.ts";
import { extractPatchFileLabel } from "../output/patch-output-label.ts";
import type { StagedSource } from "./apply-workflow-state.ts";

const createPatchOutputLabel = (fileName: string | undefined) => extractPatchFileLabel(fileName);

const resolvePatchOutputName = <TSource>(patch: StagedSource<TSource>, index: number): string => {
  if (patch.state.selectedCandidateId) {
    const selectedCandidate = patch.state.candidates.find(
      (candidate) => candidate.id === patch.state.selectedCandidateId,
    );
    if (selectedCandidate?.type === "file" && selectedCandidate.fileName) return selectedCandidate.fileName;
  }
  if (patch.state.status === "needsSelection" && !patch.state.selectedCandidateId) {
    const selectableGroups = patch.state.candidates.filter(
      (candidate) => candidate.type === "group" && candidate.selectable,
    );
    const selectableGroupIds = new Set(selectableGroups.map((candidate) => candidate.id));
    const selectablePatches = patch.state.candidates.filter(
      (candidate): candidate is SelectionFileCandidate =>
        candidate.type === "file" &&
        candidate.kind === "patch" &&
        candidate.selectable &&
        !selectableGroupIds.has(candidate.parentCandidateId || ""),
    );
    if (selectablePatches.length === 1 && selectablePatches[0]?.fileName) return selectablePatches[0].fileName;
  }
  return patch.state.fileName || patch.outputLabel || `patch ${index + 1}`;
};

export { createPatchOutputLabel, resolvePatchOutputName };
