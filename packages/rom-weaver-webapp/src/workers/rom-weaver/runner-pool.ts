import { createLogger } from "../../lib/logging.ts";

const logger = createLogger("runner-pool");

/**
 * A borrowed runner. The holder runs one operation, then calls exactly one of `release` (return the
 * runner to the warm idle pool for reuse) or - implicitly, via `terminate` - discards it. `markStale`
 * flags a runner so it is disposed instead of reused when released (e.g. after an error that may have
 * left wasm state inconsistent).
 */
type RunnerLease<TRunner> = {
  readonly runner: TRunner;
  /** Return the runner to the pool, kept warm for reuse - unless it was marked stale or terminated. */
  release(): void;
  /** Flag this runner for disposal (not reuse) when released. */
  markStale(): void;
  /** Immediately drop this runner from the pool and hard-terminate it (abort / out-of-memory path). */
  terminate(): void;
};

export type RunnerPool<TRunner, TCreateOptions = void> = {
  acquire(createOptions?: TCreateOptions): Promise<RunnerLease<TRunner>>;
  /** Mark every pooled runner stale: idle runners are disposed now, busy ones when they are released. */
  markAllStale(): void;
  /**
   * Dispose every pooled runner. `terminate: true` hard-terminates idle and busy runners alike,
   * interrupting in-flight work (abort/reset). The graceful default disposes idle runners and marks
   * busy ones stale so their in-flight operation finishes before the runner is torn down.
   */
  disposeAll(options?: { terminate?: boolean }): Promise<void>;
  /**
   * Dispose idle runners only, without resetting the pool: busy runners keep running and stay
   * reusable, and an acquire whose runner creation is in flight keeps that runner (no soft-reset
   * retry). For releasing warm reservations, not for reset/teardown.
   */
  disposeIdle(): Promise<void>;
  readonly idleCount: number;
  readonly busyCount: number;
};

type RunnerPoolOptions<TRunner, TCreateOptions> = {
  /** Soft cap on warm idle runners kept for reuse. Extra runners are disposed on release. */
  maxIdle: number;
  create: (createOptions?: TCreateOptions) => Promise<TRunner>;
  /** Graceful teardown (release OPFS handles, then terminate the worker). */
  dispose: (runner: TRunner) => Promise<void>;
  /** Instant teardown (terminate the worker now). */
  terminate: (runner: TRunner) => void;
  onTrace?: (message: string, details?: Record<string, unknown>) => void;
};

type PoolEntry<TRunner> = {
  runner: TRunner;
  stale: boolean;
  disposed: boolean;
};

export function createRunnerPool<TRunner, TCreateOptions = void>(
  options: RunnerPoolOptions<TRunner, TCreateOptions>,
): RunnerPool<TRunner, TCreateOptions> {
  const idle: PoolEntry<TRunner>[] = [];
  const busy = new Set<PoolEntry<TRunner>>();
  const maxIdle = Math.max(0, Math.floor(options.maxIdle));
  let generation = 0;
  let hardResetGeneration = 0;
  const trace =
    options.onTrace ?? ((message: string, details?: Record<string, unknown>) => logger.trace(message, details));

  const disposeEntry = async (entry: PoolEntry<TRunner>, terminate: boolean): Promise<void> => {
    if (entry.disposed) return;
    entry.disposed = true;
    try {
      if (terminate) options.terminate(entry.runner);
      else await options.dispose(entry.runner);
    } catch (error) {
      trace("runner dispose failed", { message: error instanceof Error ? error.message : String(error) });
    }
  };

  const makeLease = (entry: PoolEntry<TRunner>): RunnerLease<TRunner> => {
    let settled = false;
    return {
      markStale(): void {
        entry.stale = true;
      },
      release(): void {
        if (settled) return;
        settled = true;
        busy.delete(entry);
        if (entry.stale || entry.disposed || idle.length >= maxIdle) {
          void disposeEntry(entry, false);
          return;
        }
        idle.push(entry);
        trace("runner released to idle", { busy: busy.size, idle: idle.length });
      },
      get runner(): TRunner {
        return entry.runner;
      },
      terminate(): void {
        if (settled) return;
        settled = true;
        entry.stale = true;
        busy.delete(entry);
        void disposeEntry(entry, true);
        trace("runner terminated", { busy: busy.size, idle: idle.length });
      },
    };
  };

  const takeWarmIdle = (): PoolEntry<TRunner> | undefined => {
    while (idle.length > 0) {
      const entry = idle.pop();
      if (!entry) continue;
      if (entry.stale || entry.disposed) {
        void disposeEntry(entry, false);
        continue;
      }
      return entry;
    }
    return undefined;
  };

  return {
    async acquire(createOptions?: TCreateOptions): Promise<RunnerLease<TRunner>> {
      for (;;) {
        const reused = takeWarmIdle();
        const createGeneration = generation;
        const entry: PoolEntry<TRunner> = reused ?? {
          disposed: false,
          runner: await options.create(createOptions),
          stale: false,
        };
        if (!reused && createGeneration !== generation) {
          const hardReset = hardResetGeneration > createGeneration;
          await disposeEntry(entry, hardReset);
          // A hard reset can arrive while a soft reset's graceful disposal is awaiting the worker.
          // Re-read the generation after that await so the acquire never resurrects a runner afterward.
          if (hardReset || hardResetGeneration > createGeneration) {
            throw new Error("runner pool reset during runner creation");
          }
          trace("runner creation crossed soft reset; retrying", { generation });
          continue;
        }
        busy.add(entry);
        trace(reused ? "runner acquired (warm)" : "runner acquired (new)", { busy: busy.size, idle: idle.length });
        return makeLease(entry);
      }
    },
    get busyCount(): number {
      return busy.size;
    },
    async disposeAll(disposeOptions: { terminate?: boolean } = {}): Promise<void> {
      generation += 1;
      if (disposeOptions.terminate === true) {
        hardResetGeneration = generation;
        const entries = [...idle.splice(0, idle.length), ...busy];
        busy.clear();
        await Promise.all(entries.map((entry) => disposeEntry(entry, true)));
        return;
      }
      // Graceful: dispose idle runners now, leave busy ones running but flagged for disposal on release.
      for (const entry of busy) entry.stale = true;
      const idleEntries = idle.splice(0, idle.length);
      await Promise.all(idleEntries.map((entry) => disposeEntry(entry, false)));
    },
    async disposeIdle(): Promise<void> {
      const idleEntries = idle.splice(0, idle.length);
      await Promise.all(idleEntries.map((entry) => disposeEntry(entry, false)));
    },
    get idleCount(): number {
      return idle.length;
    },
    markAllStale(): void {
      generation += 1;
      for (const entry of busy) entry.stale = true;
      const previouslyIdle = idle.splice(0, idle.length);
      for (const entry of previouslyIdle) void disposeEntry(entry, false);
    },
  };
}
