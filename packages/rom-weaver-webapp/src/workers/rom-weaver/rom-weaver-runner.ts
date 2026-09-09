import { OUT_OF_MEMORY_MESSAGE_REGEX } from "../../lib/errors.ts";
import { createLogger } from "../../lib/logging.ts";
import { markWasmFinished } from "../../lib/perf/op-perf-marks.ts";
import { toThreadBudget } from "../../lib/runtime/compression-thread-budget.ts";
import {
  estimateOpWorkingSetBytes,
  estimateScheduledThreads,
  isMobileRuntime,
  resolveAppleMobileSharedMemoryMaximumPages,
  resolveMemoryCeilingBytes,
} from "../../lib/runtime/op-memory-estimate.ts";
import { perfNow, recordCommandLatency } from "../../lib/runtime/perf-latency.ts";
import { toRomWeaverOptions } from "../../lib/runtime/run-options.ts";
import { getDefaultBrowserThreadCount } from "../../platform/shared/compression-options.ts";
import type { LogLevel } from "../../types/logging.ts";
import type { RuntimeThreadBudgetInput, WorkflowRuntimeLog } from "../../types/workflow-runtime-adapter.ts";
import type {
  RomWeaverBrowserOpfsRunOptions,
  RomWeaverRunInput,
  RomWeaverRunJsonEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
} from "../../wasm/index.ts";
import {
  collectRomWeaverRunInputPaths,
  createRomWeaverCommand,
  readRomWeaverRequestedThreadCount,
  readRomWeaverRunInputCommand,
  romWeaverCommandSupportsThreads,
  withRomWeaverForcedThreads,
} from "../../wasm/index.ts";
import browserWasmUrl from "../../wasm/rom-weaver-app.wasm?url";
import browserOpfsProxyWorkerUrl from "../../wasm/workers/browser-opfs-proxy-worker.ts?worker&url";
import browserRunnerWorkerUrl from "../../wasm/workers/browser-runner-worker.ts?worker&url";
import browserThreadWorkerUrl from "../../wasm/workers/browser-wasi-thread-worker.ts?worker&url";
import { createBrowserWorkerClient } from "../../wasm/workers/browser-worker-client.ts";
import { formatCommandForTrace } from "../../wasm/workers/worker-trace-format.ts";
import { getStagedInputMs } from "../protocol/browser-opfs-source-ref.ts";
import { type BrowserVirtualFile, getActiveBrowserVirtualFiles } from "../protocol/browser-virtual-files.ts";
import { isBrowserRuntime } from "../shared/runtime-env.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../shared/worker-storage/storage-layout.ts";
import {
  markRomWeaverRunnerStale,
  registerRunnerLifecycle,
  resolveInputSelection,
  resetRomWeaverRunner,
  setInputSelectionHandler,
  type InputSelectionHandler,
} from "./runner-control.ts";
import {
  getRomWeaverRunEventDetails,
  getRomWeaverRunEventElapsedMs,
  isRomWeaverTerminalRunEvent,
} from "./rom-weaver-run-events.ts";
import { getRomWeaverFailureMessage, withRomWeaverFailureKind } from "./runner-errors.ts";
import { createRunnerPool, type RunnerPool } from "./runner-pool.ts";
import { createOperationScheduler, type OperationScheduler } from "./runner-scheduler.ts";

type RomWeaverRunnerRunJsonOptions = RomWeaverRunJsonOptions<RomWeaverRunJsonEvent, RuntimeValue> &
  RomWeaverBrowserOpfsRunOptions & { signal?: AbortSignal };
type RomWeaverRunnerRunJsonResult = RomWeaverRunJsonResult<RomWeaverRunJsonEvent, RuntimeValue>;

type RomWeaverWorkerClient = {
  init: (...args: unknown[]) => Promise<RomWeaverRunnerReadyMetadata>;
  dispose?: () => Promise<void>;
  terminate?: () => void;
  runJson: (
    commandOrRequest: RomWeaverRunInput,
    options?: RomWeaverRunnerRunJsonOptions,
  ) => Promise<RomWeaverRunnerRunJsonResult>;
};

type RomWeaverRunnerReadyMetadata = {
  mode: string;
  threaded: boolean;
  wasmUrl: string | null;
};

type RomWeaverRunner = {
  dispose?: () => Promise<void>;
  ready: RomWeaverRunnerReadyMetadata;
  runJson: (
    commandOrRequest: RomWeaverRunInput,
    options?: RomWeaverRunnerRunJsonOptions,
  ) => Promise<RomWeaverRunnerRunJsonResult>;
  terminate?: () => void;
};

type BrowserWasmAssetSelection = {
  opfsProxyWorkerUrl?: string;
  threadWorkerUrl?: string;
  wasmUrl?: string;
};

type RunnerCreateOptions = { threads?: RuntimeValue };

// Keep about half the thread budget as idle runners, with a floor of two and this cap.
// The scheduler separately limits active operations by the thread budget.
const MAX_WARM_IDLE_RUNNERS = 8;
const resolveWarmIdleRunners = (): number => {
  // WASM heaps never shrink. Mobile keeps one runner because shared-memory reservations leave little headroom.
  if (isMobileRuntime()) return 1;
  return Math.max(2, Math.min(MAX_WARM_IDLE_RUNNERS, Math.ceil(getDefaultBrowserThreadCount() / 2)));
};

// New runners use warmup's resolved auto thread count, so their worker-shell pools are ready for the first command.
let runnerCreateThreads: RuntimeValue | undefined;
let runnerWarmupPromise: Promise<RomWeaverRunnerReadyMetadata> | null = null;

let runnerPool: RunnerPool<RomWeaverRunner, RunnerCreateOptions> | null = null;
let operationScheduler: OperationScheduler | null = null;

// Bound graceful disposal so a worker blocked in a synchronous wait cannot block a reset.
const RUNNER_DISPOSE_GRACE_MS = 2000;

// WASM heaps only grow. These switches keep warmup cleanup outside the first operation.
const PRE_EXTRACT_GAP = {
  // Compile once on the page thread and reuse the module across runner and thread workers.
  cacheCompiledWasmModule: true,
  // Terminate an exhausted worker immediately to release its OPFS handles.
  hardTerminateStaleOnOom: true,
  // Keep the runner that warmed extraction state and release the other warm heaps.
  recycleRunnerAfterWarmup: true,
};

// Page-thread cache entries are keyed by URL so a changed asset recompiles.
let cachedBrowserWasmModule: { module: WebAssembly.Module; wasmUrl: string } | null = null;

// Coalesce concurrent first compiles for the same URL.
let inflightBrowserWasmCompile: { promise: Promise<WebAssembly.Module>; wasmUrl: string } | null = null;

const nowMs = () =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();

// Cache events use the page-thread logger, where the user's log-level setting applies.
const logger = createLogger("rom-weaver-runner");
const emitWasmCacheTrace = (message: string, details?: Record<string, unknown>) => logger.trace(message, details);

const compileBrowserWasmModule = async (wasmUrl: string): Promise<WebAssembly.Module> => {
  const response = await fetch(wasmUrl);
  if (!response.ok) {
    throw new Error(`failed to fetch wasm module from ${wasmUrl}: ${response.status} ${response.statusText}`);
  }
  if (typeof WebAssembly.compileStreaming === "function") {
    try {
      return await WebAssembly.compileStreaming(response.clone());
    } catch {
      // Fall through to non-streaming compile (e.g. when the response MIME type is not application/wasm).
    }
  }
  return WebAssembly.compile(await response.arrayBuffer());
};

// Compile and cache the module on first use. A failure leaves the worker-side wasmUrl fallback available.
const getCachedBrowserWasmModule = async (wasmUrl?: string): Promise<WebAssembly.Module | undefined> => {
  if (!PRE_EXTRACT_GAP.cacheCompiledWasmModule) return undefined;
  if (!wasmUrl) return undefined;
  if (cachedBrowserWasmModule?.wasmUrl === wasmUrl) {
    emitWasmCacheTrace("wasm module cache hit (skipping fetch+compile)", { wasmUrl });
    return cachedBrowserWasmModule.module;
  }
  // Concurrent preload shares the in-flight compile.
  if (inflightBrowserWasmCompile?.wasmUrl === wasmUrl) {
    emitWasmCacheTrace("wasm module compile in flight; awaiting shared page-thread compile", { wasmUrl });
    try {
      return await inflightBrowserWasmCompile.promise;
    } catch {
      return undefined;
    }
  }
  emitWasmCacheTrace("wasm module cache miss; compiling on page thread", { wasmUrl });
  const startedAt = nowMs();
  const promise = compileBrowserWasmModule(wasmUrl);
  inflightBrowserWasmCompile = { promise, wasmUrl };
  try {
    const module = await promise;
    cachedBrowserWasmModule = { module, wasmUrl };
    emitWasmCacheTrace("wasm module compiled and cached", {
      compileMs: Number((nowMs() - startedAt).toFixed(1)),
      wasmUrl,
    });
    return module;
  } catch (error) {
    emitWasmCacheTrace("wasm module compile failed; falling back to worker-side compile", {
      message: error instanceof Error ? error.message : String(error),
      wasmUrl,
    });
    return undefined;
  } finally {
    if (inflightBrowserWasmCompile?.promise === promise) inflightBrowserWasmCompile = null;
  }
};

const describeVirtualFilesForTrace = (files: BrowserVirtualFile[]) => {
  let proxyCount = 0;
  let totalBytes = 0;
  for (const file of files) {
    if (file.useProxyHandle) proxyCount += 1;
    if (file.source) {
      const source = file.source as Blob | Uint8Array | ArrayBuffer;
      totalBytes +=
        source instanceof Uint8Array || source instanceof ArrayBuffer ? source.byteLength : source.size || 0;
    }
  }
  return {
    count: files.length,
    proxyCount,
    totalBytes,
  };
};

const emitRunnerTraceLine = (options: RomWeaverRunnerRunJsonOptions | undefined, message: string) => {
  options?.onTraceNonJsonLine?.(`[browser-runner] ${message}`);
};

const collectReferencedVirtualFilePaths = (
  commandOrRequest: RomWeaverRunInput,
  options?: RomWeaverRunnerRunJsonOptions,
) => {
  return new Set(
    collectRomWeaverRunInputPaths(commandOrRequest, {
      knownInputPaths: options?.knownInputPaths,
    }),
  );
};

const selectActiveVirtualFilesForRun = (
  activeVirtualFiles: BrowserVirtualFile[],
  commandOrRequest: RomWeaverRunInput,
  options?: RomWeaverRunnerRunJsonOptions,
) => {
  const command = readRomWeaverRunInputCommand(commandOrRequest);
  const referencedPaths = collectReferencedVirtualFilePaths(commandOrRequest, options);
  if (command.type === "compress" && [...referencedPaths].some((path) => /\.cue$/i.test(path))) {
    return activeVirtualFiles;
  }
  if (!referencedPaths.size) return activeVirtualFiles;
  return activeVirtualFiles.filter((file) => referencedPaths.has(file.path));
};

const resolveBrowserWasmUrl = async () => browserWasmUrl;

const resolveBrowserThreadWorkerUrl = async () => browserThreadWorkerUrl;

const resolveBrowserOpfsProxyWorkerUrl = async () => browserOpfsProxyWorkerUrl;

const resolveBrowserRunnerWorkerUrl = async () => browserRunnerWorkerUrl;

const canUseThreadedBrowserWasm = (root: typeof globalThis = globalThis) => {
  return typeof root.SharedArrayBuffer === "function" && root.crossOriginIsolated === true;
};

const resolveBrowserWasmAsset = async (): Promise<BrowserWasmAssetSelection> => {
  if (!canUseThreadedBrowserWasm()) {
    throw new Error("rom-weaver browser runtime requires SharedArrayBuffer and cross-origin isolation (COOP/COEP).");
  }
  const [wasmUrl, threadWorkerUrl, opfsProxyWorkerUrl] = await Promise.all([
    resolveBrowserWasmUrl(),
    resolveBrowserThreadWorkerUrl(),
    resolveBrowserOpfsProxyWorkerUrl(),
  ]);
  return { opfsProxyWorkerUrl, threadWorkerUrl, wasmUrl };
};

const normalizeRunnerDefaultThreads = (threads?: RuntimeValue) => {
  // Seed the warm worker pool with the same auto count that commands resolve at run time.
  if (threads === undefined || threads === null) return getDefaultBrowserThreadCount();
  const raw = String(threads).trim();
  if (!raw || raw.toLowerCase() === "auto") return getDefaultBrowserThreadCount();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
};

const createBrowserRunnerInitOptions = (
  wasmAsset: BrowserWasmAssetSelection,
  options?: { threads?: RuntimeValue },
  wasmModule?: WebAssembly.Module,
) => {
  const defaultThreads = normalizeRunnerDefaultThreads(options?.threads);
  const sharedMemoryMaximumPages = resolveAppleMobileSharedMemoryMaximumPages();
  return {
    runtimeMounts: [WORKER_OPFS_MOUNTPOINT],
    // Pass a cached module when available. wasmUrl remains the worker-side compile fallback.
    ...(wasmModule ? { module: wasmModule } : {}),
    ...(wasmAsset.wasmUrl ? { wasmUrl: wasmAsset.wasmUrl } : {}),
    ...(wasmAsset.threadWorkerUrl ? { threadWorkerUrl: wasmAsset.threadWorkerUrl } : {}),
    ...(wasmAsset.opfsProxyWorkerUrl ? { opfsProxyWorkerUrl: wasmAsset.opfsProxyWorkerUrl } : {}),
    ...(defaultThreads ? { defaultThreads } : {}),
    ...(sharedMemoryMaximumPages ? { sharedMemoryMaximumPages } : {}),
    workGuestPath: WORKER_OPFS_MOUNTPOINT,
  };
};

/** Resolves a mid-run candidate selection request `{mode, heading, candidates:[{value,label}]}` to
 * the chosen 0-based indices (an empty array cancels). Single-select prompts resolve to one index;
 * multi-select prompts may resolve to several. Runs on the main thread. */
const createBrowserRunner = async (options?: { threads?: RuntimeValue }): Promise<RomWeaverRunner> => {
  const runnerWorkerUrl = await resolveBrowserRunnerWorkerUrl();
  const client = createBrowserWorkerClient({ workerUrl: runnerWorkerUrl }) as unknown as RomWeaverWorkerClient;
  try {
    (client as { setSelectionHandler?: (handler: InputSelectionHandler) => void }).setSelectionHandler?.(
      resolveInputSelection,
    );
    const wasmAsset = await resolveBrowserWasmAsset();
    const wasmModule = await getCachedBrowserWasmModule(wasmAsset.wasmUrl);
    const ready = await client.init(createBrowserRunnerInitOptions(wasmAsset, options, wasmModule));
    const selectedWasmUrl = wasmAsset.wasmUrl ?? ready.wasmUrl ?? "";
    publishRomWeaverWasmDiagnostic({
      context: "rom-weaver browser runner",
      contextUrl: selectedWasmUrl,
      reason: "cross-origin isolated",
      threaded: ready.threaded,
      url: ready.wasmUrl || selectedWasmUrl,
    });
    return {
      dispose: async () => {
        // Always terminate after the bounded cleanup to release the grown WASM heap.
        const graceful = client.dispose?.().catch(() => undefined);
        if (graceful) {
          await Promise.race([graceful, new Promise((resolve) => setTimeout(resolve, RUNNER_DISPOSE_GRACE_MS))]);
        }
        client.terminate?.();
      },
      ready,
      runJson: (commandOrRequest, options) => client.runJson(commandOrRequest, options),
      terminate: () => client.terminate?.(),
    };
  } catch (error) {
    client.terminate?.();
    throw error;
  }
};

const getRunnerPool = (): RunnerPool<RomWeaverRunner, RunnerCreateOptions> => {
  if (!runnerPool) {
    runnerPool = createRunnerPool<RomWeaverRunner, RunnerCreateOptions>({
      create: (createOptions) => createBrowserRunner(createOptions),
      dispose: (runner) => runner.dispose?.() ?? Promise.resolve(),
      maxIdle: resolveWarmIdleRunners(),
      terminate: (runner) => runner.terminate?.(),
    });
    registerRunnerLifecycle({
      disposeAll: (options) => runnerPool?.disposeAll(options) ?? Promise.resolve(),
      markAllStale: () => runnerPool?.markAllStale(),
    });
  }
  return runnerPool;
};

const getOperationScheduler = (): OperationScheduler => {
  if (!operationScheduler) {
    // Limit operations by the thread budget. The thread gate keeps their total request within it, so full-budget work runs alone.
    const threadBudget = getDefaultBrowserThreadCount();
    operationScheduler = createOperationScheduler({
      maxConcurrency: threadBudget,
      memoryCeiling: resolveMemoryCeilingBytes(),
      // Rust plans I/O batches from browser memory, thread limits, and source sizes. Its planner command bypasses this scheduler.
      planBatch: (jobSizes, planOptions) =>
        invokeRomWeaverPlanExtractBatchWorker({
          jobSizes,
          memoryCeilingBytes: planOptions.memoryCeilingBytes,
          threads: planOptions.threadBudget,
        }),
      totalThreadBudget: threadBudget,
    });
  }
  return operationScheduler;
};

// The staging layer records all simultaneous source sizes before admission, so the first plan sees the full drop.
const noteRomWeaverIoBatch = (jobSizes: number[]) => {
  getOperationScheduler().noteIoBatch(Array.isArray(jobSizes) ? jobSizes : []);
};

// Keep the extraction runner and release the other idle warmup runners without resetting its worker or thread-pool state.
const recycleWarmRomWeaverRunner = async (threads?: RuntimeValue) => {
  if (!PRE_EXTRACT_GAP.recycleRunnerAfterWarmup) return;
  if (!isBrowserRuntime()) return;
  const pool = getRunnerPool();
  if (pool.busyCount !== 0 || pool.idleCount === 0) return;
  runnerCreateThreads = threads ?? runnerCreateThreads;
  const warmLease = await pool.acquire({ threads: runnerCreateThreads });
  await pool.disposeIdle();
  warmLease.release();
};

// Recycle after a heavy operation during an idle gap. Debouncing preserves light-operation bursts, which rely on OOM handling.
const IDLE_RECYCLE_DEBOUNCE_MS = 600;
const IDLE_RECYCLE_MIN_OP_BYTES = 32 * 1024 * 1024;
let idleRecycleTimer: ReturnType<typeof setTimeout> | null = null;
let idleRecycleInFlight = false;
const scheduleIdleRecycle = (operationBytes: number) => {
  if (!isBrowserRuntime()) return;
  if (!PRE_EXTRACT_GAP.recycleRunnerAfterWarmup) return;
  if (operationBytes < IDLE_RECYCLE_MIN_OP_BYTES) return;
  if (idleRecycleTimer) clearTimeout(idleRecycleTimer);
  idleRecycleTimer = setTimeout(() => {
    idleRecycleTimer = null;
    if (idleRecycleInFlight || !runnerPool || runnerPool.busyCount !== 0) return;
    idleRecycleInFlight = true;
    void recycleWarmRomWeaverRunner()
      .catch(() => undefined)
      .finally(() => {
        idleRecycleInFlight = false;
      });
  }, IDLE_RECYCLE_DEBOUNCE_MS);
};

// Mobile evicts idle runners to release their shared-memory reservation. Queued work re-arms the debounce.
const MOBILE_IDLE_EVICTION_DEBOUNCE_MS = 250;
let mobileIdleEvictionTimer: ReturnType<typeof setTimeout> | null = null;
const scheduleMobileIdleRunnerEviction = () => {
  if (mobileIdleEvictionTimer) clearTimeout(mobileIdleEvictionTimer);
  mobileIdleEvictionTimer = setTimeout(() => {
    mobileIdleEvictionTimer = null;
    const pool = runnerPool;
    if (!pool || pool.idleCount === 0) return;
    // Pool idleness can occur between staging operations. Wait for queued work, then dispose only idle runners.
    const scheduler = operationScheduler;
    const schedulerDrained = !scheduler || (scheduler.inFlightCount === 0 && scheduler.waitingCount === 0);
    if (pool.busyCount !== 0 || !schedulerDrained) {
      logger.trace("mobile idle runner eviction deferred: work still queued", {
        busy: pool.busyCount,
        inFlight: scheduler ? scheduler.inFlightCount : 0,
        waiting: scheduler ? scheduler.waitingCount : 0,
      });
      scheduleMobileIdleRunnerEviction();
      return;
    }
    logger.trace("mobile idle runner eviction: releasing warm shared-memory reservation", {
      idle: pool.idleCount,
    });
    void pool.disposeIdle().catch(() => undefined);
  }, MOBILE_IDLE_EVICTION_DEBOUNCE_MS);
};

// WASM heaps only grow. Match shared WASI/Emscripten OOM messages and V8 memory RangeErrors so the affected runner is recycled.
const isRunnerOutOfMemoryError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  if (OUT_OF_MEMORY_MESSAGE_REGEX.test(error.message)) return true;
  return error.name === "RangeError" && /memory/i.test(error.message);
};

const createRunnerAbortError = () => {
  const error = new Error("Workflow was cancelled") as Error & { code?: string };
  error.name = "AbortError";
  error.code = "CANCELLED";
  return error;
};

// Read the terminal event's WASM duration for the UI and compare it with round-trip time to expose browser overhead.
const readWasmReportedElapsedMs = (result: RomWeaverRunnerRunJsonResult): number | undefined => {
  const events = Array.isArray(result?.events) ? result.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && isRomWeaverTerminalRunEvent(event)) {
      const elapsed = getRomWeaverRunEventElapsedMs(event);
      return typeof elapsed === "number" ? elapsed : undefined;
    }
  }
  return undefined;
};

const runRomWeaverJson = async (commandOrRequest: RomWeaverRunInput, options?: RomWeaverRunnerRunJsonOptions) => {
  const { signal, ...runOptionOverrides } = options || {};
  const activeVirtualFiles = getActiveBrowserVirtualFiles();
  const scopedActiveVirtualFiles = selectActiveVirtualFilesForRun(activeVirtualFiles, commandOrRequest, options);
  const configuredVirtualFiles = runOptionOverrides.virtualFiles;
  // Cached OPFS mounts hold sync access handles. Release them before UI-side VFS writes and downloads.
  const defaultInvalidateMountCacheAfterRun = true;
  const runOptions: RomWeaverRunnerRunJsonOptions =
    scopedActiveVirtualFiles.length > 0
      ? {
          ...runOptionOverrides,
          virtualFiles: [
            ...scopedActiveVirtualFiles,
            ...(Array.isArray(configuredVirtualFiles) ? configuredVirtualFiles : []),
          ],
        }
      : {
          ...runOptionOverrides,
        };
  if (!Object.hasOwn(runOptions, "invalidateMountCacheAfterRun")) {
    runOptions.invalidateMountCacheAfterRun = defaultInvalidateMountCacheAfterRun;
  }
  // The app prompts when a container has multiple entries and the command has no explicit selection.
  if (!Object.hasOwn(runOptions, "interactiveSelectionEnabled")) {
    (runOptions as { interactiveSelectionEnabled?: boolean }).interactiveSelectionEnabled = true;
  }
  emitRunnerTraceLine(
    options,
    `runJson preparing command=${formatCommandForTrace(readRomWeaverRunInputCommand(commandOrRequest))} activeVirtualFiles=${JSON.stringify(
      describeVirtualFilesForTrace(activeVirtualFiles),
    )} scopedVirtualFiles=${JSON.stringify(
      describeVirtualFilesForTrace(scopedActiveVirtualFiles),
    )} configuredVirtualFiles=${Array.isArray(configuredVirtualFiles) ? configuredVirtualFiles.length : 0} invalidateMountCacheAfterRun=${String(runOptions.invalidateMountCacheAfterRun)}`,
  );
  const command = readRomWeaverRunInputCommand(commandOrRequest);
  const operationPaths = collectReferencedVirtualFilePaths(commandOrRequest, options);
  // Include the source preparation time recorded on the page thread when a referenced input was staged.
  const stagedInputMs = getStagedInputMs(operationPaths);
  if (typeof stagedInputMs === "number") {
    (runOptions as { stagingMs?: number }).stagingMs = stagedInputMs;
  }
  const threadBudget = getDefaultBrowserThreadCount();
  // Probe and list reserve no workers. Estimate other commands so a single-threaded operation does not reserve the full budget.
  const requestedThreads = readRomWeaverRequestedThreadCount(commandOrRequest, { defaultThreads: threadBudget });
  const requested = romWeaverCommandSupportsThreads(command) ? (requestedThreads ?? threadBudget) : 0;
  const inputBytes = describeVirtualFilesForTrace(scopedActiveVirtualFiles).totalBytes;
  const operationThreads = estimateScheduledThreads(command, inputBytes, requested);
  // Reserve the estimated working set from staged input sizes to prevent overlap that exhausts device memory.
  const operationBytes = estimateOpWorkingSetBytes(command, inputBytes);

  const dispatchRun = async (assignedThreads: number): Promise<RomWeaverRunnerRunJsonResult> => {
    if (signal?.aborted) throw createRunnerAbortError();
    // Wait for warmup to release its lease so the first operation can reuse that runner.
    await runnerWarmupPromise?.catch(() => undefined);
    if (signal?.aborted) throw createRunnerAbortError();
    const lease = await getRunnerPool().acquire({ threads: runnerCreateThreads });
    if (signal?.aborted) {
      lease.terminate();
      throw createRunnerAbortError();
    }
    emitRunnerTraceLine(
      options,
      `runJson dispatch mode=${lease.runner.ready.mode} threaded=${String(lease.runner.ready.threaded)}`,
    );
    let removeAbortListener: (() => void) | undefined;
    try {
      return await new Promise<RomWeaverRunnerRunJsonResult>((resolve, reject) => {
        let settled = false;
        const abortRun = () => {
          if (settled) return;
          settled = true;
          // Abort only this operation's runner. Pooled siblings retain their workers and keep running.
          emitRunnerTraceLine(options, "runJson aborted; terminating active runner");
          lease.terminate();
          reject(createRunnerAbortError());
        };
        if (signal) {
          signal.addEventListener("abort", abortRun, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", abortRun);
        }
        // Force the scheduler's per-operation allotment so concurrent WASI pools do not each claim the full budget.
        const forcedThreads = Math.max(1, Math.floor(assignedThreads));
        const dispatchInput =
          romWeaverCommandSupportsThreads(command) && forcedThreads < threadBudget
            ? withRomWeaverForcedThreads(commandOrRequest, forcedThreads)
            : commandOrRequest;
        if (dispatchInput !== commandOrRequest) {
          emitRunnerTraceLine(
            options,
            `runJson thread allotment threadsPerOp=${forcedThreads} threadBudget=${threadBudget}`,
          );
        }
        lease.runner.runJson(dispatchInput, runOptions).then(
          (result) => {
            if (settled) return;
            settled = true;
            // Start the perceived-latency tail that ends when the result paints.
            markWasmFinished();
            resolve(result);
          },
          (error) => {
            if (settled) return;
            settled = true;
            reject(error);
          },
        );
      });
    } catch (error) {
      // A long-lived worker can exhaust its grown heap. Only that runner is replaced on the next acquire.
      if (isRunnerOutOfMemoryError(error)) {
        if (PRE_EXTRACT_GAP.hardTerminateStaleOnOom) {
          // Release the exhausted worker's OPFS handles immediately.
          emitRunnerTraceLine(options, "runJson out-of-memory; terminating exhausted runner");
          lease.terminate();
        } else {
          emitRunnerTraceLine(options, "runJson out-of-memory; flagging exhausted runner for recycle");
          lease.markStale();
        }
      }
      throw error;
    } finally {
      removeAbortListener?.();
      if (isMobileRuntime()) {
        // Mobile releases runners after heavy or threaded work. Light-operation runners remain for a short burst, then idle eviction releases them.
        const mobileHeavyOp = operationBytes >= IDLE_RECYCLE_MIN_OP_BYTES || operationThreads > 1;
        if (mobileHeavyOp) {
          emitRunnerTraceLine(
            options,
            `runJson mobile heavy op; terminating runner bytes=${operationBytes} threads=${operationThreads}`,
          );
          lease.terminate();
        } else {
          emitRunnerTraceLine(
            options,
            `runJson mobile light op; reusing warm runner bytes=${operationBytes} threads=${operationThreads}`,
          );
          lease.release();
          scheduleMobileIdleRunnerEviction();
        }
      } else {
        // Return a usable runner to the pool. A terminated or stale runner is disposed.
        lease.release();
        // Restore a clean-heap baseline during the next idle gap so the next heavy operation does not start near its cap.
        scheduleIdleRecycle(operationBytes);
      }
    }
  };

  // Measure perceived latency from scheduler admission until the worker reply. A thread-capable command closes the user-facing drop-to-done interval.
  const submittedAtMs = perfNow();
  const threadCapable = romWeaverCommandSupportsThreads(command);
  // Batch planning bypasses the scheduler to avoid re-entry. Extract, ingest, and checksum use its Rust plan for memory and overlap.
  const ioCommand = command.type === "extract" || command.type === "ingest" || command.type === "checksum";
  const result =
    command.type === "plan-extract-batch"
      ? await dispatchRun(operationThreads)
      : await getOperationScheduler().schedule(
          {
            bytes: operationBytes,
            io: ioCommand,
            jobSizeBytes: inputBytes,
            label: command.type,
            paths: operationPaths,
            signal,
            threads: operationThreads,
          },
          dispatchRun,
        );
  recordCommandLatency({
    commandType: command.type,
    submittedAtMs,
    threadCapable,
    wasmElapsedMs: readWasmReportedElapsedMs(result),
  });
  return result;
};

/** One concurrently-runnable group of a {@link RomWeaverBatchPlan}: the original job indices that may
 * run together and the worker-thread count each should use (the Rust planner's even split of the
 * budget for the group). */
type RomWeaverBatchPlanWave = { jobs: number[]; threadsPerJob: number };
/** A concurrent extraction schedule from the Rust planner: ordered waves run one after another, the
 * jobs within a wave run together. Mirrors Rust `BatchPlan`; parsed loosely (no typegen dependency). */
type RomWeaverBatchPlan = { waves: RomWeaverBatchPlanWave[] };

const asPlanRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const parseRomWeaverBatchPlanWave = (value: unknown): RomWeaverBatchPlanWave | null => {
  const wave = asPlanRecord(value);
  if (!wave) return null;
  const jobs: number[] = [];
  for (const jobValue of Array.isArray(wave.jobs) ? wave.jobs : []) {
    const job = Number(jobValue);
    if (Number.isInteger(job) && job >= 0) jobs.push(job);
  }
  return {
    jobs,
    threadsPerJob: Math.max(1, Math.floor(Number(wave.threads_per_job)) || 1),
  };
};

const parseRomWeaverBatchPlan = (details: unknown): RomWeaverBatchPlan | undefined => {
  const plan = asPlanRecord(asPlanRecord(details)?.extract_batch_plan);
  if (!plan) return undefined;
  const waves = (Array.isArray(plan.waves) ? plan.waves : []).flatMap((value) => {
    const wave = parseRomWeaverBatchPlanWave(value);
    return wave ? [wave] : [];
  });
  return { waves };
};

// Run Rust batch planning outside the scheduler because scheduler admission calls it. Keeping it here avoids a runner-to-command module cycle.
const invokeRomWeaverPlanExtractBatchWorker = async (input: {
  jobSizes: number[];
  logLevel?: LogLevel | string;
  maxConcurrency?: number;
  memoryCeilingBytes?: number;
  onLog?: (log: WorkflowRuntimeLog) => void;
  signal?: AbortSignal;
  threads?: RuntimeThreadBudgetInput;
}): Promise<RomWeaverBatchPlan> => {
  const jobSizes = (Array.isArray(input.jobSizes) ? input.jobSizes : []).map((size) =>
    BigInt(Math.max(0, Math.floor(Number(size) || 0))),
  );
  const threadArg = toThreadBudget(input.threads);
  const command = createRomWeaverCommand("plan-extract-batch", {
    job_sizes: jobSizes,
    ...(threadArg ? { threads: threadArg } : {}),
    ...(typeof input.maxConcurrency === "number" && input.maxConcurrency > 0
      ? { max_concurrency: Math.floor(input.maxConcurrency) }
      : {}),
    ...(typeof input.memoryCeilingBytes === "number" && input.memoryCeilingBytes > 0
      ? { memory_ceiling_bytes: BigInt(Math.floor(input.memoryCeilingBytes)) }
      : {}),
  });
  const result = await runRomWeaverJson(
    command,
    toRomWeaverOptions({ logLevel: input.logLevel, onLog: input.onLog, signal: input.signal }),
  );
  if (!(result.ok && result.exitCode === 0)) {
    throw withRomWeaverFailureKind(
      new Error(getRomWeaverFailureMessage(result, "Extract batch planning failed")),
      result,
    );
  }
  const events = Array.isArray(result.events) ? result.events : [];
  const terminal = events.length ? events.at(-1) : null;
  const plan = parseRomWeaverBatchPlan(terminal ? getRomWeaverRunEventDetails(terminal) : undefined);
  if (!plan) throw withRomWeaverFailureKind(new Error("Extract batch plan was missing or malformed"), result);
  return plan;
};

// Normalize a warmup thread seed for change detection.
const normalizeThreadsSeed = (value: RuntimeValue | undefined): string =>
  value == null ? "" : String(value).trim().toLowerCase();

const warmupRomWeaverRunner = (threads?: RuntimeValue) => {
  const warmupPromise = (async () => {
    if (!isBrowserRuntime()) throw new Error("rom-weaver wasm runner is only available in browser runtimes");
    // A changed thread budget MUST replace idle runners because acquire otherwise reuses their old-sized pools.
    const seedChanged = normalizeThreadsSeed(runnerCreateThreads) !== normalizeThreadsSeed(threads);
    runnerCreateThreads = threads;
    if (seedChanged) markRomWeaverRunnerStale();
    const lease = await getRunnerPool().acquire({ threads });
    try {
      return lease.runner.ready;
    } finally {
      lease.release();
    }
  })();
  runnerWarmupPromise = warmupPromise;
  const clearWarmup = () => {
    if (runnerWarmupPromise === warmupPromise) runnerWarmupPromise = null;
  };
  void warmupPromise.then(clearWarmup, clearWarmup);
  return warmupPromise;
};

const getRomWeaverRunnerMetadata = async () => {
  if (!isBrowserRuntime()) throw new Error("rom-weaver wasm runner is only available in browser runtimes");
  const lease = await getRunnerPool().acquire({ threads: runnerCreateThreads });
  try {
    return lease.runner.ready;
  } finally {
    lease.release();
  }
};

const publishRomWeaverWasmDiagnostic = (message: {
  context?: string;
  contextUrl?: string;
  reason?: string;
  threaded: boolean;
  url: string;
}) => {
  if (typeof BroadcastChannel !== "function") return;
  try {
    const channel = new BroadcastChannel("rom-weaver-runtime-diagnostics");
    channel.postMessage({
      id: `rom-weaver-runner:${message.url}`,
      kind: "wasm",
      name: getResourceName(message.url),
      ...message,
    });
    channel.close();
  } catch {
    // diagnostics are best-effort
  }
};

const getResourceName = (urlLike: string) => {
  try {
    const url = new URL(urlLike, globalThis.location?.href || "http://localhost/");
    return url.pathname.split("/").filter(Boolean).pop() || "rom-weaver-app.wasm";
  } catch {
    return urlLike.split("/").filter(Boolean).pop() || "rom-weaver-app.wasm";
  }
};

export {
  getRomWeaverFailureMessage,
  getRomWeaverRunnerMetadata,
  noteRomWeaverIoBatch,
  recycleWarmRomWeaverRunner,
  resetRomWeaverRunner,
  runRomWeaverJson,
  setInputSelectionHandler,
  warmupRomWeaverRunner,
  withRomWeaverFailureKind,
};
