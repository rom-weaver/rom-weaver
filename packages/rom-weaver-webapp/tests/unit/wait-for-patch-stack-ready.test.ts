import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForPatchStackReady } from "../../src/public/react/wait-for-patch-stack-ready.ts";

const stackHarness = (items: Array<{ optionsDisabled?: boolean; progress?: unknown }> = []) => {
  let state = { items };
  const listeners = new Set<() => void>();
  return {
    controller: {
      getState: () => state,
      subscribe: vi.fn((listener: () => void) => {
        listeners.add(listener);
        return vi.fn(() => listeners.delete(listener));
      }),
    },
    listenerCount: () => listeners.size,
    setItems(next: typeof items) {
      state = { items: next };
      for (const listener of listeners) listener();
    },
  };
};

afterEach(() => vi.useRealTimers());

describe("waitForPatchStackReady", () => {
  it("does not subscribe when the initial state is ready", async () => {
    const harness = stackHarness([{ progress: null }]);
    await waitForPatchStackReady(harness.controller as never, {
      signal: new AbortController().signal,
    });
    expect(harness.controller.subscribe).not.toHaveBeenCalled();
  });

  it("waits for the exact count and cleans up its subscription", async () => {
    const harness = stackHarness([{ progress: {} }]);
    const waiting = waitForPatchStackReady(harness.controller as never, {
      count: 2,
      signal: new AbortController().signal,
    });
    expect(harness.listenerCount()).toBe(1);
    harness.setItems([{ progress: null }, { optionsDisabled: false }]);
    await waiting;
    expect(harness.listenerCount()).toBe(0);
  });

  it("cleans up when readiness changes during subscription", async () => {
    let ready = false;
    const unsubscribe = vi.fn();
    const stack = {
      getState: () => ({ items: ready ? [{ progress: null }] : [] }),
      subscribe: (listener: () => void) => {
        ready = true;
        listener();
        return unsubscribe;
      },
    };
    await waitForPatchStackReady(stack as never, { signal: new AbortController().signal });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("resolves and cleans up on abort", async () => {
    const harness = stackHarness();
    const abort = new AbortController();
    const waiting = waitForPatchStackReady(harness.controller as never, { signal: abort.signal });
    abort.abort();
    await waiting;
    expect(harness.listenerCount()).toBe(0);
  });

  it("falls back after 2000ms and cleans up", async () => {
    vi.useFakeTimers();
    const harness = stackHarness();
    const waiting = waitForPatchStackReady(harness.controller as never, {
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(harness.listenerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(harness.listenerCount()).toBe(0);
  });
});
