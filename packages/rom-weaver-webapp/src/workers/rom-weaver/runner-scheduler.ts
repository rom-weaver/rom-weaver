import { createLogger } from "../../lib/logging.ts";

const logger = createLogger("runner-scheduler");

const createSchedulerAbortError = () => {
  const error = new Error("Workflow was cancelled") as Error & { code?: string };
  error.name = "AbortError";
  error.code = "CANCELLED";
  return error;
};

/**
 * A unit of work admitted through one of two lanes:
 *
 * - Non-I/O ops use local concurrency, thread, memory, and OPFS-path gates.
 * - I/O ops use Rust's shared `plan-extract-batch` policy, plus browser-only
 *   concurrency and path-exclusivity gates.
 *
 * {@link OperationScheduler.noteIoBatch} declares staggered multi-file drops
 * up front so the first Rust plan assigns threads across the whole batch.
 */
type ScheduledOperation = {
  /**
   * Worker-thread count for a non-I/O op (its reservation and its forced count). Thread-less commands
   * (`probe`/`list`) pass 0 so they never count against the budget. Ignored for I/O ops - their count
   * is the planner's per-wave `threadsPerJob`.
   */
  threads: number;
  /**
   * Estimated peak resident working set in bytes (non-I/O ops). Two non-I/O ops whose summed estimate
   * would exceed the memory ceiling are not run concurrently. I/O ops ignore this - their memory fit is
   * decided by the Rust plan from `jobSizeBytes` - and contribute 0 to the local memory gate.
   */
  bytes?: number;
  /**
   * OPFS/guest paths the operation reads or writes. Two operations whose path sets intersect are never
   * run concurrently: OPFS `FileSystemSyncAccessHandle`s are exclusive per file, so overlapping access
   * would deadlock or fail one of them. Enforced for both lanes.
   */
  paths: ReadonlySet<string>;
  /** When true the operation must run with the pool otherwise empty (a hard "run me alone" request). */
  exclusive?: boolean;
  /** Short label (the command type) used only for trace lines. */
  label?: string;
  /** When true the op is admitted via the Rust batch plan (extract/ingest/checksum) rather than the
   * local thread/memory gates. */
  io?: boolean;
  /** Source size in bytes fed to the Rust planner for an I/O op. */
  jobSizeBytes?: number;
  /** Cancels this operation while queued. Once admitted, the run callback owns active cancellation. */
  signal?: AbortSignal;
};

/** One concurrently-runnable group from the Rust planner: original job indices that may overlap and the
 * even thread split for the group. Structurally compatible with `RomWeaverBatchPlan` from the runtime. */
type SchedulerBatchPlan = { waves: Array<{ jobs: number[]; threadsPerJob: number }> };

/** Decide which queued I/O jobs may overlap, via the Rust `plan-extract-batch` command. The scheduler
 * passes the in-flight + waiting + noted-but-not-yet-arrived job sizes (in that order) and its own
 * limits; the first wave is the set that may run together. Injected so the scheduler stays free of
 * wasm/runner coupling (and unit tests can stub it). */
type PlanBatch = (
  jobSizes: number[],
  options: { memoryCeilingBytes: number; threadBudget: number },
) => Promise<SchedulerBatchPlan>;

export type OperationScheduler = {
  schedule<TResult>(
    operation: ScheduledOperation,
    run: (assignedThreads: number) => Promise<TResult>,
  ): Promise<TResult>;
  /** Declare a batch of I/O jobs (their source sizes) about to be staged, so the first plan call sees
   * the whole simultaneous drop even though the ops reach the scheduler staggered. Replaces any prior
   * note; consumed as the ops arrive and cleared once the batch has run and drained. */
  noteIoBatch(jobSizes: number[]): void;
  setMaxConcurrency(maxConcurrency: number): void;
  setMemoryCeiling(memoryCeiling: number): void;
  setTotalThreadBudget(totalThreadBudget: number): void;
  readonly inFlightCount: number;
  readonly inFlightThreadedCount: number;
  readonly waitingCount: number;
};

type SchedulerOptions = {
  totalThreadBudget: number;
  maxConcurrency: number;
  memoryCeiling?: number;
  /** Rust-backed I/O admission. When omitted, I/O ops fall back to serial admission (one at a time). */
  planBatch?: PlanBatch;
  onTrace?: (message: string, details?: Record<string, unknown>) => void;
};

type InFlightEntry = {
  threads: number;
  bytes: number;
  paths: ReadonlySet<string>;
  exclusive: boolean;
  io: boolean;
  jobSizeBytes: number;
};

type Waiter = {
  operation: ScheduledOperation;
  detachAbort: () => void;
  /** Admit this waiter with `threads` worker threads (the planner's wave allotment for an I/O op, the
   * op's own reservation otherwise). The count is recorded for cross-lane gating and forwarded to the
   * run callback so the runner forces exactly that many. */
  admit: (threads: number) => void;
};

export function createOperationScheduler(options: SchedulerOptions): OperationScheduler {
  let totalThreadBudget = Math.max(1, Math.floor(options.totalThreadBudget));
  let maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency));
  let memoryCeiling =
    options.memoryCeiling === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.floor(options.memoryCeiling));
  const planBatch = options.planBatch;
  const inFlight = new Set<InFlightEntry>();
  const waiters: Waiter[] = [];
  // Guards against overlapping `plan-extract-batch` round-trips: only one I/O planning pass runs at a
  // time; arrivals during the await are picked up by the re-pump after it resolves.
  let planningIoWave = false;
  // Sizes of a declared I/O drop that have NOT yet reached the scheduler - see noteIoBatch. Each is
  // removed as its op arrives (so it is never double-counted) and they feed the plan so the first
  // arriving job is grouped against the whole drop. `noteConsumed` tracks that the batch actually
  // started, so a stale note is cleared only after its ops have run and drained (never mid-staging).
  let pendingIoBatchSizes: number[] = [];
  let noteConsumed = false;
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

  const nonIoAllocatedThreads = (): number => {
    let sum = 0;
    for (const entry of inFlight) if (!entry.io) sum += entry.threads;
    return sum;
  };

  const hasIoInFlight = (): boolean => {
    for (const entry of inFlight) if (entry.io) return true;
    return false;
  };

  const hasExclusiveInFlight = (): boolean => {
    for (const entry of inFlight) if (entry.exclusive) return true;
    return false;
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

  // Claim one pending batch slot so an arriving op replaces, rather than
  // duplicates, its declared size in the next plan.
  // ponytail: membership keyed by exact declared size, not a batch id threaded from the drop point; a
  // coincidental same-size unrelated op can still false-match (perf-only: one drop wave gets the wrong
  // thread share, never a correctness/data issue). Thread a real batch id through schedule() if that
  // collision ever matters.
  const consumePendingBatchSize = (size: number): boolean => {
    const index = pendingIoBatchSizes.indexOf(size);
    if (index < 0) return false;
    pendingIoBatchSizes.splice(index, 1);
    return true;
  };

  // Local admission gate for NON-I/O ops (unchanged contract). With nothing in flight a candidate
  // always fits (the lone-job rule). I/O in-flight threads count here too, so a CPU op cannot start
  // alongside an I/O wave that already holds the budget.
  // The thread and memory ceilings only bite once something is already running:
  // with an idle lane the lone-job rule hands a candidate the whole budget.
  const fitsSharedBudget = (operation: ScheduledOperation): boolean => {
    if (inFlight.size === 0) return true;
    if (allocatedThreads() + Math.max(0, operation.threads) > totalThreadBudget) return false;
    return allocatedBytes() + Math.max(0, operation.bytes ?? 0) <= memoryCeiling;
  };

  const canAdmit = (operation: ScheduledOperation): boolean => {
    if (inFlight.size >= maxConcurrency) return false;
    if (hasExclusiveInFlight()) return false;
    if (operation.exclusive === true && inFlight.size > 0) return false;
    if (!fitsSharedBudget(operation)) return false;
    return !intersectsInFlightPaths(operation.paths);
  };

  const admit = <TResult>(
    operation: ScheduledOperation,
    threads: number,
    notedMember: boolean,
    run: (assignedThreads: number) => Promise<TResult>,
    resolve: (value: TResult) => void,
    reject: (reason: unknown) => void,
  ): void => {
    const assignedThreads = Math.max(0, threads);
    const entry: InFlightEntry = {
      bytes: operation.io ? 0 : Math.max(0, operation.bytes ?? 0),
      exclusive: operation.exclusive === true,
      io: operation.io === true,
      jobSizeBytes: Math.max(0, operation.jobSizeBytes ?? 0),
      paths: operation.paths,
      threads: assignedThreads,
    };
    inFlight.add(entry);
    // Only a real member of the noted drop marks the note started, so an unrelated I/O op admitted while
    // a note is pending can't trip the note-clear in pump() before the drop's own ops arrive.
    if (entry.io && notedMember) noteConsumed = true;
    trace("operation admitted", {
      allocatedThreads: allocatedThreads(),
      inFlight: inFlight.size,
      io: entry.io,
      label: operation.label,
      threads: entry.threads,
      waiting: waiters.length,
    });
    let settled: Promise<TResult>;
    try {
      settled = run(assignedThreads);
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

  // Synchronous lane: admit non-I/O waiters that currently fit. First-fit from the head so a cheap op
  // can start alongside a long one instead of blocking behind a head-of-line op that cannot fit yet.
  const pumpNonIo = (): void => {
    while (inFlight.size < maxConcurrency && waiters.length > 0) {
      const index = waiters.findIndex((waiter) => !waiter.operation.io && canAdmit(waiter.operation));
      if (index < 0) break;
      const [waiter] = waiters.splice(index, 1);
      waiter?.admit(Math.max(0, waiter.operation.threads));
    }
  };

  // Serial fallback when no planner is wired or a planning round-trip fails: admit ONE I/O waiter alone
  // with the whole budget, but only when the I/O lane is idle (no plan ⇒ no memory fit known, so never
  // overlap). A later finish re-pumps and re-tries the plan. Matches the pre-planner serial behaviour.
  const admitIoFallbackOne = (): void => {
    if (hasIoInFlight()) return;
    if (inFlight.size >= maxConcurrency) return;
    const waiter = waiters.find(
      (candidate) => candidate.operation.io && !intersectsInFlightPaths(candidate.operation.paths),
    );
    if (!waiter) return;
    waiters.splice(waiters.indexOf(waiter), 1);
    waiter.admit(totalThreadBudget);
  };

  /**
   * Admit every arrived I/O waiter the planner placed in the current wave, still
   * subject to the concurrency cap and OPFS path exclusivity. Returns whether any
   * were admitted, which is what tells the caller real progress was made.
   */
  const admitPlannedWave = (
    ioWaiters: Waiter[],
    waveJobs: ReadonlySet<number>,
    offset: number,
    threadsPerJob: number,
  ): boolean => {
    // Index against the plan up front; anything outside the wave waits for the
    // current one to drain, so the admit walk below is a straight line.
    const planned = ioWaiters.filter((_waiter, index) => waveJobs.has(offset + index));
    let admittedAny = false;
    for (const waiter of planned) {
      if (inFlight.size >= maxConcurrency) break;
      const position = waiters.indexOf(waiter);
      // A missing position means it left the queue meanwhile; the path check is
      // the OPFS exclusivity safety net.
      if (position < 0 || intersectsInFlightPaths(waiter.operation.paths)) continue;
      waiters.splice(position, 1);
      waiter.admit(threadsPerJob);
      admittedAny = true;
    }
    return admittedAny;
  };

  /**
   * One planning round-trip: build the job-size list the planner scores, ask it
   * for a plan, then admit its first wave. Returns whether anything was admitted.
   */
  const planAndAdmitIoWave = async (plan: NonNullable<SchedulerOptions["planBatch"]>): Promise<boolean> => {
    const ioWaiters = waiters.filter((waiter) => waiter.operation.io);
    const inFlightIo = [...inFlight].filter((entry) => entry.io);
    // Order: in-flight, then arrived waiters, then declared-not-yet-arrived. Greedy first-fit fills a
    // wave by ascending index, so arrived waiters are always preferred over not-yet-arrived ones - a
    // pending slot never displaces a real waiter; it only shrinks the per-job thread share to match
    // the full drop.
    const sizes = [
      ...inFlightIo.map((entry) => entry.jobSizeBytes),
      ...ioWaiters.map((waiter) => Math.max(0, Math.floor(waiter.operation.jobSizeBytes ?? 0))),
      ...pendingIoBatchSizes,
    ];
    // Plan against the threads not already held by non-I/O ops, so the two lanes never oversubscribe.
    const availableThreads = Math.max(1, totalThreadBudget - nonIoAllocatedThreads());
    const planned = await plan(sizes, { memoryCeilingBytes: memoryCeiling, threadBudget: availableThreads });
    const wave = planned.waves[0];
    const threadsPerJob = Math.max(1, Math.floor(wave?.threadsPerJob ?? availableThreads));
    const admittedAny = admitPlannedWave(ioWaiters, new Set(wave?.jobs ?? []), inFlightIo.length, threadsPerJob);
    trace("io wave planned", {
      admitted: admittedAny,
      inFlightIo: inFlightIo.length,
      pending: pendingIoBatchSizes.length,
      threadsPerJob,
      waiting: waiters.length,
      waveSize: wave?.jobs?.length ?? 0,
    });
    return admittedAny;
  };

  // Asynchronous lane: ask the Rust planner which queued I/O jobs may overlap the in-flight I/O set
  // (plus any noted-but-not-yet-arrived batch jobs, so the first arrival is grouped against the whole
  // drop), then admit that first wave with the wave's thread allotment (subject to the concurrency cap
  // and OPFS path exclusivity). Re-pumps on successful progress so jobs that arrived during the
  // round-trip - the staggered Promise.all case - are planned against the now-larger set.
  // Nothing to plan while a round-trip is already out, the cap is full, or no I/O is queued.
  const canPlanIoWave = (): boolean =>
    !planningIoWave && inFlight.size < maxConcurrency && waiters.some((waiter) => waiter.operation.io);

  const pumpIoWave = async (): Promise<void> => {
    if (!canPlanIoWave()) return;
    if (!planBatch) {
      admitIoFallbackOne();
      return;
    }
    planningIoWave = true;
    let admittedAny = false;
    try {
      admittedAny = await planAndAdmitIoWave(planBatch);
    } catch (error) {
      trace("io wave planning failed; admitting one job serially", {
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      planningIoWave = false;
    }
    // Re-pump only after real progress, so arrivals during the await are planned against the updated
    // set; no progress means the remaining waiters need a finish to free capacity (avoids a tight
    // no-op planning loop).
    if (admittedAny) {
      void pumpIoWave();
      return;
    }
    // Reached when the plan threw (serial fallback; a later finish re-pumps and re-tries) and as the
    // liveness backstop: the planner's lone-job rule always places a waiter in the first wave when the
    // I/O lane is idle, so admitting nothing is unreachable today, but a plan that ever placed none
    // while nothing was in flight to re-pump on would hang the queued ops forever. admitIoFallbackOne
    // no-ops when I/O is in flight, so this only fires as the idle-lane rescue.
    admitIoFallbackOne();
  };

  const pump = (): void => {
    pumpNonIo();
    // Once a noted batch has actually run and the I/O lane is fully idle, drop any leftover declared
    // sizes (ops that never materialized) so they cannot mis-size a later, unrelated I/O op's plan.
    if (noteConsumed && !hasIoInFlight() && !waiters.some((waiter) => waiter.operation.io)) {
      pendingIoBatchSizes = [];
      noteConsumed = false;
    }
    void pumpIoWave();
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
    noteIoBatch(jobSizes: number[]): void {
      pendingIoBatchSizes = (Array.isArray(jobSizes) ? jobSizes : [])
        .map((size) => Math.max(0, Math.floor(Number(size) || 0)))
        .filter((size) => size > 0);
      noteConsumed = false;
      trace("io batch noted", { jobCount: pendingIoBatchSizes.length });
    },
    schedule<TResult>(
      operation: ScheduledOperation,
      run: (assignedThreads: number) => Promise<TResult>,
    ): Promise<TResult> {
      return new Promise<TResult>((resolve, reject) => {
        // An arriving I/O op claims its slot from the noted batch so the plan counts it once (as a real
        // waiter) rather than twice (also as a pending size). `notedMember` is whether this op actually
        // belongs to the noted drop (its declared size was still pending); only members mark the note
        // consumed on admit, so an unrelated overlapping I/O op leaves the note intact for its own ops.
        const notedMember =
          operation.io === true && consumePendingBatchSize(Math.max(0, Math.floor(operation.jobSizeBytes ?? 0)));
        // Both lanes go through the waiter queue so the pump (synchronous for non-I/O, asynchronous for
        // the planned I/O lane) is the single admission point. A non-I/O op that fits is admitted within
        // this call by pumpNonIo; an I/O op is admitted once the Rust plan places it in the next wave.
        if (operation.signal?.aborted) {
          reject(createSchedulerAbortError());
          return;
        }
        const waiter: Waiter = {
          admit: (threads: number) => {
            waiter.detachAbort();
            admit(operation, threads, notedMember, run, resolve, reject);
          },
          detachAbort: () => undefined,
          operation,
        };
        waiters.push(waiter);
        if (operation.signal) {
          const abort = () => {
            const index = waiters.indexOf(waiter);
            if (index < 0) return;
            waiters.splice(index, 1);
            waiter.detachAbort();
            trace("queued operation aborted", {
              inFlight: inFlight.size,
              io: operation.io === true,
              label: operation.label,
              waiting: waiters.length,
            });
            reject(createSchedulerAbortError());
            pump();
          };
          operation.signal.addEventListener("abort", abort, { once: true });
          waiter.detachAbort = () => operation.signal?.removeEventListener("abort", abort);
          if (operation.signal.aborted) {
            abort();
            return;
          }
        }
        trace("operation queued", {
          inFlight: inFlight.size,
          io: operation.io === true,
          label: operation.label,
          threads: Math.max(0, operation.threads),
          waiting: waiters.length,
        });
        pump();
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
