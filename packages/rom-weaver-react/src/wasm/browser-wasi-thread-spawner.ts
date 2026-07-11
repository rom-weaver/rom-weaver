import type { ThreadPoolCommandSlot, ThreadWorkerSlot, TraceLine } from "./browser-opfs-runtime-types.ts";
import { basenameForTrace, formatErrorForTrace } from "./browser-opfs-stdio-events.ts";
import { wrapThreadFailure } from "./browser-wasi-thread-errors.ts";
import { finishThreadSpawn, needsWasiThreadSpawnImport } from "./browser-wasi-thread-memory.ts";
import type { BrowserWasiThreadPoolCommand, BrowserWasiThreadWorkerPool } from "./browser-wasi-thread-pool.ts";
import type { ThreadSpawnerRuntime } from "./browser-wasi-thread-pool-protocol.ts";
import {
  allocateThreadId,
  createWaitDeadline,
  signalThreadStartState,
  THREAD_SLOT_ERROR_INDEX,
  THREAD_SLOT_START_ARG_INDEX,
  THREAD_SLOT_STATE_FAILED,
  THREAD_SLOT_STATE_IDLE,
  THREAD_SLOT_STATE_INDEX,
  THREAD_SLOT_STATE_REQUESTED,
  THREAD_SLOT_STATE_SHUTDOWN,
  THREAD_SLOT_TID_INDEX,
  WASI_ERRNO_AGAIN,
  WASI_ERRNO_ENOSYS,
  waitForAtomicsStateChange,
  waitForThreadStartAck,
} from "./browser-wasi-thread-protocol.ts";
import {
  createStandaloneBrowserWasiThread,
  loadThreadSlotState,
  resolveThreadWorkerUrl,
  THREAD_WORKER_BUSY_RETRY_TIMEOUT_MS,
} from "./browser-wasi-thread-shell.ts";
import { resolveBrowserThreadPoolSizeFromRequest } from "./browser-wasi-thread-sizing.ts";

export interface BrowserWasiThreadSpawnerOptions {
  allowWorkerPool?: boolean;
  envList?: unknown;
  moduleImports: WebAssembly.ModuleImportDescriptor[];
  runtime?: ThreadSpawnerRuntime;
  streamBroadcastChannelName?: string;
  streamRequestId?: number;
  threadIdState: unknown;
  threadWorkerPool?: BrowserWasiThreadWorkerPool | null;
  threadWorkerUrl?: string | URL;
  trace?: TraceLine;
  wasiArgs?: unknown;
  wasmMemory?: WebAssembly.Memory;
  wasmModule: WebAssembly.Module;
}

export interface BrowserWasiThreadSpawner {
  ready: Promise<void>;
  spawn: (startArg: number, errorOrTidPtr?: number) => number;
  waitForWorkers: () => Promise<void>;
}

export function createBrowserWasiThreadSpawner({
  allowWorkerPool = true,
  streamBroadcastChannelName,
  streamRequestId,
  trace,
  moduleImports,
  threadIdState,
  threadWorkerUrl,
  threadWorkerPool,
  wasmMemory,
  wasmModule,
  wasiArgs,
  envList,
  runtime,
}: BrowserWasiThreadSpawnerOptions): BrowserWasiThreadSpawner {
  if (!needsWasiThreadSpawnImport(moduleImports)) {
    return {
      ready: Promise.resolve(),
      spawn: () => -WASI_ERRNO_ENOSYS,
      waitForWorkers: async () => {
        // single-thread fallback spawner has no workers to wait for
      },
    };
  }
  if (!(wasmMemory instanceof WebAssembly.Memory)) {
    throw new Error("threaded wasm module imports wasi.thread-spawn, but no shared WebAssembly.Memory was created");
  }
  if (!(wasmMemory.buffer instanceof SharedArrayBuffer)) {
    throw new Error("threaded wasm requires shared memory backed by SharedArrayBuffer");
  }

  const activeWorkers = new Map<number, ThreadWorkerSlot>();
  let firstThreadFailure: Error | null = null;
  const resolvedThreadWorkerUrl = resolveThreadWorkerUrl(threadWorkerUrl);
  trace?.(
    `[browser-opfs] thread spawner create pooled=${Boolean(allowWorkerPool && threadWorkerPool)} worker=${basenameForTrace(resolvedThreadWorkerUrl)}`,
  );
  if (allowWorkerPool && threadWorkerPool) {
    const poolSize = resolveBrowserThreadPoolSizeFromRequest(runtime?.request);
    const command = threadWorkerPool.createCommand({
      debugWasi: Boolean(runtime?.debugWasi ?? false),
      envList,
      poolSize,
      runtime,
      streamBroadcastChannelName,
      streamRequestId,
      threadIdState,
      threadWorkerUrl,
      trace,
      wasiArgs,
      wasmMemory,
      wasmModule,
    });
    return createBrowserWasiThreadSpawnerForCommand({
      command,
      threadIdState,
      trace,
      wasmMemory,
    });
  }

  const recordFailure = (tid: number, error: unknown): Error => {
    const wrapped = wrapThreadFailure(tid, error);
    if (!firstThreadFailure) firstThreadFailure = wrapped;
    for (const [activeTid, slot] of activeWorkers.entries()) {
      if (activeTid === tid) continue;
      try {
        slot.worker?.terminate();
      } catch {
        // ignored
      }
    }
    return wrapped;
  };

  const spawn = function spawn(startArg: number, errorOrTidPtr?: number): number {
    trace?.(`[browser-opfs] thread spawn requested startArg=${Number(startArg) | 0}`);
    for (const [activeTid, slot] of activeWorkers.entries()) {
      const state = loadThreadSlotState(slot.control);
      if (state === THREAD_SLOT_STATE_IDLE) {
        slot.busy = false;
        slot.tid = null;
        activeWorkers.delete(activeTid);
        continue;
      }
      if (state === THREAD_SLOT_STATE_FAILED) {
        slot.busy = false;
        slot.tid = null;
        activeWorkers.delete(activeTid);
        recordFailure(activeTid, new Error(`wasi thread ${activeTid} failed in browser worker ${slot.index}`));
      }
    }

    const tid = allocateThreadId(threadIdState);
    if (tid < 0) {
      trace?.(`[browser-opfs] thread spawn allocation failed errno=${Math.abs(tid)}`);
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, Math.abs(tid), true);
    }

    let slot: ThreadWorkerSlot;
    try {
      slot = createStandaloneBrowserWasiThread({
        debugWasi: Boolean(runtime?.debugWasi ?? false),
        envList,
        index: `standalone-${tid}`,
        runtime,
        startArg,
        streamBroadcastChannelName,
        streamRequestId,
        threadIdState,
        threadWorkerUrl: resolvedThreadWorkerUrl,
        tid,
        trace,
        wasiArgs,
        wasmMemory,
        wasmModule,
      });
    } catch (error) {
      trace?.(`[browser-opfs] thread spawn worker create failed tid=${tid} ${formatErrorForTrace(error)}`);
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, WASI_ERRNO_AGAIN, true);
    }
    activeWorkers.set(tid, slot);
    trace?.(`[browser-opfs] thread spawn dispatched tid=${tid} worker=${slot.index}`);

    const startAckError = waitForThreadStartAck(slot.control, tid);
    if (startAckError) {
      activeWorkers.delete(tid);
      slot.busy = false;
      slot.tid = null;
      recordFailure(tid, startAckError);
      trace?.(`[browser-opfs] thread spawn ack failed tid=${tid} ${formatErrorForTrace(startAckError)}`);
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, WASI_ERRNO_AGAIN, true);
    }

    trace?.(`[browser-opfs] thread spawn acked tid=${tid} worker=${slot.index}`);
    return finishThreadSpawn(wasmMemory, errorOrTidPtr, tid, false);
  };

  const waitForWorkers = async () => {
    trace?.(`[browser-opfs] thread wait start active=${activeWorkers.size}`);
    while (activeWorkers.size > 0) {
      for (const [tid, slot] of activeWorkers.entries()) {
        while (true) {
          const state = loadThreadSlotState(slot.control);
          if (state === THREAD_SLOT_STATE_IDLE) {
            slot.busy = false;
            slot.tid = null;
            activeWorkers.delete(tid);
            trace?.(`[browser-opfs] thread completed tid=${tid} worker=${slot.index}`);
            break;
          }
          if (state === THREAD_SLOT_STATE_FAILED) {
            recordFailure(tid, slot.failure || new Error(`wasi thread ${tid} failed in browser worker ${slot.index}`));
            slot.busy = false;
            slot.tid = null;
            activeWorkers.delete(tid);
            break;
          }
          waitForAtomicsStateChange(slot.control, THREAD_SLOT_STATE_INDEX, state);
        }
      }
    }
    if (firstThreadFailure) throw firstThreadFailure;
    trace?.("[browser-opfs] thread wait done");
  };

  return { ready: Promise.resolve(), spawn, waitForWorkers };
}

function createBrowserWasiThreadSpawnerForCommand({
  command,
  threadIdState,
  trace,
  wasmMemory,
}: {
  command: BrowserWasiThreadPoolCommand;
  threadIdState: unknown;
  trace?: TraceLine;
  wasmMemory: WebAssembly.Memory;
}): BrowserWasiThreadSpawner {
  const activeWorkers = new Map<number, ThreadPoolCommandSlot>();
  // Slots whose start was never acknowledged: kept tracked (so no later spawn reuses them) and signalled
  // SHUTDOWN, but drained without blocking in waitForWorkers - the bounded command.shutdown owns their
  // final teardown so a worker wedged inside wasi_thread_start cannot hang the run.
  const poisonedSlots = new Set<ThreadPoolCommandSlot>();
  let firstThreadFailure: Error | null = null;

  const recordFailure = (tid: number, error: unknown): Error => {
    const wrapped = wrapThreadFailure(tid, error);
    if (!firstThreadFailure) firstThreadFailure = wrapped;
    return wrapped;
  };

  // command.shutdown awaits each slot's done with no internal deadline, so a worker that never acks (and
  // may be wedged running wasi_thread_start) would hang teardown forever. Bound the wait: on timeout the
  // recorded failure still surfaces, turning a permanent hang into a clean failure.
  const shutdownCommandWithDeadline = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bound = new Promise<"timed-out">((resolve) => {
      timer = setTimeout(() => resolve("timed-out"), THREAD_WORKER_BUSY_RETRY_TIMEOUT_MS);
    });
    try {
      const outcome = await Promise.race([command.shutdown().then(() => "done" as const), bound]);
      if (outcome === "timed-out") {
        trace?.(
          `[browser-opfs] thread pool command shutdown wait timed out command=${command.commandId}` +
            ` after ${THREAD_WORKER_BUSY_RETRY_TIMEOUT_MS}ms`,
        );
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const reapCompletedWorkers = () => {
    for (const [activeTid, slot] of activeWorkers.entries()) {
      const state = loadThreadSlotState(slot.control);
      if (state === THREAD_SLOT_STATE_IDLE) {
        slot.busy = false;
        slot.tid = null;
        activeWorkers.delete(activeTid);
        continue;
      }
      if (state === THREAD_SLOT_STATE_FAILED) {
        slot.busy = false;
        slot.tid = null;
        activeWorkers.delete(activeTid);
        recordFailure(
          activeTid,
          slot.failure || new Error(`wasi thread ${activeTid} failed in browser worker ${slot.index}`),
        );
      }
    }
  };

  const findIdlePooledWorker = () =>
    command.slots.find(
      (candidate) =>
        candidate.online && !candidate.busy && loadThreadSlotState(candidate.control) === THREAD_SLOT_STATE_IDLE,
    );

  const findWaitablePooledWorker = (): { slot: ThreadPoolCommandSlot; state: number } | null => {
    for (const slot of activeWorkers.values()) {
      const state = loadThreadSlotState(slot.control);
      if (
        state !== THREAD_SLOT_STATE_IDLE &&
        state !== THREAD_SLOT_STATE_FAILED &&
        state !== THREAD_SLOT_STATE_SHUTDOWN
      ) {
        return { slot, state };
      }
    }
    for (const slot of command.slots) {
      const state = loadThreadSlotState(slot.control);
      if (
        slot.online &&
        state !== THREAD_SLOT_STATE_IDLE &&
        state !== THREAD_SLOT_STATE_FAILED &&
        state !== THREAD_SLOT_STATE_SHUTDOWN
      ) {
        return { slot, state };
      }
    }
    return null;
  };

  const waitForIdlePooledWorker = (tid: number): ThreadPoolCommandSlot | null => {
    const deadline = createWaitDeadline(THREAD_WORKER_BUSY_RETRY_TIMEOUT_MS);
    let tracedWait = false;
    while (true) {
      reapCompletedWorkers();
      if (firstThreadFailure) return null;
      const idleSlot = findIdlePooledWorker();
      if (idleSlot) return idleSlot;

      const waitable = findWaitablePooledWorker();
      if (!waitable) return null;
      if (!tracedWait) {
        trace?.(
          `[browser-opfs] thread spawn waiting for idle pooled worker tid=${tid} command=${command.commandId}` +
            ` active=${activeWorkers.size} slots=${command.slots.length}`,
        );
        tracedWait = true;
      }
      const waitResult = waitForAtomicsStateChange(waitable.slot.control, THREAD_SLOT_STATE_INDEX, waitable.state, {
        deadline,
      });
      if (waitResult === "timed-out") {
        trace?.(
          `[browser-opfs] thread spawn wait for idle pooled worker timed out tid=${tid} command=${command.commandId}` +
            ` active=${activeWorkers.size} slots=${command.slots.length}`,
        );
        return null;
      }
    }
  };

  const spawn = function spawn(startArg: number, errorOrTidPtr?: number): number {
    trace?.(`[browser-opfs] thread spawn requested startArg=${Number(startArg) | 0} command=${command.commandId}`);
    reapCompletedWorkers();

    const tid = allocateThreadId(threadIdState);
    if (tid < 0) {
      trace?.(`[browser-opfs] thread spawn allocation failed errno=${Math.abs(tid)} command=${command.commandId}`);
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, Math.abs(tid), true);
    }

    const slot = findIdlePooledWorker() ?? waitForIdlePooledWorker(tid);
    if (!slot) {
      trace?.(`[browser-opfs] thread spawn no idle pooled worker tid=${tid} command=${command.commandId}`);
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, WASI_ERRNO_AGAIN, true);
    }

    slot.busy = true;
    slot.tid = tid;
    activeWorkers.set(tid, slot);
    Atomics.store(slot.control, THREAD_SLOT_TID_INDEX, tid);
    Atomics.store(slot.control, THREAD_SLOT_START_ARG_INDEX, Number(startArg) | 0);
    Atomics.store(slot.control, THREAD_SLOT_ERROR_INDEX, 0);
    Atomics.store(slot.control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_REQUESTED);
    Atomics.notify(slot.control, THREAD_SLOT_STATE_INDEX, 1);
    trace?.(`[browser-opfs] thread spawn dispatched tid=${tid} worker=${slot.index} command=${command.commandId}`);

    const startAckError = waitForThreadStartAck(slot.control, tid);
    if (startAckError) {
      // The worker may not have picked up this REQUESTED slot yet; if simply abandoned it would still run
      // wasi_thread_start against a now-stale startArg and orphan a thread. Signal SHUTDOWN so an
      // unstarted worker aborts cleanly, keep the slot tracked+busy (poisoned) so no later spawn reuses
      // it, and let the bounded command.shutdown finish its teardown.
      signalThreadStartState(slot.control, THREAD_SLOT_STATE_SHUTDOWN);
      poisonedSlots.add(slot);
      recordFailure(tid, startAckError);
      trace?.(`[browser-opfs] thread spawn ack failed tid=${tid} ${formatErrorForTrace(startAckError)}`);
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, WASI_ERRNO_AGAIN, true);
    }

    trace?.(`[browser-opfs] thread spawn acked tid=${tid} worker=${slot.index} command=${command.commandId}`);
    return finishThreadSpawn(wasmMemory, errorOrTidPtr, tid, false);
  };

  const waitForWorkers = async () => {
    trace?.(`[browser-opfs] thread wait start active=${activeWorkers.size} command=${command.commandId}`);
    while (activeWorkers.size > 0) {
      for (const [tid, slot] of activeWorkers.entries()) {
        // A poisoned slot (start never acknowledged) is already failing and SHUTDOWN-signalled; do not
        // block on its state - the bounded command.shutdown tears it down.
        if (poisonedSlots.has(slot)) {
          poisonedSlots.delete(slot);
          activeWorkers.delete(tid);
          trace?.(`[browser-opfs] thread abandoned tid=${tid} worker=${slot.index} command=${command.commandId}`);
          continue;
        }
        while (true) {
          const state = loadThreadSlotState(slot.control);
          if (state === THREAD_SLOT_STATE_IDLE) {
            slot.busy = false;
            slot.tid = null;
            activeWorkers.delete(tid);
            trace?.(`[browser-opfs] thread completed tid=${tid} worker=${slot.index} command=${command.commandId}`);
            break;
          }
          if (state === THREAD_SLOT_STATE_FAILED) {
            recordFailure(tid, slot.failure || new Error(`wasi thread ${tid} failed in browser worker ${slot.index}`));
            slot.busy = false;
            slot.tid = null;
            activeWorkers.delete(tid);
            break;
          }
          waitForAtomicsStateChange(slot.control, THREAD_SLOT_STATE_INDEX, state);
        }
      }
    }
    await shutdownCommandWithDeadline();
    if (firstThreadFailure) throw firstThreadFailure;
    trace?.(`[browser-opfs] thread wait done command=${command.commandId}`);
  };

  const ready = command.ready.catch(async (error) => {
    await command.shutdown();
    throw error;
  });

  return { ready, spawn, waitForWorkers };
}
