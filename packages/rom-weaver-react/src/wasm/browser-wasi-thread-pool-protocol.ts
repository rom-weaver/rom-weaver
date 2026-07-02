import type { BrowserOpfsRuntime } from "./browser-opfs-runtime-types.ts";
import type { NormalizedVirtualFile } from "./browser-opfs-virtual-files.ts";

/**
 * Runtime options accepted by the thread spawner. Identical to the shared BrowserOpfsRuntime
 * except `virtualFiles` is the already-normalized shape: the runner normalizes once on the main
 * thread and structured clone (postMessage) preserves Uint8Array/ArrayBuffer/Blob/File intact,
 * so workers consume them directly without re-normalizing.
 */
export type ThreadSpawnerRuntime = Omit<BrowserOpfsRuntime, "virtualFiles"> & {
  virtualFiles?: NormalizedVirtualFile[];
};

/** Runtime payload forwarded to thread workers; handles are re-resolved inside the worker. */
type ThreadWorkerRuntimePayload = ThreadSpawnerRuntime & {
  resolveMountHandlesInWorker: true;
  virtualOnlyMounts: true;
};

/** Structured clone of an Error posted by a thread worker (see worker serializeError). */
export interface SerializedThreadWorkerError {
  cause?: SerializedThreadWorkerError;
  message: string;
  name: string;
  stack?: string;
}

/** Shared fields posted with both pool-command and standalone thread messages. */
interface ThreadWorkerCommandMessageBase {
  __streamBroadcastChannelName?: string;
  __streamRequestId?: number;
  debugWasi: boolean;
  envList: unknown;
  runtime?: ThreadSpawnerRuntime;
  threadIdState: unknown;
  threadWorkerUrl: string;
  wasiArgs: unknown;
  wasmMemory: WebAssembly.Memory;
  wasmModule: WebAssembly.Module;
}

/** Posted to a pooled worker shell right after construction. */
export interface ThreadWorkerPoolShellMessage {
  mode: "pool-shell";
}

/** Posted to a pooled worker shell to terminate it. */
export interface ThreadWorkerShutdownMessage {
  mode: "shutdown";
}

/** Posted to a pooled worker shell to attach it to a command's control slot. */
export interface ThreadWorkerPoolCommandMessage extends ThreadWorkerCommandMessageBase {
  commandId: number;
  controlBuffer: SharedArrayBuffer;
  mode: "pool-command";
}

/** Posted to a standalone (non-pooled) worker to run a single wasi thread. */
export interface ThreadWorkerThreadStartMessage extends ThreadWorkerCommandMessageBase {
  mode: "thread";
  startArg: number;
  startControlBuffer: SharedArrayBuffer;
  tid: number;
}

/** Every message the pool posts to a thread worker. */
export type ThreadWorkerMessage =
  | ThreadWorkerPoolCommandMessage
  | ThreadWorkerPoolShellMessage
  | ThreadWorkerShutdownMessage
  | ThreadWorkerThreadStartMessage;

/** Worker shell finished booting and can accept pool commands. */
export interface ThreadWorkerShellReadyReply {
  type: "shell-ready";
}

/** Pooled worker primed its runtime and is watching the command control slot. */
export interface ThreadWorkerReadyReply {
  commandId: number;
  type: "ready";
}

/** Pooled worker observed the command shutdown state and detached. */
export interface ThreadWorkerCommandDoneReply {
  commandId: number;
  type: "command-done";
}

/** Standalone worker finished its single wasi thread. */
export interface ThreadWorkerDoneReply {
  tid: number | null;
  type: "done";
}

/** A thread (or the shell itself) failed; `tid` is null for shell-level failures. */
export interface ThreadWorkerErrorReply {
  commandId?: number;
  error: SerializedThreadWorkerError;
  tid: number | null;
  type: "error";
}

/** Defensive receive-side view of ThreadWorkerReply (unknown senders, partial clones). */
export interface ThreadWorkerReplyView {
  commandId?: number;
  error?: unknown;
  tid?: number | null;
  type?: string;
}

export function createThreadWorkerRuntimePayload(
  runtime: ThreadSpawnerRuntime | undefined,
): ThreadSpawnerRuntime | undefined {
  if (!runtime || typeof runtime !== "object") return runtime;
  const { mountHandles: _mountHandles, ...rest } = runtime;
  const payload: ThreadWorkerRuntimePayload = {
    ...rest,
    resolveMountHandlesInWorker: true,
    virtualOnlyMounts: true,
  };
  return payload;
}
