type CandidateKind = "cue" | "disc" | "gdi" | "patch" | "rom" | "track" | "unknown";

type CandidateGroupKind = "chd-output-mode" | "cue-disc" | "multi-file-input";

type SelectionRole = "input" | "modified" | "original" | "patch";

type SelectionFileCandidate = {
  type: "file";
  breadcrumbs?: string[];
  /** Pre-select (and mark as "matches") this candidate when the multi-select picker opens - the
   * same-named default for a "replace from archive" pick. The user can still change the selection. */
  defaultSelected?: boolean;
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
  /** When true, the host may pick several candidates at once (each becomes its own patch entry). */
  multiSelect?: boolean;
  role: SelectionRole;
  sourceIndex?: number;
  sourceName: string;
  warnings: string[];
};

/** A resolved selection. `id` is always the primary (first) pick; `ids` carries the full ordered set
 * for a multi-select request. */
type SelectionChoice = { id: string; ids?: string[] };

type SelectFile = (request: CandidateSelectionRequest) => Promise<SelectionChoice> | SelectionChoice;

export type {
  CandidateSelectionRequest,
  SelectFile,
  SelectionCandidate,
  SelectionChoice,
  SelectionFileCandidate,
  SelectionGroupCandidate,
  SelectionRole,
};
