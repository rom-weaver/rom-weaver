import { OUT_OF_MEMORY_MESSAGE_REGEX } from "../../lib/errors.ts";
import { createLogger } from "../../lib/logging.ts";
import {
  estimateOpWorkingSetBytes,
  estimateScheduledThreads,
  resolveMemoryCeilingBytes,
} from "../../lib/runtime/op-memory-estimate.ts";
import { perfNow, recordCommandLatency } from "../../lib/runtime/perf-latency.ts";
import { getDefaultBrowserThreadCount } from "../../platform/shared/compression-options.ts";
import type {
  RomWeaverBrowserOpfsRunOptions,
  RomWeaverRunInput,
  RomWeaverRunJsonEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
} from "../../wasm/index.ts";
import {
  collectRomWeaverRunInputPaths,
  readRomWeaverRequestedThreadCount,
  readRomWeaverRunInputCommand,
  romWeaverCommandSupportsThreads,
  withRomWeaverForcedThreads,
} from "../../wasm/index.ts";
import browserWasmUrl from "../../wasm/rom-weaver-app.wasm?url";
import browserRunnerWorkerUrl from "../../wasm/workers/browser-runner-worker.ts?worker&url";
import browserThreadWorkerUrl from "../../wasm/workers/browser-wasi-thread-worker.ts?worker&url";
import { createBrowserWorkerClient } from "../../wasm/workers/browser-worker-client.ts";
import { formatCommandForTrace } from "../../wasm/workers/worker-trace-format.ts";
import { type BrowserVirtualFile, getActiveBrowserVirtualFiles } from "../protocol/browser-virtual-files.ts";
import { isBrowserRuntime } from "../shared/runtime-env.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../shared/worker-storage/storage-layout.ts";
import {
  getRomWeaverRunEventElapsedMs,
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
  threadWorkerUrl?: string;
  wasmUrl?: string;
};

type RunnerCreateOptions = { workerThreads?: RuntimeValue };

// Warm idle runners kept for reuse between operations, scaled to the machine: about half the thread
// budget, floored at 2 so reuse always works and capped so a high-core machine doesn't hold an
// unbounded number of idle wasm heaps. How many operations actually run at once is bounded separately
// by the thread budget (the scheduler's maxConcurrency below).
const MAX_WARM_IDLE_RUNNERS = 8;
const resolveWarmIdleRunners = (): number =>
  Math.max(2, Math.min(MAX_WARM_IDLE_RUNNERS, Math.ceil(getDefaultBrowserThreadCount() / 2)));

// Seed forwarded to freshly created runners so their initial worker-shell pool matches the resolved
// "auto" thread count; set by warmup and reused for on-demand runner creation.
let runnerCreateWorkerThreads: RuntimeValue | undefined;

let runnerPool: RunnerPool<RomWeaverRunner, RunnerCreateOptions> | null = null;
let operationScheduler: OperationScheduler | null = null;

// Upper bound on waiting for a worker to acknowledge a graceful dispose before terminating it
// anyway. A worker stuck in a synchronous wait (abandoned selection prompt, wedged op) never
// replies, and dispose must not hang resets behind it.
const RUNNER_DISPOSE_GRACE_MS = 2000;

// --- pre-extract-gap experiments (perf/pre-extract-gap) -----------------------------------------
// The wasm heap only ever grows. The page-load warmup (and the 8-thread pool init) leaves the shared
// worker's heap near the cap, so the first real op OOMs and forces a worker recycle ON the critical
// path (~2.5s observed: dispatch a `list`/`extract`, OOM, then tear down the wedged worker + stand up
// a replacement before the extract can run). These three toggles attack that; flip any to false to
// A/B test its contribution. (#4 — caching the compiled WebAssembly.Module — is intentionally NOT
// implemented: the post-recycle instantiate measured ~25ms, i.e. the browser already caches the
// compiled module, so recompile is not the cost; the recycle teardown is.)
//
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
  // #1: after warmup, recycle the heap-dirtied worker to a fresh clean-heap one while still idle, so the
  //     first real op starts clean and never pays an OOM-triggered recycle on the critical path.
  recycleRunnerAfterWarmup: true,
};

// Page-thread cache of the compiled wasm module (#4), keyed by wasm URL so a changed asset recompiles.
let cachedBrowserWasmModule: { module: WebAssembly.Module; wasmUrl: string } | null = null;

// Single-flight guard for the page-thread compile (#4b). The runtime preload fires the `compression`
// and `checksum` capability warmups in parallel, so without this both miss the still-empty cache and
// each compiles the full ~6 MB module (observed as a doubled "compiling on page thread" every boot).
// Coalesce concurrent first compiles for the same URL onto one in-flight promise.
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
  let directCount = 0;
  let proxyCount = 0;
  let totalBytes = 0;
  for (const file of files) {
    if (file.proxy) {
      proxyCount += 1;
      totalBytes += file.proxy.size || 0;
    }
    if (file.source) {
      directCount += 1;
      const source = file.source as Blob | Uint8Array | ArrayBuffer;
      totalBytes +=
        source instanceof Uint8Array || source instanceof ArrayBuffer ? source.byteLength : source.size || 0;
    }
  }
  return {
    count: files.length,
    directCount,
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

const resolveBrowserRunnerWorkerUrl = async () => browserRunnerWorkerUrl;

const canUseThreadedBrowserWasm = (root: typeof globalThis = globalThis) => {
  return typeof root.SharedArrayBuffer === "function" && root.crossOriginIsolated === true;
};

const resolveBrowserWasmAsset = async (): Promise<BrowserWasmAssetSelection> => {
  if (!canUseThreadedBrowserWasm()) {
    throw new Error("rom-weaver browser runtime requires SharedArrayBuffer and cross-origin isolation (COOP/COEP).");
  }
  const [wasmUrl, threadWorkerUrl] = await Promise.all([resolveBrowserWasmUrl(), resolveBrowserThreadWorkerUrl()]);
  return { threadWorkerUrl, wasmUrl };
};

const normalizeRunnerDefaultThreads = (workerThreads?: RuntimeValue) => {
  // Seed the thread-worker warm-up pool with the same count "auto" resolves to at run time
  // (max(4, hardwareConcurrency)) so the first command does not have to spawn extra worker shells.
  if (workerThreads === undefined || workerThreads === null) return getDefaultBrowserThreadCount();
  const raw = String(workerThreads).trim();
  if (!raw || raw.toLowerCase() === "auto") return getDefaultBrowserThreadCount();
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
};

const createBrowserRunnerInitOptions = (
  wasmAsset: BrowserWasmAssetSelection,
  options?: { workerThreads?: RuntimeValue },
  wasmModule?: WebAssembly.Module,
) => {
  const defaultThreads = normalizeRunnerDefaultThreads(options?.workerThreads);
  return {
    runtimeMounts: [WORKER_OPFS_MOUNTPOINT],
    // Pass the precompiled module when cached (#4); keep wasmUrl as the worker-side compile fallback.
    ...(wasmModule ? { module: wasmModule } : {}),
    ...(wasmAsset.wasmUrl ? { wasmUrl: wasmAsset.wasmUrl } : {}),
    ...(wasmAsset.threadWorkerUrl ? { threadWorkerUrl: wasmAsset.threadWorkerUrl } : {}),
    ...(defaultThreads ? { defaultThreads } : {}),
    workGuestPath: WORKER_OPFS_MOUNTPOINT,
  };
};

/** Resolves a mid-run candidate selection request `{mode, heading, candidates:[{value,label}]}` to
 * the chosen 0-based indices (an empty array cancels). Single-select prompts resolve to one index;
 * multi-select prompts may resolve to several. Runs on the main thread. */
type InputSelectionHandler = (request: string) => number[] | Promise<number[]>;

let inputSelectionHandler: InputSelectionHandler | undefined;

/** Register the UI selection handler invoked when the wasm app needs the user to pick an input
 * candidate. When unset, selection is cancelled (returns -1) — the app always registers a handler. */
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
        logger.trace("input selection requested but no handler registered — cancelling", {
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

const createBrowserRunner = async (options?: { workerThreads?: RuntimeValue }): Promise<RomWeaverRunner> => {
  const runnerWorkerUrl = await resolveBrowserRunnerWorkerUrl();
  const client = createBrowserWorkerClient({ workerUrl: runnerWorkerUrl }) as unknown as RomWeaverWorkerClient;
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
      // Gracefully release the worker's resources (OPFS sync access handles, thread pool) first,
      // then terminate the Worker thread itself. `dispose()` alone leaves the worker — and its wasm
      // linear memory, which only ever grows — alive, so recycling it would leak the grown heap.
      // The graceful request must be time-bounded: a worker blocked in a synchronous wait (e.g. an
      // interactive selection prompt that was abandoned mid-flight) never acknowledges dispose, and
      // an unbounded await here deadlocks every later reset/warmup behind it.
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
      totalThreadBudget: threadBudget,
    });
  }
  return operationScheduler;
};

const resetRomWeaverRunner = async (options: { terminate?: boolean } = {}) => {
  if (!runnerPool) return;
  await runnerPool.disposeAll(options);
};

const markRomWeaverRunnerStale = () => {
  runnerPool?.markAllStale();
};

// #1: Drop heap-dirtied idle runners and stand up a fresh clean-heap one. Meant to run during idle
// (right after warmup) so the user's first real op starts on a clean heap and never pays an
// out-of-memory worker recycle on the critical path. No-op while any runner has work in flight.
const recycleWarmRomWeaverRunner = async (workerThreads?: RuntimeValue) => {
  if (!PRE_EXTRACT_GAP.recycleRunnerAfterWarmup) return;
  if (!isBrowserRuntime()) return;
  const pool = getRunnerPool();
  if (pool.busyCount !== 0) return;
  await pool.disposeAll();
  await warmupRomWeaverRunner(workerThreads ?? runnerCreateWorkerThreads);
};

// Back-to-back ops should be as fast as the first. The wasm heap only ever grows, so a runner that just
// ran a heavy op sits closer to its memory cap; reusing it makes the next op slower (and eventually
// forces an out-of-memory recycle onto the critical path). After a heavy op, once the runtime goes
// quiet, recycle to a fresh clean-heap runner (which the eager pool pre-warm re-warms) so the next
// action starts from the same clean+warm baseline as the first. Debounced + idle-gated so a burst of
// back-to-back ops never recycles mid-burst — the warm runner stays available for immediate reuse, and
// only a genuine pause stands up the clean replacement. Skipped for light ops, whose heap growth is
// small enough that the reactive out-of-memory recycle already covers the rare exhaustion.
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

// The wasm runner's linear memory only ever grows, so the browser surfaces an exhausted heap as an
// out-of-memory error. V8 reports it as `RangeError: Out of memory`, but the wasi/Emscripten layer
// can also surface "cannot enlarge memory", "ENOMEM", etc. — reuse the canonical matcher so every
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
  const threadBudget = getDefaultBrowserThreadCount();
  // probe/list spawn no workers (0 budget). Threaded commands request "auto" (the full budget), but
  // most do not use every core — gate the scheduler on the threads the operation will realistically use
  // (a single-threaded apply reserves 1, not all of them) so light operations can overlap.
  const requestedThreads = readRomWeaverRequestedThreadCount(commandOrRequest, { defaultThreads: threadBudget });
  const requested = romWeaverCommandSupportsThreads(command) ? (requestedThreads ?? threadBudget) : 0;
  const inputBytes = describeVirtualFilesForTrace(scopedActiveVirtualFiles).totalBytes;
  const operationThreads = estimateScheduledThreads(command, inputBytes, requested);
  // Estimate the working set from the staged input sizes so the scheduler can refuse to overlap two
  // operations whose combined memory would exhaust the device.
  const operationBytes = estimateOpWorkingSetBytes(command, inputBytes);

  const dispatchRun = async (): Promise<RomWeaverRunnerRunJsonResult> => {
    if (signal?.aborted) throw createRunnerAbortError();
    const lease = await getRunnerPool().acquire({ workerThreads: runnerCreateWorkerThreads });
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
          // Terminate only this operation's runner — a sibling operation on another pooled runner keeps
          // running, unlike the previous singleton where any abort tore down the shared worker.
          emitRunnerTraceLine(options, "runJson aborted; terminating active runner");
          lease.terminate();
          reject(createRunnerAbortError());
        };
        if (signal) {
          signal.addEventListener("abort", abortRun, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", abortRun);
        }
        // Hand this operation its fair slice of the shared thread budget. By the time dispatch runs,
        // every sibling fired in the same tick has already been admitted (acquire is async), so the
        // count reflects the true concurrency: a lone op keeps the whole budget, but K concurrent ops
        // each cap to budget/K so their WASI thread pools sum to the budget instead of each grabbing it
        // whole (which oversubscribed the pool → `os error 6` → single-thread fallback). Divide only
        // across *thread-requesting* ops: a concurrent 0-thread op (a probe, or a single-threaded patch
        // validate/apply staged alongside a heavy extract) competes for a runner but not for the thread
        // pool, so counting it would needlessly halve the heavy op's threads. This is the browser
        // counterpart of the Rust planner's fair_thread_allotment; the scheduler's memory/concurrency
        // gates above already decided *which* ops may overlap.
        const concurrency = Math.max(1, getOperationScheduler().inFlightThreadedCount);
        const dispatchInput =
          romWeaverCommandSupportsThreads(command) && concurrency > 1
            ? withRomWeaverForcedThreads(commandOrRequest, Math.max(1, Math.floor(threadBudget / concurrency)))
            : commandOrRequest;
        if (dispatchInput !== commandOrRequest) {
          emitRunnerTraceLine(
            options,
            `runJson thread allotment concurrency=${concurrency} threadBudget=${threadBudget} threadsPerOp=${Math.max(1, Math.floor(threadBudget / concurrency))}`,
          );
        }
        lease.runner.runJson(dispatchInput, runOptions).then(
          (result) => {
            if (settled) return;
            settled = true;
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
      // No-op if the runner was terminated above; otherwise returns the warm runner to the pool (or
      // disposes it when marked stale).
      lease.release();
      // After a heavy op, restore the clean-heap baseline during the next idle gap (debounced) so a
      // following op starts as fast as the first instead of on a heap left near its cap.
      scheduleIdleRecycle(operationBytes);
    }
  };

  // Stamp the perceived-latency start on the main thread: `submittedAtMs` is when
  // the command enters the scheduler; the measure fires when the worker replies.
  // A thread-capable command is the heavy work the user is waiting on, so it (not
  // a preceding probe `list`) closes the drop -> done arc.
  const submittedAtMs = perfNow();
  const threadCapable = romWeaverCommandSupportsThreads(command);
  const result = await getOperationScheduler().schedule(
    { bytes: operationBytes, label: command.type, paths: operationPaths, threads: operationThreads },
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

// Normalize a worker-threads seed so "auto"/numbers/undefined compare by surface value; used only to
// detect a thread-budget *change* between warmups.
const normalizeWorkerThreadsSeed = (value: RuntimeValue | undefined): string =>
  value == null ? "" : String(value).trim().toLowerCase();

const warmupRomWeaverRunner = async (workerThreads?: RuntimeValue) => {
  if (!isBrowserRuntime()) throw new Error("rom-weaver wasm runner is only available in browser runtimes");
  // A thread-budget change must not silently reuse the old warm pool: getRunnerPool().acquire reuses a
  // warm idle runner regardless of the requested thread count, so without this the next op keeps the
  // stale-sized pool and grows it on demand. Drop the pooled runners when the seed changes so a fresh
  // runner is created at the new budget and self-pre-warms to it — keeping ops warm after a thread change.
  const seedChanged =
    normalizeWorkerThreadsSeed(runnerCreateWorkerThreads) !== normalizeWorkerThreadsSeed(workerThreads);
  runnerCreateWorkerThreads = workerThreads;
  if (seedChanged) markRomWeaverRunnerStale();
  const lease = await getRunnerPool().acquire({ workerThreads });
  try {
    return lease.runner.ready;
  } finally {
    lease.release();
  }
};

const getRomWeaverRunnerMetadata = async () => {
  if (!isBrowserRuntime()) throw new Error("rom-weaver wasm runner is only available in browser runtimes");
  const lease = await getRunnerPool().acquire({ workerThreads: runnerCreateWorkerThreads });
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
  } catch (_err) {
    // diagnostics are best-effort
  }
};

const getResourceName = (urlLike: string) => {
  try {
    const url = new URL(urlLike, globalThis.location?.href || "http://localhost/");
    return url.pathname.split("/").filter(Boolean).pop() || "rom-weaver-app.wasm";
  } catch (_err) {
    return urlLike.split("/").filter(Boolean).pop() || "rom-weaver-app.wasm";
  }
};

const getErrorMessage = (value: unknown) => {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (value instanceof Error) return String(value.message || "").trim();
  if (typeof value === "object") {
    const record = value as { message?: unknown; kind?: unknown; context?: unknown };
    const message =
      typeof record.message === "string" && record.message.trim()
        ? record.message.trim()
        : typeof record.kind === "string" && record.kind.trim()
          ? `rom-weaver error (${record.kind.trim()})`
          : "";
    if (!message) return "";
    if (!(record.context && typeof record.context === "object")) return message;
    const command =
      "command" in record.context && typeof (record.context as { command?: unknown }).command === "string"
        ? (record.context as { command: string }).command.trim()
        : "";
    const stage =
      "stage" in record.context && typeof (record.context as { stage?: unknown }).stage === "string"
        ? (record.context as { stage: string }).stage.trim()
        : "";
    if (!(command || stage)) return message;
    const contextParts = [command ? `command=${command}` : "", stage ? `stage=${stage}` : ""].filter((part) => !!part);
    return `${message} (${contextParts.join(", ")})`;
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
  recycleWarmRomWeaverRunner,
  resetRomWeaverRunner,
  runRomWeaverJson,
  setInputSelectionHandler,
  warmupRomWeaverRunner,
};
