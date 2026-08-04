import * as wasiShim from "@bjorn3/browser_wasi_shim";
import { DEFAULT_WORK_GUEST_PATH } from "./browser-opfs-constants.ts";
import {
  buildBrowserOpfsWasiFds,
  cleanupBrowserOpfsMounts,
  createBrowserOpfsMountCache,
  normalizeKnownInputPaths,
  normalizeMountHandleMap,
  normalizeVirtualFiles,
  normalizeWritableRoots,
} from "./browser-opfs-mounts.ts";
import { browserProxyAdapterBufferBytes } from "./browser-opfs-proxy-file.ts";
import { startOpfsProxyRuntime } from "./browser-opfs-proxy-runtime.ts";
import type { OpfsProxyMountBootstrap } from "./browser-opfs-proxy-server.ts";
import {
  assertDedicatedWorkerRuntime,
  assertDirectoryHandle,
  canUseThreadedWasmRuntime,
  normalizeRuntimeMounts,
  resolveBrowserModule,
  verifyWritableOpfsRoot,
} from "./browser-opfs-runtime-env.ts";
import type {
  BrowserOpfsCreateOptions,
  BrowserOpfsRunOptions,
  RomWeaverBrowserSyncAccessMode,
  RomWeaverRunInput,
  RomWeaverRunJsonEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
  RomWeaverRunOutput,
  RomWeaverRunRequest,
  RomWeaverRunResult,
  WasiStartInstance,
} from "./browser-opfs-runtime-types.ts";
import {
  basenameForTrace,
  createLineTrace,
  decodeChunks,
  formatCommandForTrace,
  formatErrorForTrace,
  installDirectWasiFileIoImports,
  summarizeNormalizedVirtualFiles,
  traceDirectWasiFileIoStats,
  traceFlushOpenWasiFileDescriptors,
  traceRandomAccessFileIoStats,
} from "./browser-opfs-stdio-events.ts";
import { closeSyncFiles } from "./browser-opfs-sync-access.ts";
import { cleanupBrowserOpfsRunScratch } from "./browser-opfs-run-cleanup.ts";
import type { NormalizedVirtualFile } from "./browser-opfs-virtual-files.ts";
import { attachThreadWorkerCensus, readThreadWorkerCensus } from "./browser-wasi-thread-census.ts";
import {
  browserThreadRequestOptions,
  createBrowserWasiThreadSpawner,
  createBrowserWasiThreadWorkerPool,
  createSharedThreadMemory,
  DEFAULT_BROWSER_THREAD_COUNT,
  needsEnvMemoryImport,
  needsWasiThreadSpawnImport,
  parseRequestedThreadCount,
  resolveBrowserThreadPoolSizeFromCount,
  throwWithThreadFailure,
} from "./browser-wasi-thread-pool.ts";
import { createThreadIdState } from "./browser-wasi-thread-protocol.ts";
import {
  clampRomWeaverBrowserThreadRequest,
  normalizeRomWeaverRunRequest,
  readRomWeaverRunRequestCommand,
  withRomWeaverDefaultThreads,
} from "./rom-weaver-command.ts";
import {
  createJsonLineParser,
  createTraceJsonLineParser,
  createWasmEnvImports,
  normalizeGuestPath,
} from "./rom-weaver-runtime-utils.ts";
import type { RomWeaverEnv } from "./rom-weaver-types.d.ts";
import { normalizeDefaultThreads, resolveBrowserDefaultThreads } from "./workers/browser-thread-budget.ts";
import { createVfsPathId } from "../storage/vfs/path-id.ts";

const DEFAULT_BROWSER_RAYON_GLOBAL_THREADS = DEFAULT_BROWSER_THREAD_COUNT;
const MAX_BROWSER_RAYON_GLOBAL_THREADS = 8;
type BrowserOpfsProxyRuntime = Awaited<ReturnType<typeof startOpfsProxyRuntime>>;
type BrowserThreadSpawner = ReturnType<typeof createBrowserWasiThreadSpawner>;
type BrowserOpfsMountCache = ReturnType<typeof createBrowserOpfsMountCache>;

const invalidateMountCacheBeforeRun = async ({
  enabled,
  mountCache,
  runtimeMounts,
  trace,
}: {
  enabled: boolean;
  mountCache: BrowserOpfsMountCache;
  runtimeMounts: string[];
  trace: (message: string) => void;
}) => {
  if (!enabled) return;
  trace("[browser-opfs] invalidate mount cache before run start");
  await mountCache.invalidateMountPaths(runtimeMounts);
  trace("[browser-opfs] invalidate mount cache before run done");
};

const assertThreadedRuntimeIfNeeded = (threaded: boolean, wasmUrl: string | null) => {
  if (threaded) assertThreadedWasmRuntimeSupported({ wasmUrl });
};

const registerProxyBlobInputs = (
  virtualFiles: NormalizedVirtualFile[],
  opfsProxy: BrowserOpfsProxyRuntime,
  trace: (message: string) => void,
) => {
  const proxyBlobInputs = virtualFiles.filter(
    (file): file is NormalizedVirtualFile & { source: Blob } =>
      Boolean(file.useProxyHandle) && file.source instanceof Blob,
  );
  for (const file of proxyBlobInputs) {
    opfsProxy.registerBlobSource(file.path, file.source);
    trace(`[browser-opfs] proxy blob source registered path=${file.path} size=${file.source.size}`);
  }
  return proxyBlobInputs;
};

const createRunThreadSpawner = ({
  options,
  runOptions,
  threadWorkerPool,
  ...runtime
}: Parameters<typeof createBrowserWasiThreadSpawner>[0] & {
  options: BrowserOpfsCreateOptions;
  runOptions: BrowserOpfsRunOptions;
  threadWorkerPool: ReturnType<typeof createBrowserWasiThreadWorkerPool> | null;
}) =>
  createBrowserWasiThreadSpawner({
    ...runtime,
    threadWorkerPool: getRunThreadWorkerPool(options, runOptions, threadWorkerPool),
    threadWorkerUrl: runOptions.threadWorkerUrl ?? options.threadWorkerUrl,
  });

const getRunThreadWorkerPool = (
  options: BrowserOpfsCreateOptions,
  runOptions: BrowserOpfsRunOptions,
  threadWorkerPool: ReturnType<typeof createBrowserWasiThreadWorkerPool> | null,
) => (runOptions.threadWorkerUrl && runOptions.threadWorkerUrl !== options.threadWorkerUrl ? null : threadWorkerPool);

/**
 * Everything a run derives by layering this call's overrides over the runner's
 * own options. Kept together so `run` reads as a sequence of steps rather than
 * a wall of fallback chains.
 */
const resolveRunSettings = (options: BrowserOpfsCreateOptions, runOptions: BrowserOpfsRunOptions) => ({
  debugWasi: Boolean(runOptions.debugWasi ?? options.debugWasi ?? false),
  knownInputPaths: normalizeKnownInputPaths([
    ...(Array.isArray(options.knownInputPaths) ? options.knownInputPaths : []),
    ...(Array.isArray(runOptions.knownInputPaths) ? runOptions.knownInputPaths : []),
  ]),
  virtualFiles: normalizeVirtualFiles([
    ...(Array.isArray(options.virtualFiles) ? options.virtualFiles : []),
    ...(Array.isArray(runOptions.virtualFiles) ? runOptions.virtualFiles : []),
  ]),
  virtualOnlyMounts: Boolean(runOptions.virtualOnlyMounts ?? options.virtualOnlyMounts ?? false),
});

/**
 * The per-op latency breakdown, logged once teardown finishes. `setup` is the
 * "before the operation starts" cost, `compute` is wasi.start itself, and
 * `teardown` is the drain/flush/cleanup after it returns.
 */
const traceRunTimings = (
  trace: (line: string) => void,
  input: {
    command: unknown;
    computeDoneAtMs: number | null;
    exitCode: number | null;
    request: RomWeaverRunRequest;
    runEndedAtMs: number;
    runStartedAtMs: number;
    runSucceeded: boolean;
    setupDoneAtMs: number | null;
    stagingMs: number | undefined;
  },
) => {
  const { computeDoneAtMs, runEndedAtMs, runStartedAtMs, setupDoneAtMs } = input;
  const setupMs = setupDoneAtMs === null ? null : setupDoneAtMs - runStartedAtMs;
  const computeMs = setupDoneAtMs === null || computeDoneAtMs === null ? null : computeDoneAtMs - setupDoneAtMs;
  const teardownMs = computeDoneAtMs === null ? null : runEndedAtMs - computeDoneAtMs;
  const fmt = (value: number | null): string => (value === null ? "n/a" : value.toFixed(1));
  // `threads` is the requested budget (>1 = thread pool engaged, which is what setupMs mostly
  // measures on a cold runner). stagingMs = OPFS input copy-in time (recorded on the main
  // thread); 0 = already on OPFS, n/a = nothing staged (e.g. virtual-Blob input).
  const stagingMsFmt = typeof input.stagingMs === "number" ? input.stagingMs.toFixed(1) : "n/a";
  trace(
    `[perf] command timings command=${formatCommandForTrace(input.command)}` +
      ` threads=${parseRequestedThreadCount(input.request) ?? 1} exitCode=${input.exitCode === null ? "n/a" : input.exitCode}` +
      ` stagingMs=${stagingMsFmt} setupMs=${fmt(setupMs)} computeMs=${fmt(computeMs)} teardownMs=${fmt(teardownMs)}` +
      ` totalMs=${(runEndedAtMs - runStartedAtMs).toFixed(1)} succeeded=${input.runSucceeded}`,
  );
};

/**
 * Runs the guest to completion. A throw here is re-raised through
 * `throwWithThreadFailure` so a worker-side crash replaces the opaque trap.
 */
const startWasiInstance = async (input: {
  instance: WasiStartInstance;
  setupMs: number;
  threadSpawner: BrowserThreadSpawner;
  trace: (message: string) => void;
  wasi: wasiShim.WASI;
}): Promise<number> => {
  const { trace } = input;
  try {
    trace(`[perf] wasi.start start setupMs=${input.setupMs.toFixed(1)}`);
    return input.wasi.start(input.instance);
  } catch (error) {
    trace(`[browser-opfs] wasi.start threw ${formatErrorForTrace(error)}`);
    await throwWithThreadFailure(error, input.threadSpawner);
    // throwWithThreadFailure always throws; this unreachable rethrow keeps the
    // return type free of undefined for the success path.
    throw error;
  }
};

/**
 * Two gauges sampled before teardown, so they report what the run actually held
 * rather than what cleanup left behind. Handle `live` tracking an archive's entry
 * count is the many-small-files fan-out that kills iOS tabs (one SyncAccessHandle
 * plus its coalescing buffers per entry); it must stay bounded by concurrency. The
 * worker census is its companion: a dedicated Worker per unit of work rather than
 * per unit of concurrency is a ~7 MB wasm instantiation each time. `total` spans
 * the runner's whole lifetime, `created` only this run.
 */
const traceRunResourceStats = (
  trace: (message: string) => void,
  handleStats: { live: number; opened: number; peak: number },
  threadWorkersAtRunStart: number,
) => {
  trace(
    `[perf] opfs proxy handles live=${handleStats.live} peak=${handleStats.peak} opened=${handleStats.opened}` +
      ` adapterBufferBytes=${browserProxyAdapterBufferBytes()}`,
  );
  const threadWorkersTotal = readThreadWorkerCensus();
  trace(
    `[perf] thread workers created=${threadWorkersTotal === null ? "n/a" : threadWorkersTotal - threadWorkersAtRunStart}` +
      ` total=${threadWorkersTotal ?? "n/a"}`,
  );
};

const createRunWasmMemory = (importsEnvMemory: boolean, options: BrowserOpfsCreateOptions) =>
  importsEnvMemory
    ? createSharedThreadMemory({
        initialPages: options.sharedMemoryInitialPages,
        maximumPages: options.sharedMemoryMaximumPages,
      })
    : undefined;

const createThreadSpawnerDrain = (threadSpawner: BrowserThreadSpawner) => {
  let drained = false;
  return async () => {
    if (drained) return;
    drained = true;
    await threadSpawner.ready.catch(() => {
      // drain regardless of readiness failures; the run error surfaces elsewhere
    });
    await threadSpawner.waitForWorkers().catch(() => {
      // drain best-effort; worker failures already surfaced through the run result
    });
  };
};

export async function createRomWeaverBrowserOpfs(options: BrowserOpfsCreateOptions = {}) {
  assertDedicatedWorkerRuntime();

  const workGuestPath = normalizeGuestPath(options.workGuestPath ?? options.opfsGuestPath ?? DEFAULT_WORK_GUEST_PATH, {
    label: "workGuestPath",
  });
  const opfsHandle = options.opfsHandle ?? (await navigator.storage.getDirectory());
  assertDirectoryHandle(opfsHandle, "opfsHandle");
  await verifyWritableOpfsRoot(opfsHandle);

  const { module, wasmUrl, wasmByteLength, wasmSha } = await resolveBrowserModule({
    module: options.module,
    wasmUrl: options.wasmUrl,
  });
  const moduleImports = WebAssembly.Module.imports(module);
  const importsEnvMemory = needsEnvMemoryImport(moduleImports);
  const importsWasiThreadSpawn = needsWasiThreadSpawnImport(moduleImports);
  const threaded = importsEnvMemory || importsWasiThreadSpawn;
  assertThreadedRuntimeIfNeeded(threaded, wasmUrl);
  const runtimeMounts = normalizeRuntimeMounts(options.runtimeMounts ?? [workGuestPath]);
  const baseMountHandles = normalizeMountHandleMap({
    mountHandles: {
      [workGuestPath]: opfsHandle,
      ...options.mountHandles,
    },
  });
  const baseWritableRoots = normalizeWritableRoots({
    workGuestPath,
    writableDirectories: options.writableDirectories,
  });
  const baseDefaultThreads = resolveConfiguredDefaultThreads(options, resolveBrowserDefaultThreads());
  const mountCache = createBrowserOpfsMountCache();
  const baseSyncAccessMode = resolveRunSyncAccessMode({ baseMode: options.syncAccessMode, threaded });
  // One lifetime proxy owns every OPFS handle for runner and compute threads,
  // satisfying WebKit exclusivity. Safari cannot clone directory handles to a
  // nested worker, so send root-relative mount paths for the proxy to resolve.
  const opfsRootForResolve = await navigator.storage.getDirectory();
  const proxyMounts: OpfsProxyMountBootstrap[] = [];
  // Spawned WASI threads cannot receive the directory handles either, so they re-derive them from
  // the same root-relative paths. Without this a mount that is not the OPFS root silently resolves
  // to the root inside every thread, and the guest sees ENOENT for files that plainly exist.
  const mountRootRelativeParts: Record<string, string[]> = {};
  for (const mountPath of runtimeMounts) {
    const directoryHandle = baseMountHandles[mountPath];
    if (!directoryHandle) continue;
    const rootRelativeParts = (await opfsRootForResolve.resolve(directoryHandle as unknown as FileSystemHandle)) ?? [];
    proxyMounts.push({ mountPath, rootRelativeParts, writableRoots: baseWritableRoots });
    mountRootRelativeParts[mountPath] = rootRelativeParts;
  }
  const opfsProxy = await startOpfsProxyRuntime({
    mounts: proxyMounts,
    slotCount: resolveBrowserThreadPoolSizeFromCount(baseDefaultThreads ?? resolveBrowserDefaultThreads()) + 4,
    syncAccessMode: baseSyncAccessMode,
    workerUrl: options.opfsProxyWorkerUrl,
  });
  // Attach the thread-worker census before anything can create a thread worker: the pool starts
  // pre-warming the moment it is constructed, so its shells would otherwise go uncounted.
  attachThreadWorkerCensus(opfsProxy.transfer);
  const threadWorkerPool =
    threaded && importsWasiThreadSpawn
      ? createBrowserWasiThreadWorkerPool({
          initialSize: resolveBrowserThreadPoolSizeFromCount(baseDefaultThreads ?? resolveBrowserDefaultThreads()),
          threadWorkerUrl: options.threadWorkerUrl,
        })
      : null;
  // The wasi thread pool pre-warms itself to `initialSize` after a short idle delay (see
  // browser-wasi-thread-pool.ts). Runner init does not wait on it: warmup and small non-threaded ops
  // never need the shells, and threaded runs grow the pool on demand.

  const runner = {
    async dispose() {
      await mountCache.dispose();
      await threadWorkerPool?.dispose();
      await opfsProxy.stop();
    },

    async run(
      commandOrRequest: RomWeaverRunInput,
      runOptions: BrowserOpfsRunOptions = {},
    ): Promise<RomWeaverRunResult> {
      const runDefaultThreads = resolveConfiguredDefaultThreads(runOptions, baseDefaultThreads);
      const request = clampRomWeaverBrowserThreadRequest(
        withRomWeaverDefaultThreads(
          normalizeRomWeaverRunRequest(commandOrRequest, readRunOutputOverrides(runOptions)),
          runDefaultThreads,
        ),
        browserThreadRequestOptions(runDefaultThreads ?? resolveBrowserDefaultThreads()),
      );
      const command = readRomWeaverRunRequestCommand(request);
      const trace = createLineTrace(runOptions?.onTraceNonJsonLine);
      // Surface the (once-per-runner) proxy worker's traces through this run's trace channel.
      opfsProxy.setTrace(trace);
      trace(
        `[browser-opfs] run start command=${formatCommandForTrace(command)} threaded=${threaded} wasm=${basenameForTrace(wasmUrl)} wasmBytes=${wasmByteLength ?? "?"} wasmSha=${wasmSha || "?"}`,
      );
      await invalidateMountCacheBeforeRun({
        enabled: !!runOptions.invalidateMountCacheBeforeRun,
        mountCache,
        runtimeMounts,
        trace,
      });
      const env = createRunEnv({
        requestedThreadCount: parseRequestedThreadCount(request),
        runEnv: runOptions.env,
        threaded,
      });
      const opfsRunId = createVfsPathId();
      env.ROM_WEAVER_OPFS_RUN_ID = opfsRunId;
      const envList = Object.entries(env).map(([key, value]) => `${key}=${String(value)}`);
      const wasmMemory = createRunWasmMemory(importsEnvMemory, options);
      const threadIdState = createThreadIdState();
      const mountHandles = {
        ...baseMountHandles,
        ...normalizeMountHandleMap({ mountHandles: runOptions.mountHandles }),
      };
      const settings = resolveRunSettings(options, runOptions);
      const { debugWasi, knownInputPaths, virtualFiles } = settings;
      trace(`[browser-opfs] virtual files normalized ${summarizeNormalizedVirtualFiles(virtualFiles)}`);

      // Hand any proxy-handle Blob inputs to the OPFS proxy worker so it serves them by guest path
      // (single Blob owner, no per-thread FileReaderSync, no staging copy). Registered before the fd
      // build so it is in place before any thread opens the path; unregistered in the finally below.
      const proxyBlobInputs = registerProxyBlobInputs(virtualFiles, opfsProxy, trace);

      const closeables: { close(): unknown }[] = [];
      let runSucceeded = false;
      // Phase timings for the per-op latency breakdown (logged in the finally below). `setup` is the
      // "before the operation starts" cost - mount/fd build, wasm instantiate, and any thread-pool
      // pre-warm wait up to wasi.start; `compute` is wasi.start itself; `teardown` is the
      // drain/flush/cleanup after it returns ("after finish"). performance.now() is available in workers.
      const nowMs = (): number => (typeof performance === "undefined" ? 0 : performance.now());
      const runStartedAtMs = nowMs();
      const threadWorkersAtRunStart = readThreadWorkerCensus() ?? 0;
      let setupDoneAtMs: number | null = null;
      let computeDoneAtMs: number | null = null;
      let exitCode: number | null = null;
      const resolvedSyncAccessMode = resolveRunSyncAccessMode({
        baseMode: options.syncAccessMode,
        runMode: runOptions.syncAccessMode,
        threaded,
      });
      const wasiArgs = ["rom-weaver"];
      const requestStdin = serializeRunRequestForStdin(request);
      const writableRoots = normalizeWritableRoots({
        inherited: baseWritableRoots,
        workGuestPath,
        writableDirectories: runOptions.writableDirectories,
      });
      const resolvedVirtualOnlyMounts = settings.virtualOnlyMounts;
      const threadSpawner = createRunThreadSpawner({
        options,
        runOptions,
        threadWorkerPool,
        envList,
        moduleImports,
        runtime: {
          cwdMountPath: workGuestPath,
          debugWasi,
          invalidateMountCacheAfterRun: Boolean(runOptions.invalidateMountCacheAfterRun),
          invalidateMountCacheBeforeRun: Boolean(runOptions.invalidateMountCacheBeforeRun),
          knownInputPaths,
          mountHandles,
          mountRootRelativeParts,
          opfsProxyTransfer: opfsProxy.transfer,
          request,
          runtimeMounts,
          syncAccessMode: resolvedSyncAccessMode,
          virtualFiles,
          virtualOnlyMounts: resolvedVirtualOnlyMounts,
          writableRoots,
        },
        streamBroadcastChannelName: runOptions.__streamBroadcastChannelName,
        streamRequestId: runOptions.__streamRequestId,
        threadIdState,
        trace,
        wasiArgs,
        wasmMemory,
        wasmModule: module,
      });
      // Always drain dispatched shells: pre-WASI failures otherwise leave them permanently busy.
      // Shutdown is idempotent, so the success path may drain twice safely.
      const drainThreadSpawnerOnce = createThreadSpawnerDrain(threadSpawner);
      trace(`[browser-opfs] build wasi fds start mounts=${runtimeMounts.length} syncAccess=${resolvedSyncAccessMode}`);
      const { fds, mounts, stdoutCollector, stderrCollector, stdoutChunks, stderrChunks } =
        await buildBrowserOpfsWasiFds({
          cwdMountPath: workGuestPath,
          knownInputPaths,
          mountCache,
          mountHandles,
          proxyClient: opfsProxy.client,
          request,
          runCloseables: closeables,
          runtimeMounts,
          stderrLineHandler: runOptions.onStderrLine,
          stdin: requestStdin,
          stdoutLineHandler: runOptions.onStdoutLine,
          syncAccessMode: resolvedSyncAccessMode,
          trace,
          virtualFiles,
          virtualOnlyMounts: resolvedVirtualOnlyMounts,
          writableRoots,
        }).catch(async (error) => {
          // fd-build aborted after the pool command already claimed shells; release them so the
          // failure cannot wedge the pool for the next run, then surface the original error.
          await drainThreadSpawnerOnce();
          throw error;
        });
      trace(`[browser-opfs] build wasi fds done fds=${fds.length} mounts=${mounts.length}`);
      // Both exits report whatever the run managed to emit, so the flush is shared.
      const flushStreams = () => {
        stdoutCollector.flush();
        stderrCollector.flush();
        return { stderr: decodeChunks(stderrChunks), stdout: decodeChunks(stdoutChunks) };
      };

      try {
        trace("[browser-opfs] instantiate start");
        const wasi = new wasiShim.WASI(wasiArgs, envList, fds, { debug: debugWasi });
        installDirectWasiFileIoImports(wasi, trace);

        const instance = (await WebAssembly.instantiate(module, {
          env: createWasmEnvImports(wasmMemory, runOptions.hostSelect),
          wasi_snapshot_preview1: wasi.wasiImport,
          ...(importsWasiThreadSpawn ? { wasi: { "thread-spawn": threadSpawner.spawn } } : {}),
        })) as WasiStartInstance;
        trace("[browser-opfs] instantiate done");

        trace("[browser-opfs] thread spawner ready wait start");
        await threadSpawner.ready;
        trace("[browser-opfs] thread spawner ready");
        setupDoneAtMs = nowMs();
        exitCode = await startWasiInstance({
          instance,
          setupMs: setupDoneAtMs - runStartedAtMs,
          threadSpawner,
          trace,
          wasi,
        });
        computeDoneAtMs = nowMs();
        trace(
          `[perf] wasi.start returned exitCode=${String(exitCode)} computeMs=${(computeDoneAtMs - setupDoneAtMs).toFixed(1)}`,
        );
        trace("[browser-opfs] waitForWorkers start");
        await threadSpawner.waitForWorkers();
        trace("[browser-opfs] waitForWorkers done");
        traceFlushOpenWasiFileDescriptors(trace, wasi.fds, "[browser-opfs] flush fd write buffers");
        traceDirectWasiFileIoStats(trace, wasi, "[perf] direct file io");
        traceRandomAccessFileIoStats(trace, fds, "[perf] random access file io");
        // Output files are real OPFS files written through the proxy during the run, so there is no
        // end-of-run materialization step: the bytes are already persisted by the time wasi.start returns.
        runSucceeded = true;
        return { command, exitCode, ok: exitCode === 0, request, ...flushStreams() };
      } catch (error) {
        trace(`[browser-opfs] run failed ${formatErrorForTrace(error)}`);
        return { command, error, exitCode: 1, ok: false, request, ...flushStreams() };
      } finally {
        traceRunResourceStats(trace, opfsProxy.client.handleStats(), threadWorkersAtRunStart);
        trace(`[browser-opfs] cleanup start succeeded=${runSucceeded}`);
        // Drain before tearing down mounts (mirrors the success path's waitForWorkers→flush order) so
        // pool workers release their OPFS handles before the mount handles are closed.
        await drainThreadSpawnerOnce();
        closeSyncFiles(closeables);
        // Preserve the existing microtask boundary before listing scratch paths.
        // oxlint-disable-next-line typescript/await-thenable
        await cleanupBrowserOpfsMounts(mounts);
        for (const file of proxyBlobInputs) opfsProxy.unregisterBlobSource(file.path);
        if (!runSucceeded || runOptions.invalidateMountCacheAfterRun) await mountCache.invalidateMounts(mounts);
        try {
          await cleanupBrowserOpfsRunScratch({ runId: opfsRunId, trace, workGuestPath });
        } catch (error) {
          trace(`[browser-opfs] run scratch cleanup failed ${formatErrorForTrace(error)}`);
        }
        trace("[browser-opfs] cleanup done");
        traceRunTimings(trace, {
          command,
          computeDoneAtMs,
          exitCode,
          request,
          runEndedAtMs: nowMs(),
          runStartedAtMs,
          runSucceeded,
          setupDoneAtMs,
          stagingMs: runOptions.stagingMs,
        });
      }
    },

    async runJson<TEvent = RomWeaverRunJsonEvent, TTraceEvent = unknown>(
      commandOrRequest: RomWeaverRunInput,
      runOptions: BrowserOpfsRunOptions & RomWeaverRunJsonOptions<TEvent, TTraceEvent> = {},
    ): Promise<RomWeaverRunJsonResult<TEvent, TTraceEvent>> {
      const trace = createLineTrace(runOptions?.onTraceNonJsonLine);
      const request = normalizeRomWeaverRunRequest(commandOrRequest, {
        ...readRunOutputOverrides(runOptions),
        json: true,
      });
      trace(`[browser-opfs] runJson start command=${formatCommandForTrace(readRomWeaverRunRequestCommand(request))}`);
      const parsed = createJsonLineParser<TEvent>({
        onEvent: runOptions.onEvent,
        onNonJsonLine: runOptions.onNonJsonLine,
      });
      const parsedTrace = createTraceJsonLineParser<TTraceEvent>({
        onTraceEvent: runOptions.onTraceEvent,
        onTraceNonJsonLine: runOptions.onTraceNonJsonLine,
      });
      const result = await this.run(request, {
        ...runOptions,
        onStderrLine(line: string) {
          parsedTrace.pushLine(line);
        },
        onStdoutLine(line: string) {
          parsed.pushLine(line);
        },
      });
      trace(
        `[browser-opfs] runJson done ok=${Boolean(result.ok)} exitCode=${String(result.exitCode)} events=${parsed.events.length} traceEvents=${parsedTrace.traceEvents.length}`,
      );

      return {
        ...result,
        events: parsed.events,
        nonJsonLines: parsed.nonJsonLines,
        traceEvents: parsedTrace.traceEvents,
        traceNonJsonLines: parsedTrace.traceNonJsonLines,
      };
    },
  };

  return {
    dispose: () => runner.dispose(),
    fs: null,
    mode: "browser-opfs",
    opfsGuestPath: workGuestPath,
    opfsHandle,
    run: (commandOrRequest: RomWeaverRunInput, runOptions?: BrowserOpfsRunOptions) =>
      runner.run(commandOrRequest, runOptions),
    runJson: <TEvent = RomWeaverRunJsonEvent, TTraceEvent = unknown>(
      commandOrRequest: RomWeaverRunInput,
      runOptions?: BrowserOpfsRunOptions & RomWeaverRunJsonOptions<TEvent, TTraceEvent>,
    ) => runner.runJson<TEvent, TTraceEvent>(commandOrRequest, runOptions),
    runtimeMounts,
    threaded,
    wasmUrl,
    workGuestPath,
    writableRoots: baseWritableRoots,
  };
}

function createRunEnv({
  runEnv,
  requestedThreadCount,
  threaded,
}: {
  runEnv?: RomWeaverEnv;
  requestedThreadCount: number | null;
  threaded: boolean;
}): RomWeaverEnv {
  const merged = { ...runEnv };
  if (!threaded) return merged;
  applyBrowserThreadedRayonEnvDefaults(merged, requestedThreadCount);
  return merged;
}

function applyBrowserThreadedRayonEnvDefaults(env: RomWeaverEnv, requestedThreadCount: number | null) {
  if (!env || typeof env !== "object") return;
  if (Object.hasOwn(env, "RAYON_NUM_THREADS") || Object.hasOwn(env, "RAYON_RS_NUM_CPUS")) return;
  const resolved = resolveBrowserGlobalRayonThreads(requestedThreadCount);
  env.RAYON_NUM_THREADS = String(resolved);
  env.RAYON_RS_NUM_CPUS = String(resolved);
}

function resolveBrowserGlobalRayonThreads(requestedThreadCount: number | null): number {
  if (requestedThreadCount === null || !Number.isInteger(requestedThreadCount) || requestedThreadCount <= 0) {
    return DEFAULT_BROWSER_RAYON_GLOBAL_THREADS;
  }
  return Math.max(1, Math.min(MAX_BROWSER_RAYON_GLOBAL_THREADS, requestedThreadCount));
}

function readRunOutputOverrides(runOptions: Partial<BrowserOpfsRunOptions> = {}) {
  const output: Partial<RomWeaverRunOutput> & { interactive_selection_enabled?: boolean } = {};
  if (typeof runOptions?.json === "boolean") output.json = runOptions.json;
  if (runOptions?.log_level !== undefined) output.log_level = runOptions.log_level;
  if (typeof runOptions?.dep_trace === "boolean") output.dep_trace = runOptions.dep_trace;
  if (typeof runOptions?.progress === "boolean") output.progress = runOptions.progress;
  if (typeof runOptions?.interactiveSelectionEnabled === "boolean") {
    output.interactive_selection_enabled = runOptions.interactiveSelectionEnabled;
  }
  if (typeof runOptions?.interactive_selection_enabled === "boolean") {
    output.interactive_selection_enabled = runOptions.interactive_selection_enabled;
  }
  return output;
}

function serializeRunRequestForStdin(request: RomWeaverRunRequest): string {
  return `${JSON.stringify(request, runRequestJsonReplacer)}\n`;
}

function runRequestJsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value !== "bigint") return value;
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new TypeError("rom-weaver run request bigint values must fit in a JSON-safe number");
  }
  return Number(value);
}

function resolveConfiguredDefaultThreads(
  options: BrowserOpfsCreateOptions | BrowserOpfsRunOptions,
  fallback: number | null,
): number | null {
  if (options && Object.hasOwn(options, "defaultThreads")) {
    return normalizeDefaultThreads(options.defaultThreads);
  }
  return fallback;
}

function assertThreadedWasmRuntimeSupported({ wasmUrl }: { wasmUrl?: string | null }) {
  if (canUseThreadedWasmRuntime()) return;
  throw new Error(
    `threaded wasm requires SharedArrayBuffer and cross-origin isolation (COOP/COEP); selected ${wasmUrl ?? "WebAssembly.Module"} cannot run in this browser runtime`,
  );
}

function resolveRunSyncAccessMode({
  baseMode,
  runMode,
  threaded,
}: {
  baseMode?: RomWeaverBrowserSyncAccessMode;
  runMode?: RomWeaverBrowserSyncAccessMode;
  threaded?: boolean;
}) {
  if (runMode !== undefined && runMode !== null) return runMode;
  if (baseMode !== undefined && baseMode !== null) return baseMode;
  return threaded ? "readwrite-unsafe" : undefined;
}
