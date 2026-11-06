import type { CandidateSelectionRequest } from "../../types/selection.ts";
import { hasEngineErrorCode, toRomWeaverError } from "../errors.ts";

const canRecoverWithCandidateSelection = (error: unknown, requests: CandidateSelectionRequest[]) => {
  if (!requests.length) return false;
  const normalized = toRomWeaverError(error);
  return normalized.code === "AMBIGUOUS_SELECTION";
};

// The engine codes a dismissed interactive (host-driven) selection prompt, so staging can tell a
// deliberate cancel apart from a recoverable ambiguity and stop instead of re-prompting a worker
// nobody will answer.
const isInteractiveSelectionCancelledError = (error: unknown): boolean =>
  hasEngineErrorCode(error, "selection.cancelled");

// A cancelled selection must surface as the graceful "skipped" code: setInput's catch then releases
// the staged input (no stranded OPFS copy) and the form swallows it instead of showing an error.
const createSelectionSkippedError = (cause: unknown): Error & { code: string } => {
  const error = new Error("Input selection was cancelled") as Error & { code: string; cause?: unknown };
  error.code = "WORKFLOW_SELECTION_SKIPPED";
  error.cause = cause;
  return error;
};

export { canRecoverWithCandidateSelection, createSelectionSkippedError, isInteractiveSelectionCancelledError };
