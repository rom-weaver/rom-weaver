// Holds wasm runs and input staging until the page-load OPFS wipe has settled, so a write can never
// land in a directory the boot-time recursive delete is still walking. All OPFS writes happen inside
// workers that only act on a main-thread dispatch, and the wipe runs on the main thread — so gating
// the main-thread dispatch chokepoints preserves the "no write before cleanup" guarantee while the UI
// renders ahead of the wipe.
//
// Defaults to settled (resolved): any context that never opens the gate — unit tests, the CLI — never
// waits. Only the webapp boot opens it, and always closes it (even if the wipe fails).

let settled = true;
let resolveGate: (() => void) | null = null;
let gate: Promise<void> = Promise.resolve();

/** Open the gate. Call once, synchronously, before the first render — after this, dispatches wait. */
const beginOpfsCleanupGate = (): void => {
  if (!settled) return;
  settled = false;
  gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
};

/** Close the gate once the page-load wipe has finished (or failed). Idempotent. */
const markOpfsCleanupSettled = (): void => {
  if (settled) return;
  settled = true;
  resolveGate?.();
  resolveGate = null;
};

/** Await before any OPFS-touching dispatch. Resolves immediately once the wipe has settled. */
const whenOpfsCleanupSettled = (): Promise<void> => gate;

export { beginOpfsCleanupGate, markOpfsCleanupSettled, whenOpfsCleanupSettled };
