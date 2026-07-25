/**
 * On-device thread-scaling DIAGNOSTIC harness - not part of the core wasm runtime.
 *
 * Runs the same compress + extract round trip once per explicit `--threads`
 * value across `BROWSER_THREAD_SWEEP_COUNTS` (1..16), asserting the round trip
 * stays byte-exact at every count and recording the thread telemetry the CLI
 * reports back (requested vs effective threads, mode, fallback reason). The
 * point is to find the count at which a device stops honouring the request or
 * starts corrupting output - Mobile Safari resolves `auto` to a small number,
 * so the interesting counts are the ones above it.
 *
 * The workload is a multi-entry archive of 1 MiB entries on purpose. Measured
 * on desktop Chromium:
 *   - `compress` sizes its pool to the request whatever the shape of the input.
 *   - `extract` splits per entry only once entries are large enough - at 256 KiB
 *     it stays at `effective_threads=1` for every request, at 1 MiB it tracks
 *     the request 1:1.
 *   - a single large entry pins BOTH commands to one thread (lzma2 over one
 *     48 MiB file reports 1 for every request).
 * The last shape is what a naive sweep would use, and it would pass with
 * threading completely broken - hence the entry count and size defaults here.
 *
 * Reachable from `mobile-safari-matrix.html` (profile `threads`). The app
 * itself never imports it.
 *
 * The payload is synthetic filler generated in-browser, not ROM data: 1 MiB
 * entries that are three-quarters smooth ramp and one-quarter PRNG noise,
 * zipped with deflate. The mix is what keeps entries big enough after
 * compression for extract to still split them.
 */
import { resolveAppleMobileSharedMemoryMaximumPages } from "../lib/runtime/op-memory-estimate.ts";
import type { BrowserFormatMatrixStep, BrowserFormatMatrixSummary } from "./browser-format-matrix.ts";
import {
  assert,
  assertBytesEqual,
  assertRunJsonSucceeded,
  joinGuestPath,
  OPFS_GUEST_ROOT,
  readGuestFile,
  removeFixtureDirectory,
  waitForGuestFile,
  writeGuestFile,
} from "./browser-matrix-guest-io.ts";
import { createRomWeaverCommand } from "./rom-weaver-command.ts";
import type { RomWeaverRunJsonEvent } from "./rom-weaver-types.d.ts";
import { createBrowserWorkerClient } from "./workers/browser-worker-client.ts";

/** Every thread count the sweep exercises, including the non-powers of two. */
const BROWSER_THREAD_SWEEP_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] as const;

// One entry per thread at the top of the sweep, so the highest count still has
// work for every thread it asked for.
const DEFAULT_ENTRY_COUNT = 16;

/**
 * Measured floor for `extract` to split work at all: at 256 KiB per entry it
 * reports `effective_threads=1` for every request (entry count makes no
 * difference), and at 1 MiB it tracks the request 1:1. `compress` sizes its
 * pool to the request either way, so this floor is what keeps both halves of
 * the round trip meaningful.
 */
const DEFAULT_ENTRY_BYTES = 1024 * 1024;
const DEFAULT_FORMAT = "zip";
const DEFAULT_CODEC = "deflate";

const entryFileName = (index: number) => `thread-sweep-${String(index).padStart(2, "0")}.bin`;

/** Thread telemetry the CLI reported for one command at one requested count. */
type BrowserThreadSweepObservation = {
  command: "compress" | "extract";
  durationMs: number;
  effectiveThreads: number | null;
  requestedThreads: number | null;
  threadFallback: boolean | null;
  threadFallbackReason: string | null;
  threadMode: string | null;
  threads: number;
  usedParallelism: boolean | null;
};

export type BrowserThreadSweepSummary = BrowserFormatMatrixSummary & {
  entryCount: number;
  observations: BrowserThreadSweepObservation[];
};

export type BrowserThreadSweepOptions = {
  codec?: string;
  entryByteLength?: number;
  entryCount?: number;
  format?: string;
  onEvent?: (event: RomWeaverRunJsonEvent) => void;
  onStep?: (step: BrowserFormatMatrixStep) => void;
  prefix?: string;
  threadCounts?: readonly number[];
  wasmUrl?: string;
};

/**
 * Deterministic, mildly compressible filler. Pure pattern data collapses to
 * almost nothing, which shrinks the per-entry work until the thread split stops
 * being observable.
 */
const createEntryBytes = (byteLength: number, seed: number) => {
  const bytes = new Uint8Array(byteLength);
  let state = seed >>> 0;
  for (let index = 0; index < byteLength; index += 1) {
    state = (Math.imul(state ^ (state >>> 15), 0x85ebca6b) + index) >>> 0;
    bytes[index] = index % 64 < 48 ? index % 251 : state & 0xff;
  }
  return bytes;
};

const readThreadTelemetry = (
  event: RomWeaverRunJsonEvent,
  command: BrowserThreadSweepObservation["command"],
  threads: number,
  durationMs: number,
): BrowserThreadSweepObservation => ({
  command,
  durationMs,
  effectiveThreads: typeof event.effective_threads === "number" ? event.effective_threads : null,
  requestedThreads: typeof event.requested_threads === "number" ? event.requested_threads : null,
  threadFallback: typeof event.thread_fallback === "boolean" ? event.thread_fallback : null,
  threadFallbackReason: event.thread_fallback_reason ?? null,
  threadMode: event.thread_mode ?? null,
  threads,
  usedParallelism: typeof event.used_parallelism === "boolean" ? event.used_parallelism : null,
});

/**
 * Invariants every device must hold. Deliberately does NOT require the request
 * to be met in full - a device that caps the pool below the request is the
 * finding this sweep exists to surface, not an error to abort on. Callers that
 * run on hardware known to have the cores enforce the 1:1 match themselves (the
 * CI test does).
 */
const assertThreadTelemetry = (observation: BrowserThreadSweepObservation) => {
  const context = `${observation.command} threads=${observation.threads}`;
  assert(
    observation.requestedThreads === observation.threads,
    `${context}: requested_threads should echo the request, got ${observation.requestedThreads}`,
  );
  assert(
    observation.effectiveThreads !== null && observation.effectiveThreads >= 1,
    `${context}: effective_threads should be at least 1, got ${observation.effectiveThreads}`,
  );
  assert(
    observation.effectiveThreads <= observation.threads,
    `${context}: effective_threads ${observation.effectiveThreads} should not exceed the ${observation.threads} requested`,
  );
  // A silent downgrade is the failure this sweep exists to catch, so a fallback
  // has to say why.
  if (observation.threadFallback === true) {
    assert(
      typeof observation.threadFallbackReason === "string" && observation.threadFallbackReason.length > 0,
      `${context}: thread_fallback was reported without a thread_fallback_reason`,
    );
  }
};

export async function runBrowserThreadSweep(
  options: BrowserThreadSweepOptions = {},
): Promise<BrowserThreadSweepSummary> {
  const threadCounts = options.threadCounts ?? BROWSER_THREAD_SWEEP_COUNTS;
  const format = options.format ?? DEFAULT_FORMAT;
  const codec = options.codec ?? DEFAULT_CODEC;
  const entryCount = options.entryCount ?? DEFAULT_ENTRY_COUNT;
  const entryByteLength = options.entryByteLength ?? DEFAULT_ENTRY_BYTES;
  const wasmUrl = options.wasmUrl || new URL("./rom-weaver-app.wasm", import.meta.url).href;
  const sharedMemoryMaximumPages = resolveAppleMobileSharedMemoryMaximumPages();

  assert(entryCount >= 1, `entryCount must be at least 1, got ${entryCount}`);

  const root = await navigator.storage.getDirectory();
  const fixtureName = `${options.prefix || "rom-weaver-thread-sweep-"}${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  await root.getDirectoryHandle(fixtureName, { create: true });
  const fixtureGuestRoot = joinGuestPath(OPFS_GUEST_ROOT, fixtureName);

  const steps: BrowserFormatMatrixStep[] = [];
  const observations: BrowserThreadSweepObservation[] = [];
  const startedAt = performance.now();

  const addStep = (step: BrowserFormatMatrixStep) => {
    steps.push(step);
    options.onStep?.(step);
  };

  try {
    const entries: Array<{ bytes: Uint8Array; fileName: string; path: string }> = [];
    for (let index = 0; index < entryCount; index += 1) {
      const fileName = entryFileName(index);
      const path = joinGuestPath(fixtureGuestRoot, "source", fileName);
      const bytes = createEntryBytes(entryByteLength, 0x9e3779b9 + index);
      await writeGuestFile(root, path, bytes);
      entries.push({ bytes, fileName, path });
    }
    const inputPaths = entries.map((entry) => entry.path);

    for (const threads of threadCounts) {
      const name = `threads-${threads}`;
      const stepStartedAt = performance.now();
      addStep({ command: `${format} round trip`, name, status: "running", timestamp: new Date().toISOString() });

      // A fresh worker per count keeps a pool sized for N from serving N+1.
      const worker = createBrowserWorkerClient({});
      try {
        await worker.init({
          runtimeMounts: [OPFS_GUEST_ROOT],
          ...(sharedMemoryMaximumPages ? { sharedMemoryMaximumPages } : {}),
          wasmUrl,
          workGuestPath: OPFS_GUEST_ROOT,
        });

        const runJson = async (command: ReturnType<typeof createRomWeaverCommand>) =>
          worker.runJson(command, {
            onEvent(event: RomWeaverRunJsonEvent) {
              options.onEvent?.(event);
            },
          });

        const archivePath = joinGuestPath(fixtureGuestRoot, `sweep-${threads}.${format}`);
        const compressStartedAt = performance.now();
        const compressResult = await runJson(
          createRomWeaverCommand("compress", {
            codec: [codec],
            format,
            input: inputPaths,
            output: archivePath,
            threads,
          }),
        );
        const compressTerminal = assertRunJsonSucceeded(compressResult, { command: "compress" });
        const compressObservation = readThreadTelemetry(
          compressTerminal,
          "compress",
          threads,
          Math.round(performance.now() - compressStartedAt),
        );
        assertThreadTelemetry(compressObservation);
        observations.push(compressObservation);
        await waitForGuestFile(root, archivePath, compressResult);

        const extractDir = joinGuestPath(fixtureGuestRoot, `sweep-${threads}-out`);
        const extractStartedAt = performance.now();
        const extractResult = await runJson(
          createRomWeaverCommand("extract", {
            input: archivePath,
            output: extractDir,
            threads,
          }),
        );
        const extractTerminal = assertRunJsonSucceeded(extractResult, { command: "extract" });
        const extractObservation = readThreadTelemetry(
          extractTerminal,
          "extract",
          threads,
          Math.round(performance.now() - extractStartedAt),
        );
        assertThreadTelemetry(extractObservation);
        observations.push(extractObservation);

        for (const entry of entries) {
          const extractedPath = joinGuestPath(extractDir, entry.fileName);
          await waitForGuestFile(root, extractedPath, extractResult);
          assertBytesEqual(
            await readGuestFile(root, extractedPath),
            entry.bytes,
            `threads=${threads}: ${entry.fileName} changed in the ${format} round trip`,
          );
        }

        addStep({
          command: `${format} round trip compress=${compressObservation.effectiveThreads}/${threads} extract=${extractObservation.effectiveThreads}/${threads}`,
          durationMs: Math.round(performance.now() - stepStartedAt),
          name,
          status: "succeeded",
          terminalStatus: extractTerminal.status,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        addStep({
          command: `${format} round trip`,
          durationMs: Math.round(performance.now() - stepStartedAt),
          error: error instanceof Error ? error.message : String(error),
          name,
          status: "failed",
          timestamp: new Date().toISOString(),
        });
        throw error;
      } finally {
        worker.terminate();
      }
    }
  } finally {
    await removeFixtureDirectory(root, fixtureName);
  }

  return {
    durationMs: Math.round(performance.now() - startedAt),
    entryCount,
    failedSteps: steps.filter((step) => step.status === "failed").length,
    observations,
    passedSteps: steps.filter((step) => step.status === "succeeded").length,
    steps,
  };
}
