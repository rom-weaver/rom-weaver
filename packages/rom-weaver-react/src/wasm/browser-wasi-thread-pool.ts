import type {
  ThreadPoolCommandSlot,
  ThreadPoolShell,
  ThreadWorkerSlot,
  TraceLine,
} from "./browser-opfs-runtime-types.ts";
import { basenameForTrace, formatErrorForTrace, monotonicNowMs } from "./browser-opfs-stdio-events.ts";
import {
  annotateThreadWorkerError,
  createThreadWorkerLoadError,
  deserializeThreadWorkerError,
  toThreadWorkerError,
  wrapThreadFailure,
} from "./browser-wasi-thread-errors.ts";
import { finishThreadSpawn, needsWasiThreadSpawnImport } from "./browser-wasi-thread-memory.ts";
import {
  createThreadWorkerRuntimePayload,
  type ThreadSpawnerRuntime,
  type ThreadWorkerPoolCommandMessage,
  type ThreadWorkerPoolShellMessage,
  type ThreadWorkerReplyView,
  type ThreadWorkerShutdownMessage,
} from "./browser-wasi-thread-pool-protocol.ts";
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
  createThreadSlotControl,
  loadThreadSlotState,
  resolveThreadWorkerUrl,
  THREAD_WORKER_BUSY_RETRY_INTERVAL_MS,
  THREAD_WORKER_BUSY_RETRY_TIMEOUT_MS,
  THREAD_WORKER_READY_TIMEOUT_MS,
} from "./browser-wasi-thread-shell.ts";
import { MAX_BROWSER_THREAD_POOL_SIZE, resolveBrowserThreadPoolSizeFromRequest } from "./browser-wasi-thread-sizing.ts";

export {
  createSharedThreadMemory,
  needsEnvMemoryImport,
  needsWasiThreadSpawnImport,
} from "./browser-wasi-thread-memory.ts";
export type {
  SerializedThreadWorkerError,
  ThreadSpawnerRuntime,
  ThreadWorkerCommandDoneReply,
  ThreadWorkerCommandMessageBase,
  ThreadWorkerDoneReply,
  ThreadWorkerErrorReply,
  ThreadWorkerMessage,
  ThreadWorkerPoolCommandMessage,
  ThreadWorkerPoolShellMessage,
  ThreadWorkerReadyReply,
  ThreadWorkerReply,
  ThreadWorkerRuntimePayload,
  ThreadWorkerShellReadyReply,
  ThreadWorkerShutdownMessage,
  ThreadWorkerThreadStartMessage,
} from "./browser-wasi-thread-pool-protocol.ts";
export { createThreadWorkerRuntimePayload } from "./browser-wasi-thread-pool-protocol.ts";
export { resolveThreadWorkerUrl } from "./browser-wasi-thread-shell.ts";
export {
  browserThreadRequestOptions,
  DEFAULT_BROWSER_THREAD_COUNT,
  MAX_BROWSER_THREAD_POOL_SIZE,
  parseRequestedThreadCount,
  resolveBrowserThreadPoolSizeFromCount,
} from "./browser-wasi-thread-sizing.ts";

/** Upper bound on module-worker script loads started concurrently while growing the pool, so a
 * burst of `new Worker()` calls cannot exceed what the host (e.g. the dev server) can serve. */
const SHELL_CREATE_BATCH_SIZE = 4;

export interface BrowserWasiThreadWorkerPoolOptions {
  initialSize: number;
  threadWorkerUrl?: string | URL;
}

export interface BrowserWasiThreadPoolCommandOptions {
  debugWasi: boolean;
  envList: unknown;
  poolSize: number;
  runtime: ThreadSpawnerRuntime | undefined;
  streamBroadcastChannelName?: string;
  streamRequestId?: number;
  threadIdState: unknown;
  threadWorkerUrl?: string | URL;
  trace?: TraceLine;
  wasiArgs: unknown;
  wasmMemory: WebAssembly.Memory;
  wasmModule: WebAssembly.Module;
}

export interface BrowserWasiThreadPoolCommand {
  commandId: number;
  debugWasi: boolean;
  envList: unknown;
  ready: Promise<void>;
  runtime: ThreadSpawnerRuntime | undefined;
  shutdown: () => Promise<void>;
  slots: ThreadPoolCommandSlot[];
  streamBroadcastChannelName?: string;
  streamRequestId?: number;
  threadIdState: unknown;
  threadWorkerUrl: string;
  wasiArgs: unknown;
  wasmMemory: WebAssembly.Memory;
  wasmModule: WebAssembly.Module;
}

export interface BrowserWasiThreadWorkerPool {
  createCommand: (options: BrowserWasiThreadPoolCommandOptions) => BrowserWasiThreadPoolCommand;
  dispose: () => Promise<void>;
  isReady: (size: number) => boolean;
  ready: Promise<void>;
  resolvedThreadWorkerUrl: string;
}

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

export function createBrowserWasiThreadWorkerPool({
  initialSize,
  threadWorkerUrl,
}: BrowserWasiThreadWorkerPoolOptions): BrowserWasiThreadWorkerPool {
  const resolvedThreadWorkerUrl = resolveThreadWorkerUrl(threadWorkerUrl);
  const workers: ThreadPoolShell[] = [];
  let disposed = false;
  let nextCommandId = 1;

  const rejectShell = (slot: ThreadPoolShell, error: Error) => {
    slot.rejectReady?.(error);
    slot.resolveReady = null;
    slot.rejectReady = null;
  };

  const failShell = (shell: ThreadPoolShell, error: Error) => {
    if (shell.terminated) return;
    shell.trace?.(
      `[browser-opfs] thread pool shell failed index=${shell.index}` +
        ` online=${shell.online} hadCommand=${Boolean(shell.currentCommand)} ${formatErrorForTrace(error)}`,
    );
    shell.terminated = true;
    try {
      shell.worker?.terminate();
    } catch {
      // ignored
    }
    rejectShell(shell, error);
    const command = shell.currentCommand;
    if (!command) return;
    command.failure = error;
    Atomics.store(command.control, THREAD_SLOT_ERROR_INDEX, 1);
    signalThreadStartState(command.control, THREAD_SLOT_STATE_FAILED);
    command.rejectReady?.(error);
    command.resolveDone?.();
    shell.currentCommand = null;
  };

  const handleShellMessage = (shell: ThreadPoolShell, message: ThreadWorkerReplyView) => {
    if (message.type === "shell-ready") {
      shell.trace?.(`[browser-opfs] thread pool shell online index=${shell.index}`);
      shell.online = true;
      shell.resolveReady?.();
      shell.resolveReady = null;
      shell.rejectReady = null;
      return;
    }
    const command = shell.currentCommand;
    if (!command || message.commandId !== command.commandId) return;
    if (message.type === "ready") {
      command.readyResolved = true;
      command.resolveReady?.();
      command.resolveReady = null;
      command.rejectReady = null;
      return;
    }
    if (message.type === "command-done") {
      shell.currentCommand = null;
      command.resolveDone?.();
      return;
    }
    if (message.type === "error") {
      const error = annotateThreadWorkerError(
        deserializeThreadWorkerError(message.error),
        command,
        resolvedThreadWorkerUrl,
      );
      command.failure = error;
      Atomics.store(command.control, THREAD_SLOT_ERROR_INDEX, 1);
      signalThreadStartState(command.control, THREAD_SLOT_STATE_FAILED);
      if (typeof message.tid === "number" && Number.isInteger(message.tid)) {
        command.tid = message.tid;
        return;
      }
      command.resolveDone?.();
      shell.currentCommand = null;
      command.rejectReady?.(error);
    }
  };

  const createShell = (index: number, trace: ThreadPoolShell["trace"] = null): ThreadPoolShell => {
    const slot: ThreadPoolShell = {
      currentCommand: null,
      index,
      online: false,
      ready: null,
      readyTimer: null,
      rejectReady: null,
      resolveReady: null,
      terminated: false,
      trace,
      worker: null,
    };
    trace?.(
      `[browser-opfs] thread pool shell create index=${index} worker=${basenameForTrace(resolvedThreadWorkerUrl)}`,
    );
    slot.ready = new Promise<void>((resolveReady, rejectReady) => {
      slot.resolveReady = () => resolveReady();
      slot.rejectReady = rejectReady;
    }).finally(() => {
      if (slot.readyTimer) clearTimeout(slot.readyTimer);
      slot.readyTimer = null;
    });
    slot.readyTimer = setTimeout(() => {
      trace?.(
        `[browser-opfs] thread pool shell ready timeout index=${slot.index} after ${THREAD_WORKER_READY_TIMEOUT_MS}ms`,
      );
      failShell(
        slot,
        new Error(
          `browser wasi thread worker ${slot.index} did not become ready within ${THREAD_WORKER_READY_TIMEOUT_MS}ms` +
            ` (workerUrl=${resolvedThreadWorkerUrl})`,
        ),
      );
    }, THREAD_WORKER_READY_TIMEOUT_MS);

    const worker = new Worker(resolvedThreadWorkerUrl, { type: "module" });
    slot.worker = worker;
    worker.addEventListener("message", (event: MessageEvent<ThreadWorkerReplyView>) => {
      handleShellMessage(slot, event.data ?? {});
    });
    worker.addEventListener("error", (event) => {
      event.preventDefault?.();
      const error = createThreadWorkerLoadError(event, slot.currentCommand ?? slot, resolvedThreadWorkerUrl);
      failShell(slot, error);
    });
    worker.addEventListener("messageerror", (event) => {
      event.preventDefault?.();
      failShell(
        slot,
        new Error(
          `browser wasi thread worker ${slot.index} could not receive its message` +
            ` (workerUrl=${resolvedThreadWorkerUrl})`,
        ),
      );
    });
    worker.postMessage({ mode: "pool-shell" } satisfies ThreadWorkerPoolShellMessage);
    return slot;
  };

  const replaceShell = (index: number, reason: Error | null = null, trace: ThreadPoolShell["trace"] = null) => {
    const previous = workers[index];
    if (previous) {
      previous.terminated = true;
      try {
        previous.worker?.terminate();
      } catch {
        // ignored
      }
      if (reason) rejectShell(previous, reason);
    }
    trace?.(`[browser-opfs] thread pool replacing worker=${index}` + (reason ? ` ${formatErrorForTrace(reason)}` : ""));
    const replacement = createShell(index, trace);
    workers[index] = replacement;
    return replacement;
  };

  const ensureSize = async (size: number, trace: ThreadPoolShell["trace"] = null) => {
    if (disposed) throw new Error("browser wasi thread worker pool is disposed");
    const targetSize = Math.min(Math.max(0, size), MAX_BROWSER_THREAD_POOL_SIZE);
    let replacementCount = 0;
    let lastFailure: unknown = null;
    const maxReplacementCount = Math.max(targetSize, 1) * 2;
    const onlineCount = () => workers.slice(0, targetSize).filter((slot) => slot?.online && !slot.terminated).length;
    trace?.(
      `[browser-opfs] thread pool ensureSize start target=${targetSize} existing=${workers.length}` +
        ` online=${onlineCount()} batchSize=${SHELL_CREATE_BATCH_SIZE} maxReplacements=${maxReplacementCount}`,
    );
    let pass = 0;
    // Bring shells online in bounded batches. Starting every missing shell at once fires a burst of
    // simultaneous module-worker script loads; under a limited connection pool (notably the dev
    // server) the loads past the first several fail their fetch — surfacing as an empty-message
    // worker `error`, not a code crash — which previously aborted the whole run. Limiting how many
    // loads are in flight at a time keeps each batch within what the host can serve, and the
    // replacement budget below still bounds retries so a genuine failure can't loop forever.
    while (true) {
      pass += 1;
      const batch: ThreadPoolShell[] = [];
      const created: number[] = [];
      const replaced: number[] = [];
      for (let index = 0; index < targetSize && batch.length < SHELL_CREATE_BATCH_SIZE; index += 1) {
        const shell = workers[index];
        if (shell && !shell.terminated) continue;
        if (shell) {
          if (shell.currentCommand) {
            throw lastFailure || new Error("browser wasi thread worker failed while running a command");
          }
          if (replacementCount >= maxReplacementCount) {
            trace?.(
              `[browser-opfs] thread pool ensureSize giving up target=${targetSize} online=${onlineCount()}` +
                ` replacements=${replacementCount}/${maxReplacementCount} ${formatErrorForTrace(lastFailure)}`,
            );
            throw lastFailure || new Error("browser wasi thread worker pool could not replace failed workers");
          }
          replaceShell(index, lastFailure as Error | null, trace);
          replacementCount += 1;
          replaced.push(index);
        } else {
          workers[index] = createShell(index, trace);
          created.push(index);
        }
        const startedShell = workers[index];
        if (startedShell) batch.push(startedShell);
      }
      if (batch.length === 0) {
        trace?.(
          `[browser-opfs] thread pool ensureSize ready target=${targetSize} online=${onlineCount()} passes=${pass - 1}`,
        );
        return;
      }
      trace?.(
        `[browser-opfs] thread pool ensureSize pass=${pass} starting=${batch.length}` +
          ` created=[${created.join(",")}] replaced=[${replaced.join(",")}] replacements=${replacementCount}/${maxReplacementCount}`,
      );
      const results = await Promise.allSettled(batch.map((slot) => slot.ready));
      let failedThisPass = 0;
      for (const result of results) {
        if (result.status === "rejected") {
          failedThisPass += 1;
          lastFailure = result.reason;
        }
      }
      trace?.(
        `[browser-opfs] thread pool ensureSize pass=${pass} settled ok=${batch.length - failedThisPass}` +
          ` failed=${failedThisPass} online=${onlineCount()}/${targetSize}`,
      );
    }
  };

  const selectAvailableShells = async (
    poolSize: number,
    trace: ThreadPoolShell["trace"],
    commandId: number,
  ): Promise<ThreadPoolShell[]> => {
    const deadline = Date.now() + THREAD_WORKER_BUSY_RETRY_TIMEOUT_MS;
    while (true) {
      const available = workers.filter((shell) => !(shell.terminated || shell.currentCommand));
      if (available.length >= poolSize) return available.slice(0, poolSize);
      if (workers.slice(0, poolSize).some((shell) => !shell || shell.terminated)) {
        await ensureSize(poolSize, trace);
        continue;
      }
      if (Date.now() >= deadline) {
        const busyShell = workers.find((shell) => !shell.terminated && shell.currentCommand);
        if (busyShell) throw new Error(`browser wasi thread worker ${busyShell.index} is already busy`);
        throw new Error("browser wasi thread worker pool does not have enough available workers");
      }
      await new Promise((resolve) => setTimeout(resolve, THREAD_WORKER_BUSY_RETRY_INTERVAL_MS));
    }
  };

  const isReady = (size: number): boolean => {
    if (disposed) return false;
    const targetSize = Math.min(Math.max(0, size), MAX_BROWSER_THREAD_POOL_SIZE);
    if (targetSize === 0) return true;
    if (workers.length < targetSize) return false;
    return workers.slice(0, targetSize).every((slot) => slot.online && !slot.terminated && !slot.currentCommand);
  };

  const createCommand = ({
    poolSize,
    streamBroadcastChannelName,
    streamRequestId,
    trace,
    debugWasi,
    envList,
    runtime,
    threadIdState,
    threadWorkerUrl,
    wasiArgs,
    wasmMemory,
    wasmModule,
  }: BrowserWasiThreadPoolCommandOptions): BrowserWasiThreadPoolCommand => {
    const commandId = nextCommandId;
    nextCommandId += 1;
    const commandStartMs = monotonicNowMs();
    trace?.(`[browser-opfs] thread pool command create id=${commandId} poolSize=${poolSize}`);
    const command: BrowserWasiThreadPoolCommand = {
      commandId,
      debugWasi,
      envList,
      ready: Promise.resolve(),
      runtime,
      shutdown: async () => {
        const shutdownStartMs = monotonicNowMs();
        trace?.(`[browser-opfs] thread pool command shutdown start id=${commandId}`);
        for (const slot of command.slots) {
          if (slot.shell.currentCommand !== slot) continue;
          while (true) {
            const state = loadThreadSlotState(slot.control);
            if (
              state === THREAD_SLOT_STATE_IDLE ||
              state === THREAD_SLOT_STATE_FAILED ||
              state === THREAD_SLOT_STATE_SHUTDOWN
            ) {
              break;
            }
            trace?.(
              `[browser-opfs] thread pool command shutdown wait worker=${slot.index} state=${state} id=${commandId}`,
            );
            waitForAtomicsStateChange(slot.control, THREAD_SLOT_STATE_INDEX, state);
          }
          Atomics.store(slot.control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_SHUTDOWN);
          Atomics.notify(slot.control, THREAD_SLOT_STATE_INDEX, 1);
        }
        await Promise.allSettled(command.slots.map((slot) => slot.done));
        trace?.(
          `[browser-opfs] thread pool command shutdown done id=${commandId} ms=${(monotonicNowMs() - shutdownStartMs).toFixed(1)}`,
        );
      },
      slots: [],
      streamBroadcastChannelName,
      streamRequestId,
      threadIdState,
      threadWorkerUrl: resolvedThreadWorkerUrl,
      wasiArgs,
      wasmMemory,
      wasmModule,
    };
    command.ready = ensureSize(poolSize, trace).then(async () => {
      const ensureMs = monotonicNowMs() - commandStartMs;
      if (threadWorkerUrl && resolveThreadWorkerUrl(threadWorkerUrl) !== resolvedThreadWorkerUrl) {
        throw new Error(
          `browser wasi thread worker pool URL mismatch: ${resolvedThreadWorkerUrl} !== ${threadWorkerUrl}`,
        );
      }
      const selectStartMs = monotonicNowMs();
      const shells = await selectAvailableShells(poolSize, trace ?? null, commandId);
      const selectMs = monotonicNowMs() - selectStartMs;
      trace?.(
        `[browser-opfs] thread pool command selected workers id=${commandId} workers=${shells.map((shell) => shell.index).join(",")}`,
      );
      const postStartMs = monotonicNowMs();
      for (const shell of shells) {
        const shellWorker = shell.worker;
        if (shell.terminated || !shellWorker) {
          throw new Error(`browser wasi thread worker ${shell.index} is not available`);
        }
        const control = createThreadSlotControl();
        control[THREAD_SLOT_STATE_INDEX] = THREAD_SLOT_STATE_IDLE;
        control[THREAD_SLOT_TID_INDEX] = 0;
        control[THREAD_SLOT_START_ARG_INDEX] = 0;
        control[THREAD_SLOT_ERROR_INDEX] = 0;
        const commandSlot: ThreadPoolCommandSlot = {
          busy: false,
          commandId,
          control,
          done: null,
          failure: null,
          index: shell.index,
          online: true,
          ready: null,
          readyResolved: false,
          rejectReady: null,
          resolveDone: null,
          resolveReady: null,
          shell,
          tid: null,
          worker: shellWorker,
        };
        commandSlot.ready = new Promise<void>((resolveReady, rejectReady) => {
          commandSlot.resolveReady = () => resolveReady();
          commandSlot.rejectReady = rejectReady;
        });
        commandSlot.done = new Promise<void>((resolveDone) => {
          commandSlot.resolveDone = () => resolveDone();
        });
        shell.currentCommand = commandSlot;
        command.slots.push(commandSlot);
        const payload: ThreadWorkerPoolCommandMessage = {
          __streamBroadcastChannelName: streamBroadcastChannelName,
          __streamRequestId: streamRequestId,
          commandId,
          controlBuffer: control.buffer,
          debugWasi,
          envList,
          mode: "pool-command",
          runtime: createThreadWorkerRuntimePayload(runtime),
          threadIdState,
          threadWorkerUrl: resolvedThreadWorkerUrl,
          wasiArgs,
          wasmMemory,
          wasmModule,
        };
        trace?.(`[browser-opfs] thread pool command post worker=${shell.index} id=${commandId}`);
        try {
          shellWorker.postMessage(payload);
          trace?.(`[browser-opfs] thread pool command post returned worker=${shell.index} id=${commandId}`);
        } catch (error) {
          trace?.(
            `[browser-opfs] thread pool command post failed worker=${shell.index} id=${commandId} ${formatErrorForTrace(error)}`,
          );
          commandSlot.failure = toThreadWorkerError(error);
          commandSlot.rejectReady?.(error);
          commandSlot.resolveDone?.();
          shell.currentCommand = null;
          throw error;
        }
      }
      const postMs = monotonicNowMs() - postStartMs;
      await Promise.all(command.slots.map((slot) => slot.ready));
      trace?.(
        `[browser-opfs] thread pool command ready id=${commandId} slots=${command.slots.length}` +
          ` ensureMs=${ensureMs.toFixed(1)} selectMs=${selectMs.toFixed(1)} postMs=${postMs.toFixed(1)}` +
          ` readyMs=${(monotonicNowMs() - commandStartMs).toFixed(1)}`,
      );
    });
    return command;
  };

  const dispose = async () => {
    disposed = true;
    for (const slot of workers) {
      try {
        slot.worker?.postMessage({ mode: "shutdown" } satisfies ThreadWorkerShutdownMessage);
      } catch {
        // ignored
      }
      slot.worker?.terminate();
      slot.terminated = true;
    }
    workers.length = 0;
  };

  return {
    createCommand,
    dispose,
    isReady,
    ready: ensureSize(initialSize),
    resolvedThreadWorkerUrl,
  };
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
  let firstThreadFailure: Error | null = null;

  const recordFailure = (tid: number, error: unknown): Error => {
    const wrapped = wrapThreadFailure(tid, error);
    if (!firstThreadFailure) firstThreadFailure = wrapped;
    return wrapped;
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
      activeWorkers.delete(tid);
      slot.busy = false;
      slot.tid = null;
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
    await command.shutdown();
    if (firstThreadFailure) throw firstThreadFailure;
    trace?.(`[browser-opfs] thread wait done command=${command.commandId}`);
  };

  const ready = command.ready.catch(async (error) => {
    await command.shutdown();
    throw error;
  });

  return { ready, spawn, waitForWorkers };
}

export async function throwWithThreadFailure(
  error: unknown,
  threadSpawner: Pick<BrowserWasiThreadSpawner, "waitForWorkers">,
): Promise<never> {
  try {
    await threadSpawner.waitForWorkers();
  } catch (threadError) {
    const baseMessage = error instanceof Error ? error.message : String(error);
    const threadMessage = threadError instanceof Error ? threadError.message : String(threadError);
    const out = new Error(`${baseMessage}; ${threadMessage}`);
    if (error instanceof Error && typeof error.stack === "string") out.stack = error.stack;
    throw out;
  }
  throw error;
}
