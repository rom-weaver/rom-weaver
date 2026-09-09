/** Reusable dedicated workers for nested WASI thread spawns. Nested spawns MUST bypass the runner's
 * bounded pool: parents block on their children while holding its slots, which would deadlock.
 *
 * This free list belongs to one realm, which is its only mutator, and never blocks: acquire takes an
 * IDLE worker or creates one. A worker is parked only after its child is IDLE, so reuse does not
 * exceed the realm's peak simultaneous children.
 * The list is keyed by run-payload identity and drained when that changes, so workers never retain a
 * stale module, memory, or runtime. */

import type { ThreadWorkerSlot, TraceLine } from "./browser-opfs-runtime-types.ts";
import { basenameForTrace, formatErrorForTrace } from "./browser-opfs-stdio-events.ts";
import { countThreadWorkerCreated } from "./browser-wasi-thread-census.ts";
import {
  annotateThreadWorkerError,
  createThreadWorkerLoadError,
  deserializeThreadWorkerError,
} from "./browser-wasi-thread-errors.ts";
import {
  createThreadWorkerRuntimePayload,
  type ThreadSpawnerRuntime,
  type ThreadWorkerPoolCommandMessage,
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
  THREAD_SLOT_STATE_REQUESTED,
  THREAD_SLOT_STATE_SHUTDOWN,
  THREAD_SLOT_TID_INDEX,
} from "./browser-wasi-thread-protocol.ts";
import { createThreadSlotControl, loadThreadSlotState, resolveThreadWorkerUrl } from "./browser-wasi-thread-shell.ts";

/** How long drain waits for parked workers to acknowledge shutdown before terminating them. */
const NESTED_WORKER_DRAIN_TIMEOUT_MS = 5000;

export interface NestedThreadWorkerOptions {
  debugWasi: boolean;
  envList: unknown;
  runtime: ThreadSpawnerRuntime | undefined;
  streamBroadcastChannelName?: string;
  streamRequestId?: number;
  threadIdState: unknown;
  threadWorkerUrl: string;
  trace?: TraceLine;
  wasiArgs: unknown;
  wasmMemory: WebAssembly.Memory;
  wasmModule: WebAssembly.Module;
}

export type NestedThreadWorkerSlot = ThreadWorkerSlot & { done: Promise<void>; resolveDone: () => void };

export interface NestedThreadWorkerList {
  /** Takes a parked worker or creates one, arms its control slot, and hands it back armed. Never blocks. */
  acquire: (tid: number, startArg: number) => NestedThreadWorkerSlot;
  /** Shuts every worker down. Idempotent; the list refuses further acquires afterwards. */
  drain: () => Promise<void>;
  /** Parks a finished worker for the next spawn. */
  release: (slot: NestedThreadWorkerSlot) => void;
  /** Permanently discards a worker that failed or never acknowledged its start. */
  retire: (slot: NestedThreadWorkerSlot) => void;
}

/**
 * Identity of the run a parked worker was configured for. A parked worker still holds the command
 * message it was created with (module, memory, tid counter, runtime, stream routing), so it may only
 * be reused while every one of those is the same object.
 */
type NestedThreadWorkerKey = {
  envList: unknown;
  runtime: ThreadSpawnerRuntime | undefined;
  streamBroadcastChannelName?: string;
  streamRequestId?: number;
  threadIdState: unknown;
  threadWorkerUrl: string;
  wasiArgs: unknown;
  wasmMemory: WebAssembly.Memory;
  wasmModule: WebAssembly.Module;
};

const keysMatch = (left: NestedThreadWorkerKey, right: NestedThreadWorkerKey): boolean =>
  left.envList === right.envList &&
  left.runtime === right.runtime &&
  left.streamBroadcastChannelName === right.streamBroadcastChannelName &&
  left.streamRequestId === right.streamRequestId &&
  left.threadIdState === right.threadIdState &&
  left.threadWorkerUrl === right.threadWorkerUrl &&
  left.wasiArgs === right.wasiArgs &&
  left.wasmMemory === right.wasmMemory &&
  left.wasmModule === right.wasmModule;

let currentList: { key: NestedThreadWorkerKey; list: NestedThreadWorkerList } | null = null;

/**
 * The realm's nested-worker free list for this run. Reused across every parent WASI thread the realm
 * runs for the same command; a different command drains the previous list first.
 */
export function acquireNestedThreadWorkerList(options: NestedThreadWorkerOptions): NestedThreadWorkerList {
  const key: NestedThreadWorkerKey = {
    envList: options.envList,
    runtime: options.runtime,
    streamBroadcastChannelName: options.streamBroadcastChannelName,
    streamRequestId: options.streamRequestId,
    threadIdState: options.threadIdState,
    threadWorkerUrl: resolveThreadWorkerUrl(options.threadWorkerUrl),
    wasiArgs: options.wasiArgs,
    wasmMemory: options.wasmMemory,
    wasmModule: options.wasmModule,
  };
  if (currentList && keysMatch(currentList.key, key)) return currentList.list;
  if (currentList) {
    options.trace?.("[browser-opfs] nested thread workers draining stale list");
    // `acquire` MUST stay synchronous because the guest calls thread-spawn synchronously.
    void currentList.list.drain();
  }
  const list = createNestedThreadWorkerList({ ...options, threadWorkerUrl: key.threadWorkerUrl });
  currentList = { key, list };
  return list;
}

/** Drains the realm's nested workers. Called when a realm finishes a command or shuts down. */
export async function disposeNestedThreadWorkerLists(): Promise<void> {
  const previous = currentList;
  currentList = null;
  await previous?.list.drain();
}

function createNestedThreadWorkerList({
  debugWasi,
  envList,
  runtime,
  streamBroadcastChannelName,
  streamRequestId,
  threadIdState,
  threadWorkerUrl,
  trace,
  wasiArgs,
  wasmMemory,
  wasmModule,
}: NestedThreadWorkerOptions): NestedThreadWorkerList {
  const allSlots = new Set<NestedThreadWorkerSlot>();
  const idleSlots: NestedThreadWorkerSlot[] = [];
  let createdCount = 0;
  let nextIndex = 0;
  let drained = false;

  const failSlot = (slot: NestedThreadWorkerSlot, error: Error) => {
    slot.failure = error;
    Atomics.store(slot.control, THREAD_SLOT_ERROR_INDEX, 1);
    signalThreadStartState(slot.control, THREAD_SLOT_STATE_FAILED);
  };

  const createSlot = (): NestedThreadWorkerSlot => {
    const control = createThreadSlotControl();
    Atomics.store(control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_IDLE);
    const index = `nested-${nextIndex}`;
    nextIndex += 1;
    const worker = new Worker(threadWorkerUrl, { type: "module" });
    createdCount += 1;
    const totalCreated = countThreadWorkerCreated();
    trace?.(
      `[browser-opfs] thread worker created kind=nested index=${index}` +
        ` worker=${basenameForTrace(threadWorkerUrl)} total=${totalCreated}`,
    );
    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const slot: NestedThreadWorkerSlot = {
      busy: false,
      control,
      done,
      failure: null,
      index,
      resolveDone: () => resolveDone(),
      tid: null,
      worker,
    };

    worker.addEventListener("message", (event: MessageEvent<ThreadWorkerReplyView>) => {
      const message = event.data ?? {};
      if (message.type === "command-done") {
        slot.resolveDone();
        return;
      }
      if (message.type !== "error") return;
      // A per-thread failure already set FAILED on the control word from inside the worker; recording
      // the deserialized error here is what turns it into a useful message for the parent.
      slot.failure = annotateThreadWorkerError(deserializeThreadWorkerError(message.error), slot, threadWorkerUrl);
      Atomics.store(slot.control, THREAD_SLOT_ERROR_INDEX, 1);
      signalThreadStartState(slot.control, THREAD_SLOT_STATE_FAILED);
    });
    worker.addEventListener("error", (event) => {
      event.preventDefault?.();
      failSlot(slot, createThreadWorkerLoadError(event, slot, threadWorkerUrl));
      slot.resolveDone();
    });
    worker.addEventListener("messageerror", (event) => {
      event.preventDefault?.();
      failSlot(
        slot,
        new Error(
          `browser wasi nested thread worker ${slot.index} could not receive its message` +
            ` (workerUrl=${threadWorkerUrl})`,
        ),
      );
      slot.resolveDone();
    });

    // pool-command primes one runtime, then serves requests from the control word loop without rebuilding WASM or OPFS mounts.
    const payload: ThreadWorkerPoolCommandMessage = {
      __streamBroadcastChannelName: streamBroadcastChannelName,
      __streamRequestId: streamRequestId,
      commandId: 0,
      controlBuffer: control.buffer,
      debugWasi,
      envList,
      mode: "pool-command",
      prewarmRuntime: false,
      runtime: createThreadWorkerRuntimePayload(runtime),
      threadIdState,
      threadWorkerUrl,
      wasiArgs,
      wasmMemory,
      wasmModule,
    };
    worker.postMessage(payload);
    allSlots.add(slot);
    return slot;
  };

  const takeIdleSlot = (): NestedThreadWorkerSlot | null => {
    while (idleSlots.length > 0) {
      const slot = idleSlots.pop();
      if (!slot) continue;
      // Skip slots that failed or shut down while parked.
      if (!allSlots.has(slot) || slot.failure) continue;
      if (loadThreadSlotState(slot.control) !== THREAD_SLOT_STATE_IDLE) continue;
      return slot;
    }
    return null;
  };

  const shutdownSlot = (slot: NestedThreadWorkerSlot) => {
    allSlots.delete(slot);
    const state = loadThreadSlotState(slot.control);
    // A command-loop worker waits on FAILED. Failed slots MUST advance to SHUTDOWN so queued shutdown can run.
    if (state !== THREAD_SLOT_STATE_SHUTDOWN) {
      signalThreadStartState(slot.control, THREAD_SLOT_STATE_SHUTDOWN);
    }
    try {
      // The worker handles this after its loop exits, then disposes its mount cache and releases OPFS handles.
      slot.worker?.postMessage({ mode: "shutdown" } satisfies ThreadWorkerShutdownMessage);
    } catch (error) {
      trace?.(
        `[browser-opfs] nested thread worker shutdown post failed index=${slot.index} ${formatErrorForTrace(error)}`,
      );
      slot.resolveDone();
    }
  };

  return {
    acquire(tid, startArg) {
      if (drained) throw new Error("browser wasi nested thread worker list is drained");
      const slot = takeIdleSlot() ?? createSlot();
      slot.busy = true;
      slot.tid = tid;
      slot.failure = null;
      Atomics.store(slot.control, THREAD_SLOT_TID_INDEX, Number(tid) | 0);
      Atomics.store(slot.control, THREAD_SLOT_START_ARG_INDEX, Number(startArg) | 0);
      Atomics.store(slot.control, THREAD_SLOT_ERROR_INDEX, 0);
      Atomics.store(slot.control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_REQUESTED);
      Atomics.notify(slot.control, THREAD_SLOT_STATE_INDEX, 1);
      return slot;
    },

    async drain() {
      if (drained) return;
      drained = true;
      const slots = [...allSlots];
      idleSlots.length = 0;
      trace?.(`[browser-opfs] nested thread workers drain start workers=${slots.length} created=${createdCount}`);
      for (const slot of slots) shutdownSlot(slot);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const bounded = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, NESTED_WORKER_DRAIN_TIMEOUT_MS);
      });
      await Promise.race([Promise.allSettled(slots.map((slot) => slot.done)).then(() => undefined), bounded]);
      if (timer) clearTimeout(timer);
      // Always terminate after the bounded wait. Closing twice is safe, and an unresponsive worker MUST NOT remain.
      for (const slot of slots) {
        try {
          slot.worker?.terminate();
        } catch {
          // ignored
        }
      }
      trace?.(`[browser-opfs] nested thread workers drain done workers=${slots.length}`);
    },

    release(slot) {
      slot.busy = false;
      slot.tid = null;
      if (drained || !allSlots.has(slot)) return;
      if (slot.failure || loadThreadSlotState(slot.control) !== THREAD_SLOT_STATE_IDLE) return;
      idleSlots.push(slot);
    },

    retire(slot) {
      slot.busy = false;
      slot.tid = null;
      if (!allSlots.has(slot)) return;
      trace?.(`[browser-opfs] nested thread worker retired index=${slot.index}`);
      allSlots.delete(slot);
      // A sibling can still run wasi_thread_start. Terminate failed slots now because delayed shutdown can be overwritten by IDLE.
      signalThreadStartState(slot.control, THREAD_SLOT_STATE_SHUTDOWN);
      try {
        slot.worker?.terminate();
      } catch {
        // ignored
      }
      slot.resolveDone();
    },
  };
}
