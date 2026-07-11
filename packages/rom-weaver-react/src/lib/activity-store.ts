import { createLogger } from "./logging.ts";

/**
 * Workbench activity for the selvage status strip: which state the bench is
 * in (idle / staging / ready / running / failed / done) and an optional stage
 * line ("Apply - Track 1.bin"). Forms publish per workflow; the selvage
 * subscribes to the derived published state. A vanilla store so non-React
 * controllers can publish too.
 *
 * The three workflow forms stay mounted at once, so a single-slot store was
 * last-writer-wins: mounting another tab (busy=false) overwrote a live run's
 * `running` with `idle` and released the wake lock mid-operation. Keying by
 * workflow and publishing the highest-priority state across them keeps a live
 * run visible no matter what a sibling form publishes.
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

export { getWorkbenchActivity, setWorkbenchActivity, subscribeWorkbenchActivity };
