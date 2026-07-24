import type { ThreadWorkerSlot, TraceLine } from "./browser-opfs-runtime-types.ts";
import {
  annotateThreadWorkerError,
  createThreadWorkerLoadError,
  deserializeThreadWorkerError,
} from "./browser-wasi-thread-errors.ts";
import {
  createThreadWorkerRuntimePayload,
  type ThreadSpawnerRuntime,
  type ThreadWorkerReplyView,
  type ThreadWorkerThreadStartMessage,
} from "./browser-wasi-thread-pool-protocol.ts";
import {
  signalThreadStartState,
  THREAD_SLOT_ERROR_INDEX,
  THREAD_SLOT_LENGTH,
  THREAD_SLOT_START_ARG_INDEX,
  THREAD_SLOT_STATE_FAILED,
  THREAD_SLOT_STATE_INDEX,
  THREAD_SLOT_STATE_REQUESTED,
  THREAD_SLOT_TID_INDEX,
  type ThreadStartControl,
} from "./browser-wasi-thread-protocol.ts";
// `?worker&url`, never `new URL(..., import.meta.url)` - see "Worker URLs" in docs/ARCHITECTURE.md.
import BUILT_THREAD_WORKER_URL from "./workers/browser-wasi-thread-worker.ts?worker&url";

export const THREAD_WORKER_READY_TIMEOUT_MS = 5000;
export const THREAD_WORKER_BUSY_RETRY_INTERVAL_MS = 25;
export const THREAD_WORKER_BUSY_RETRY_TIMEOUT_MS = 30000;

interface StandaloneBrowserWasiThreadOptions {
  debugWasi: boolean;
  envList: unknown;
  index: number | string;
  runtime: ThreadSpawnerRuntime | undefined;
  startArg: number;
  streamBroadcastChannelName?: string;
  streamRequestId?: number;
  threadIdState: unknown;
  threadWorkerUrl: string;
  tid: number;
  trace?: TraceLine;
  wasiArgs: unknown;
  wasmMemory: WebAssembly.Memory;
  wasmModule: WebAssembly.Module;
}

export function createThreadSlotControl(): ThreadStartControl {
  return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * THREAD_SLOT_LENGTH)) as ThreadStartControl;
}

export function loadThreadSlotState(control: ThreadStartControl): number {
  return Atomics.load(control, THREAD_SLOT_STATE_INDEX);
}

export function createStandaloneBrowserWasiThread({
  debugWasi,
  envList,
  index,
  runtime,
  startArg,
  streamBroadcastChannelName,
  streamRequestId,
  threadIdState,
  threadWorkerUrl,
  tid,
  trace,
  wasiArgs,
  wasmMemory,
  wasmModule,
}: StandaloneBrowserWasiThreadOptions): ThreadWorkerSlot {
  const control = createThreadSlotControl();
  Atomics.store(control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_REQUESTED);
  Atomics.store(control, THREAD_SLOT_TID_INDEX, Number(tid) | 0);
  Atomics.store(control, THREAD_SLOT_START_ARG_INDEX, Number(startArg) | 0);
  Atomics.store(control, THREAD_SLOT_ERROR_INDEX, 0);

  const worker = new Worker(resolveThreadWorkerUrl(threadWorkerUrl), { type: "module" });
  const slot: ThreadWorkerSlot = {
    busy: true,
    control,
    failure: null,
    index,
    tid: Number(tid) | 0,
    worker,
  };

  worker.addEventListener("message", (event: MessageEvent<ThreadWorkerReplyView>) => {
    const message = event.data ?? {};
    if (message.type === "done") {
      slot.busy = false;
      slot.tid = null;
      return;
    }
    if (message.type !== "error") return;
    const error = annotateThreadWorkerError(deserializeThreadWorkerError(message.error), slot, threadWorkerUrl);
    slot.failure = error;
    Atomics.store(control, THREAD_SLOT_ERROR_INDEX, 1);
    signalThreadStartState(control, THREAD_SLOT_STATE_FAILED);
  });
  worker.addEventListener("error", (event) => {
    event.preventDefault?.();
    const error = createThreadWorkerLoadError(event, slot, threadWorkerUrl);
    slot.failure = error;
    Atomics.store(control, THREAD_SLOT_ERROR_INDEX, 1);
    signalThreadStartState(control, THREAD_SLOT_STATE_FAILED);
  });
  worker.addEventListener("messageerror", (event) => {
    event.preventDefault?.();
    const error = new Error(
      `browser wasi thread worker ${slot.index} could not receive its message (workerUrl=${threadWorkerUrl})`,
    );
    slot.failure = error;
    Atomics.store(control, THREAD_SLOT_ERROR_INDEX, 1);
    signalThreadStartState(control, THREAD_SLOT_STATE_FAILED);
  });

  worker.postMessage({
    __streamBroadcastChannelName: streamBroadcastChannelName,
    __streamRequestId: streamRequestId,
    debugWasi,
    envList,
    mode: "thread",
    runtime: createThreadWorkerRuntimePayload(runtime),
    startArg,
    startControlBuffer: control.buffer,
    threadIdState,
    threadWorkerUrl,
    tid,
    wasiArgs,
    wasmMemory,
    wasmModule,
  } satisfies ThreadWorkerThreadStartMessage);
  trace?.(`[browser-opfs] standalone thread worker posted tid=${tid} worker=${index}`);
  return slot;
}

// The thread worker runs with full access to the shared wasm memory, so its URL must stay
// on our own origin. Callers pass a build-resolved URL; anything that resolves elsewhere
// (a `data:`/`https://evil` string threaded in from untrusted config) is rejected outright
// rather than spawned (CodeQL js/client-side-unvalidated-url-redirection).
const assertSameOriginWorkerUrl = (href: string): string => {
  const origin = typeof self === "undefined" ? undefined : self.location?.origin;
  if (!origin) return href;
  let resolved: URL;
  try {
    resolved = new URL(href, origin);
  } catch {
    throw new Error(`thread worker URL is not a valid URL: ${href}`);
  }
  if (resolved.origin !== origin)
    throw new Error(`thread worker URL must be same-origin (${origin}), got ${resolved.origin}`);
  return resolved.href;
};

export function resolveThreadWorkerUrl(value: string | URL | undefined): string {
  if (value instanceof URL) return assertSameOriginWorkerUrl(value.href);
  if (typeof value === "string" && value.trim().length > 0) return assertSameOriginWorkerUrl(value);
  return BUILT_THREAD_WORKER_URL;
}
