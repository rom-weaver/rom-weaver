/**
 * This diagnostic grows shared WASM memory and writes one byte per 64 KiB WASM page.
 * A saved running record identifies an interrupted run, not its cause or an exact device memory limit.
 */

import type { BrowserFormatMatrixStep, BrowserFormatMatrixSummary } from "./browser-format-matrix.ts";

const WASM_PAGE_BYTES = 64 * 1024;
const MIB = 1024 * 1024;
const PAGES_PER_MIB = MIB / WASM_PAGE_BYTES;

const STORAGE_KEY = "rom-weaver.memory-growth-probe";
const DEFAULT_TARGET_MIB = 2048;
const DEFAULT_STEP_MIB = 32;
// Bound step sizes so the probe makes progress without skipping large ranges between observations.
const MIN_STEP_MIB = 8;
const MAX_STEP_MIB = 128;
// Give the page time to paint and the browser time to persist progress before another allocation.
// This delay does not guarantee that localStorage reaches disk before an interruption.
const SETTLE_MS = 150;

type GrowthRecord = {
  committedMib: number;
  startedAt: string;
  status: "completed" | "refused" | "running";
  stepMib: number;
  targetMib: number;
  userAgent: string;
};

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

const readNumberParam = (name: string, fallback: number): number => {
  const raw = new URLSearchParams(location.search).get(name);
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const storage = (): Storage | null => {
  try {
    // Private-mode WebKit throws on access rather than returning null.
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

const readRecord = (): GrowthRecord | null => {
  const raw = storage()?.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GrowthRecord;
  } catch {
    return null;
  }
};

/**
 * Save the last completed step before attempting another allocation.
 * Storage can fail or lose recent writes, so a recovered value is only a lower bound on completed work.
 */
const writeRecord = (record: GrowthRecord): void => {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // A full or unavailable store must not abort the measurement; the live steps still report.
  }
};

const clearRecord = (): void => {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do - a stale record only costs one duplicated report line on the next run.
  }
};

/**
 * Touch each new WASM page so the probe exercises writes as well as address-space growth.
 * One write per 64 KiB does not measure total physical memory committed by the engine or OS.
 */
const commitRegion = (memory: WebAssembly.Memory, fromPages: number, toPages: number): void => {
  // Re-read the buffer after every grow: engines hand back a new SharedArrayBuffer object for the
  // enlarged memory, and a stale view would only ever touch the original region.
  const bytes = new Uint8Array(memory.buffer);
  for (let page = fromPages; page < toPages; page += 1) {
    bytes[page * WASM_PAGE_BYTES] = 1;
  }
};

const yieldToPage = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

const describePreviousRun = (previous: GrowthRecord): BrowserFormatMatrixStep => {
  const died = previous.status === "running";
  return {
    command: `grown=${previous.committedMib} MiB target=${previous.targetMib} MiB step=${previous.stepMib} MiB started=${previous.startedAt}`,
    durationMs: 0,
    name: died ? "previous run: interrupted before completion" : `previous run: ${previous.status}`,
    status: died ? "failed" : "succeeded",
    timestamp: new Date().toISOString(),
    ...(died
      ? {
          error: `last saved progress was ${previous.committedMib} MiB; the record does not identify the interruption cause`,
        }
      : {}),
  };
};

/**
 * Read the previous result at page startup without starting another memory allocation run.
 * Reading preserves the record; the next probe run clears it.
 */
export function getInterruptedMemoryGrowthRun(): BrowserFormatMatrixStep | null {
  const previous = readRecord();
  return previous ? describePreviousRun(previous) : null;
}

/**
 * Report a saved result, including a run interrupted before its final status was written.
 */
const reportPreviousRun = (addStep: (step: BrowserFormatMatrixStep) => void): void => {
  const previous = readRecord();
  if (previous) addStep(describePreviousRun(previous));
};

export async function runBrowserMemoryGrowthProbe(callbacks: {
  onStep: (step: BrowserFormatMatrixStep) => void;
}): Promise<BrowserFormatMatrixSummary> {
  const steps: BrowserFormatMatrixStep[] = [];
  const addStep = (step: BrowserFormatMatrixStep) => {
    steps.push(step);
    callbacks.onStep(step);
  };
  const startedAt = performance.now();

  reportPreviousRun(addStep);
  clearRecord();

  const targetMib = readNumberParam("growthTargetMib", DEFAULT_TARGET_MIB);
  const stepMib = clamp(readNumberParam("growthStepMib", DEFAULT_STEP_MIB), MIN_STEP_MIB, MAX_STEP_MIB);
  const targetPages = targetMib * PAGES_PER_MIB;
  const stepPages = stepMib * PAGES_PER_MIB;

  const record: GrowthRecord = {
    committedMib: 0,
    startedAt: new Date().toISOString(),
    status: "running",
    stepMib,
    targetMib,
    userAgent: navigator.userAgent,
  };
  writeRecord(record);

  addStep({
    command: `target=${targetMib} MiB step=${stepMib} MiB (writing one byte per 64 KiB WASM page)`,
    durationMs: 0,
    name: "growth probe start",
    status: "succeeded",
    timestamp: new Date().toISOString(),
  });

  let memory: WebAssembly.Memory;
  try {
    memory = new WebAssembly.Memory({ initial: 0, maximum: targetPages, shared: true });
  } catch (error) {
    addStep({
      command: `maximum=${targetPages} pages`,
      durationMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      name: "could not reserve the growth target",
      status: "failed",
      timestamp: new Date().toISOString(),
    });
    record.status = "refused";
    writeRecord(record);
    return summarize(steps, startedAt);
  }

  let committedPages = 0;
  while (committedPages < targetPages) {
    const nextPages = Math.min(committedPages + stepPages, targetPages);
    const stepStartedAt = performance.now();
    try {
      memory.grow(nextPages - committedPages);
      commitRegion(memory, committedPages, nextPages);
    } catch (error) {
      addStep({
        command: `refused growing past ${committedPages / PAGES_PER_MIB} MiB`,
        durationMs: performance.now() - stepStartedAt,
        error: error instanceof Error ? error.message : String(error),
        name: "engine refused further growth",
        status: "failed",
        timestamp: new Date().toISOString(),
      });
      record.status = "refused";
      writeRecord(record);
      break;
    }
    committedPages = nextPages;
    record.committedMib = committedPages / PAGES_PER_MIB;
    // Save completed progress before the next allocation can interrupt the run.
    writeRecord(record);
    addStep({
      command: `grew to ${record.committedMib} MiB and touched each WASM page`,
      durationMs: performance.now() - stepStartedAt,
      name: `grow ${record.committedMib} MiB`,
      status: "succeeded",
      timestamp: new Date().toISOString(),
    });
    // Allow the page to paint and the browser to persist progress between allocation steps.
    await yieldToPage();
  }

  if (record.status === "running") {
    record.status = "completed";
    writeRecord(record);
  }

  addStep({
    command: `grown=${record.committedMib} MiB of ${targetMib} MiB target (status ${record.status})`,
    durationMs: 0,
    name:
      record.status === "completed"
        ? `result: reached ${targetMib} MiB and touched each WASM page`
        : `result: growth stopped after ${record.committedMib} MiB in this run`,
    status: "succeeded",
    timestamp: new Date().toISOString(),
  });

  return summarize(steps, startedAt);
}

function summarize(steps: BrowserFormatMatrixStep[], startedAt: number): BrowserFormatMatrixSummary {
  return {
    durationMs: performance.now() - startedAt,
    failedSteps: steps.filter((step) => step.status === "failed").length,
    passedSteps: steps.filter((step) => step.status === "succeeded").length,
    steps,
  };
}
