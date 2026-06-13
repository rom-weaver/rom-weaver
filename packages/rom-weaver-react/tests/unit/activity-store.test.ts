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
    setWorkbenchActivity({ stage: "Apply — track 1", state: "running" });
    expect(getWorkbenchActivity()).toEqual({ stage: "Apply — track 1", state: "running" });
    expect(listener).toHaveBeenCalledTimes(1);
    // omitting stage clears it
    setWorkbenchActivity({ state: "done" });
    expect(getWorkbenchActivity()).toEqual({ stage: "", state: "done" });
    unsubscribe();
    setWorkbenchActivity({ state: "idle" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("short-circuits identical updates", () => {
    setWorkbenchActivity({ state: "idle" });
    const listener = vi.fn();
    const unsubscribe = subscribeWorkbenchActivity(listener);
    setWorkbenchActivity({ state: "idle" });
    setWorkbenchActivity({ stage: "", state: "idle" });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
