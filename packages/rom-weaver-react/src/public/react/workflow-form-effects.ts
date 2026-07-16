import { useEffect } from "react";
import { setWorkbenchActivity } from "../../lib/activity-store.ts";
import type { PageFileDrop } from "./patcher-form.ts";
import { useLatestRef } from "./use-latest-ref.ts";

/**
 * Shared workflow-form effect/handler helpers extracted from the create and
 * trim forms (and, where the contract matches, the apply form). These collapse
 * several near-identical inline effects/routines that the forms duplicated.
 */

type WorkflowResetActionsOptions = {
  setQueued: (queued: boolean) => void;
  disposeActiveOutput: () => void;
  clearCompleted: () => void;
  clearWorkflowMessage: () => void;
  setProgress: (progress: null) => void;
};

/**
 * The reset routine every `update*` handler runs when an input/setting changes:
 * drop any queued run, dispose the active output, clear the completed output and
 * any workflow message, and (by default) clear progress. `clearProgress: false`
 * matches the `updateSettings` handlers, which intentionally leave progress
 * untouched.
 */
const useWorkflowResetActions = ({
  setQueued,
  disposeActiveOutput,
  clearCompleted,
  clearWorkflowMessage,
  setProgress,
}: WorkflowResetActionsOptions) => {
  const optionsRef = useLatestRef({
    clearCompleted,
    clearWorkflowMessage,
    disposeActiveOutput,
    setProgress,
    setQueued,
  });
  // Read the latest callbacks at call time so this stays a stable identity
  // without re-subscribing the (frequently re-created) form callbacks.
  return ({ clearProgress = true }: { clearProgress?: boolean } = {}) => {
    const options = optionsRef.current;
    options.setQueued(false);
    options.disposeActiveOutput();
    options.clearCompleted();
    options.clearWorkflowMessage();
    if (clearProgress) options.setProgress(null);
  };
};

type QueuedRunEffectOptions = {
  queued: boolean;
  busy: boolean;
  /** True once the run already produced output (completed / pending download). */
  completed: boolean;
  /** Whether the inputs are present enough to queue a run at all. */
  canQueue: boolean;
  /** A blocking warning/error that should drop the queued run. */
  blocked: boolean;
  /** Sources are still preparing - stay queued and wait. */
  pending: boolean;
  /** Everything is ready to start the run right now. */
  canStart: boolean;
  setQueued: (queued: boolean) => void;
  run: () => void;
};

/**
 * The "queued runner" effect shared by the create and trim forms: once a run is
 * queued, drop it if the workflow is busy/completed, can no longer be queued, or
 * is blocked; keep waiting while preparation is pending; otherwise start the run
 * as soon as it can. Runs on every render (no dependency array) so it re-checks
 * readiness as staging state settles - matching the original inline effects.
 */
const useQueuedRunEffect = ({
  queued,
  busy,
  completed,
  canQueue,
  blocked,
  pending,
  canStart,
  setQueued,
  run,
}: QueuedRunEffectOptions) => {
  // No dependency array: this intentionally runs every render to re-check
  // readiness as staging state settles, matching the original inline effects.
  useEffect(() => {
    if (!queued) return;
    if (busy || completed) {
      setQueued(false);
      return;
    }
    if (!canQueue) {
      setQueued(false);
      return;
    }
    if (blocked) {
      setQueued(false);
      return;
    }
    if (pending) return;
    if (!canStart) {
      setQueued(false);
      return;
    }
    run();
  });
};

/**
 * Records the moment a workflow's compression phase begins, the first time a
 * "compress" progress event arrives. Shared by create and trim, which both keep
 * a `compressionStartedAt` slot on a timing ref to derive the compress duration.
 */
const markCompressionStart = (timing: { compressionStartedAt: number | null }): boolean => {
  if (timing.compressionStartedAt !== null) return false;
  timing.compressionStartedAt = Date.now();
  return true;
};

type WorkbenchActivityOptions = {
  busy: boolean;
  queued: boolean;
  completed: boolean;
};

/**
 * Publishes the create/trim workflow's job state to the selvage status strip:
 * running while busy or queued, done once an output is ready, idle otherwise.
 * (The apply form keeps a richer staging/failed-aware variant inline.) Keyed by
 * the caller's stable workflow id so each mounted form owns its own activity slot
 * - a sibling form mounting/settling can no longer clobber a live run.
 */
const useWorkbenchActivity = (workflowId: string, { busy, queued, completed }: WorkbenchActivityOptions) => {
  useEffect(() => {
    if (busy || queued) setWorkbenchActivity(workflowId, { state: "running" });
    else if (completed) setWorkbenchActivity(workflowId, { state: "done" });
    else setWorkbenchActivity(workflowId, { state: "idle" });
    // ponytail: no unmount cleanup - the webapp forms never unmount, and normal
    // settling already clears the slot to idle. Add a cleanup here if a form can
    // unmount mid-run (would otherwise leave a stale 'running' pinned).
  }, [workflowId, busy, queued, completed]);
};

/**
 * Forwards a page-level drop (dragging anywhere on the page) to the form's
 * unified drop handler, so the whole tab is a drop target - not just the
 * dropzone box. Each drop id is handled once; the handler runs in a microtask so
 * it does not fire synchronously during render. The cleanup guard suppresses a
 * queued call if the effect is torn down before that microtask starts.
 */
const usePageDropForwarder = (
  pageDrop: PageFileDrop | null | undefined,
  handler: (files: File[]) => void,
  handledPageDropIdRef: { current: number | null },
) => {
  const handlerRef = useLatestRef(handler);
  useEffect(() => {
    if (!pageDrop || handledPageDropIdRef.current === pageDrop.id) return;
    handledPageDropIdRef.current = pageDrop.id;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      handlerRef.current(pageDrop.files);
    });
    return () => {
      cancelled = true;
    };
  }, [pageDrop, handlerRef, handledPageDropIdRef]);
};

export {
  markCompressionStart,
  usePageDropForwarder,
  useQueuedRunEffect,
  useWorkbenchActivity,
  useWorkflowResetActions,
};
