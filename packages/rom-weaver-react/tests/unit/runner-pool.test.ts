import { describe, expect, it } from "vitest";
import { createRunnerPool } from "../../src/workers/rom-weaver/runner-pool.ts";

type MockRunner = { id: number };

function createTrackedPool(maxIdle = 1) {
  let created = 0;
  const disposed: number[] = [];
  const terminated: number[] = [];
  const pool = createRunnerPool<MockRunner>({
    create: async () => {
      created += 1;
      return { id: created };
    },
    dispose: async (runner) => {
      disposed.push(runner.id);
    },
    maxIdle,
    terminate: (runner) => {
      terminated.push(runner.id);
    },
  });
  return {
    countCreated: () => created,
    disposed,
    pool,
    terminated,
  };
}

describe("createRunnerPool", () => {
  it("creates a runner on first acquire and reuses it after release", async () => {
    const tracked = createTrackedPool(1);
    const lease1 = await tracked.pool.acquire();
    expect(lease1.runner.id).toBe(1);
    expect(tracked.pool.busyCount).toBe(1);
    lease1.release();
    expect(tracked.pool.idleCount).toBe(1);
    const lease2 = await tracked.pool.acquire();
    expect(lease2.runner.id).toBe(1);
    expect(tracked.countCreated()).toBe(1);
    expect(tracked.disposed).toEqual([]);
  });

  it("disposes (does not reuse) a runner marked stale before release", async () => {
    const tracked = createTrackedPool(1);
    const lease1 = await tracked.pool.acquire();
    lease1.markStale();
    lease1.release();
    expect(tracked.disposed).toEqual([1]);
    expect(tracked.pool.idleCount).toBe(0);
    const lease2 = await tracked.pool.acquire();
    expect(lease2.runner.id).toBe(2);
    expect(tracked.countCreated()).toBe(2);
  });

  it("hard-terminates a runner via the lease and never reuses it", async () => {
    const tracked = createTrackedPool(1);
    const lease = await tracked.pool.acquire();
    lease.terminate();
    expect(tracked.terminated).toEqual([1]);
    expect(tracked.pool.busyCount).toBe(0);
    // A late release after terminate is a no-op (no double dispose).
    lease.release();
    expect(tracked.disposed).toEqual([]);
  });

  it("caps warm idle runners at maxIdle, disposing the surplus on release", async () => {
    const tracked = createTrackedPool(1);
    const lease1 = await tracked.pool.acquire();
    const lease2 = await tracked.pool.acquire();
    expect(tracked.countCreated()).toBe(2);
    lease1.release();
    lease2.release();
    expect(tracked.pool.idleCount).toBe(1);
    expect(tracked.disposed).toEqual([2]);
  });

  it("markAllStale disposes idle runners now and busy ones on release", async () => {
    const tracked = createTrackedPool(2);
    const lease1 = await tracked.pool.acquire(); // entry 1 -> busy
    const lease2 = await tracked.pool.acquire(); // entry 2 -> busy (idle empty, so a fresh runner)
    lease1.release(); // entry 1 -> idle
    tracked.pool.markAllStale();
    expect(tracked.disposed).toEqual([1]);
    expect(tracked.pool.idleCount).toBe(0);
    lease2.release();
    expect(tracked.disposed).toEqual([1, 2]);
  });

  it("disposeAll({ terminate: true }) terminates idle and busy runners", async () => {
    const tracked = createTrackedPool(2);
    const lease1 = await tracked.pool.acquire(); // entry 1 -> busy
    const lease2 = await tracked.pool.acquire(); // entry 2 -> busy (idle empty, so a fresh runner)
    lease1.release(); // entry 1 -> idle
    await tracked.pool.disposeAll({ terminate: true });
    expect(tracked.terminated.slice().sort()).toEqual([1, 2]);
    expect(tracked.pool.idleCount).toBe(0);
    expect(tracked.pool.busyCount).toBe(0);
    lease2.release(); // late release after terminate is a no-op
    expect(tracked.disposed).toEqual([]);
  });

  it("disposeAll() gracefully disposes idle runners and marks busy ones for disposal", async () => {
    const tracked = createTrackedPool(2);
    const lease1 = await tracked.pool.acquire(); // entry 1 -> busy
    const lease2 = await tracked.pool.acquire();
    lease2.release(); // entry 2 -> idle
    await tracked.pool.disposeAll();
    expect(tracked.disposed).toEqual([2]);
    lease1.release();
    expect(tracked.disposed).toEqual([2, 1]);
  });
});
