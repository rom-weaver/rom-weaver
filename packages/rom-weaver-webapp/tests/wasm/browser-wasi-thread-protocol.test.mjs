import { describe, expect, it } from "vitest";
import {
  allocateThreadId,
  createThreadIdState,
  createWaitDeadline,
  MAX_WASI_THREAD_ID,
  signalThreadStartState,
  THREAD_ID_COUNTER_INDEX,
  THREAD_ID_COUNTER_INITIAL,
  THREAD_SLOT_LENGTH,
  THREAD_SLOT_STATE_FAILED,
  THREAD_SLOT_STATE_IDLE,
  THREAD_SLOT_STATE_INDEX,
  THREAD_SLOT_STATE_RUNNING,
  THREAD_SLOT_STATE_SHUTDOWN,
  threadStartControlFromBuffer,
  WASI_ERRNO_AGAIN,
  WASI_ERRNO_ENOSYS,
  waitForAtomicsStateChange,
  waitForThreadStartAck,
} from "@rom-weaver/wasm/browser-wasi-thread-protocol";

// Unit coverage for the WASI thread-start protocol helpers (see docs/browser-concurrency.md). These
// run on the browser main thread, so they only exercise paths that do NOT call Atomics.wait (which
// throws on a thread that cannot block). The blocking ack/poll loops are covered end-to-end by
// browser-worker-client.test.mjs against the real threaded wasm module.

describe("thread-id allocation", () => {
  it("seeds the shared counter and hands out strictly increasing ids", () => {
    const state = createThreadIdState();
    expect(state).toBeInstanceOf(Int32Array);
    expect(state.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(Atomics.load(state, THREAD_ID_COUNTER_INDEX)).toBe(THREAD_ID_COUNTER_INITIAL);

    // The counter is post-incremented, so the first tid is the initial seed value itself.
    const first = allocateThreadId(state);
    const second = allocateThreadId(state);
    expect(first).toBe(THREAD_ID_COUNTER_INITIAL);
    expect(second).toBe(first + 1);
    expect(second).toBeGreaterThan(0);
  });

  it("returns -ENOSYS for a malformed or non-shared counter", () => {
    expect(allocateThreadId(null)).toBe(-WASI_ERRNO_ENOSYS);
    expect(allocateThreadId([])).toBe(-WASI_ERRNO_ENOSYS);
    // Int32Array backed by a non-shared ArrayBuffer is not usable for cross-thread allocation.
    expect(allocateThreadId(new Int32Array(1))).toBe(-WASI_ERRNO_ENOSYS);
  });

  it("returns -EAGAIN once the id space is exhausted", () => {
    const state = createThreadIdState();
    Atomics.store(state, THREAD_ID_COUNTER_INDEX, MAX_WASI_THREAD_ID + 1);
    expect(allocateThreadId(state)).toBe(-WASI_ERRNO_AGAIN);
  });
});

describe("control-buffer helpers", () => {
  it("views a valid shared control buffer and rejects bad ones", () => {
    const control = threadStartControlFromBuffer(
      new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * THREAD_SLOT_LENGTH),
    );
    expect(control).toBeInstanceOf(Int32Array);
    expect(control.length).toBe(THREAD_SLOT_LENGTH);

    expect(threadStartControlFromBuffer(new ArrayBuffer(16))).toBeNull();
    // Too small to hold a full slot.
    expect(threadStartControlFromBuffer(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))).toBeNull();
  });

  it("signalThreadStartState stores the state word and ignores undersized buffers", () => {
    const control = threadStartControlFromBuffer(
      new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * THREAD_SLOT_LENGTH),
    );
    signalThreadStartState(control, THREAD_SLOT_STATE_RUNNING);
    expect(Atomics.load(control, THREAD_SLOT_STATE_INDEX)).toBe(THREAD_SLOT_STATE_RUNNING);
    // No throw on a too-small control word.
    expect(() => signalThreadStartState(new Int32Array(1), THREAD_SLOT_STATE_RUNNING)).not.toThrow();
  });
});

describe("createWaitDeadline", () => {
  it("produces a non-decreasing absolute deadline", () => {
    const before = Date.now();
    const deadline = createWaitDeadline(1000);
    expect(deadline).toBeGreaterThanOrEqual(before + 1000);
  });

  it("floors negative/garbage timeouts to now", () => {
    const before = Date.now();
    expect(createWaitDeadline(-5)).toBeGreaterThanOrEqual(before);
    expect(createWaitDeadline("nope")).toBeGreaterThanOrEqual(before);
  });
});

describe("waitForAtomicsStateChange (non-blocking branch)", () => {
  it("returns timed-out when the deadline has already passed (no Atomics.wait)", () => {
    const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * THREAD_SLOT_LENGTH));
    const result = waitForAtomicsStateChange(control, THREAD_SLOT_STATE_INDEX, 0, {
      deadline: Date.now() - 1,
    });
    expect(result).toBe("timed-out");
  });
});

describe("waitForThreadStartAck (immediate states)", () => {
  const controlInState = (state) => {
    const control = threadStartControlFromBuffer(
      new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * THREAD_SLOT_LENGTH),
    );
    Atomics.store(control, THREAD_SLOT_STATE_INDEX, state);
    return control;
  };

  it("acks immediately when the worker is already RUNNING or IDLE", () => {
    expect(waitForThreadStartAck(controlInState(THREAD_SLOT_STATE_RUNNING), 7)).toBeNull();
    expect(waitForThreadStartAck(controlInState(THREAD_SLOT_STATE_IDLE), 7)).toBeNull();
  });

  it("returns an error for FAILED, SHUTDOWN, and unexpected states", () => {
    expect(waitForThreadStartAck(controlInState(THREAD_SLOT_STATE_FAILED), 7)).toBeInstanceOf(Error);
    expect(waitForThreadStartAck(controlInState(THREAD_SLOT_STATE_SHUTDOWN), 7)).toBeInstanceOf(Error);
    // 99 is not a defined state and is neither REQUESTED nor STARTING, so it resolves immediately.
    expect(waitForThreadStartAck(controlInState(99), 7)).toBeInstanceOf(Error);
  });
});
