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

export { scheduleBrowserRuntimePreload };
