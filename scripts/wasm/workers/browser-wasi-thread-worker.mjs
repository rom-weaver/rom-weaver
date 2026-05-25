import { __runRomWeaverBrowserWasiThread } from '../rom-weaver-browser-opfs-api.mjs';

self.addEventListener('message', (event) => {
  const payload = event.data ?? {};
  if (payload.mode === 'pool') {
    void runPoolWorker(payload);
    return;
  }
  void runSingleThread(payload);
}, { once: true });

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

async function runSingleThread(payload) {
  const tid = payload?.tid ?? null;
  try {
    await __runRomWeaverBrowserWasiThread(payload);
    self.postMessage({ type: 'done', tid });
  } catch (error) {
    self.postMessage({
      type: 'error',
      tid,
      error: serializeError(error),
    });
  } finally {
    self.close();
  }
}

async function runPoolWorker(payload) {
  const control = new Int32Array(payload.controlBuffer);
  if (!(control.buffer instanceof SharedArrayBuffer) || control.length < THREAD_SLOT_LENGTH) {
    throw new Error('browser wasi thread pool worker missing shared control buffer');
  }
  self.postMessage({ type: 'ready' });

  while (true) {
    while (Atomics.load(control, THREAD_SLOT_STATE_INDEX) === THREAD_SLOT_STATE_IDLE) {
      Atomics.wait(control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_IDLE);
    }
    const state = Atomics.load(control, THREAD_SLOT_STATE_INDEX);
    if (state === THREAD_SLOT_STATE_SHUTDOWN) {
      self.close();
      return;
    }
    if (state === THREAD_SLOT_STATE_FAILED) {
      Atomics.wait(control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_FAILED, 100);
      continue;
    }
    if (state !== THREAD_SLOT_STATE_REQUESTED) continue;

    const tid = Atomics.load(control, THREAD_SLOT_TID_INDEX) | 0;
    const startArg = Atomics.load(control, THREAD_SLOT_START_ARG_INDEX) | 0;
    Atomics.store(control, THREAD_SLOT_ERROR_INDEX, 0);
    signalThreadState(control, THREAD_SLOT_STATE_STARTING);
    try {
      await __runRomWeaverBrowserWasiThread({
        ...payload,
        startArg,
        startControlBuffer: control.buffer,
        tid,
      });
      Atomics.store(control, THREAD_SLOT_ERROR_INDEX, 0);
      signalThreadState(control, THREAD_SLOT_STATE_IDLE);
    } catch (error) {
      Atomics.store(control, THREAD_SLOT_ERROR_INDEX, 1);
      signalThreadState(control, THREAD_SLOT_STATE_FAILED);
      self.postMessage({
        type: 'error',
        tid,
        error: serializeError(error),
      });
    }
  }
}

function signalThreadState(control, state) {
  Atomics.store(control, THREAD_SLOT_STATE_INDEX, state);
  Atomics.notify(control, THREAD_SLOT_STATE_INDEX, 1);
}

function serializeError(error) {
  return {
    name: error && typeof error.name === 'string' ? error.name : 'Error',
    message: error && typeof error.message === 'string' ? error.message : String(error),
    stack: error && typeof error.stack === 'string' ? error.stack : undefined,
  };
}
