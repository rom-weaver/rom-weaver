import type { PatcherStackController } from "./patcher-form.ts";

const READY_TIMEOUT_MS = 2000;

const isReady = (stack: Pick<PatcherStackController, "getState">, count: number | undefined): boolean => {
  const { items } = stack.getState();
  const hasExpectedCount = count === undefined ? items.length > 0 : items.length === count;
  return hasExpectedCount && items.every((item) => !(item.progress || item.optionsDisabled));
};

const waitForPatchStackReady = (
  stack: Pick<PatcherStackController, "getState" | "subscribe"> | null,
  { signal, count }: { signal: AbortSignal; count?: number },
): Promise<void> => {
  if (signal.aborted || (stack && isReady(stack, count))) return Promise.resolve();

  return new Promise((resolve) => {
    let unsubscribe: (() => void) | undefined;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      unsubscribe?.();
      resolve();
    };
    const timeout = setTimeout(finish, READY_TIMEOUT_MS);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) {
      finish();
      return;
    }
    if (stack) {
      unsubscribe = stack.subscribe(finishIfReady);
      if (settled) {
        unsubscribe();
        return;
      }
      // State can become ready between the initial check and subscription.
      finishIfReady();
    }

    function finishIfReady() {
      if (stack && isReady(stack, count)) finish();
    }
  });
};

export { waitForPatchStackReady };
