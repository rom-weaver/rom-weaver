import type {
  CandidateSelectionRequest,
  SelectionFileCandidate,
  SelectionGroupCandidate,
} from "../../types/selection.ts";

const getSelectionFiles = (request: CandidateSelectionRequest): SelectionFileCandidate[] =>
  request.candidates.filter((candidate): candidate is SelectionFileCandidate => candidate.type === "file");

const getSelectionGroups = (request: CandidateSelectionRequest): SelectionGroupCandidate[] =>
  request.candidates.filter((candidate): candidate is SelectionGroupCandidate => candidate.type === "group");

export { getSelectionFiles, getSelectionGroups };
