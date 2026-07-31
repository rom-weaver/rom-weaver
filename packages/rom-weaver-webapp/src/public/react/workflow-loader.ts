type DisposableWorkflow = { dispose: () => Promise<unknown> };

/** Single dynamic-import site for the deferred browser API chunk the workflow forms share. */
const loadBrowserApi = () => import("../../platform/browser/browser-api.ts");

/**
 * Single-flight holder for a lazily constructed workflow. `get` shares one in-flight
 * load across concurrent callers. `reset` invalidates loads still in flight: a workflow
 * finishing construction after a reset is disposed and handed only to its stale caller
 * (matching a reset landing right after a synchronous construction) instead of being
 * published, so the next `get` builds a fresh one.
 */
const createWorkflowHandle = <T extends DisposableWorkflow>() => {
  let current: T | null = null;
  let pending: Promise<T> | null = null;
  let generation = 0;

  const get = (load: () => Promise<() => T>): Promise<T> => {
    if (current) return Promise.resolve(current);
    if (pending) return pending;
    const startedGeneration = generation;
    const run = load().then((create) => {
      if (generation !== startedGeneration) {
        const stale = create();
        void stale.dispose().catch(() => undefined);
        return stale;
      }
      if (current) return current;
      current = create();
      return current;
    });
    pending = run;
    const clearPending = () => {
      if (pending === run) pending = null;
    };
    run.then(clearPending, clearPending);
    return run;
  };

  const peek = (): T | null => current;

  /** Drops the current workflow (returned so the caller can dispose it) and invalidates in-flight loads. */
  const reset = (): T | null => {
    generation += 1;
    pending = null;
    const workflow = current;
    current = null;
    return workflow;
  };

  return { get, peek, reset };
};

export { createWorkflowHandle, loadBrowserApi };
