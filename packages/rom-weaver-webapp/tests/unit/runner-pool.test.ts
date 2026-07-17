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

  it("disposeIdle disposes idle runners but leaves busy ones reusable", async () => {
    const tracked = createTrackedPool(2);
    const lease1 = await tracked.pool.acquire(); // entry 1 -> busy
    const lease2 = await tracked.pool.acquire(); // entry 2 -> busy
    lease2.release(); // entry 2 -> idle
    await tracked.pool.disposeIdle();
    expect(tracked.disposed).toEqual([2]);
    expect(tracked.pool.idleCount).toBe(0);
    lease1.release(); // busy runner was NOT marked stale: it returns to the warm pool
    expect(tracked.pool.idleCount).toBe(1);
    const lease3 = await tracked.pool.acquire();
    expect(lease3.runner.id).toBe(1);
    expect(tracked.countCreated()).toBe(2);
  });

  it("disposeIdle does not discard a runner whose creation is in flight", async () => {
    const finishCreates: Array<(runner: MockRunner) => void> = [];
    const disposed: number[] = [];
    const pool = createRunnerPool<MockRunner>({
      create: () =>
        new Promise((resolve) => {
          finishCreates.push(resolve);
        }),
      dispose: async (runner) => {
        disposed.push(runner.id);
      },
      maxIdle: 1,
      terminate: () => undefined,
    });

    const pendingAcquire = pool.acquire();
    await pool.disposeIdle();
    finishCreates[0]?.({ id: 1 });

    const lease = await pendingAcquire;
    expect(lease.runner.id).toBe(1);
    expect(finishCreates.length).toBe(1);
    expect(disposed).toEqual([]);
    expect(pool.busyCount).toBe(1);
  });

  it("terminates a runner whose creation finishes after a hard reset", async () => {
    let finishCreate: ((runner: MockRunner) => void) | undefined;
    const terminated: number[] = [];
    const pool = createRunnerPool<MockRunner>({
      create: () =>
        new Promise((resolve) => {
          finishCreate = resolve;
        }),
      dispose: async () => undefined,
      maxIdle: 1,
      terminate: (runner) => terminated.push(runner.id),
    });

    const pendingAcquire = pool.acquire();
    await pool.disposeAll({ terminate: true });
    finishCreate?.({ id: 1 });

    await expect(pendingAcquire).rejects.toThrow("runner pool reset during runner creation");
    expect(terminated).toEqual([1]);
    expect(pool.busyCount).toBe(0);
  });

  it("retries when runner creation crosses a soft reset", async () => {
    const finishCreates: Array<(runner: MockRunner) => void> = [];
    const disposed: number[] = [];
    const pool = createRunnerPool<MockRunner>({
      create: () =>
        new Promise((resolve) => {
          finishCreates.push(resolve);
        }),
      dispose: async (runner) => {
        disposed.push(runner.id);
      },
      maxIdle: 1,
      terminate: () => undefined,
    });

    const pendingAcquire = pool.acquire();
    await pool.disposeAll();
    finishCreates[0]?.({ id: 1 });
    await expect.poll(() => finishCreates.length).toBe(2);
    finishCreates[1]?.({ id: 2 });

    const lease = await pendingAcquire;
    expect(lease.runner.id).toBe(2);
    expect(disposed).toEqual([1]);
    expect(pool.busyCount).toBe(1);
  });

  it("rejects when a hard reset arrives during stale runner disposal", async () => {
    let finishCreate: ((runner: MockRunner) => void) | undefined;
    let finishDispose: (() => void) | undefined;
    let disposeStarted = false;
    let createCount = 0;
    const pool = createRunnerPool<MockRunner>({
      create: () => {
        createCount += 1;
        return new Promise((resolve) => {
          finishCreate = resolve;
        });
      },
      dispose: () =>
        new Promise((resolve) => {
          disposeStarted = true;
          finishDispose = resolve;
        }),
      maxIdle: 1,
      terminate: () => undefined,
    });

    const pendingAcquire = pool.acquire();
    await pool.disposeAll();
    finishCreate?.({ id: 1 });
    await expect.poll(() => disposeStarted).toBe(true);
    await pool.disposeAll({ terminate: true });
    finishDispose?.();

    await expect(pendingAcquire).rejects.toThrow("runner pool reset during runner creation");
    expect(createCount).toBe(1);
    expect(pool.busyCount).toBe(0);
  });
});
