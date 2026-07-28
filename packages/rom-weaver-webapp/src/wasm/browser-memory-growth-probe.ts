/**
 * On-device probe for how much shared wasm memory an engine will actually COMMIT.
 *
 * The companion reservation probe (`browser-shared-memory-probe.ts`) showed iOS granting the full
 * 4 GiB `maximum` without stepping down the ladder, which contradicts the rationale the Apple-only
 * cap rests on. But reservation is not the failure mode: iOS jetsam kills a tab over *committed*
 * pages, so an engine can hand out a 4 GiB address range and still kill the page at 800 MiB of real
 * memory. Reserving proves nothing about that.
 *
 * This probe grows a shared memory in steps and touches one byte per page of each new region, which
 * forces the engine to back it with physical memory. The number it reports is the one that matters
 * for sizing runners.
 *
 * Growing until the engine gives out is expected to sometimes kill the tab - that IS the
 * measurement. So every step is written to localStorage synchronously before the next one is
 * attempted, and a record still marked `running` on the next page load is reported as the point the
 * device died. A probe that only reported on clean completion would lose exactly the data points it
 * exists to collect.
 *
 * `?growthTargetMib=` and `?growthStepMib=` override the bounds.
 */

import type { BrowserFormatMatrixStep, BrowserFormatMatrixSummary } from "./browser-format-matrix.ts";

const WASM_PAGE_BYTES = 64 * 1024;
const MIB = 1024 * 1024;
const PAGES_PER_MIB = MIB / WASM_PAGE_BYTES;

const STORAGE_KEY = "rom-weaver.memory-growth-probe";
const DEFAULT_TARGET_MIB = 2048;
const DEFAULT_STEP_MIB = 32;
// Below this a step is pointless; above it a single step can take the device out before the previous
// result is durable.
const MIN_STEP_MIB = 8;
const MAX_STEP_MIB = 128;
// Pause after each durability write so WebKit has a window to flush localStorage to disk before the
// next step risks the tab. A zero timeout yields to the event loop but not to the flush.
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
 * Persist progress before the step that might kill the tab.
 *
 * The `setItem` call is synchronous but the flush to disk is NOT - WebKit batches it - so a jetsam
 * kill can still drop the most recent write. That is why the loop waits {@link SETTLE_MS} after each
 * write instead of yielding with a zero timeout: it trades a little wall clock for the flush window.
 * Treat a recovered figure as a lower bound, accurate to within one step.
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
 * Force the engine to back the newly grown region with real pages. `grow` alone can be satisfied
 * with address space on some engines, which is the exact distinction this probe exists to draw.
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
    command: `committed=${previous.committedMib} MiB target=${previous.targetMib} MiB step=${previous.stepMib} MiB started=${previous.startedAt}`,
    durationMs: 0,
    name: died ? "previous run: DEVICE DIED mid-probe" : `previous run: ${previous.status}`,
    status: died ? "failed" : "succeeded",
    timestamp: new Date().toISOString(),
    ...(died
      ? { error: `the tab was killed after committing ${previous.committedMib} MiB; that is the device's real ceiling` }
      : {}),
  };
};

/**
 * Surface a record left behind by a previous load, for the page to render at startup.
 *
 * This has to run on load rather than only inside the probe: the run that gets killed is exactly the
 * run that never reports, and requiring the user to start another (also-killed) run to see the last
 * result loses the measurement every time. Mirrors `getInterruptedArchiveStressCase`.
 *
 * Non-destructive - the record is cleared when the next run starts, so reloading repeatedly keeps
 * showing the same result instead of erasing it on first read.
 */
export function getInterruptedMemoryGrowthRun(): BrowserFormatMatrixStep | null {
  const previous = readRecord();
  return previous ? describePreviousRun(previous) : null;
}

/** Report a record left `running` by a previous load - the device died mid-run. */
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
    command: `target=${targetMib} MiB step=${stepMib} MiB (writing one byte per page to force commit)`,
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
    // Durable BEFORE the next step, so a kill leaves the last good value behind.
    writeRecord(record);
    addStep({
      command: `committed ${record.committedMib} MiB`,
      durationMs: performance.now() - stepStartedAt,
      name: `commit ${record.committedMib} MiB`,
      status: "succeeded",
      timestamp: new Date().toISOString(),
    });
    // Let the page paint and the write reach disk; a tight loop can be killed before either happens.
    await yieldToPage();
  }

  if (record.status === "running") {
    record.status = "completed";
    writeRecord(record);
  }

  addStep({
    command: `committed=${record.committedMib} MiB of ${targetMib} MiB target (status ${record.status})`,
    durationMs: 0,
    name:
      record.status === "completed"
        ? `verdict: committed the full ${targetMib} MiB without refusal`
        : `verdict: device ceiling is ${record.committedMib} MiB of committed shared memory`,
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
