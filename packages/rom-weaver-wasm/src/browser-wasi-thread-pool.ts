import type { ThreadPoolCommandSlot, ThreadPoolShell, TraceLine } from "./browser-opfs-runtime-types.ts";
import { basenameForTrace, formatErrorForTrace, monotonicNowMs } from "./browser-opfs-stdio-events.ts";
import {
  annotateThreadWorkerError,
  createThreadWorkerLoadError,
  deserializeThreadWorkerError,
  toThreadWorkerError,
} from "./browser-wasi-thread-errors.ts";
import {
  createThreadWorkerRuntimePayload,
  type ThreadSpawnerRuntime,
  type ThreadWorkerPoolCommandMessage,
  type ThreadWorkerPoolShellMessage,
  type ThreadWorkerReplyView,
  type ThreadWorkerShutdownMessage,
} from "./browser-wasi-thread-pool-protocol.ts";
import {
  signalThreadStartState,
  THREAD_SLOT_ERROR_INDEX,
  THREAD_SLOT_START_ARG_INDEX,
  THREAD_SLOT_STATE_FAILED,
  THREAD_SLOT_STATE_IDLE,
  THREAD_SLOT_STATE_INDEX,
  THREAD_SLOT_STATE_SHUTDOWN,
  THREAD_SLOT_TID_INDEX,
  waitForAtomicsStateChange,
} from "./browser-wasi-thread-protocol.ts";
import {
  createThreadSlotControl,
  loadThreadSlotState,
  resolveThreadWorkerUrl,
  THREAD_WORKER_BUSY_RETRY_INTERVAL_MS,
  THREAD_WORKER_BUSY_RETRY_TIMEOUT_MS,
  THREAD_WORKER_READY_TIMEOUT_MS,
} from "./browser-wasi-thread-shell.ts";
import { MAX_BROWSER_THREAD_POOL_SIZE } from "./browser-wasi-thread-sizing.ts";
import type { BrowserWasiThreadSpawner } from "./browser-wasi-thread-spawner.ts";
import { createBrowserWasiThreadSpawner } from "./browser-wasi-thread-spawner.ts";

export {
  createSharedThreadMemory,
  needsEnvMemoryImport,
  needsWasiThreadSpawnImport,
} from "./browser-wasi-thread-memory.ts";
export type {
  SerializedThreadWorkerError,
  ThreadSpawnerRuntime,
  ThreadWorkerCommandDoneReply,
  ThreadWorkerDoneReply,
  ThreadWorkerErrorReply,
  ThreadWorkerMessage,
  ThreadWorkerPoolCommandMessage,
  ThreadWorkerReadyReply,
  ThreadWorkerShellReadyReply,
  ThreadWorkerThreadStartMessage,
} from "./browser-wasi-thread-pool-protocol.ts";
export {
  browserThreadRequestOptions,
  DEFAULT_BROWSER_THREAD_COUNT,
  parseRequestedThreadCount,
  resolveBrowserThreadPoolSizeFromCount,
} from "./browser-wasi-thread-sizing.ts";
export type { BrowserWasiThreadSpawner };
export { createBrowserWasiThreadSpawner };

/** Upper bound on module-worker script loads started concurrently while growing the pool, so a
 * burst of `new Worker()` calls cannot exceed what the host (e.g. the dev server) can serve. */
const SHELL_CREATE_BATCH_SIZE = 4;

export interface BrowserWasiThreadWorkerPoolOptions {
  initialSize: number;
  threadWorkerUrl?: string | URL;
}

interface BrowserWasiThreadPoolCommandOptions {
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

// The two thread-spawner factories were split into ./browser-wasi-thread-spawner.ts; re-export the
// public surface here (see the import + export below) so existing importers of this module keep
// resolving.

export function createBrowserWasiThreadWorkerPool({
  initialSize,
  threadWorkerUrl,
}: BrowserWasiThreadWorkerPoolOptions): BrowserWasiThreadWorkerPool {
  const resolvedThreadWorkerUrl = resolveThreadWorkerUrl(threadWorkerUrl);
  const workers: ThreadPoolShell[] = [];
  let disposed = false;
  let nextCommandId = 1;
  // Eager non-blocking self-pre-warm. `ready` resolves once the pool has pre-warmed to `initialSize`;
  // it is informational - nothing blocks on it (threaded runs negotiate their own shells via
  // createCommand -> ensureSize), so the pre-warm is only a head start for the next op.
  let resolvePrewarm: () => void = () => undefined;
  const ready: Promise<void> = new Promise<void>((resolve) => {
    resolvePrewarm = resolve;
  });

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
    trace?.(`[browser-opfs] thread pool replacing worker=${index}${reason ? ` ${formatErrorForTrace(reason)}` : ""}`);
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
    // Bound concurrent worker-script loads for hosts with small connection pools; the replacement
    // budget separately prevents endless retries on genuine failures.
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
      const shells = await selectAvailableShells(poolSize, trace ?? null);
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
        `[perf] thread pool command ready id=${commandId} slots=${command.slots.length}` +
          ` ensureMs=${ensureMs.toFixed(1)} selectMs=${selectMs.toFixed(1)} postMs=${postMs.toFixed(1)}` +
          ` readyMs=${(monotonicNowMs() - commandStartMs).toFixed(1)}`,
      );
    });
    return command;
  };

  const dispose = async () => {
    disposed = true;
    resolvePrewarm();
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

  // Pre-warm the pool to `initialSize` immediately (non-blocking). Runner init does not wait on it and
  // threaded runs grow the pool on demand via createCommand, so this is purely a head start that lets a
  // freshly created runner - at boot, after a reset/thread-change, or after an idle recycle between ops
  // - be warm for the next op. No artificial delay: the sooner the pool warms, the sooner an op that
  // arrives mid-warm-up benefits.
  const startPrewarm = () => {
    if (disposed || initialSize <= 0) {
      resolvePrewarm();
      return;
    }
    void ensureSize(initialSize)
      .catch(() => undefined)
      .finally(() => resolvePrewarm());
  };
  startPrewarm();

  return {
    createCommand,
    dispose,
    isReady,
    ready,
    resolvedThreadWorkerUrl,
  };
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
