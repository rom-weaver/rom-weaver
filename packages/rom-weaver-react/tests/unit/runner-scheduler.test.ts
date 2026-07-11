import { describe, expect, it } from "vitest";
import { createOperationScheduler } from "../../src/workers/rom-weaver/runner-scheduler.ts";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

// Flush pending microtasks plus a macrotask turn so the scheduler's settle/pump callbacks run.
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("createOperationScheduler", () => {
  it("admits non-conflicting operations concurrently up to the concurrency cap", async () => {
    const scheduler = createOperationScheduler({ maxConcurrency: 2, totalThreadBudget: 4 });
    const a = deferred<string>();
    const b = deferred<string>();
    let aStarted = false;
    let bStarted = false;
    const pa = scheduler.schedule({ paths: new Set(), threads: 1 }, async () => {
      aStarted = true;
      return a.promise;
    });
    const pb = scheduler.schedule({ paths: new Set(), threads: 1 }, async () => {
      bStarted = true;
      return b.promise;
    });
    expect(aStarted).toBe(true);
    expect(bStarted).toBe(true);
    expect(scheduler.inFlightCount).toBe(2);
    a.resolve("a");
    b.resolve("b");
    expect(await pa).toBe("a");
    expect(await pb).toBe("b");
  });

  it("runs a full-budget operation alone and queues the next until it finishes", async () => {
    const scheduler = createOperationScheduler({ maxConcurrency: 2, totalThreadBudget: 4 });
    const a = deferred<string>();
    let bStarted = false;
    const pa = scheduler.schedule({ paths: new Set(), threads: 4 }, () => a.promise);
    const pb = scheduler.schedule({ paths: new Set(), threads: 4 }, async () => {
      bStarted = true;
      return "b";
    });
    expect(scheduler.inFlightCount).toBe(1);
    expect(scheduler.waitingCount).toBe(1);
    expect(bStarted).toBe(false);
    a.resolve("a");
    await pa;
    await tick();
    expect(bStarted).toBe(true);
    expect(await pb).toBe("b");
  });

  it("fully serializes when the concurrency cap is 1", async () => {
    const scheduler = createOperationScheduler({ maxConcurrency: 1, totalThreadBudget: 16 });
    const a = deferred<string>();
    let bStarted = false;
    const pa = scheduler.schedule({ paths: new Set(), threads: 1 }, () => a.promise);
    const pb = scheduler.schedule({ paths: new Set(), threads: 1 }, async () => {
      bStarted = true;
      return "b";
    });
    expect(scheduler.inFlightCount).toBe(1);
    expect(bStarted).toBe(false);
    a.resolve("a");
    await pa;
    await tick();
    expect(bStarted).toBe(true);
    await pb;
  });

  it("serializes operations whose path sets intersect even when threads fit", async () => {
    const scheduler = createOperationScheduler({ maxConcurrency: 4, totalThreadBudget: 16 });
    const a = deferred<string>();
    let bStarted = false;
    const pa = scheduler.schedule({ paths: new Set(["/work/a.iso"]), threads: 1 }, () => a.promise);
    const pb = scheduler.schedule({ paths: new Set(["/work/a.iso"]), threads: 1 }, async () => {
      bStarted = true;
      return "b";
    });
    expect(scheduler.inFlightCount).toBe(1);
    expect(bStarted).toBe(false);
    a.resolve("a");
    await pa;
    await tick();
    expect(bStarted).toBe(true);
    await pb;
  });

  it("runs operations with disjoint paths concurrently", () => {
    const scheduler = createOperationScheduler({ maxConcurrency: 4, totalThreadBudget: 16 });
    const a = deferred<string>();
    const b = deferred<string>();
    scheduler.schedule({ paths: new Set(["/work/a.iso"]), threads: 1 }, () => a.promise);
    scheduler.schedule({ paths: new Set(["/work/b.iso"]), threads: 1 }, () => b.promise);
    expect(scheduler.inFlightCount).toBe(2);
    a.resolve("a");
    b.resolve("b");
  });

  it("runs a lone operation even when it requests more than the whole budget", async () => {
    const scheduler = createOperationScheduler({ maxConcurrency: 2, totalThreadBudget: 4 });
    let started = false;
    const p = scheduler.schedule({ paths: new Set(), threads: 16 }, async () => {
      started = true;
      return "x";
    });
    expect(started).toBe(true);
    expect(await p).toBe("x");
  });

  it("lets a fitting operation pass a queued operation that does not fit yet", () => {
    const scheduler = createOperationScheduler({ maxConcurrency: 3, totalThreadBudget: 4 });
    const a = deferred<string>();
    const big = deferred<string>();
    let smallStarted = false;
    scheduler.schedule({ paths: new Set(), threads: 3 }, () => a.promise);
    scheduler.schedule({ paths: new Set(), threads: 4 }, () => big.promise);
    const pSmall = scheduler.schedule({ paths: new Set(), threads: 1 }, async () => {
      smallStarted = true;
      return "s";
    });
    expect(smallStarted).toBe(true);
    expect(scheduler.inFlightCount).toBe(2);
    expect(scheduler.waitingCount).toBe(1);
    a.resolve("a");
    big.resolve("big");
    return pSmall;
  });

  it("keeps the pool healthy when an operation rejects", async () => {
    const scheduler = createOperationScheduler({ maxConcurrency: 1, totalThreadBudget: 4 });
    let bStarted = false;
    const pa = scheduler.schedule({ paths: new Set(), threads: 1 }, async () => {
      throw new Error("boom");
    });
    const pb = scheduler.schedule({ paths: new Set(), threads: 1 }, async () => {
      bStarted = true;
      return "b";
    });
    await expect(pa).rejects.toThrow("boom");
    await tick();
    expect(bStarted).toBe(true);
    expect(await pb).toBe("b");
  });

  it("runs an exclusive operation alone and blocks others until it finishes", async () => {
    const scheduler = createOperationScheduler({ maxConcurrency: 4, totalThreadBudget: 16 });
    const ex = deferred<string>();
    let otherStarted = false;
    const pe = scheduler.schedule({ exclusive: true, paths: new Set(), threads: 1 }, () => ex.promise);
    const po = scheduler.schedule({ paths: new Set(), threads: 1 }, async () => {
      otherStarted = true;
      return "o";
    });
    expect(scheduler.inFlightCount).toBe(1);
    expect(otherStarted).toBe(false);
    ex.resolve("e");
    await pe;
    await tick();
    expect(otherStarted).toBe(true);
    await po;
  });

  it("makes an exclusive operation wait until the pool drains", async () => {
    const scheduler = createOperationScheduler({ maxConcurrency: 4, totalThreadBudget: 16 });
    const a = deferred<string>();
    let exStarted = false;
    const pa = scheduler.schedule({ paths: new Set(), threads: 1 }, () => a.promise);
    const pe = scheduler.schedule({ exclusive: true, paths: new Set(), threads: 1 }, async () => {
      exStarted = true;
      return "e";
    });
    expect(exStarted).toBe(false);
    expect(scheduler.waitingCount).toBe(1);
    a.resolve("a");
    await pa;
    await tick();
    expect(exStarted).toBe(true);
    await pe;
  });

  it("admits a waiting operation when the concurrency cap is raised", async () => {
    const scheduler = createOperationScheduler({ maxConcurrency: 1, totalThreadBudget: 16 });
    const a = deferred<string>();
    let bStarted = false;
    scheduler.schedule({ paths: new Set(), threads: 1 }, () => a.promise);
    const pb = scheduler.schedule({ paths: new Set(), threads: 1 }, async () => {
      bStarted = true;
      return "b";
    });
    expect(bStarted).toBe(false);
    scheduler.setMaxConcurrency(2);
    expect(bStarted).toBe(true);
    a.resolve("a");
    await pb;
  });

  it("serializes two operations whose combined memory estimate exceeds the ceiling", async () => {
    const scheduler = createOperationScheduler({ maxConcurrency: 4, memoryCeiling: 1000, totalThreadBudget: 16 });
    const a = deferred<string>();
    let bStarted = false;
    const pa = scheduler.schedule({ bytes: 700, paths: new Set(), threads: 1 }, () => a.promise);
    const pb = scheduler.schedule({ bytes: 700, paths: new Set(), threads: 1 }, async () => {
      bStarted = true;
      return "b";
    });
    expect(scheduler.inFlightCount).toBe(1);
    expect(bStarted).toBe(false);
    a.resolve("a");
    await pa;
    await tick();
    expect(bStarted).toBe(true);
    await pb;
  });

  it("runs two operations concurrently when their combined memory fits the ceiling", () => {
    const scheduler = createOperationScheduler({ maxConcurrency: 4, memoryCeiling: 1000, totalThreadBudget: 16 });
    const a = deferred<string>();
    const b = deferred<string>();
    scheduler.schedule({ bytes: 400, paths: new Set(), threads: 1 }, () => a.promise);
    scheduler.schedule({ bytes: 400, paths: new Set(), threads: 1 }, () => b.promise);
    expect(scheduler.inFlightCount).toBe(2);
    a.resolve("a");
    b.resolve("b");
  });

  it("runs a lone over-ceiling operation but blocks the next until it finishes", async () => {
    const scheduler = createOperationScheduler({ maxConcurrency: 4, memoryCeiling: 1000, totalThreadBudget: 16 });
    const a = deferred<string>();
    let bStarted = false;
    const pa = scheduler.schedule({ bytes: 5000, paths: new Set(), threads: 1 }, () => a.promise);
    const pb = scheduler.schedule({ bytes: 1, paths: new Set(), threads: 1 }, async () => {
      bStarted = true;
      return "b";
    });
    expect(scheduler.inFlightCount).toBe(1);
    expect(bStarted).toBe(false);
    a.resolve("a");
    await pa;
    await tick();
    expect(bStarted).toBe(true);
    await pb;
  });
});

describe("createOperationScheduler - I/O lane (Rust plan)", () => {
  const io = (jobSizeBytes: number, paths: string[] = []) => ({
    io: true,
    jobSizeBytes,
    paths: new Set(paths),
    threads: 0,
  });

  // Stub planner that puts every job in one concurrent wave (full overlap), splitting the budget evenly.
  const planAllTogether = (budget: number) => async (sizes: number[]) => ({
    waves: [{ jobs: sizes.map((_, index) => index), threadsPerJob: Math.max(1, Math.floor(budget / sizes.length)) }],
  });

  it("admits an I/O wave the planner groups together, even when the jobs arrive staggered", async () => {
    const scheduler = createOperationScheduler({
      maxConcurrency: 4,
      planBatch: planAllTogether(4),
      totalThreadBudget: 4,
    });
    const a = deferred<string>();
    const b = deferred<string>();
    const pa = scheduler.schedule(io(100), () => a.promise);
    await tick();
    const pb = scheduler.schedule(io(100), () => b.promise);
    await tick();
    expect(scheduler.inFlightCount).toBe(2);
    a.resolve("a");
    b.resolve("b");
    expect(await pa).toBe("a");
    expect(await pb).toBe("b");
  });

  it("plans a noted simultaneous drop as one batch so the first job's threads reflect the whole drop", async () => {
    const planSeen: number[][] = [];
    const planBatch = async (sizes: number[]) => {
      planSeen.push([...sizes]);
      return {
        waves: [{ jobs: sizes.map((_, index) => index), threadsPerJob: Math.max(1, Math.floor(6 / sizes.length)) }],
      };
    };
    const scheduler = createOperationScheduler({ maxConcurrency: 6, planBatch, totalThreadBudget: 6 });
    // The drop point declares all three sizes up front; only the first file reaches the scheduler now.
    scheduler.noteIoBatch([100, 100, 100]);
    const a = deferred<string>();
    let aThreads = 0;
    const pa = scheduler.schedule(io(100), (threads) => {
      aThreads = threads;
      return a.promise;
    });
    await tick();
    expect(planSeen[0]).toHaveLength(3); // first plan saw the whole drop, not just the one arrived job
    expect(aThreads).toBe(2); // floor(6/3) - the first job starts at the batch's per-job share, not full 6
    a.resolve("a");
    await pa;
  });

  it("keeps a noted drop intact when an unrelated I/O op overlaps it", async () => {
    const planSeen: number[][] = [];
    const planBatch = async (sizes: number[]) => {
      planSeen.push([...sizes]);
      return {
        waves: [{ jobs: sizes.map((_, index) => index), threadsPerJob: Math.max(1, Math.floor(6 / sizes.length)) }],
      };
    };
    const scheduler = createOperationScheduler({ maxConcurrency: 6, planBatch, totalThreadBudget: 6 });
    // A three-file drop is declared up front; none of its ingest ops has reached the scheduler yet.
    scheduler.noteIoBatch([100, 100, 100]);
    // An unrelated I/O op from a PRIOR drop (a different source size) arrives first and runs to
    // completion. It must not claim a noted slot or mark the note consumed, so the drop's note survives.
    const x = deferred<string>();
    const px = scheduler.schedule(io(50), () => x.promise);
    await tick();
    x.resolve("x");
    await px;
    await tick();
    // The drop's own first job now arrives: the note must be untouched so the plan still sees all three.
    const a = deferred<string>();
    let aThreads = 0;
    const pa = scheduler.schedule(io(100), (threads) => {
      aThreads = threads;
      return a.promise;
    });
    await tick();
    const lastPlan = planSeen[planSeen.length - 1];
    expect(lastPlan).toHaveLength(3); // still the whole noted drop, not the lone arrived job
    expect(aThreads).toBe(2); // floor(6/3) - full-drop share; would be 6 if the note had been wiped
    a.resolve("a");
    await pa;
  });

  it("gives a lone (un-noted) I/O job the whole budget", async () => {
    const scheduler = createOperationScheduler({
      maxConcurrency: 6,
      planBatch: planAllTogether(6),
      totalThreadBudget: 6,
    });
    const a = deferred<string>();
    let aThreads = 0;
    const pa = scheduler.schedule(io(100), (threads) => {
      aThreads = threads;
      return a.promise;
    });
    await tick();
    expect(aThreads).toBe(6); // no noted batch + nothing else in flight → full budget
    a.resolve("a");
    await pa;
  });

  it("defers an I/O job the planner places in a later wave until the first finishes", async () => {
    // Only the first job of any round is concurrently runnable; the rest land in a later wave.
    const planFirstOnly = async (sizes: number[]) => ({
      waves: [
        { jobs: [0], threadsPerJob: 4 },
        { jobs: sizes.slice(1).map((_, index) => index + 1), threadsPerJob: 4 },
      ],
    });
    const scheduler = createOperationScheduler({ maxConcurrency: 4, planBatch: planFirstOnly, totalThreadBudget: 4 });
    const a = deferred<string>();
    const b = deferred<string>();
    let bStarted = false;
    const pa = scheduler.schedule(io(100), () => a.promise);
    await tick();
    const pb = scheduler.schedule(io(100), async () => {
      bStarted = true;
      return b.promise;
    });
    await tick();
    expect(scheduler.inFlightCount).toBe(1);
    expect(bStarted).toBe(false);
    a.resolve("a");
    await pa;
    await tick();
    expect(bStarted).toBe(true);
    b.resolve("b");
    await pb;
  });

  it("never overlaps I/O jobs that share an OPFS path even when the planner groups them", async () => {
    const scheduler = createOperationScheduler({
      maxConcurrency: 4,
      planBatch: planAllTogether(4),
      totalThreadBudget: 4,
    });
    const a = deferred<string>();
    const b = deferred<string>();
    let bStarted = false;
    const pa = scheduler.schedule(io(100, ["/work/a.iso"]), () => a.promise);
    await tick();
    const pb = scheduler.schedule(io(100, ["/work/a.iso"]), async () => {
      bStarted = true;
      return b.promise;
    });
    await tick();
    expect(scheduler.inFlightCount).toBe(1);
    expect(bStarted).toBe(false);
    a.resolve("a");
    await pa;
    await tick();
    expect(bStarted).toBe(true);
    b.resolve("b");
    await pb;
  });

  it("falls back to serial admission when a planning round-trip fails", async () => {
    const scheduler = createOperationScheduler({
      maxConcurrency: 4,
      planBatch: async () => {
        throw new Error("plan boom");
      },
      totalThreadBudget: 4,
    });
    const a = deferred<string>();
    const b = deferred<string>();
    let bStarted = false;
    const pa = scheduler.schedule(io(100), () => a.promise);
    const pb = scheduler.schedule(io(100), async () => {
      bStarted = true;
      return b.promise;
    });
    await tick();
    expect(scheduler.inFlightCount).toBe(1);
    expect(bStarted).toBe(false);
    a.resolve("a");
    await pa;
    await tick();
    expect(bStarted).toBe(true);
    b.resolve("b");
    await pb;
  });

  it("admits I/O ops serially when no planner is configured", async () => {
    const scheduler = createOperationScheduler({ maxConcurrency: 4, totalThreadBudget: 4 });
    const a = deferred<string>();
    const b = deferred<string>();
    let bStarted = false;
    const pa = scheduler.schedule(io(100), () => a.promise);
    const pb = scheduler.schedule(io(100), async () => {
      bStarted = true;
      return b.promise;
    });
    await tick();
    expect(scheduler.inFlightCount).toBe(1);
    expect(bStarted).toBe(false);
    a.resolve("a");
    await pa;
    await tick();
    expect(bStarted).toBe(true);
    b.resolve("b");
    await pb;
  });
});
