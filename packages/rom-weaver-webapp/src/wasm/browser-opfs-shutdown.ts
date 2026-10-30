// Shared control MUST keep state (0 live, 1 stopping, 2 closed, 3 failed) and proxy-bootstrap ownership in separate words.
// Longest wait for the proxy to acknowledge closing its handles before the native worker is terminated anyway.
export const OPFS_SHUTDOWN_TIMEOUT_MS = 10_000;
const pendingShutdowns = new Set<Promise<void>>();

export function registerRomWeaverShutdown(shutdown: Promise<void>): void {
  pendingShutdowns.add(shutdown);
  void shutdown.then(
    () => pendingShutdowns.delete(shutdown),
    () => undefined,
  );
}

export async function waitForRomWeaverShutdown(): Promise<void> {
  while (pendingShutdowns.size > 0) await Promise.all(pendingShutdowns);
}

export function requestOpfsShutdown(control: Int32Array): void {
  Atomics.compareExchange(control, 0, 0, 1);
  Atomics.notify(control, 0);
}

export function acknowledgeOpfsShutdown(control: Int32Array, failed = false): void {
  Atomics.store(control, 0, failed ? 3 : 2);
  Atomics.notify(control, 0);
}

// With a timeout, a missing acknowledgement resolves instead of hanging every later waiter: the caller then
// terminates the native worker, which releases whatever it still holds. Engines may leave `Atomics.waitAsync`
// unresolved after a notification, so the timer races the wait rather than relying on its own timeout.
export async function waitForOpfsShutdownState(control: Int32Array, state: number, timeoutMs?: number): Promise<void> {
  const deadline = timeoutMs === undefined ? Number.POSITIVE_INFINITY : performance.now() + timeoutMs;
  while (Atomics.load(control, 0) < state) {
    const value = Atomics.load(control, 0);
    if (value >= state) break;
    const remaining = deadline - performance.now();
    if (remaining <= 0) return;
    const wait = Atomics.waitAsync(control, 0, value);
    if (!wait.async) continue;
    if (timeoutMs === undefined) {
      await wait.value;
      continue;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      wait.value,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remaining);
      }),
    ]);
    clearTimeout(timer);
  }
  if (state === 2 && Atomics.load(control, 0) === 3) throw new Error("OPFS proxy failed to close its owned resources");
}
