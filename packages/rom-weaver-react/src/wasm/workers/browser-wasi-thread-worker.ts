import {
  __disposeRomWeaverBrowserThreadMountCache,
  __primeRomWeaverBrowserThreadRuntime,
  __runRomWeaverBrowserWasiThread,
} from "../browser-opfs-wasi-thread-runtime.ts";
import type {
  SerializedThreadWorkerError,
  ThreadWorkerCommandDoneReply,
  ThreadWorkerDoneReply,
  ThreadWorkerErrorReply,
  ThreadWorkerMessage,
  ThreadWorkerPoolCommandMessage,
  ThreadWorkerReadyReply,
  ThreadWorkerShellReadyReply,
  ThreadWorkerThreadStartMessage,
} from "../browser-wasi-thread-pool.ts";
import { formatErrorForTrace } from "./worker-trace-format.ts";

/** Stream-routing fields shared by every command-style worker message. */
interface ThreadWorkerStreamSource {
  __streamBroadcastChannelName?: string;
  __streamRequestId?: number;
}

interface ThreadWorkerStreamPublisher {
  close: () => void;
  stderrLine: (line: string) => void;
  stdoutLine: (line: string) => void;
  traceLine: (line: string) => void;
}

let shellBusy = false;

self.addEventListener("message", (event) => {
  const payload: ThreadWorkerMessage = event.data ?? {};
  const payloadMode = payload.mode;
  if (payload.mode === "pool-shell") {
    self.postMessage({
      type: "shell-ready",
    } satisfies ThreadWorkerShellReadyReply);
    return;
  }
  if (payload.mode === "pool-command") {
    tracePayload(payload, null, `[wasi-thread-worker] pool command received command=${payload.commandId ?? "unknown"}`);
    if (shellBusy) {
      tracePayload(
        payload,
        null,
        `[wasi-thread-worker] pool command rejected busy command=${payload.commandId ?? "unknown"}`,
      );
      self.postMessage({
        commandId: payload.commandId,
        error: serializeError(new Error("browser wasi thread worker received a command while busy")),
        tid: null,
        type: "error",
      } satisfies ThreadWorkerErrorReply);
      return;
    }
    shellBusy = true;
    void runPoolWorker(payload)
      .then(() => {
        self.postMessage({
          commandId: payload.commandId,
          type: "command-done",
        } satisfies ThreadWorkerCommandDoneReply);
      })
      .catch((error) => {
        self.postMessage({
          commandId: payload.commandId,
          error: serializeError(error),
          tid: null,
          type: "error",
        } satisfies ThreadWorkerErrorReply);
      })
      .finally(() => {
        shellBusy = false;
      });
    return;
  }
  if (payload.mode === "shutdown") {
    void __disposeRomWeaverBrowserThreadMountCache()
      .catch(() => undefined)
      .finally(() => {
        self.close();
      });
    return;
  }
  if (payload.mode !== "thread") {
    self.postMessage({
      error: serializeError(
        new Error(`unsupported browser wasi thread worker mode: ${String(payloadMode ?? "unknown")}`),
      ),
      tid: null,
      type: "error",
    } satisfies ThreadWorkerErrorReply);
    return;
  }
  void runSingleThread(payload).catch((error) => {
    self.postMessage({
      error: serializeError(error),
      tid: payload?.tid ?? null,
      type: "error",
    } satisfies ThreadWorkerErrorReply);
    void __disposeRomWeaverBrowserThreadMountCache()
      .catch(() => undefined)
      .finally(() => {
        self.close();
      });
  });
});

const THREAD_SLOT_STATE_INDEX = 0;
const THREAD_SLOT_TID_INDEX = 1;
const THREAD_SLOT_START_ARG_INDEX = 2;
const THREAD_SLOT_ERROR_INDEX = 3;
const THREAD_SLOT_LENGTH = 4;
const THREAD_SLOT_STATE_IDLE = 0;
const THREAD_SLOT_STATE_REQUESTED = 1;
const THREAD_SLOT_STATE_STARTING = 2;
const THREAD_SLOT_STATE_FAILED = 5;
const THREAD_SLOT_STATE_SHUTDOWN = 6;
const ATOMICS_WAIT_SLICE_MS = 100;

async function runSingleThread(payload: ThreadWorkerThreadStartMessage) {
  const tid = payload?.tid ?? null;
  const stream = createStreamPublisher(payload, tid);
  const startControl = threadStartControlFromBuffer(payload?.startControlBuffer);
  stream?.traceLine(`[wasi-thread-worker] single thread start tid=${tid ?? "unknown"}`);
  try {
    await __runRomWeaverBrowserWasiThread(
      stream
        ? {
            ...payload,
            stderrLineHandler: stream.stderrLine,
            stdoutLineHandler: stream.stdoutLine,
          }
        : payload,
    );
    stream?.traceLine(`[wasi-thread-worker] single thread done tid=${tid ?? "unknown"}`);
    if (startControl) {
      Atomics.store(startControl, THREAD_SLOT_ERROR_INDEX, 0);
      signalThreadState(startControl, THREAD_SLOT_STATE_IDLE);
    }
    self.postMessage({ tid, type: "done" } satisfies ThreadWorkerDoneReply);
  } catch (error) {
    stream?.traceLine(
      `[wasi-thread-worker] single thread failed tid=${tid ?? "unknown"} ${formatErrorForTrace(error)}`,
    );
    if (startControl) {
      Atomics.store(startControl, THREAD_SLOT_ERROR_INDEX, 1);
      signalThreadState(startControl, THREAD_SLOT_STATE_FAILED);
    }
    self.postMessage({
      error: serializeError(error),
      tid,
      type: "error",
    } satisfies ThreadWorkerErrorReply);
  } finally {
    stream?.close();
    await __disposeRomWeaverBrowserThreadMountCache().catch(() => undefined);
    self.close();
  }
}

function threadStartControlFromBuffer(controlBuffer: unknown): Int32Array<SharedArrayBuffer> | null {
  if (!(controlBuffer instanceof SharedArrayBuffer)) return null;
  const control = new Int32Array(controlBuffer);
  if (control.length < THREAD_SLOT_LENGTH) return null;
  return control;
}

async function runPoolWorker(payload: ThreadWorkerPoolCommandMessage) {
  const control = new Int32Array(payload.controlBuffer);
  if (!(control.buffer instanceof SharedArrayBuffer) || control.length < THREAD_SLOT_LENGTH) {
    throw new Error("browser wasi thread pool worker missing shared control buffer");
  }
  const poolStream = createStreamPublisher(payload, null);
  await __primeRomWeaverBrowserThreadRuntime(payload.runtime, poolStream?.traceLine);
  poolStream?.traceLine(`[wasi-thread-worker] pool worker ready command=${payload.commandId ?? "standalone"}`);
  self.postMessage({
    commandId: payload.commandId,
    type: "ready",
  } satisfies ThreadWorkerReadyReply);

  try {
    while (true) {
      while (Atomics.load(control, THREAD_SLOT_STATE_INDEX) === THREAD_SLOT_STATE_IDLE) {
        waitForThreadStateChange(control, THREAD_SLOT_STATE_IDLE);
      }
      const state = Atomics.load(control, THREAD_SLOT_STATE_INDEX);
      if (state === THREAD_SLOT_STATE_SHUTDOWN) {
        poolStream?.traceLine(`[wasi-thread-worker] pool worker shutdown command=${payload.commandId ?? "unknown"}`);
        return;
      }
      if (state === THREAD_SLOT_STATE_FAILED) {
        waitForThreadStateChange(control, THREAD_SLOT_STATE_FAILED);
        continue;
      }
      if (state !== THREAD_SLOT_STATE_REQUESTED) continue;

      const tid = Atomics.load(control, THREAD_SLOT_TID_INDEX) | 0;
      const startArg = Atomics.load(control, THREAD_SLOT_START_ARG_INDEX) | 0;
      const stream = createStreamPublisher(payload, tid);
      stream?.traceLine(`[wasi-thread-worker] pool thread start tid=${tid} startArg=${startArg}`);
      Atomics.store(control, THREAD_SLOT_ERROR_INDEX, 0);
      signalThreadState(control, THREAD_SLOT_STATE_STARTING);
      try {
        const threadPayload = {
          ...payload,
          startArg,
          startControlBuffer: control.buffer,
          tid,
        };
        await __runRomWeaverBrowserWasiThread(
          stream
            ? {
                ...threadPayload,
                stderrLineHandler: stream.stderrLine,
                stdoutLineHandler: stream.stdoutLine,
              }
            : threadPayload,
        );
        stream?.traceLine(`[wasi-thread-worker] pool thread done tid=${tid}`);
        Atomics.store(control, THREAD_SLOT_ERROR_INDEX, 0);
        signalThreadState(control, THREAD_SLOT_STATE_IDLE);
      } catch (error) {
        stream?.traceLine(`[wasi-thread-worker] pool thread failed tid=${tid} ${formatErrorForTrace(error)}`);
        Atomics.store(control, THREAD_SLOT_ERROR_INDEX, 1);
        signalThreadState(control, THREAD_SLOT_STATE_FAILED);
        self.postMessage({
          commandId: payload.commandId,
          error: serializeError(error),
          tid,
          type: "error",
        } satisfies ThreadWorkerErrorReply);
      } finally {
        stream?.close();
      }
    }
  } finally {
    poolStream?.close();
  }
}

function createStreamPublisher(
  payload: ThreadWorkerStreamSource,
  tid: number | null,
): ThreadWorkerStreamPublisher | null {
  const channelName =
    typeof payload?.__streamBroadcastChannelName === "string" ? payload.__streamBroadcastChannelName : "";
  const rawRequestId = payload?.__streamRequestId;
  const requestId = typeof rawRequestId === "number" && Number.isInteger(rawRequestId) ? rawRequestId : null;
  if (!channelName || requestId === null || typeof BroadcastChannel !== "function") return null;

  const channel = new BroadcastChannel(channelName);
  return {
    close() {
      channel.close();
    },
    stderrLine(line) {
      publishLine(channel, requestId, tid, line, true);
    },
    stdoutLine(line) {
      publishLine(channel, requestId, tid, line, false);
    },
    traceLine(line) {
      publishLine(channel, requestId, tid, line, true);
    },
  };
}

function tracePayload(payload: ThreadWorkerStreamSource, tid: number | null, line: string): void {
  const stream = createStreamPublisher(payload, tid);
  stream?.traceLine(line);
  stream?.close();
}

function publishLine(
  channel: BroadcastChannel,
  requestId: number,
  tid: number | null,
  line: string,
  trace: boolean,
): void {
  const text = String(line ?? "");
  if (text.length === 0) return;
  try {
    const event: unknown = JSON.parse(text);
    channel.postMessage({
      event,
      requestId,
      tid,
      type: trace ? "traceEvent" : "event",
    });
  } catch {
    channel.postMessage({
      line: text,
      requestId,
      tid,
      type: trace ? "traceNonJsonLine" : "nonJsonLine",
    });
  }
}

function signalThreadState(control: Int32Array<SharedArrayBuffer>, state: number): void {
  Atomics.store(control, THREAD_SLOT_STATE_INDEX, state);
  Atomics.notify(control, THREAD_SLOT_STATE_INDEX, 1);
}

function waitForThreadStateChange(control: Int32Array<SharedArrayBuffer>, expectedState: number): void {
  Atomics.wait(control, THREAD_SLOT_STATE_INDEX, expectedState, ATOMICS_WAIT_SLICE_MS);
}

function serializeError(error: unknown): SerializedThreadWorkerError {
  if (!isErrorLike(error)) {
    return {
      cause: undefined,
      message: String(error),
      name: "Error",
      stack: undefined,
    };
  }
  return {
    cause: error.cause ? serializeError(error.cause) : undefined,
    message: typeof error.message === "string" ? error.message : String(error),
    name: typeof error.name === "string" ? error.name : "Error",
    stack: typeof error.stack === "string" ? error.stack : undefined,
  };
}

function isErrorLike(value: unknown): value is {
  cause?: unknown;
  message?: unknown;
  name?: unknown;
  stack?: unknown;
} {
  return Boolean(value) && (typeof value === "object" || typeof value === "function");
}
