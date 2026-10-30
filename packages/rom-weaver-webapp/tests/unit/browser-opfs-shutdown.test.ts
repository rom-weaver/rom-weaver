import { expect, it, vi } from "vitest";

it("concurrent cleanup waiters retain ownership until every registered shutdown closes", async () => {
  vi.resetModules();
  const { registerRomWeaverShutdown, waitForRomWeaverShutdown } =
    await import("../../src/wasm/browser-opfs-shutdown.ts");
  let closeFirst!: () => void;
  let closeSecond!: () => void;
  registerRomWeaverShutdown(
    new Promise<void>((resolve) => {
      closeFirst = resolve;
    }),
  );
  const firstWait = vi.fn();
  const secondWait = vi.fn();
  const first = waitForRomWeaverShutdown().then(firstWait);
  const second = waitForRomWeaverShutdown().then(secondWait);
  registerRomWeaverShutdown(
    new Promise<void>((resolve) => {
      closeSecond = resolve;
    }),
  );
  closeFirst();
  await Promise.resolve();
  await Promise.resolve();
  expect(firstWait).not.toHaveBeenCalled();
  expect(secondWait).not.toHaveBeenCalled();
  closeSecond();
  await Promise.all([first, second]);
  expect(firstWait).toHaveBeenCalledOnce();
  expect(secondWait).toHaveBeenCalledOnce();
});

it("failed closure rejects all cleanup waiters and retains failed ownership", async () => {
  vi.resetModules();
  const { registerRomWeaverShutdown, waitForRomWeaverShutdown } =
    await import("../../src/wasm/browser-opfs-shutdown.ts");
  registerRomWeaverShutdown(Promise.reject(new Error("closure failed")));
  await expect(waitForRomWeaverShutdown()).rejects.toThrow("closure failed");
  await expect(waitForRomWeaverShutdown()).rejects.toThrow("closure failed");
});

it("stops waiting for an acknowledgement that never comes once the timeout passes", async () => {
  vi.useFakeTimers();
  try {
    const { waitForOpfsShutdownState } = await import("../../src/wasm/browser-opfs-shutdown.ts");
    const control = new Int32Array(new SharedArrayBuffer(8));
    const waited = vi.fn();
    const waiting = waitForOpfsShutdownState(control, 2, 500).then(waited);
    await vi.advanceTimersByTimeAsync(499);
    expect(waited).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await waiting;
    expect(waited).toHaveBeenCalledOnce();
    expect(Atomics.load(control, 0)).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("sees an acknowledgement stored without a notification within one recheck slice", async () => {
  vi.useFakeTimers();
  try {
    const { waitForOpfsShutdownState } = await import("../../src/wasm/browser-opfs-shutdown.ts");
    const control = new Int32Array(new SharedArrayBuffer(8));
    const waited = vi.fn();
    const waiting = waitForOpfsShutdownState(control, 2, 10_000).then(waited);
    await vi.advanceTimersByTimeAsync(100);
    // An engine that loses the notification never wakes the async wait, so only the recheck can notice this.
    Atomics.store(control, 0, 2);
    // The first recheck lands 250 ms after the wait began, so it must resolve by then, not at the 10 s timeout.
    await vi.advanceTimersByTimeAsync(150);
    expect(waited).toHaveBeenCalledOnce();
    await waiting;
  } finally {
    vi.useRealTimers();
  }
});
