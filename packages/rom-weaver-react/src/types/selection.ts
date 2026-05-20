type CandidateKind = "cue" | "disc" | "patch" | "rom" | "track" | "unknown";

type CandidateGroupKind = "cue-disc" | "multi-file-input";

type SelectionRole = "input" | "modified" | "original" | "patch";

type SelectionFileCandidate = {
  type: "file";
  breadcrumbs?: string[];
  fileName: string;
  id: string;
  kind: CandidateKind;
  parentCandidateId?: string;
  patchable?: boolean;
  path?: string;
  reason?: string;
  selectable: boolean;
  size?: number;
};

type SelectionGroupCandidate = {
  type: "group";
  breadcrumbs?: string[];
  candidateIds: string[];
  id: string;
  kind: CandidateGroupKind;
  label: string;
  path?: string;
  selectable: boolean;
  warnings: string[];
};

type SelectionCandidate = SelectionFileCandidate | SelectionGroupCandidate;

type CandidateSelectionRequest = {
  candidates: SelectionCandidate[];
  role: SelectionRole;
  sourceIndex?: number;
  sourceName: string;
  warnings: string[];
};

type SelectionChoice = { id: string };

type SelectFile = (request: CandidateSelectionRequest) => Promise<SelectionChoice> | SelectionChoice;

type PatchTarget = { kind: "auto" } | { id: string; kind: "inputId" };

export type {
  CandidateGroupKind,
  CandidateKind,
  CandidateSelectionRequest,
  PatchTarget,
  SelectFile,
  SelectionCandidate,
  SelectionChoice,
  SelectionFileCandidate,
  SelectionGroupCandidate,
  SelectionRole,
};
