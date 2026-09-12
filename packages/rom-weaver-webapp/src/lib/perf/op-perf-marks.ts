// Page-wide timing markers cover warmup, drop-to-first-progress, and final-progress-to-next-frame latency.
// Correlation uses event order, so overlapping operations do not receive separate attribution.

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
// Suppress user-op marks while warmup drives the same runtime chokepoints.
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
 * Approximate result display latency at the next animation-frame callback after a terminal render.
 * The callback runs before paint and is not a measurement of completed screen rendering.
 */
export const markResultPaintedAfterFinish = (): void => {
  if (!(perf && afterFinishArmed)) return;
  afterFinishArmed = false;
  nextFrame(() => measureSince(MEASURE_AFTER_FINISH, MARK_WASM_FINISHED));
};
