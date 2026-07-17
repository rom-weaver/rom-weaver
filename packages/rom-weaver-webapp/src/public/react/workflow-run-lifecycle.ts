import { type MutableRefObject, useCallback } from "react";
import { getErrorCode } from "../../presentation/errors.ts";
import { isUserRequestedCancellation } from "./workflow-form-utils.ts";
import type { WorkflowFormProgressState } from "./workflow-run-hooks.ts";

// Reported-vs-measured run timing, shared by the apply/create/trim runs. Each run reports its operation
// and compression durations when it can; when it doesn't, the durations are measured from the run's
// start timestamps (operation start → compression start → completion). Returning `null`/`undefined` is
// left to the caller - this normalizes a missing value to `null` and callers map it to their own shape.
const deriveWorkflowRunTiming = ({
  completedAt,
  compressionStartedAt,
  operationStartedAt,
  reportedCompressionTimeMs,
  reportedOperationTimeMs,
}: {
  completedAt: number;
  compressionStartedAt: number | null;
  operationStartedAt: number | null;
  reportedCompressionTimeMs?: number | null;
  reportedOperationTimeMs?: number | null;
}): { compressionTimeMs: number | null; operationTimeMs: number | null } => {
  const normalizedReportedOperationTimeMs =
    typeof reportedOperationTimeMs === "number" && Number.isFinite(reportedOperationTimeMs)
      ? Math.max(0, Math.round(reportedOperationTimeMs))
      : null;
  const normalizedReportedCompressionTimeMs =
    typeof reportedCompressionTimeMs === "number" && Number.isFinite(reportedCompressionTimeMs)
      ? Math.max(0, Math.round(reportedCompressionTimeMs))
      : null;
  const fallbackOperationTimeMs =
    typeof operationStartedAt === "number"
      ? Math.max(
          0,
          (typeof compressionStartedAt === "number" ? compressionStartedAt : completedAt) - operationStartedAt,
        )
      : null;
  const operationTimeMs = normalizedReportedOperationTimeMs ?? fallbackOperationTimeMs;
  const compressionTimeMs =
    normalizedReportedCompressionTimeMs ??
    (typeof compressionStartedAt === "number" ? Math.max(0, completedAt - compressionStartedAt) : null);
  return { compressionTimeMs, operationTimeMs };
};

// The `finally` block always runs the latest cleanup the body registered (detach the progress
// listener, dispose a non-reused workflow, …). Registering eagerly - right after the listener is
// attached, before the throwable staging/run - means cleanup still runs if the body throws, matching
// the original per-form try/finally. The body owns its own progress wiring and result handling; the
// lifecycle owns the AbortController, busy flag, and catch/finally.
type WorkflowRunCleanup = () => Promise<void> | void;
type RegisterWorkflowRunCleanup = (cleanup: WorkflowRunCleanup) => void;

type WorkflowRunExecutor = (
  abortController: AbortController,
  registerCleanup: RegisterWorkflowRunCleanup,
) => Promise<void>;

type WorkflowRunLifecycleOptions = {
  abortActiveOperation: () => void;
  activeAbortControllerRef: MutableRefObject<AbortController | null>;
  clearCompleted: () => void;
  clearWorkflowMessage: () => void;
  createInitialProgress: () => WorkflowFormProgressState;
  disposeActiveOutput: () => void;
  // Run errors always surface on the output section in both create and trim.
  notifyError: (error: Error) => void;
  rememberAbortController: (abortController: AbortController | null) => void;
  setBusy: (busy: boolean) => void;
  setProgress: (progress: WorkflowFormProgressState | null) => void;
  setQueued: (queued: boolean) => void;
  setWorkflowOutputError: (error: Error) => void;
};

// Owns the run/cancel/timing lifecycle shared by the create and trim forms: it allocates the
// AbortController, flips `busy`, clears the previous output/message/progress, runs the body, and applies
// the identical cancellation → WORKFLOW_SELECTION_SKIPPED → output-error catch and the
// detach/dispose/clear-abort/setBusy(false) finally. The divergent run body (workflow construction,
// source staging, result handling) is the `execute` callback; the divergent pre-run guards stay at the
// call site. Returns `runWorkflow` (wrap a body) and `cancelOutputProgress` (the shared cancel handler).
const useWorkflowRunLifecycle = ({
  abortActiveOperation,
  activeAbortControllerRef,
  clearCompleted,
  clearWorkflowMessage,
  createInitialProgress,
  disposeActiveOutput,
  notifyError,
  rememberAbortController,
  setBusy,
  setProgress,
  setQueued,
  setWorkflowOutputError,
}: WorkflowRunLifecycleOptions) => {
  const runWorkflow = useCallback(
    async (execute: WorkflowRunExecutor) => {
      const abortController = new AbortController();
      rememberAbortController(abortController);
      setBusy(true);
      clearWorkflowMessage();
      disposeActiveOutput();
      clearCompleted();
      setProgress(createInitialProgress());
      let cleanup: WorkflowRunCleanup = () => undefined;
      const registerCleanup: RegisterWorkflowRunCleanup = (nextCleanup) => {
        cleanup = nextCleanup;
      };
      try {
        await execute(abortController, registerCleanup);
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        const code = getErrorCode(normalizedError);
        if (isUserRequestedCancellation(normalizedError, abortController.signal)) {
          clearWorkflowMessage();
          setProgress(null);
          clearCompleted();
          return;
        }
        if (code === "WORKFLOW_SELECTION_SKIPPED") {
          clearWorkflowMessage();
          setProgress(null);
          return;
        }
        setWorkflowOutputError(normalizedError);
        setProgress(null);
        clearCompleted();
        notifyError(normalizedError);
      } finally {
        await cleanup();
        if (activeAbortControllerRef.current === abortController) rememberAbortController(null);
        setBusy(false);
      }
    },
    [
      activeAbortControllerRef,
      clearCompleted,
      clearWorkflowMessage,
      createInitialProgress,
      disposeActiveOutput,
      notifyError,
      rememberAbortController,
      setBusy,
      setProgress,
      setWorkflowOutputError,
    ],
  );

  const cancelOutputProgress = useCallback(
    (busy: boolean) => {
      setQueued(false);
      if (busy) {
        abortActiveOperation();
        disposeActiveOutput();
        clearCompleted();
        return;
      }
      setProgress(null);
    },
    [abortActiveOperation, clearCompleted, disposeActiveOutput, setProgress, setQueued],
  );

  return { cancelOutputProgress, runWorkflow };
};

export { deriveWorkflowRunTiming, useWorkflowRunLifecycle };
