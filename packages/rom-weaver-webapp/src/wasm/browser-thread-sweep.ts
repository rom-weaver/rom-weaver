/**
 * On-device thread-scaling DIAGNOSTIC harness - not part of the core wasm runtime.
 *
 * Sweeps every explicit `--threads` value from 1 to 16 across the container
 * formats that can be created (`zip`, `7z`, `chd`, `z3ds`, `rvz`) at two
 * payload sizes, running compress and then ingest at each combination. Records
 * the thread telemetry the CLI reports back and verifies the round trip stays
 * byte-exact. The point is to find where a device stops honouring the request
 * or starts corrupting output - Mobile Safari resolves `auto` to a small
 * number, so the interesting counts are the ones above it.
 *
 * Codecs are never passed: each format runs on its own default (`zip`/deflate,
 * `7z`/lzma2, `z3ds`/zstd, `rvz`/zstd, `chd`/medium-dependent).
 *
 * Thread counts are recorded PER STAGE, because no single number is the answer
 * and every attempt to pick one has been wrong:
 *   - The terminal event is not it. `compress` finishes on a summary stage and
 *     `ingest` on its orchestration stage, both of which report 1 while the
 *     real work ran threaded. Reading it makes 7z look pinned at 1 and every
 *     ingest cell look single-threaded.
 *   - The peak across stages is not it either. `extract:N` echoes the requested
 *     budget in every cell measured, so a peak always equals the request and
 *     could never show a collapse.
 * `stageThreads` therefore carries the whole breakdown (e.g.
 * `ingest:1 extract:16 extract-step:1`) and the reader decides. On desktop
 * Chromium `create` tracks the request for all five formats, while
 * `extract-step` is the one that varies: 1 for small zip/7z entries, 4 for
 * small z3ds, tracking the request once payloads are larger.
 *
 * Input shape is per format and load-bearing, measured on desktop Chromium:
 * archive formats get many entries so the read side has per-entry work to
 * spread, and the single-image formats (chd, z3ds, rvz) get one file because
 * that is the only shape they accept.
 *
 * `rvz` create rejects arbitrary bytes; it needs a GameCube disc header. The
 * synthesised image mirrors `build_test_gamecube_iso` in
 * `crates/rom-weaver-cli/tests/cli_smoke/shared.rs` - the GCN magic at 0x1C is
 * the only structure nod requires to open it.
 *
 * Reachable from `mobile-safari-matrix.html` (profile `threads`). The app
 * itself never imports it.
 */
import { resolveAppleMobileSharedMemoryMaximumPages } from "../lib/runtime/op-memory-estimate.ts";
import type { BrowserFormatMatrixStep, BrowserFormatMatrixSummary } from "./browser-format-matrix.ts";
import {
  assert,
  assertBytesEqual,
  assertRunJsonSucceeded,
  joinGuestPath,
  OPFS_GUEST_ROOT,
  pathBasename,
  readGuestFile,
  removeFixtureDirectory,
  waitForGuestFile,
  writeGuestFile,
} from "./browser-matrix-guest-io.ts";
import { createRomWeaverCommand } from "./rom-weaver-command.ts";
import type { RomWeaverRunJsonEvent } from "./rom-weaver-types.d.ts";
import { createBrowserWorkerClient } from "./workers/browser-worker-client.ts";

const BROWSER_THREAD_SWEEP_COUNTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] as const;

/** GameCube disc header offsets - see `nod/disc/mod.rs`. */
const GCN_MAGIC = [0xc2, 0x33, 0x9f, 0x3d] as const;
const GCN_MAGIC_OFFSET = 0x1c;
const GCN_HEADER_SIZE = 0x440;

/**
 * `entries` archives many files so ingest has per-entry work to spread;
 * `disc` is a single image, the only shape chd/z3ds/rvz accept.
 */
type ThreadSweepShape = "disc" | "entries";
type ThreadSweepSizeName = "medium" | "small";

type ThreadSweepFormat = {
  /** Entries per archive for `entries`, always 1 for `disc`. */
  entryCount: number;
  format: string;
  /** rvz needs a real disc header; the others take arbitrary bytes. */
  gameCubeHeader: boolean;
  name: string;
  shape: ThreadSweepShape;
  /** Payload bytes per entry, by size name. */
  sizes: Record<ThreadSweepSizeName, number>;
};

const KIB = 1024;
const MIB = 1024 * 1024;

// One entry per thread at the top of the sweep, so the highest count still has
// work for every thread it asked for. Entries stay at or above 1 MiB in the
// medium size because ingest declines to split anything smaller.
const THREAD_SWEEP_FORMATS: readonly ThreadSweepFormat[] = [
  {
    entryCount: 16,
    format: "zip",
    gameCubeHeader: false,
    name: "zip",
    shape: "entries",
    sizes: { medium: 4 * MIB, small: 256 * KIB },
  },
  {
    entryCount: 16,
    format: "7z",
    gameCubeHeader: false,
    name: "7z",
    shape: "entries",
    sizes: { medium: 4 * MIB, small: 256 * KIB },
  },
  {
    entryCount: 1,
    format: "chd",
    gameCubeHeader: false,
    name: "chd",
    shape: "disc",
    sizes: { medium: 64 * MIB, small: 4 * MIB },
  },
  {
    entryCount: 1,
    format: "z3ds",
    gameCubeHeader: false,
    name: "z3ds",
    shape: "disc",
    sizes: { medium: 64 * MIB, small: 4 * MIB },
  },
  {
    entryCount: 1,
    format: "rvz",
    gameCubeHeader: true,
    name: "rvz",
    shape: "disc",
    sizes: { medium: 64 * MIB, small: 4 * MIB },
  },
];

const THREAD_SWEEP_SIZE_NAMES: readonly ThreadSweepSizeName[] = ["small", "medium"];

/** Thread telemetry the CLI reported for one command in one cell of the matrix. */
type BrowserThreadSweepObservation = {
  command: "compress" | "ingest";
  durationMs: number;
  /**
   * Peak `effective_threads` across every stage. Tracks the request in every
   * cell measured so far - useful as an upper bound, NOT as evidence that the
   * threads were used. Read `stageThreads` for that.
   */
  effectiveThreads: number | null;
  entryCount: number;
  format: string;
  payloadBytes: number;
  requestedThreads: number | null;
  size: ThreadSweepSizeName;
  /** Peak effective threads per reporting stage, e.g. `ingest:1 extract:16`. */
  stageThreads: string;
  terminalEffectiveThreads: number | null;
  threadFallback: boolean | null;
  threadFallbackReason: string | null;
  threadMode: string | null;
  threads: number;
  usedParallelism: boolean | null;
};

export type BrowserThreadSweepSummary = BrowserFormatMatrixSummary & {
  observations: BrowserThreadSweepObservation[];
};

export type BrowserThreadSweepOptions = {
  formats?: readonly string[];
  onEvent?: (event: RomWeaverRunJsonEvent) => void;
  onStep?: (step: BrowserFormatMatrixStep) => void;
  prefix?: string;
  sizes?: readonly ThreadSweepSizeName[];
  threadCounts?: readonly number[];
  wasmUrl?: string;
};

/**
 * Deterministic, mildly compressible filler. Pure pattern data collapses to
 * almost nothing, which shrinks the per-entry work until the thread split stops
 * being observable.
 */
const createPayloadBytes = (byteLength: number, seed: number) => {
  const bytes = new Uint8Array(byteLength);
  let state = seed >>> 0;
  for (let index = 0; index < byteLength; index += 1) {
    state = (Math.imul(state ^ (state >>> 15), 0x85ebca6b) + index) >>> 0;
    bytes[index] = index % 64 < 48 ? index % 251 : state & 0xff;
  }
  return bytes;
};

/**
 * Minimal GameCube image nod will open: magic at 0x1C, payload after the
 * 0x440-byte header. Mirrors `build_test_gamecube_iso` in the Rust smoke tests.
 */
const createGameCubeIsoBytes = (payloadByteLength: number, seed: number) => {
  const bytes = new Uint8Array(GCN_HEADER_SIZE + payloadByteLength);
  bytes.set(createPayloadBytes(payloadByteLength, seed), GCN_HEADER_SIZE);
  bytes.set(new TextEncoder().encode("RWTEST"), 0);
  bytes.set(GCN_MAGIC, GCN_MAGIC_OFFSET);
  bytes.set(new TextEncoder().encode("rom-weaver-thread-sweep\0"), 0x20);
  return bytes;
};

/** Peak `effective_threads` per stage across a command's events. */
const summarizeStageThreads = (events: readonly RomWeaverRunJsonEvent[]) => {
  const peaks = new Map<string, number>();
  for (const event of events) {
    if (typeof event.effective_threads !== "number") continue;
    const stage = String(event.stage ?? "unknown");
    peaks.set(stage, Math.max(peaks.get(stage) ?? 0, event.effective_threads));
  }
  return peaks;
};

const readThreadTelemetry = (
  event: RomWeaverRunJsonEvent,
  events: readonly RomWeaverRunJsonEvent[],
  command: BrowserThreadSweepObservation["command"],
  cell: { entryCount: number; format: string; payloadBytes: number; size: ThreadSweepSizeName; threads: number },
  durationMs: number,
): BrowserThreadSweepObservation => {
  const stagePeaks = summarizeStageThreads(events);
  const peak = stagePeaks.size > 0 ? Math.max(...stagePeaks.values()) : null;
  return {
    command,
    durationMs,
    effectiveThreads: peak,
    entryCount: cell.entryCount,
    format: cell.format,
    payloadBytes: cell.payloadBytes,
    requestedThreads: typeof event.requested_threads === "number" ? event.requested_threads : null,
    size: cell.size,
    stageThreads: [...stagePeaks.entries()].map(([stage, value]) => `${stage}:${value}`).join(" "),
    terminalEffectiveThreads: typeof event.effective_threads === "number" ? event.effective_threads : null,
    threadFallback: typeof event.thread_fallback === "boolean" ? event.thread_fallback : null,
    threadFallbackReason: event.thread_fallback_reason ?? null,
    threadMode: event.thread_mode ?? null,
    threads: cell.threads,
    usedParallelism: typeof event.used_parallelism === "boolean" ? event.used_parallelism : null,
  };
};

/**
 * Invariants every device must hold. Deliberately does NOT require the request
 * to be met in full - a device that caps the pool below the request is the
 * finding this sweep exists to surface, not an error to abort on.
 */
const assertThreadTelemetry = (observation: BrowserThreadSweepObservation) => {
  const context = `${observation.format}/${observation.size} ${observation.command} threads=${observation.threads}`;
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

const asRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** `ingest` reports what it wrote as `details.ingest.assets[]`, not extract's `emitted_files`. */
const getIngestedPaths = (event: RomWeaverRunJsonEvent) => {
  const assets = asRecord(asRecord(event.details).ingest).assets;
  if (!Array.isArray(assets)) return [];
  return assets.map((asset) => String(asRecord(asset).path ?? "")).filter((path) => path.length > 0);
};

export async function runBrowserThreadSweep(
  options: BrowserThreadSweepOptions = {},
): Promise<BrowserThreadSweepSummary> {
  const threadCounts = options.threadCounts ?? BROWSER_THREAD_SWEEP_COUNTS;
  const sizes = options.sizes ?? THREAD_SWEEP_SIZE_NAMES;
  const formats = options.formats
    ? THREAD_SWEEP_FORMATS.filter((entry) => options.formats?.includes(entry.name))
    : THREAD_SWEEP_FORMATS;
  const wasmUrl = options.wasmUrl || new URL("./rom-weaver-app.wasm", import.meta.url).href;
  const sharedMemoryMaximumPages = resolveAppleMobileSharedMemoryMaximumPages();

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
    for (const formatCase of formats) {
      for (const size of sizes) {
        const payloadBytes = formatCase.sizes[size];
        const sourceDir = joinGuestPath(fixtureGuestRoot, `src-${formatCase.name}-${size}`);
        const entries: Array<{ bytes: Uint8Array; fileName: string; path: string }> = [];
        for (let index = 0; index < formatCase.entryCount; index += 1) {
          const fileName = formatCase.gameCubeHeader
            ? `disc-${index}.iso`
            : `entry-${String(index).padStart(2, "0")}.bin`;
          const bytes = formatCase.gameCubeHeader
            ? createGameCubeIsoBytes(payloadBytes, 0x9e3779b9 + index)
            : createPayloadBytes(payloadBytes, 0x9e3779b9 + index);
          const path = joinGuestPath(sourceDir, fileName);
          await writeGuestFile(root, path, bytes);
          entries.push({ bytes, fileName, path });
        }
        const inputPaths = entries.map((entry) => entry.path);
        const bytesByFileName = new Map(entries.map((entry) => [entry.fileName, entry.bytes]));

        for (const threads of threadCounts) {
          const name = `${formatCase.name}/${size}/threads-${threads}`;
          const cell = {
            entryCount: formatCase.entryCount,
            format: formatCase.name,
            payloadBytes,
            size,
            threads,
          };
          const stepStartedAt = performance.now();
          addStep({ command: "compress+ingest", name, status: "running", timestamp: new Date().toISOString() });

          // A fresh worker per cell keeps a pool sized for N from serving N+1.
          const worker = createBrowserWorkerClient({});
          try {
            await worker.init({
              runtimeMounts: [OPFS_GUEST_ROOT],
              ...(sharedMemoryMaximumPages ? { sharedMemoryMaximumPages } : {}),
              wasmUrl,
              workGuestPath: OPFS_GUEST_ROOT,
            });
            // Every event, not just the terminal one: nested stages are where
            // orchestrating commands like ingest actually spend their threads.
            const runJson = async (command: ReturnType<typeof createRomWeaverCommand>) => {
              const events: RomWeaverRunJsonEvent[] = [];
              const result = await worker.runJson(command, {
                onEvent(event: RomWeaverRunJsonEvent) {
                  events.push(event);
                  options.onEvent?.(event);
                },
              });
              return { events, result };
            };

            const archivePath = joinGuestPath(
              fixtureGuestRoot,
              `${formatCase.name}-${size}-${threads}.${formatCase.format}`,
            );
            const compressStartedAt = performance.now();
            // No codec: each format runs on its own default.
            const { events: compressEvents, result: compressResult } = await runJson(
              createRomWeaverCommand("compress", {
                format: formatCase.format,
                input: inputPaths,
                output: archivePath,
                threads,
              }),
            );
            const compressTerminal = assertRunJsonSucceeded(compressResult, { command: "compress" });
            const compressObservation = readThreadTelemetry(
              compressTerminal,
              compressEvents,
              "compress",
              cell,
              Math.round(performance.now() - compressStartedAt),
            );
            assertThreadTelemetry(compressObservation);
            observations.push(compressObservation);
            await waitForGuestFile(root, archivePath, compressResult);

            const ingestDir = joinGuestPath(fixtureGuestRoot, `${formatCase.name}-${size}-${threads}-out`);
            const ingestStartedAt = performance.now();
            const { events: ingestEvents, result: ingestResult } = await runJson(
              createRomWeaverCommand("ingest", { input: archivePath, output: ingestDir, threads }),
            );
            const ingestTerminal = assertRunJsonSucceeded(ingestResult, { command: "ingest" });
            const ingestObservation = readThreadTelemetry(
              ingestTerminal,
              ingestEvents,
              "ingest",
              cell,
              Math.round(performance.now() - ingestStartedAt),
            );
            assertThreadTelemetry(ingestObservation);
            observations.push(ingestObservation);

            // Compare whatever ingest actually emitted against the source it came
            // from; disc formats rename their output, so match on basename.
            const emitted = getIngestedPaths(ingestTerminal);
            assert(
              emitted.length === entries.length,
              `${name}: ingest reported ${emitted.length} assets, expected ${entries.length}`,
            );
            // Multi-entry archives keep their entry names; a single-image format is
            // renamed after the archive (a.rvz -> a.iso), so match it by position.
            let compared = 0;
            for (const [index, emittedPath] of emitted.entries()) {
              const expected =
                entries.length === 1 ? entries[0]?.bytes : bytesByFileName.get(pathBasename(emittedPath));
              assert(expected, `${name}: ingest emitted an unexpected asset ${pathBasename(emittedPath)}`);
              await waitForGuestFile(root, emittedPath, ingestResult);
              assertBytesEqual(
                await readGuestFile(root, emittedPath),
                expected,
                `${name}: asset ${index} (${pathBasename(emittedPath)}) changed in the round trip`,
              );
              compared += 1;
            }
            // Guards against a silent skip quietly turning verification off.
            assert(compared === entries.length, `${name}: verified ${compared} of ${entries.length} assets`);

            addStep({
              command: `compress=${compressObservation.effectiveThreads}/${threads} ingest=${ingestObservation.effectiveThreads}/${threads} verified=${compared}/${emitted.length}`,
              durationMs: Math.round(performance.now() - stepStartedAt),
              name,
              status: "succeeded",
              terminalStatus: ingestTerminal.status,
              timestamp: new Date().toISOString(),
            });
          } catch (error) {
            addStep({
              command: "compress+ingest",
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
        await removeFixtureDirectory(root, `${fixtureName}/${pathBasename(sourceDir)}`);
      }
    }
  } finally {
    await removeFixtureDirectory(root, fixtureName);
  }

  return {
    durationMs: Math.round(performance.now() - startedAt),
    failedSteps: steps.filter((step) => step.status === "failed").length,
    observations,
    passedSteps: steps.filter((step) => step.status === "succeeded").length,
    steps,
  };
}
