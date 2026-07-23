import { OUT_OF_MEMORY_MESSAGE_REGEX } from "../../lib/errors.ts";
import { createLogger } from "../../lib/logging.ts";
import { markWasmFinished } from "../../lib/perf/op-perf-marks.ts";
import { toThreadBudget } from "../../lib/runtime/compression-thread-budget.ts";
import {
  estimateOpWorkingSetBytes,
  estimateScheduledThreads,
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
} from "@rom-weaver/wasm";
import {
  collectRomWeaverRunInputPaths,
  createBrowserWorkerClient,
  createRomWeaverCommand,
  getRomWeaverWasmAssetUrls,
  readRomWeaverRequestedThreadCount,
  readRomWeaverRunInputCommand,
  romWeaverCommandSupportsThreads,
  withRomWeaverForcedThreads,
} from "@rom-weaver/wasm";
import { formatCommandForTrace } from "@rom-weaver/wasm/workers/worker-trace-format";
import { getStagedInputMs } from "../protocol/browser-opfs-source-ref.ts";
import { type BrowserVirtualFile, getActiveBrowserVirtualFiles } from "../protocol/browser-virtual-files.ts";
import { isBrowserRuntime } from "../shared/runtime-env.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../shared/worker-storage/storage-layout.ts";
import {
  getRomWeaverRunEventDetails,
  getRomWeaverRunEventElapsedMs,
  getRomWeaverRunEventErrorKind,
  getRomWeaverRunEventLabel,
  isRomWeaverFailedRunEvent,
  isRomWeaverTerminalRunEvent,
} from "./rom-weaver-run-events.ts";
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

// Warm idle runners kept for reuse between operations, scaled to the machine: about half the thread
// budget, floored at 2 so reuse always works and capped so a high-core machine doesn't hold an
// unbounded number of idle wasm heaps. How many operations actually run at once is bounded separately
// by the thread budget (the scheduler's maxConcurrency below).
const MAX_WARM_IDLE_RUNNERS = 8;
const resolveWarmIdleRunners = (): number => {
  // Apple mobile WebKit reserves each worker's full shared-memory `maximum` (~1 GiB on mobile) up front
  // and does not promptly reclaim it, so every extra idle worker keeps ~1 GiB reserved and courts an
  // out-of-memory tab reload. Keep at most one warm runner there - enough for a burst of back-to-back
  // light ops to reuse a warm worker, evicted quickly once idle (see scheduleMobileIdleRunnerEviction).
  if (resolveAppleMobileSharedMemoryMaximumPages()) return 1;
  return Math.max(2, Math.min(MAX_WARM_IDLE_RUNNERS, Math.ceil(getDefaultBrowserThreadCount() / 2)));
};

// Seed forwarded to freshly created runners so their initial worker-shell pool matches the resolved
// "auto" thread count; set by warmup and reused for on-demand runner creation.
let runnerCreateThreads: RuntimeValue | undefined;

let runnerPool: RunnerPool<RomWeaverRunner, RunnerCreateOptions> | null = null;
let operationScheduler: OperationScheduler | null = null;

// Upper bound on waiting for a worker to acknowledge a graceful dispose before terminating it
// anyway. A worker stuck in a synchronous wait (abandoned selection prompt, wedged op) never
// replies, and dispose must not hang resets behind it.
const RUNNER_DISPOSE_GRACE_MS = 2000;

// The WASM heap only grows, so warmup can leave a runner near its cap and force
// first-op recycling. These toggles keep recycling off the critical path and
// remain individually switchable for performance comparisons.
const PRE_EXTRACT_GAP = {
  // #4: compile the wasm module once on the main/page thread, cache it, and hand the precompiled
  //     WebAssembly.Module to every (re)created runner worker so worker recycles skip the fetch+compile.
  //     The module is reusable across instances and is already transferred to thread workers, so the
  //     thread pool benefits too. (Compile is moved off the worker onto the page thread, paid once.)
  cacheCompiledWasmModule: true,
  // #2: when a run OOMs, hard-terminate the exhausted worker immediately instead of waiting for the next
  //     dispatch to *gracefully* dispose it (graceful dispose of a wedged worker can block for seconds;
  //     terminate() is instant and the browser releases its OPFS handles on worker teardown).
  hardTerminateStaleOnOom: true,
  // #1: after warmup, keep only the runner that exercised extraction. This preserves first-drop worker/JIT
  //     state while releasing the rest of the preload pool's shared heaps and address-space reservations.
  recycleRunnerAfterWarmup: true,
};

// Page-thread cache of the compiled wasm module (#4), keyed by wasm URL so a changed asset recompiles.
let cachedBrowserWasmModule: { module: WebAssembly.Module; wasmUrl: string } | null = null;

// Single-flight guard for the page-thread compile (#4b). Concurrent runner consumers can otherwise
// both miss the still-empty cache and compile the full ~6 MB module. Coalesce first compiles for the
// same URL onto one in-flight promise.
let inflightBrowserWasmCompile: { promise: Promise<WebAssembly.Module>; wasmUrl: string } | null = null;

const nowMs = () =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();

// Trace for the wasm module cache (#4), so the cache's behaviour is visible in trace captures. The cache
// runs on the page/main thread where configureLogger has applied the user's log level setting, so it logs
// through the shared logger (gated by that setting). A "cache hit" line on the second-and-later worker
// (re)creation is the proof the precompiled module is being reused.
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

// Returns the cached compiled module for this wasm URL, compiling+caching it on first use. Returns
// undefined (so init falls back to the worker compiling from wasmUrl) if disabled or compilation fails.
const getCachedBrowserWasmModule = async (wasmUrl?: string): Promise<WebAssembly.Module | undefined> => {
  if (!PRE_EXTRACT_GAP.cacheCompiledWasmModule) return undefined;
  if (!wasmUrl) return undefined;
  if (cachedBrowserWasmModule?.wasmUrl === wasmUrl) {
    emitWasmCacheTrace("wasm module cache hit (skipping fetch+compile)", { wasmUrl });
    return cachedBrowserWasmModule.module;
  }
  // A compile for this URL is already running (parallel preload): await the shared one instead of
  // kicking a second full compile of the same module.
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

// The wasm module and its three worker entrypoints are resolved by the package
// via `new URL(..., import.meta.url)`, which the webapp's bundler rewrites to
// copied asset URLs. The runner passes these strings through the client's init
// options, so worker construction is never statically analyzed by the bundler.
const browserWasmAssetUrls = getRomWeaverWasmAssetUrls();

const resolveBrowserWasmUrl = async () => browserWasmAssetUrls.wasmUrl;

const resolveBrowserThreadWorkerUrl = async () => browserWasmAssetUrls.threadWorkerUrl;

const resolveBrowserOpfsProxyWorkerUrl = async () => browserWasmAssetUrls.opfsProxyWorkerUrl;

const resolveBrowserRunnerWorkerUrl = async () => browserWasmAssetUrls.runnerWorkerUrl;

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
  // Seed the thread-worker warm-up pool with the same count "auto" resolves to at run time
  // (max(4, hardwareConcurrency)) so the first command does not have to spawn extra worker shells.
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
    // Pass the precompiled module when cached (#4); keep wasmUrl as the worker-side compile fallback.
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
type InputSelectionHandler = (request: string) => number[] | Promise<number[]>;

let inputSelectionHandler: InputSelectionHandler | undefined;

/** Register the UI selection handler invoked when the wasm app needs the user to pick an input
 * candidate. When unset, selection is cancelled (returns -1) - the app always registers a handler. */
const setInputSelectionHandler = (handler?: InputSelectionHandler) => {
  logger.trace(handler ? "input selection handler registered" : "input selection handler cleared");
  inputSelectionHandler = handler;
};

/** Summarize a `{heading, candidates}` selection request JSON for trace logs without dumping its
 * full contents. */
const summarizeInputSelectionRequest = (request: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(request);
    return {
      candidateCount: Array.isArray(parsed?.candidates) ? parsed.candidates.length : 0,
      heading: typeof parsed?.heading === "string" ? parsed.heading : "",
      mode: typeof parsed?.mode === "string" ? parsed.mode : "single",
    };
  } catch {
    return { requestBytes: request.length, unparsable: true };
  }
};

// With concurrent operations two runners can request a candidate selection at the same moment, but the
// single host handler drives one dialog at a time. Serialize prompt invocations through a chain so the
// second prompt only opens once the first resolves; the operations themselves keep running in parallel.
let inputSelectionChain: Promise<unknown> = Promise.resolve();

const resolveInputSelection: InputSelectionHandler = (request) => {
  const run = inputSelectionChain
    .catch(() => undefined)
    .then(() => {
      if (!inputSelectionHandler) {
        logger.trace("input selection requested but no handler registered - cancelling", {
          requestBytes: typeof request === "string" ? request.length : 0,
        });
        return [];
      }
      logger.trace("forwarding input selection request to UI handler", summarizeInputSelectionRequest(request));
      return inputSelectionHandler(request);
    });
  inputSelectionChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

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
        // Bound graceful cleanup because a worker blocked in a synchronous wait cannot acknowledge it;
        // always terminate afterward to release its grow-only wasm heap.
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
  }
  return runnerPool;
};

const getOperationScheduler = (): OperationScheduler => {
  if (!operationScheduler) {
    // Bound the operation count by the available thread budget: every operation needs at least one
    // thread, and the thread gate already keeps the summed request within the budget, so this scales
    // concurrency with the machine's cores without oversubscribing them. Heavy (full-budget) operations
    // still run alone; only light operations pack together.
    const threadBudget = getDefaultBrowserThreadCount();
    operationScheduler = createOperationScheduler({
      maxConcurrency: threadBudget,
      memoryCeiling: resolveMemoryCeilingBytes(),
      // I/O ops (extract/ingest/checksum) are admitted by the shared Rust planner: the browser passes
      // only its own (mobile-capped) memory ceiling and thread budget plus each job's source size; Rust
      // owns the multiplier, the memory fit, and which jobs overlap. `plan-extract-batch` is dispatched
      // outside the scheduler (see the dispatch below), so this call cannot re-enter it.
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

// Declare a simultaneous I/O drop (its source sizes) so the scheduler's first plan call sees the whole
// batch even though each file reaches the scheduler staggered (staged independently). Called by the
// drop/staging layer, which alone knows every file's size up front.
const noteRomWeaverIoBatch = (jobSizes: number[]) => {
  getOperationScheduler().noteIoBatch(Array.isArray(jobSizes) ? jobSizes : []);
};

const resetRomWeaverRunner = async (options: { terminate?: boolean } = {}) => {
  if (!runnerPool) return;
  await runnerPool.disposeAll(options);
};

const markRomWeaverRunnerStale = () => {
  runnerPool?.markAllStale();
};

// #1: Keep the most recently released runner (the one that performed extraction) and dispose every other
// idle preload runner. Borrowing it before disposeIdle avoids a pool reset, so the first real operation
// reuses its worker/JIT/thread-pool state instead of crossing a soft reset and rebuilding on the critical path.
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

// After a heavy op, recycle during the next idle gap so the following action
// gets a clean, prewarmed heap. Debounce avoids recycling mid-burst; light ops
// rely on reactive OOM handling.
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

// Apple mobile reuses a runner during light bursts but evicts it at idle to
// release the large shared-memory reservation that can trigger WebKit reloads.
// Busy or queued work re-arms the debounce.
const MOBILE_IDLE_EVICTION_DEBOUNCE_MS = 250;
let mobileIdleEvictionTimer: ReturnType<typeof setTimeout> | null = null;
const scheduleMobileIdleRunnerEviction = () => {
  if (mobileIdleEvictionTimer) clearTimeout(mobileIdleEvictionTimer);
  mobileIdleEvictionTimer = setTimeout(() => {
    mobileIdleEvictionTimer = null;
    const pool = runnerPool;
    if (!pool || pool.idleCount === 0) return;
    // Momentary pool idleness can occur between queued staging ops. Wait for the
    // scheduler to drain, then dispose only idle runners so racing creation survives.
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

// The wasm runner's linear memory only ever grows, so the browser surfaces an exhausted heap as an
// out-of-memory error. V8 reports it as `RangeError: Out of memory`, but the wasi/Emscripten layer
// can also surface "cannot enlarge memory", "ENOMEM", etc. - reuse the canonical matcher so every
// OOM phrasing triggers a clean-heap worker recycle, while still catching a RangeError mentioning
// memory whose exact wording the shared regex might not enumerate.
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

// The wasm-reported command duration we surface in the UI: the elapsed time
// carried by the run's terminal event. Used to compare against the main-thread
// round-trip wall clock so the JS/worker/OPFS overhead is visible.
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
  // Cached OPFS mounts hold sync access handles; release them before UI-side VFS writes/downloads.
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
  // Let the app prompt (via the host selection callback) when a container has multiple selectable
  // entries and no explicit selection. Commands that pass an explicit `--select` never reach it.
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
  // Surface how long this command's OPFS inputs took to stage (recorded on the main thread by
  // createBrowserOpfsSourceRef) so it lands on the runner's [perf] command timings line alongside
  // setup/compute/teardown. Undefined when no referenced input was staged (e.g. virtual-Blob inputs).
  const stagedInputMs = getStagedInputMs(operationPaths);
  if (typeof stagedInputMs === "number") {
    (runOptions as { stagingMs?: number }).stagingMs = stagedInputMs;
  }
  const threadBudget = getDefaultBrowserThreadCount();
  // probe/list spawn no workers (0 budget). Threaded commands request "auto" (the full budget), but
  // most do not use every core - gate the scheduler on the threads the operation will realistically use
  // (a single-threaded apply reserves 1, not all of them) so light operations can overlap.
  const requestedThreads = readRomWeaverRequestedThreadCount(commandOrRequest, { defaultThreads: threadBudget });
  const requested = romWeaverCommandSupportsThreads(command) ? (requestedThreads ?? threadBudget) : 0;
  const inputBytes = describeVirtualFilesForTrace(scopedActiveVirtualFiles).totalBytes;
  const operationThreads = estimateScheduledThreads(command, inputBytes, requested);
  // Estimate the working set from the staged input sizes so the scheduler can refuse to overlap two
  // operations whose combined memory would exhaust the device.
  const operationBytes = estimateOpWorkingSetBytes(command, inputBytes);

  const dispatchRun = async (assignedThreads: number): Promise<RomWeaverRunnerRunJsonResult> => {
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
          // Terminate only this operation's runner - a sibling operation on another pooled runner keeps
          // running, unlike the previous singleton where any abort tore down the shared worker.
          emitRunnerTraceLine(options, "runJson aborted; terminating active runner");
          lease.terminate();
          reject(createRunnerAbortError());
        };
        if (signal) {
          signal.addEventListener("abort", abortRun, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", abortRun);
        }
        // Force the scheduler's per-op thread allotment unless it equals the full
        // budget. This keeps concurrent WASI pools from each claiming everything.
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
            // Wasm reported the run finished: open the perceived-latency tail measured to the result
            // paint (see lib/perf/op-perf-marks.ts → romweaver:after-finish).
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
      // A long-lived worker can exhaust its (only-ever-growing) wasm heap after several heavy ops and
      // fail with an out-of-memory error. Only this runner's heap is affected; the pool stands up a
      // fresh clean-heap runner on the next acquire.
      if (isRunnerOutOfMemoryError(error)) {
        if (PRE_EXTRACT_GAP.hardTerminateStaleOnOom) {
          // #2: hard-terminate the exhausted worker now to release its OPFS handles immediately.
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
      if (resolveAppleMobileSharedMemoryMaximumPages()) {
        // WebKit does not promptly reclaim grown heaps or thread-pool memory.
        // Terminate after heavy/threaded work; keep light runners for the burst,
        // then let idle eviction release them.
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
        // No-op if the runner was terminated above; otherwise returns the warm runner to the pool (or
        // disposes it when marked stale).
        lease.release();
        // After a heavy op, restore the clean-heap baseline during the next idle gap (debounced) so a
        // following op starts as fast as the first instead of on a heap left near its cap.
        scheduleIdleRecycle(operationBytes);
      }
    }
  };

  // Stamp the perceived-latency start on the main thread: `submittedAtMs` is when
  // the command enters the scheduler; the measure fires when the worker replies.
  // A thread-capable command is the heavy work the user is waiting on, so it (not
  // a preceding probe `list`) closes the drop -> done arc.
  const submittedAtMs = perfNow();
  const threadCapable = romWeaverCommandSupportsThreads(command);
  // The batch-plan command bypasses its calling scheduler to avoid reentrant
  // deadlock. Extract/ingest/checksum use that Rust plan for memory and overlap.
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

// Ask the shared Rust planner to group jobs from browser limits and source sizes.
// Lives here to avoid a runner↔command module cycle and runs outside the
// scheduler because the scheduler calls it during admission.
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

// Normalize a worker-threads seed so "auto"/numbers/undefined compare by surface value; used only to
// detect a thread-budget *change* between warmups.
const normalizeThreadsSeed = (value: RuntimeValue | undefined): string =>
  value == null ? "" : String(value).trim().toLowerCase();

const warmupRomWeaverRunner = async (threads?: RuntimeValue) => {
  if (!isBrowserRuntime()) throw new Error("rom-weaver wasm runner is only available in browser runtimes");
  // A thread-budget change must not silently reuse the old warm pool: getRunnerPool().acquire reuses a
  // warm idle runner regardless of the requested thread count, so without this the next op keeps the
  // stale-sized pool and grows it on demand. Drop the pooled runners when the seed changes so a fresh
  // runner is created at the new budget and self-pre-warms to it - keeping ops warm after a thread change.
  const seedChanged = normalizeThreadsSeed(runnerCreateThreads) !== normalizeThreadsSeed(threads);
  runnerCreateThreads = threads;
  if (seedChanged) markRomWeaverRunnerStale();
  const lease = await getRunnerPool().acquire({ threads });
  try {
    return lease.runner.ready;
  } finally {
    lease.release();
  }
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

const getRecordErrorMessage = (record: { message?: unknown; kind?: unknown }) =>
  typeof record.message === "string" && record.message.trim()
    ? record.message.trim()
    : typeof record.kind === "string" && record.kind.trim()
      ? `rom-weaver error (${record.kind.trim()})`
      : "";

const getErrorContextSuffix = (context: unknown) => {
  if (!(context && typeof context === "object")) return "";
  const record = context as { command?: unknown; stage?: unknown };
  const command = typeof record.command === "string" ? record.command.trim() : "";
  const stage = typeof record.stage === "string" ? record.stage.trim() : "";
  if (!(command || stage)) return "";
  return ` (${[command ? `command=${command}` : "", stage ? `stage=${stage}` : ""].filter(Boolean).join(", ")})`;
};

const getErrorMessage = (value: unknown) => {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (value instanceof Error) return String(value.message || "").trim();
  if (typeof value === "object") {
    const record = value as { message?: unknown; kind?: unknown; context?: unknown };
    const message = getRecordErrorMessage(record);
    if (!message) return "";
    return `${message}${getErrorContextSuffix(record.context)}`;
  }
  return "";
};

const getRomWeaverFailureMessage = (
  result: Partial<RomWeaverRunnerRunJsonResult> | null | undefined,
  fallback = "rom-weaver operation failed",
) => {
  const events = Array.isArray(result?.events) ? result.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!(event && isRomWeaverFailedRunEvent(event))) continue;
    const label = getRomWeaverRunEventLabel(event).trim();
    if (label) return label;
  }

  const nonJsonLines = Array.isArray(result?.nonJsonLines) ? result.nonJsonLines : [];
  for (let index = nonJsonLines.length - 1; index >= 0; index -= 1) {
    const line = String(nonJsonLines[index] || "").trim();
    if (line) return line;
  }

  const errorMessage = getErrorMessage((result as { error?: unknown } | null | undefined)?.error);
  if (errorMessage) return errorMessage;

  const stderr = getNonTraceStderr(result);
  if (stderr) return stderr;

  return fallback;
};

type RomWeaverFailureKind = NonNullable<ReturnType<typeof getRomWeaverRunEventErrorKind>>;

// The typed `RomWeaverErrorKind` the Rust core attached to the failing terminal
// event, if any. This is the canonical, generated-enum classification - the JS
// `inferCoreWorkerErrorKind` regex is only a fallback for failures that arrive
// without it (worker/panic strings, or messages wrapped in extra context).
const getRomWeaverFailureKind = (
  result: Partial<RomWeaverRunnerRunJsonResult> | null | undefined,
): RomWeaverFailureKind | undefined => {
  const events = Array.isArray(result?.events) ? result.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!(event && isRomWeaverFailedRunEvent(event))) continue;
    const kind = getRomWeaverRunEventErrorKind(event);
    if (kind) return kind;
  }
  return undefined;
};

// Attach the run's typed failure kind to a thrown error so the worker-error
// classifier (`resolveWorkerErrorKind`) prefers it over message-prefix
// inference. No-op when the run carried no typed kind, leaving the existing
// fallback path untouched.
const withRomWeaverFailureKind = <E extends Error>(
  error: E,
  result: Partial<RomWeaverRunnerRunJsonResult> | null | undefined,
): E => {
  const kind = getRomWeaverFailureKind(result);
  if (kind) {
    (error as E & { kind?: RomWeaverFailureKind }).kind = kind;
  }
  return error;
};

const TRACE_STDERR_LINE_REGEX = /^\d{4}-\d{2}-\d{2}T\S+\s+(?:TRACE|DEBUG|INFO|WARN|ERROR)\s+[\w:]+:/;

const getNonTraceStderr = (result: Partial<RomWeaverRunnerRunJsonResult> | null | undefined) => {
  const stderr = typeof result?.stderr === "string" ? result.stderr.trim() : "";
  if (!stderr) return "";
  const lines = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !TRACE_STDERR_LINE_REGEX.test(line));
  return lines.join("\n").trim();
};

export {
  getRomWeaverFailureMessage,
  getRomWeaverRunnerMetadata,
  markRomWeaverRunnerStale,
  noteRomWeaverIoBatch,
  recycleWarmRomWeaverRunner,
  resetRomWeaverRunner,
  runRomWeaverJson,
  setInputSelectionHandler,
  warmupRomWeaverRunner,
  withRomWeaverFailureKind,
};
