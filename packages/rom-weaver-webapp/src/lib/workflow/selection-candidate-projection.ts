import type { CandidateSelectionRequest, SelectionCandidate } from "../../types/selection.ts";
import { selectionToArchiveEntry } from "../input/selection.ts";
import { cloneCandidate } from "./controller-utils.ts";
import type { SharedInternalCandidate, SharedRomSourceState, SharedRomStagedSource } from "./staged-source-types.ts";

type SelectionCandidateProjection<TSource, TState extends SharedRomSourceState> = {
  candidates: SelectionCandidate[];
  internalCandidates: Map<string, SharedInternalCandidate<TSource, TState>>;
};

const projectSelectionCandidates = <TSource, TState extends SharedRomSourceState>(options: {
  createPublicId: (candidate: SelectionCandidate) => string;
  owner: SharedRomStagedSource<TSource, TState>;
  request: CandidateSelectionRequest;
}): SelectionCandidateProjection<TSource, TState> => {
  const { owner, request } = options;
  const publicIdByCandidateId = new Map(
    request.candidates.map((candidate) => [candidate.id, options.createPublicId(candidate)]),
  );
  const internalCandidates = new Map<string, SharedInternalCandidate<TSource, TState>>();
  const candidates = request.candidates.map((candidate) => {
    const publicId = publicIdByCandidateId.get(candidate.id) as string;
    const publicCandidate = cloneCandidate(candidate);
    internalCandidates.set(publicId, {
      archiveEntry: candidate.selectable ? selectionToArchiveEntry(request, { id: candidate.id }) : undefined,
      candidate,
      owner,
      request,
    });
    return {
      ...publicCandidate,
      id: publicId,
      ...(publicCandidate.type === "group"
        ? {
            candidateIds: (publicCandidate.candidateIds || []).map(
              (candidateId) => publicIdByCandidateId.get(candidateId) || candidateId,
            ),
          }
        : publicCandidate.parentCandidateId
          ? {
              parentCandidateId: publicIdByCandidateId.get(publicCandidate.parentCandidateId),
            }
          : {}),
    } as SelectionCandidate;
  });
  return { candidates, internalCandidates };
};

export { projectSelectionCandidates };
