// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

import { scheduleBrowserRuntimePrefetch } from "../../src/webapp/browser-runtime-preload.ts";

describe("scheduleBrowserRuntimePrefetch", () => {
  it("does not prefetch without user intent", () => {
    vi.useFakeTimers();
    const prefetch = vi.fn();
    const cancel = scheduleBrowserRuntimePrefetch(prefetch);
    vi.advanceTimersByTime(10_000);
    vi.useRealTimers();
    expect(prefetch).not.toHaveBeenCalled();
    cancel();
  });

  it.each(["dragenter", "pointerdown", "keydown"])("prefetches once on the first %s", (eventName) => {
    const prefetch = vi.fn();
    const cancel = scheduleBrowserRuntimePrefetch(prefetch);
    window.dispatchEvent(new Event(eventName));
    window.dispatchEvent(new Event("keydown"));
    window.dispatchEvent(new Event("pointerdown"));
    expect(prefetch).toHaveBeenCalledTimes(1);
    cancel();
  });

  it("does not prefetch after cancel", () => {
    const prefetch = vi.fn();
    scheduleBrowserRuntimePrefetch(prefetch)();
    for (const eventName of ["dragenter", "pointerdown", "keydown"]) window.dispatchEvent(new Event(eventName));
    expect(prefetch).not.toHaveBeenCalled();
  });
});
