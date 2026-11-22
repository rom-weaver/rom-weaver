// Pages hold this Web Lock while they have unsaved work, so the service worker can see that work in any tab.
const UNSAVED_WORK_LOCK_NAME = "rom-weaver-unsaved-work";

/** Holds the shared unsaved-work lock from `set(true)` until `set(false)` or the page unloads. */
const createUnsavedWorkLock = (locks: LockManager | undefined, onRequestError: (error: unknown) => void) => {
  let release: (() => void) | undefined;
  return {
    set(unsaved: boolean) {
      if (!locks || unsaved === (release !== undefined)) return;
      if (!unsaved) {
        release?.();
        release = undefined;
        return;
      }
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      locks.request(UNSAVED_WORK_LOCK_NAME, { mode: "shared" }, () => held).catch(onRequestError);
    },
  };
};

/** Whether any page of this origin holds the unsaved-work lock. */
const isUnsavedWorkOpen = async (locks: LockManager | undefined) => {
  const snapshot = await locks?.query();
  return snapshot?.held?.some((lock) => lock.name === UNSAVED_WORK_LOCK_NAME) ?? false;
};

export { createUnsavedWorkLock, isUnsavedWorkOpen };
