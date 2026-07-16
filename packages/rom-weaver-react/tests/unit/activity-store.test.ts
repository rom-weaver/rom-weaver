import { describe, expect, it, vi } from "vitest";
import {
  getWorkbenchActivity,
  setWorkbenchActivity,
  subscribeWorkbenchActivity,
} from "../../src/lib/activity-store.ts";

/**
 * Workbench activity store: forms publish job state, the selvage subscribes.
 * Equal states must not notify (the publishing effects run on every render).
 */

describe("activity store", () => {
  it("publishes state changes to subscribers and resets the stage line", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeWorkbenchActivity(listener);
    setWorkbenchActivity("apply", { stage: "Apply - track 1", state: "running" });
    expect(getWorkbenchActivity()).toEqual({ stage: "Apply - track 1", state: "running" });
    expect(listener).toHaveBeenCalledTimes(1);
    // omitting stage clears it
    setWorkbenchActivity("apply", { state: "done" });
    expect(getWorkbenchActivity()).toEqual({ stage: "", state: "done" });
    unsubscribe();
    setWorkbenchActivity("apply", { state: "idle" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("short-circuits identical updates", () => {
    setWorkbenchActivity("apply", { state: "idle" });
    const listener = vi.fn();
    const unsubscribe = subscribeWorkbenchActivity(listener);
    setWorkbenchActivity("apply", { state: "idle" });
    setWorkbenchActivity("apply", { stage: "", state: "idle" });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("keeps a live run published when another workflow settles to idle", () => {
    // The last-writer-wins bug: mounting/settling a sibling form must not clobber
    // a concurrently running workflow (which would release the wake lock).
    setWorkbenchActivity("apply", { state: "idle" });
    setWorkbenchActivity("trim", { state: "idle" });
    setWorkbenchActivity("trim", { stage: "Trim", state: "running" });
    expect(getWorkbenchActivity().state).toBe("running");
    // Make Patch tab mounts with busy=false and publishes idle - must NOT win.
    setWorkbenchActivity("create", { state: "idle" });
    expect(getWorkbenchActivity().state).toBe("running");
    setWorkbenchActivity("trim", { state: "idle" });
    expect(getWorkbenchActivity().state).toBe("idle");
  });
});
