import { describe, expect, it, vi } from "vitest";
import { createUnsavedWorkLock, isUnsavedWorkOpen } from "../../src/webapp/pwa/unsaved-work-lock.ts";

// Grants each request at once and lists held locks the way LockManager.query does.
const createLocks = (otherHeld: string[] = []) => {
  const held: LockInfo[] = otherHeld.map((name) => ({ mode: "exclusive", name }));
  return {
    held,
    query: async () => ({ held: [...held], pending: [] }),
    request: async (name: string, options: LockOptions, callback: () => Promise<unknown>) => {
      const info: LockInfo = { mode: options.mode, name };
      held.push(info);
      try {
        return await callback();
      } finally {
        held.splice(held.indexOf(info), 1);
      }
    },
  };
};
const asLockManager = (locks: ReturnType<typeof createLocks>) => locks as unknown as LockManager;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("unsaved-work lock", () => {
  it("holds one shared lock while work is unsaved, across repeated changes", async () => {
    const locks = createLocks();
    const lock = createUnsavedWorkLock(asLockManager(locks), vi.fn());

    lock.set(true);
    lock.set(true);
    await flush();
    expect(locks.held).toEqual([{ mode: "shared", name: "rom-weaver-unsaved-work" }]);
    await expect(isUnsavedWorkOpen(asLockManager(locks))).resolves.toBe(true);

    lock.set(false);
    lock.set(false);
    await flush();
    await expect(isUnsavedWorkOpen(asLockManager(locks))).resolves.toBe(false);

    lock.set(true);
    await flush();
    await expect(isUnsavedWorkOpen(asLockManager(locks))).resolves.toBe(true);
  });

  it.each([
    { label: "only other locks are held", locks: asLockManager(createLocks(["rom-weaver-kept-roms"])) },
    { label: "the browser has no Web Locks", locks: undefined },
  ])("reports no unsaved work when $label", async ({ locks }) => {
    await expect(isUnsavedWorkOpen(locks)).resolves.toBe(false);
  });

  it("passes a failed lock request to the error handler", async () => {
    const error = new Error("the document is not fully active");
    const onRequestError = vi.fn();
    const locks = { request: vi.fn(() => Promise.reject(error)) } as unknown as LockManager;

    createUnsavedWorkLock(locks, onRequestError).set(true);
    await flush();

    expect(onRequestError).toHaveBeenCalledWith(error);
  });
});
