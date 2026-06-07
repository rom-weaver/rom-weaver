// WASI thread-start handshake — the "start barrier" that serializes wasi.thread-spawn so concurrent
// memory.grow calls (from per-thread stack allocation) cannot race V8's shared-memory size
// propagation and trip an out-of-bounds hang. The requester publishes one spawn request on a
// pooled worker's control word and blocks here until the worker acknowledges it has started; only
// then may the next spawn proceed. See docs/browser-concurrency.md for the full protocol and the
// state-transition table, and rom-weaver-browser-opfs-api.ts / workers/browser-wasi-thread-worker.ts
// for the requester and worker halves.
//
// This module holds the wire constants and the leaf Atomics helpers so the protocol is defined in
// one place and is unit-testable without spinning up real worker threads.

// --- WASI errnos returned to the wasm thread-spawn import ----------------------------------------

export const WASI_ERRNO_AGAIN = 6;
export const WASI_ERRNO_ENOSYS = 52;

// --- Atomics wait tuning (internal to this module) -----------------------------------------------

const ATOMICS_WAIT_SLICE_MS = 100;
const ATOMICS_WAIT_TIMEOUT_MS = 8000;
const THREAD_START_ACK_TIMEOUT_MS = ATOMICS_WAIT_TIMEOUT_MS;

// --- Thread-id allocation (shared monotonic counter) ---------------------------------------------

export const MAX_WASI_THREAD_ID = 0x1fffffff;
export const THREAD_ID_COUNTER_INDEX = 0;
// The counter is post-incremented (Atomics.add returns the prior value), so the first allocated tid
// is THREAD_ID_COUNTER_INITIAL itself; lower ids are reserved for the main/runner thread.
export const THREAD_ID_COUNTER_INITIAL = 43;

// --- Per-slot control word (Int32Array over the slot's startControlBuffer) ------------------------

export const THREAD_SLOT_STATE_INDEX = 0;
export const THREAD_SLOT_TID_INDEX = 1;
export const THREAD_SLOT_START_ARG_INDEX = 2;
export const THREAD_SLOT_ERROR_INDEX = 3;
export const THREAD_SLOT_LENGTH = 4;

// --- Slot states (stored at THREAD_SLOT_STATE_INDEX; value 4 intentionally unused) ---------------

export const THREAD_SLOT_STATE_IDLE = 0;
export const THREAD_SLOT_STATE_REQUESTED = 1;
export const THREAD_SLOT_STATE_STARTING = 2;
export const THREAD_SLOT_STATE_RUNNING = 3;
export const THREAD_SLOT_STATE_FAILED = 5;
export const THREAD_SLOT_STATE_SHUTDOWN = 6;

export type ThreadStartControl = Int32Array<SharedArrayBuffer>;
export type AtomicsWaitResult = 'ok' | 'not-equal' | 'timed-out';

export type WaitForAtomicsStateChangeOptions = {
  deadline?: number;
  sliceMs?: number;
};

/** Creates the shared monotonic thread-id counter (one Int32 in a SharedArrayBuffer). */
export function createThreadIdState(): ThreadStartControl {
  const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  state[THREAD_ID_COUNTER_INDEX] = THREAD_ID_COUNTER_INITIAL;
  return state;
}

/**
 * Atomically allocates the next wasi thread id. Returns a positive tid, or a negative WASI errno
 * (-ENOSYS for a malformed/non-shared counter, -EAGAIN once the id space is exhausted).
 */
export function allocateThreadId(threadIdState: unknown): number {
  if (!(threadIdState instanceof Int32Array) || threadIdState.length <= THREAD_ID_COUNTER_INDEX) {
    return -WASI_ERRNO_ENOSYS;
  }
  if (!(threadIdState.buffer instanceof SharedArrayBuffer)) {
    return -WASI_ERRNO_ENOSYS;
  }
  const tid = Atomics.add(threadIdState, THREAD_ID_COUNTER_INDEX, 1);
  if (tid <= 0 || tid > MAX_WASI_THREAD_ID) {
    return -WASI_ERRNO_AGAIN;
  }
  return tid;
}

/** Views a slot's control buffer as an Int32Array, or null if it is missing/too small/non-shared. */
export function threadStartControlFromBuffer(controlBuffer: unknown): ThreadStartControl | null {
  if (!(controlBuffer instanceof SharedArrayBuffer)) return null;
  const control = new Int32Array(controlBuffer);
  if (control.length < THREAD_SLOT_LENGTH) return null;
  return control;
}

/** Publishes a new slot state and wakes the peer blocked on the state word. */
export function signalThreadStartState(control: unknown, state: number): void {
  if (!(control instanceof Int32Array) || control.length < THREAD_SLOT_LENGTH) return;
  Atomics.store(control, THREAD_SLOT_STATE_INDEX, state);
  Atomics.notify(control, THREAD_SLOT_STATE_INDEX, 1);
}

/** Absolute deadline (ms, wall clock) timeoutMs from now. */
export function createWaitDeadline(timeoutMs: unknown): number {
  return Date.now() + Math.max(0, Number(timeoutMs) || 0);
}

/**
 * Blocks on Atomics.wait until control[index] leaves expectedState. With a deadline it polls in
 * sliceMs slices and returns 'timed-out' when the deadline passes; without one it does a single
 * bounded wait. Returns the underlying Atomics.wait result ('ok' / 'not-equal') otherwise.
 */
export function waitForAtomicsStateChange(
  control: ThreadStartControl,
  index: number,
  expectedState: number,
  options: WaitForAtomicsStateChangeOptions = {},
): AtomicsWaitResult {
  const {
    deadline,
    sliceMs = ATOMICS_WAIT_SLICE_MS,
  } = options;
  const slice = Math.max(1, Number(sliceMs) || ATOMICS_WAIT_SLICE_MS);
  if (typeof deadline === 'number') {
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return 'timed-out';
      const result = Atomics.wait(control, index, expectedState, Math.min(remainingMs, slice));
      if (result !== 'timed-out') return result;
      if (remainingMs <= slice) return 'timed-out';
    }
  }
  return Atomics.wait(control, index, expectedState, slice);
}

/**
 * The start barrier: blocks the requester until the spawned worker acknowledges start. Returns null
 * once the worker reaches RUNNING (or IDLE, if it already completed), or an Error if it FAILED, was
 * SHUTDOWN, entered an unexpected state, or did not ack within THREAD_START_ACK_TIMEOUT_MS.
 */
export function waitForThreadStartAck(control: ThreadStartControl, tid: unknown): Error | null {
  const deadline = createWaitDeadline(THREAD_START_ACK_TIMEOUT_MS);
  while (true) {
    const state = Atomics.load(control, THREAD_SLOT_STATE_INDEX);
    if (state === THREAD_SLOT_STATE_RUNNING || state === THREAD_SLOT_STATE_IDLE) return null;
    if (state === THREAD_SLOT_STATE_FAILED) {
      return new Error(`wasi thread ${tid} failed before start acknowledgement`);
    }
    if (state === THREAD_SLOT_STATE_SHUTDOWN) {
      return new Error(`wasi thread ${tid} was shut down before start acknowledgement`);
    }
    if (state === THREAD_SLOT_STATE_STARTING) {
      const waitResult = waitForAtomicsStateChange(
        control,
        THREAD_SLOT_STATE_INDEX,
        THREAD_SLOT_STATE_STARTING,
        { deadline },
      );
      if (waitResult === 'timed-out') {
        return new Error(`wasi thread ${tid} start acknowledgement timed out`);
      }
      continue;
    }
    if (state !== THREAD_SLOT_STATE_REQUESTED) {
      return new Error(`wasi thread ${tid} entered unexpected start state ${state}`);
    }
    const waitResult = waitForAtomicsStateChange(
      control,
      THREAD_SLOT_STATE_INDEX,
      THREAD_SLOT_STATE_REQUESTED,
      { deadline },
    );
    if (waitResult === 'timed-out') {
      return new Error(`wasi thread ${tid} start acknowledgement timed out`);
    }
  }
}
