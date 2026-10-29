// Shared control MUST keep state (0 live, 1 stopping, 2 closed, 3 failed) and proxy-bootstrap ownership in separate words.
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

export async function waitForOpfsShutdownState(control: Int32Array, state: number): Promise<void> {
  while (Atomics.load(control, 0) < state) {
    const value = Atomics.load(control, 0);
    if (value >= state) break;
    const wait = Atomics.waitAsync(control, 0, value);
    if (wait.async) await wait.value;
  }
  if (state === 2 && Atomics.load(control, 0) === 3) throw new Error("OPFS proxy failed to close its owned resources");
}
