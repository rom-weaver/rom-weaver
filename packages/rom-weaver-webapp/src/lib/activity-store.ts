import { createLogger } from "./logging.ts";

/**
 * Vanilla store for the workbench status strip. Forms publish per-workflow
 * state and optional stage text; React and non-React consumers share it.
 *
 * Mounted sibling forms can publish idle during another workflow's run. Keying
 * by workflow and choosing the highest-priority state preserves live status and
 * the wake lock.
 */

type WorkbenchActivityState = "done" | "failed" | "idle" | "ready" | "running" | "staging";

type WorkbenchActivity = {
  state: WorkbenchActivityState;
  /** Short live description of the active stage; empty when not running. */
  stage: string;
};

const logger = createLogger("activity-store");

// Only running/staging gate behaviour (wake lock, perceived-latency settle); the
// terminal ordering below is cosmetic (which stage line the selvage shows when
// several workflows differ).
const STATE_PRIORITY: Record<WorkbenchActivityState, number> = {
  done: 1,
  failed: 3,
  idle: 0,
  ready: 2,
  running: 5,
  staging: 4,
};

const IDLE: WorkbenchActivity = { stage: "", state: "idle" };

const activities = new Map<string, WorkbenchActivity>();
let published: WorkbenchActivity = IDLE;
const listeners = new Set<() => void>();
const runStartListeners = new Set<(workflowId: string) => void>();

const getWorkbenchActivity = (): WorkbenchActivity => published;

const derivePublished = (): WorkbenchActivity => {
  let best: WorkbenchActivity | null = null;
  for (const entry of activities.values()) {
    if (!best || STATE_PRIORITY[entry.state] > STATE_PRIORITY[best.state]) best = entry;
  }
  return best ?? IDLE;
};

const setWorkbenchActivity = (
  workflowId: string,
  next: Partial<WorkbenchActivity> & { state: WorkbenchActivityState },
) => {
  const merged: WorkbenchActivity = { stage: next.stage ?? "", state: next.state };
  const previous = activities.get(workflowId);
  const unchanged = previous
    ? previous.state === merged.state && previous.stage === merged.stage
    : merged.state === "idle";
  if (unchanged) return;
  // Idle is the absence of activity: drop the entry so a settled workflow cannot
  // pin the published state above another workflow's live run.
  if (merged.state === "idle") activities.delete(workflowId);
  else activities.set(workflowId, merged);
  // Checked before the published state: a run that starts while another one runs leaves it unchanged.
  if (merged.state === "running" && previous?.state !== "running") {
    for (const listener of runStartListeners) listener(workflowId);
  }
  const nextPublished = derivePublished();
  if (nextPublished.state === published.state && nextPublished.stage === published.stage) return;
  logger.trace("Workbench activity changed", {
    from: published.state,
    stage: nextPublished.stage,
    to: nextPublished.state,
    workflowId,
  });
  published = nextPublished;
  for (const listener of listeners) listener();
};

const subscribeWorkbenchActivity = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Calls `listener` with the workflow's id each time a workflow starts a run. */
const subscribeWorkbenchRunStart = (listener: (workflowId: string) => void) => {
  runStartListeners.add(listener);
  return () => {
    runStartListeners.delete(listener);
  };
};

export { getWorkbenchActivity, setWorkbenchActivity, subscribeWorkbenchActivity, subscribeWorkbenchRunStart };
