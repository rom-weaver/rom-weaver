import { createLogger } from "./logging.ts";

/**
 * Workbench activity for the selvage status strip: which state the bench is
 * in (idle / staging / ready / running / failed / done) and an optional stage
 * line ("Apply — Track 1.bin"). Forms publish; the selvage subscribes. A
 * vanilla store so non-React controllers can publish too.
 */

type WorkbenchActivityState = "done" | "failed" | "idle" | "ready" | "running" | "staging";

type WorkbenchActivity = {
  state: WorkbenchActivityState;
  /** Short live description of the active stage; empty when not running. */
  stage: string;
};

const logger = createLogger("activity-store");

let activity: WorkbenchActivity = { stage: "", state: "idle" };
const listeners = new Set<() => void>();

const getWorkbenchActivity = (): WorkbenchActivity => activity;

const setWorkbenchActivity = (next: Partial<WorkbenchActivity> & { state: WorkbenchActivityState }) => {
  const merged: WorkbenchActivity = { stage: next.stage ?? "", state: next.state };
  if (merged.state === activity.state && merged.stage === activity.stage) return;
  logger.trace("Workbench activity changed", { from: activity.state, stage: merged.stage, to: merged.state });
  activity = merged;
  for (const listener of listeners) listener();
};

const subscribeWorkbenchActivity = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export type { WorkbenchActivity, WorkbenchActivityState };
export { getWorkbenchActivity, setWorkbenchActivity, subscribeWorkbenchActivity };
