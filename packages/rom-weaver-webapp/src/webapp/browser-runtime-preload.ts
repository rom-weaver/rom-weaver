const INTENT_EVENTS = ["pointerdown", "keydown", "dragenter", "drop"] as const;

const scheduleBrowserRuntimePreload = (preload: () => void): (() => void) => {
  let stopped = false;
  let idleId: number | undefined;
  let timeoutId: number | undefined;
  const removeIntentListeners = () => {
    for (const eventName of INTENT_EVENTS) window.removeEventListener(eventName, start, true);
  };
  const cancel = () => {
    stopped = true;
    removeIntentListeners();
    if (idleId !== undefined) window.cancelIdleCallback(idleId);
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  };
  const start = () => {
    if (stopped) return;
    cancel();
    preload();
  };
  for (const eventName of INTENT_EVENTS) window.addEventListener(eventName, start, { capture: true, passive: true });
  timeoutId = window.setTimeout(() => {
    timeoutId = undefined;
    if (typeof window.requestIdleCallback === "function") {
      idleId = window.requestIdleCallback(start, { timeout: 2000 });
    } else {
      start();
    }
  }, 2000);
  return cancel;
};

/**
 * Run a network-and-compile-only prefetch (chunk imports, index fetch, wasm fetch) on the next task after
 * hydration. Unlike the full preload it spawns no workers, so it can run well before the 2 s timer and
 * an early drop finds the chunks and wasm module already loaded. It deliberately avoids
 * requestIdleCallback: the page is rarely idle this early, which delayed the start past an early drop.
 */
const scheduleBrowserRuntimePrefetch = (prefetch: () => void): (() => void) => {
  const timeoutId = window.setTimeout(prefetch, 0);
  return () => window.clearTimeout(timeoutId);
};

export { scheduleBrowserRuntimePrefetch, scheduleBrowserRuntimePreload };
