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

const PREFETCH_INTENT_EVENTS = ["dragenter", "pointerdown", "keydown"] as const;

/**
 * Run a network-and-compile-only prefetch (chunk imports, index fetch, wasm fetch) once, on the first
 * sign of user intent. Starting it at page load put a 2.4 MB wasm download on the critical path of
 * slow-network loads, so nothing runs until the visitor interacts. It spawns no workers. Returns a
 * cancel function that removes the listeners.
 */
const scheduleBrowserRuntimePrefetch = (prefetch: () => void): (() => void) => {
  const cancel = () => {
    for (const eventName of PREFETCH_INTENT_EVENTS) window.removeEventListener(eventName, onIntent, true);
  };
  const onIntent = () => {
    cancel();
    prefetch();
  };
  for (const eventName of PREFETCH_INTENT_EVENTS) {
    window.addEventListener(eventName, onIntent, { capture: true, passive: true });
  }
  return cancel;
};

export { scheduleBrowserRuntimePrefetch, scheduleBrowserRuntimePreload };
