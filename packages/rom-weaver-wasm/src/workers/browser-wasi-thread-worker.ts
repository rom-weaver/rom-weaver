import {
  __disposeRomWeaverBrowserThreadMountCache,
  __primeRomWeaverBrowserThreadRuntime,
  __runRomWeaverBrowserWasiThread,
} from '../browser-opfs-wasi-thread-runtime.ts';

let shellBusy = false;

self.addEventListener('message', (event) => {
  const payload = event.data ?? {};
  if (payload.mode === 'pool-shell') {
    self.postMessage({ type: 'shell-ready' });
    return;
  }
  if (payload.mode === 'pool-command') {
    tracePayload(payload, null, `[wasi-thread-worker] pool command received command=${payload.commandId ?? 'unknown'}`);
    if (shellBusy) {
      tracePayload(payload, null, `[wasi-thread-worker] pool command rejected busy command=${payload.commandId ?? 'unknown'}`);
      self.postMessage({
        type: 'error',
        commandId: payload.commandId,
        tid: null,
        error: serializeError(new Error('browser wasi thread worker received a command while busy')),
      });
      return;
    }
    shellBusy = true;
    void runPoolWorker(payload)
      .then(() => {
        self.postMessage({ type: 'command-done', commandId: payload.commandId });
      })
      .catch((error) => {
        self.postMessage({
          type: 'error',
          commandId: payload.commandId,
          tid: null,
          error: serializeError(error),
        });
      })
      .finally(() => {
        shellBusy = false;
      });
    return;
  }
  if (payload.mode === 'shutdown') {
    void __disposeRomWeaverBrowserThreadMountCache()
      .catch(() => undefined)
      .finally(() => {
        self.close();
      });
    return;
  }
  if (payload.mode !== 'thread') {
    self.postMessage({
      type: 'error',
      tid: null,
      error: serializeError(new Error(`unsupported browser wasi thread worker mode: ${String(payload.mode ?? 'unknown')}`)),
    });
    return;
  }
  void runSingleThread(payload).catch((error) => {
    self.postMessage({
      type: 'error',
      tid: payload?.tid ?? null,
      error: serializeError(error),
    });
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

async function runSingleThread(payload) {
  const tid = payload?.tid ?? null;
  const stream = createStreamPublisher(payload, tid);
  const startControl = threadStartControlFromBuffer(payload?.startControlBuffer);
  stream?.traceLine(`[wasi-thread-worker] single thread start tid=${tid ?? 'unknown'}`);
  try {
    await __runRomWeaverBrowserWasiThread(stream
      ? {
        ...payload,
        stderrLineHandler: stream.stderrLine,
        stdoutLineHandler: stream.stdoutLine,
      }
      : payload);
    stream?.traceLine(`[wasi-thread-worker] single thread done tid=${tid ?? 'unknown'}`);
    if (startControl) {
      Atomics.store(startControl, THREAD_SLOT_ERROR_INDEX, 0);
      signalThreadState(startControl, THREAD_SLOT_STATE_IDLE);
    }
    self.postMessage({ type: 'done', tid });
  } catch (error) {
    stream?.traceLine(`[wasi-thread-worker] single thread failed tid=${tid ?? 'unknown'} ${formatErrorForTrace(error)}`);
    if (startControl) {
      Atomics.store(startControl, THREAD_SLOT_ERROR_INDEX, 1);
      signalThreadState(startControl, THREAD_SLOT_STATE_FAILED);
    }
    self.postMessage({
      type: 'error',
      tid,
      error: serializeError(error),
    });
  } finally {
    stream?.close();
    await __disposeRomWeaverBrowserThreadMountCache().catch(() => undefined);
    self.close();
  }
}

function threadStartControlFromBuffer(controlBuffer) {
  if (!(controlBuffer instanceof SharedArrayBuffer)) return null;
  const control = new Int32Array(controlBuffer);
  if (control.length < THREAD_SLOT_LENGTH) return null;
  return control;
}

async function runPoolWorker(payload) {
  const control = new Int32Array(payload.controlBuffer);
  if (!(control.buffer instanceof SharedArrayBuffer) || control.length < THREAD_SLOT_LENGTH) {
    throw new Error('browser wasi thread pool worker missing shared control buffer');
  }
  const poolStream = createStreamPublisher(payload, null);
  await __primeRomWeaverBrowserThreadRuntime(payload.runtime, poolStream?.traceLine);
  poolStream?.traceLine(`[wasi-thread-worker] pool worker ready command=${payload.commandId ?? 'standalone'}`);
  self.postMessage({ type: 'ready', commandId: payload.commandId });

  try {
    while (true) {
      while (Atomics.load(control, THREAD_SLOT_STATE_INDEX) === THREAD_SLOT_STATE_IDLE) {
        waitForThreadStateChange(control, THREAD_SLOT_STATE_IDLE);
      }
      const state = Atomics.load(control, THREAD_SLOT_STATE_INDEX);
      if (state === THREAD_SLOT_STATE_SHUTDOWN) {
        poolStream?.traceLine(`[wasi-thread-worker] pool worker shutdown command=${payload.commandId ?? 'unknown'}`);
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
        await __runRomWeaverBrowserWasiThread(stream
          ? {
            ...threadPayload,
            stderrLineHandler: stream.stderrLine,
            stdoutLineHandler: stream.stdoutLine,
          }
          : threadPayload);
        stream?.traceLine(`[wasi-thread-worker] pool thread done tid=${tid}`);
        Atomics.store(control, THREAD_SLOT_ERROR_INDEX, 0);
        signalThreadState(control, THREAD_SLOT_STATE_IDLE);
      } catch (error) {
        stream?.traceLine(`[wasi-thread-worker] pool thread failed tid=${tid} ${formatErrorForTrace(error)}`);
        Atomics.store(control, THREAD_SLOT_ERROR_INDEX, 1);
        signalThreadState(control, THREAD_SLOT_STATE_FAILED);
        self.postMessage({
          type: 'error',
          commandId: payload.commandId,
          tid,
          error: serializeError(error),
        });
      } finally {
        stream?.close();
      }
    }
  } finally {
    poolStream?.close();
  }
}

function createStreamPublisher(payload, tid) {
  const channelName = typeof payload?.__streamBroadcastChannelName === 'string'
    ? payload.__streamBroadcastChannelName
    : '';
  const requestId = Number.isInteger(payload?.__streamRequestId) ? payload.__streamRequestId : null;
  if (!channelName || requestId === null || typeof BroadcastChannel !== 'function') return null;

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

function tracePayload(payload, tid, line) {
  const stream = createStreamPublisher(payload, tid);
  stream?.traceLine(line);
  stream?.close();
}

function publishLine(channel, requestId, tid, line, trace) {
  const text = String(line ?? '');
  if (text.length === 0) return;
  try {
    const event = JSON.parse(text);
    channel.postMessage({
      type: trace ? 'traceEvent' : 'event',
      requestId,
      tid,
      event,
    });
  } catch {
    channel.postMessage({
      type: trace ? 'traceNonJsonLine' : 'nonJsonLine',
      requestId,
      tid,
      line: text,
    });
  }
}

function signalThreadState(control, state) {
  Atomics.store(control, THREAD_SLOT_STATE_INDEX, state);
  Atomics.notify(control, THREAD_SLOT_STATE_INDEX, 1);
}

function waitForThreadStateChange(control, expectedState) {
  Atomics.wait(control, THREAD_SLOT_STATE_INDEX, expectedState, ATOMICS_WAIT_SLICE_MS);
}

function serializeError(error) {
  return {
    cause: error && error.cause ? serializeError(error.cause) : undefined,
    name: error && typeof error.name === 'string' ? error.name : 'Error',
    message: error && typeof error.message === 'string' ? error.message : String(error),
    stack: error && typeof error.stack === 'string' ? error.stack : undefined,
  };
}

function formatErrorForTrace(error) {
  if (error instanceof Error) return `${error.name}:${truncateForTrace(error.message)}`;
  return truncateForTrace(String(error));
}

function truncateForTrace(value, maxLength = 180) {
  const text = String(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}...`;
}
