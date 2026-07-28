import { afterEach, expect, test, vi } from "vitest";
import { scheduleBrowserRuntimePreload } from "../../src/webapp/browser-runtime-preload.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test.each(["pointerdown", "keydown", "dragenter", "drop"])("preloads once on first %s intent", (eventName) => {
  vi.useFakeTimers();
  const requestIdleCallback = vi.fn();
  vi.stubGlobal("requestIdleCallback", requestIdleCallback);
  vi.stubGlobal("cancelIdleCallback", vi.fn());
  const preload = vi.fn();
  const cancel = scheduleBrowserRuntimePreload(preload);

  window.dispatchEvent(new Event(eventName));
  window.dispatchEvent(new Event(eventName));
  vi.advanceTimersByTime(2000);

  expect(preload).toHaveBeenCalledTimes(1);
  expect(requestIdleCallback).not.toHaveBeenCalled();
  cancel();
});

test("preloads during idle after the quiet period", () => {
  vi.useFakeTimers();
  let runIdle;
  const requestIdleCallback = vi.fn((callback) => {
    runIdle = callback;
    return 1;
  });
  vi.stubGlobal("requestIdleCallback", requestIdleCallback);
  vi.stubGlobal("cancelIdleCallback", vi.fn());
  const preload = vi.fn();
  const cancel = scheduleBrowserRuntimePreload(preload);

  vi.advanceTimersByTime(1999);
  expect(requestIdleCallback).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(requestIdleCallback).toHaveBeenCalledOnce();
  runIdle();

  expect(preload).toHaveBeenCalledOnce();
  cancel();
});
