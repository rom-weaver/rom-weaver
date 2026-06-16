import { createLogger } from "../../lib/logging.ts";

const logger = createLogger("runner-scheduler");

/**
 * A unit of work the scheduler admits subject to three gates: a maximum number of concurrent
 * operations, a shared worker-thread budget, and OPFS path exclusivity. The scheduler is generic and
 * holds no wasm/runner state — `runRomWeaverJson` describes each operation and supplies the callback
 * that actually drives a pooled runner.
 */
type ScheduledOperation = {
  /**
   * Requested worker-thread count. Thread-less commands (`probe`/`list`) pass 0 so they never count
   * against the budget. Commands that request the whole machine (a large compress) pass the resolved
   * core count, which keeps a second heavy operation from starting alongside them.
   */
  threads: number;
  /**
   * Estimated peak resident working set in bytes. Two operations whose summed estimate would exceed the
   * memory ceiling are not run concurrently. 0 (the default) means "unknown / negligible".
   */
  bytes?: number;
  /**
   * OPFS/guest paths the operation reads or writes. Two operations whose path sets intersect are never
   * run concurrently: OPFS `FileSystemSyncAccessHandle`s are exclusive per file, so overlapping access
   * would deadlock or fail one of them.
   */
  paths: ReadonlySet<string>;
  /** When true the operation must run with the pool otherwise empty (a hard "run me alone" request). */
  exclusive?: boolean;
  /** Short label (the command type) used only for trace lines. */
  label?: string;
};

export type OperationScheduler = {
  schedule<TResult>(operation: ScheduledOperation, run: () => Promise<TResult>): Promise<TResult>;
  setMaxConcurrency(maxConcurrency: number): void;
  setMemoryCeiling(memoryCeiling: number): void;
  setTotalThreadBudget(totalThreadBudget: number): void;
  readonly inFlightCount: number;
  /** In-flight operations that requested at least one worker thread (excludes 0-thread probe/list). */
  readonly inFlightThreadedCount: number;
  readonly waitingCount: number;
};

type SchedulerOptions = {
  totalThreadBudget: number;
  maxConcurrency: number;
  memoryCeiling?: number;
  onTrace?: (message: string, details?: Record<string, unknown>) => void;
};

type InFlightEntry = {
  threads: number;
  bytes: number;
  paths: ReadonlySet<string>;
  exclusive: boolean;
};

type Waiter = {
  operation: ScheduledOperation;
  admit: () => void;
};

export function createOperationScheduler(options: SchedulerOptions): OperationScheduler {
  let totalThreadBudget = Math.max(1, Math.floor(options.totalThreadBudget));
  let maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency));
  let memoryCeiling =
    options.memoryCeiling === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(options.memoryCeiling));
  const inFlight = new Set<InFlightEntry>();
  const waiters: Waiter[] = [];
  const trace =
    options.onTrace ?? ((message: string, details?: Record<string, unknown>) => logger.trace(message, details));

  const allocatedThreads = (): number => {
    let sum = 0;
    for (const entry of inFlight) sum += entry.threads;
    return sum;
  };

  const allocatedBytes = (): number => {
    let sum = 0;
    for (const entry of inFlight) sum += entry.bytes;
    return sum;
  };

  const intersectsInFlightPaths = (paths: ReadonlySet<string>): boolean => {
    if (paths.size === 0) return false;
    for (const entry of inFlight) {
      if (entry.paths.size === 0) continue;
      for (const path of paths) {
        if (entry.paths.has(path)) return true;
      }
    }
    return false;
  };

  const canAdmit = (operation: ScheduledOperation): boolean => {
    if (inFlight.size >= maxConcurrency) return false;
    // An exclusive operation in flight blocks everything; a fresh exclusive operation needs the pool
    // empty before it can claim it.
    for (const entry of inFlight) {
      if (entry.exclusive) return false;
    }
    if (operation.exclusive === true && inFlight.size > 0) return false;
    // A lone operation always runs, even when it requests more than the whole budget, so a single op
    // configured with a high thread count never deadlocks waiting for capacity that will never free.
    if (inFlight.size > 0 && allocatedThreads() + Math.max(0, operation.threads) > totalThreadBudget) {
      return false;
    }
    // Memory gate, symmetric with the thread gate: a lone operation always runs (even when its own
    // estimate exceeds the ceiling), but a second one is refused when the combined estimate would.
    if (inFlight.size > 0 && allocatedBytes() + Math.max(0, operation.bytes ?? 0) > memoryCeiling) {
      return false;
    }
    return !intersectsInFlightPaths(operation.paths);
  };

  const admit = <TResult>(
    operation: ScheduledOperation,
    run: () => Promise<TResult>,
    resolve: (value: TResult) => void,
    reject: (reason: unknown) => void,
  ): void => {
    const entry: InFlightEntry = {
      bytes: Math.max(0, operation.bytes ?? 0),
      exclusive: operation.exclusive === true,
      paths: operation.paths,
      threads: Math.max(0, operation.threads),
    };
    inFlight.add(entry);
    trace("operation admitted", {
      allocatedThreads: allocatedThreads(),
      inFlight: inFlight.size,
      label: operation.label,
      threads: entry.threads,
      waiting: waiters.length,
    });
    let settled: Promise<TResult>;
    try {
      settled = run();
    } catch (error) {
      settled = Promise.reject(error);
    }
    const finish = (): void => {
      inFlight.delete(entry);
      pump();
    };
    settled.then(
      (value) => {
        finish();
        resolve(value);
      },
      (error) => {
        finish();
        reject(error);
      },
    );
  };

  const pump = (): void => {
    // First-fit from the head of the queue: admit the earliest waiter that currently fits, then retry.
    // First-fit (rather than strict head-only) lets a cheap operation start alongside a long one
    // instead of blocking behind a head-of-line operation that cannot fit yet. A waiter that never
    // fits can in principle starve; `maxConcurrency` is small so the window is bounded, and the
    // configurable budget keeps the common case (a handful of operations) fair.
    while (inFlight.size < maxConcurrency && waiters.length > 0) {
      const index = waiters.findIndex((waiter) => canAdmit(waiter.operation));
      if (index < 0) break;
      const [waiter] = waiters.splice(index, 1);
      waiter?.admit();
    }
  };

  return {
    get inFlightCount(): number {
      return inFlight.size;
    },
    get inFlightThreadedCount(): number {
      let count = 0;
      for (const entry of inFlight) {
        if (entry.threads > 0) count += 1;
      }
      return count;
    },
    schedule<TResult>(operation: ScheduledOperation, run: () => Promise<TResult>): Promise<TResult> {
      return new Promise<TResult>((resolve, reject) => {
        const start = (): void => admit(operation, run, resolve, reject);
        if (canAdmit(operation)) {
          start();
          return;
        }
        trace("operation queued", {
          inFlight: inFlight.size,
          label: operation.label,
          threads: Math.max(0, operation.threads),
          waiting: waiters.length + 1,
        });
        waiters.push({ admit: start, operation });
      });
    },
    setMaxConcurrency(value: number): void {
      maxConcurrency = Math.max(1, Math.floor(value));
      pump();
    },
    setMemoryCeiling(value: number): void {
      memoryCeiling = Math.max(1, Math.floor(value));
      pump();
    },
    setTotalThreadBudget(value: number): void {
      totalThreadBudget = Math.max(1, Math.floor(value));
      pump();
    },
    get waitingCount(): number {
      return waiters.length;
    },
  };
}
