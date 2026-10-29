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
