// User Timing instrumentation for the user-perceived latency around an operation. These land on the
// main-thread performance timeline, so they show up both in `performance.getEntriesByType("measure")`
// and in the DevTools Performance panel "Timings" track:
//
//   romweaver:warmup       - page-load warmup extraction: start → done.
//   romweaver:before-start - a drop/file-selection begins → the FIRST progress event from wasm. This is
//                            the dead time the user waits after dropping before the operation visibly
//                            starts working (JS staging + input prep + runner/proxy spawn + wasm boot).
//   romweaver:after-finish - wasm reports the run finished → the result is painted in the UI. This is
//                            the dead time the user waits for the info to appear after the work is
//                            already done (JS result post-processing + React render + paint).
//
// Correlation is time-ordered: the workflow state machine runs one user operation at a time, so the most
// recent drop / wasm-finished mark is the active one. Concurrent operations would interleave their marks,
// but the common flows (ROM load, apply, create, trim) are sequential. A multi-step user action (e.g. a
// ROM load = extract + checksum) measures before-start against the FIRST wasm progress and after-finish
// against the LAST wasm finish (the after-finish measure is taken only on the terminal "done" render).

const perf =
  typeof performance !== "undefined" &&
  typeof performance.mark === "function" &&
  typeof performance.measure === "function"
    ? performance
    : null;

const MARK_WARMUP_START = "romweaver:warmup:start";
const MARK_DROP = "romweaver:op:drop";
const MARK_WASM_FINISHED = "romweaver:op:wasm-finished";

const MEASURE_WARMUP = "romweaver:warmup";
const MEASURE_BEFORE_START = "romweaver:before-start";
const MEASURE_AFTER_FINISH = "romweaver:after-finish";

let beforeStartArmed = false;
let afterFinishArmed = false;
// True while the silent page-load warmup runs. The warmup drives a real wasm extract through the same
// runtime chokepoints, so its progress/finish marks must NOT be mistaken for a user operation (otherwise
// it arms a bogus after-finish that a much-later user render closes against the warmup's finish).
let warmupActive = false;

const mark = (name: string): void => {
  try {
    perf?.mark(name);
  } catch {
    // Performance marks are best-effort; instrumentation must never break a run.
  }
};

const measureSince = (name: string, startMark: string): void => {
  try {
    // The two-arg form measures from `startMark` to now.
    perf?.measure(name, startMark);
  } catch {
    // Ignore (e.g. the start mark was never recorded); instrumentation must not throw.
  }
};

const nextFrame = (callback: () => void): void => {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => callback());
    return;
  }
  setTimeout(callback, 0);
};

/** Page-load warmup extraction started: emit `romweaver:warmup` start and suppress user-op marks. */
export const markWarmupStart = (): void => {
  warmupActive = true;
  if (perf) mark(MARK_WARMUP_START);
};

/** Page-load warmup extraction finished → emit `romweaver:warmup`. */
export const markWarmupDone = (): void => {
  if (perf) measureSince(MEASURE_WARMUP, MARK_WARMUP_START);
};

/** The whole warmup routine (extract + runner recycle) is done; resume user-op instrumentation. */
export const markWarmupEnd = (): void => {
  warmupActive = false;
};

/** A drop / file-picker selection began: opens the before-start window. */
export const markDropReceived = (): void => {
  if (!perf) return;
  mark(MARK_DROP);
  beforeStartArmed = true;
};

/** First live progress event from wasm arrived: closes the before-start window (once per drop). */
export const markWasmFirstProgress = (): void => {
  if (!(perf && beforeStartArmed) || warmupActive) return;
  beforeStartArmed = false;
  measureSince(MEASURE_BEFORE_START, MARK_DROP);
};

/** Wasm reported the run finished: opens (or re-opens, for multi-step actions) the after-finish window. */
export const markWasmFinished = (): void => {
  if (!perf || warmupActive) return;
  mark(MARK_WASM_FINISHED);
  afterFinishArmed = true;
};

/**
 * Called from the always-mounted status strip on the terminal "done" render - the commit that shows the
 * result. Schedules the measure on the next animation frame so it captures the paint, then disarms until
 * the next wasm finish. Intermediate (still-running) renders of a multi-step action do not call this, so
 * the measure spans the LAST wasm finish → the paint that reveals the result.
 */
export const markResultPaintedAfterFinish = (): void => {
  if (!(perf && afterFinishArmed)) return;
  afterFinishArmed = false;
  nextFrame(() => measureSince(MEASURE_AFTER_FINISH, MARK_WASM_FINISHED));
};
