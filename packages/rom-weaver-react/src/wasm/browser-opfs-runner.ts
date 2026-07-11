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
import type { NormalizedVirtualFile } from "./browser-opfs-virtual-files.ts";
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

const DEFAULT_BROWSER_RAYON_GLOBAL_THREADS = DEFAULT_BROWSER_THREAD_COUNT;
const MAX_BROWSER_RAYON_GLOBAL_THREADS = 8;

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
  if (threaded) assertThreadedWasmRuntimeSupported({ wasmUrl });
  const runtimeMounts = normalizeRuntimeMounts(options.runtimeMounts ?? [workGuestPath]);
  const baseMountHandles = normalizeMountHandleMap({
    mountHandles: {
      [workGuestPath]: opfsHandle,
      ...(options.mountHandles ?? {}),
    },
  });
  const baseWritableRoots = normalizeWritableRoots({
    workGuestPath,
    writableDirectories: options.writableDirectories,
  });
  const baseDefaultThreads = resolveConfiguredDefaultThreads(options, resolveBrowserDefaultThreads());
  const threadWorkerPool =
    threaded && importsWasiThreadSpawn
      ? createBrowserWasiThreadWorkerPool({
          initialSize: resolveBrowserThreadPoolSizeFromCount(baseDefaultThreads ?? resolveBrowserDefaultThreads()),
          threadWorkerUrl: options.threadWorkerUrl,
        })
      : null;
  const mountCache = createBrowserOpfsMountCache();
  const baseSyncAccessMode = resolveRunSyncAccessMode({ baseMode: options.syncAccessMode, threaded });
  // The single OPFS-handle-owning proxy worker is spawned once for the runner's lifetime. Every mount -
  // the runner thread and every spawned WASI compute thread - routes its OPFS I/O through it, which is
  // the one model that respects WebKit's "one SyncAccessHandle per file" rule while letting spawned
  // threads (which cannot path_open OPFS files themselves) perform real I/O.
  // Only mount METADATA is posted; the proxy worker re-resolves its own directory handle (Safari/iOS
  // cannot structured-clone a FileSystemDirectoryHandle to a nested worker). For each mount we compute
  // the path from the OPFS root to its handle via `root.resolve(handle)` so the worker can navigate the
  // same directory - empty for the app (the mount IS the root), or subdir segments for a nested handle.
  const opfsRootForResolve = await navigator.storage.getDirectory();
  const proxyMounts: OpfsProxyMountBootstrap[] = [];
  for (const mountPath of runtimeMounts) {
    const directoryHandle = baseMountHandles[mountPath];
    if (!directoryHandle) continue;
    const rootRelativeParts = (await opfsRootForResolve.resolve(directoryHandle as unknown as FileSystemHandle)) ?? [];
    proxyMounts.push({ mountPath, rootRelativeParts, writableRoots: baseWritableRoots });
  }
  const opfsProxy = await startOpfsProxyRuntime({
    mounts: proxyMounts,
    slotCount: resolveBrowserThreadPoolSizeFromCount(baseDefaultThreads ?? resolveBrowserDefaultThreads()) + 4,
    syncAccessMode: baseSyncAccessMode,
    workerUrl: options.opfsProxyWorkerUrl,
  });
  // The wasi thread pool pre-warms itself to `initialSize` after a short idle delay (see
  // browser-wasi-thread-pool.ts). Runner init no longer waits on it: the page-load warmup and small
  // non-threaded ops never need the shells, and threaded runs grow the pool on demand, so a runner
  // becomes usable as soon as its wasm is instantiated instead of after ~all `initialSize` shells spawn.

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
      if (runOptions.invalidateMountCacheBeforeRun) {
        trace("[browser-opfs] invalidate mount cache before run start");
        await mountCache.invalidateMountPaths(runtimeMounts);
        trace("[browser-opfs] invalidate mount cache before run done");
      }
      const env = createRunEnv({
        baseEnv: options.env,
        requestedThreadCount: parseRequestedThreadCount(request),
        runEnv: runOptions.env,
        threaded,
      });
      const envList = Object.entries(env).map(([key, value]) => `${key}=${String(value)}`);
      const wasmMemory = importsEnvMemory
        ? createSharedThreadMemory({
            initialPages: options.sharedMemoryInitialPages,
            maximumPages: options.sharedMemoryMaximumPages,
          })
        : undefined;
      const threadIdState = createThreadIdState();
      const mountHandles = {
        ...baseMountHandles,
        ...normalizeMountHandleMap({ mountHandles: runOptions.mountHandles }),
      };
      const virtualFiles = normalizeVirtualFiles([
        ...(Array.isArray(options.virtualFiles) ? options.virtualFiles : []),
        ...(Array.isArray(runOptions.virtualFiles) ? runOptions.virtualFiles : []),
      ]);
      trace(`[browser-opfs] virtual files normalized ${summarizeNormalizedVirtualFiles(virtualFiles)}`);

      // Hand any proxy-handle Blob inputs to the OPFS proxy worker so it serves them by guest path
      // (single Blob owner, no per-thread FileReaderSync, no staging copy). Registered before the fd
      // build so it is in place before any thread opens the path; unregistered in the finally below.
      const proxyBlobInputs = virtualFiles.filter(
        (file): file is NormalizedVirtualFile & { source: Blob } =>
          Boolean(file.useProxyHandle) && file.source instanceof Blob,
      );
      for (const file of proxyBlobInputs) {
        opfsProxy.registerBlobSource(file.path, file.source);
        trace(`[browser-opfs] proxy blob source registered path=${file.path} size=${file.source.size}`);
      }

      const closeables: { close(): unknown }[] = [];
      let runSucceeded = false;
      // Phase timings for the per-op latency breakdown (logged in the finally below). `setup` is the
      // "before the operation starts" cost - mount/fd build, wasm instantiate, and any thread-pool
      // pre-warm wait up to wasi.start; `compute` is wasi.start itself; `teardown` is the
      // drain/flush/cleanup after it returns ("after finish"). performance.now() is available in workers.
      const nowMs = (): number => (typeof performance === "undefined" ? 0 : performance.now());
      const runStartedAtMs = nowMs();
      let setupDoneAtMs: number | null = null;
      let computeDoneAtMs: number | null = null;
      let exitCode: number | null = null;
      const resolvedSyncAccessMode = resolveRunSyncAccessMode({
        baseMode: options.syncAccessMode,
        runMode: runOptions.syncAccessMode,
        threaded,
      });
      const wasiArgs = [runOptions.program ?? options.program ?? options.argv0 ?? "rom-weaver"];
      const requestStdin = serializeRunRequestForStdin(request);
      const writableRoots = normalizeWritableRoots({
        inherited: baseWritableRoots,
        workGuestPath,
        writableDirectories: runOptions.writableDirectories,
      });
      const resolvedVirtualOnlyMounts = Boolean(runOptions.virtualOnlyMounts ?? options.virtualOnlyMounts ?? false);
      const knownInputPaths = normalizeKnownInputPaths([
        ...(Array.isArray(options.knownInputPaths) ? options.knownInputPaths : []),
        ...(Array.isArray(runOptions.knownInputPaths) ? runOptions.knownInputPaths : []),
      ]);
      const threadSpawner = createBrowserWasiThreadSpawner({
        envList,
        moduleImports,
        runtime: {
          cwdMountPath: workGuestPath,
          debugWasi: Boolean(runOptions.debugWasi ?? options.debugWasi ?? false),
          invalidateMountCacheAfterRun: Boolean(runOptions.invalidateMountCacheAfterRun),
          knownInputPaths,
          mountHandles,
          opfsProxyTransfer: opfsProxy.transfer,
          request,
          runtimeMounts,
          syncAccessMode: resolvedSyncAccessMode,
          virtualFiles,
          writableRoots,
        },
        streamBroadcastChannelName: runOptions.__streamBroadcastChannelName,
        streamRequestId: runOptions.__streamRequestId,
        threadIdState,
        threadWorkerPool:
          runOptions.threadWorkerUrl && runOptions.threadWorkerUrl !== options.threadWorkerUrl
            ? null
            : threadWorkerPool,
        threadWorkerUrl: runOptions.threadWorkerUrl ?? options.threadWorkerUrl,
        trace,
        wasiArgs,
        wasmMemory,
        wasmModule: module,
      });
      // A run can fail before wasi.start (e.g. an OPFS fd-build error) after the thread-pool command
      // has already selected and dispatched its shells. Those shells stay stamped with currentCommand
      // until the command is shut down, so without a guaranteed teardown a failed run permanently
      // wedges the pool and later runs throw "worker N is already busy". command.shutdown() (reached
      // via waitForWorkers) is idempotent, so draining once here is safe even on the success path,
      // which has already drained by the time this finally runs.
      let threadSpawnerDrained = false;
      const drainThreadSpawnerOnce = async () => {
        if (threadSpawnerDrained) return;
        threadSpawnerDrained = true;
        await threadSpawner.ready.catch(() => {
          // drain regardless of readiness failures; the run error surfaces elsewhere
        });
        await threadSpawner.waitForWorkers().catch(() => {
          // drain best-effort; worker failures already surfaced through the run result
        });
      };
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

      try {
        trace("[browser-opfs] instantiate start");
        const wasi = new wasiShim.WASI(wasiArgs, envList, fds, {
          debug: Boolean(runOptions.debugWasi ?? options.debugWasi ?? false),
        });
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
        try {
          setupDoneAtMs = nowMs();
          trace(`[perf] wasi.start start setupMs=${(setupDoneAtMs - runStartedAtMs).toFixed(1)}`);
          exitCode = wasi.start(instance);
          computeDoneAtMs = nowMs();
          trace(
            `[perf] wasi.start returned exitCode=${String(exitCode)} computeMs=${(computeDoneAtMs - setupDoneAtMs).toFixed(1)}`,
          );
        } catch (error) {
          trace(`[browser-opfs] wasi.start threw ${formatErrorForTrace(error)}`);
          await throwWithThreadFailure(error, threadSpawner);
          // throwWithThreadFailure always throws; this unreachable rethrow keeps exitCode
          // definitely assigned for the success path below.
          throw error;
        }
        trace("[browser-opfs] waitForWorkers start");
        await threadSpawner.waitForWorkers();
        threadSpawnerDrained = true;
        trace("[browser-opfs] waitForWorkers done");
        traceFlushOpenWasiFileDescriptors(trace, wasi.fds, "[browser-opfs] flush fd write buffers");
        traceDirectWasiFileIoStats(trace, wasi, "[perf] direct file io");
        traceRandomAccessFileIoStats(trace, fds, "[perf] random access file io");
        // Output files are real OPFS files written through the proxy during the run, so there is no
        // end-of-run materialization step: the bytes are already persisted by the time wasi.start returns.
        runSucceeded = true;
        stdoutCollector.flush();
        stderrCollector.flush();
        const stdout = decodeChunks(stdoutChunks);
        const stderr = decodeChunks(stderrChunks);

        return {
          command,
          exitCode,
          ok: exitCode === 0,
          request,
          stderr,
          stdout,
        };
      } catch (error) {
        trace(`[browser-opfs] run failed ${formatErrorForTrace(error)}`);
        stdoutCollector.flush();
        stderrCollector.flush();
        const stdout = decodeChunks(stdoutChunks);
        const stderr = decodeChunks(stderrChunks);

        return {
          command,
          error,
          exitCode: 1,
          ok: false,
          request,
          stderr,
          stdout,
        };
      } finally {
        trace(`[browser-opfs] cleanup start succeeded=${runSucceeded}`);
        // Drain before tearing down mounts (mirrors the success path's waitForWorkers→flush order) so
        // pool workers release their OPFS handles before the mount handles are closed.
        await drainThreadSpawnerOnce();
        closeSyncFiles(closeables);
        await cleanupBrowserOpfsMounts(mounts);
        for (const file of proxyBlobInputs) opfsProxy.unregisterBlobSource(file.path);
        if (!runSucceeded || runOptions.invalidateMountCacheAfterRun) await mountCache.invalidateMounts(mounts);
        trace("[browser-opfs] cleanup done");
        // Per-op latency breakdown. setup = dispatch→wasi.start (mount/fd build + instantiate + any
        // thread-pool pre-warm wait); compute = wasi.start; teardown = drain/flush/cleanup after it.
        const runEndedAtMs = nowMs();
        const setupMs = setupDoneAtMs === null ? null : setupDoneAtMs - runStartedAtMs;
        const computeMs = setupDoneAtMs === null || computeDoneAtMs === null ? null : computeDoneAtMs - setupDoneAtMs;
        const teardownMs = computeDoneAtMs === null ? null : runEndedAtMs - computeDoneAtMs;
        const fmt = (value: number | null): string => (value === null ? "n/a" : value.toFixed(1));
        // `command` says what ran; `threads` is the requested budget (1 = thread-gated, no pool
        // pre-warm; >1 = the thread pool was engaged, which is what setupMs mostly measures on a cold
        // runner); `exitCode`/`succeeded` are the outcome. setup = dispatch→wasi.start, compute =
        // wasi.start, teardown = drain/flush/cleanup after it.
        // stagingMs = how long this command's OPFS inputs took to copy in (preCommand, recorded on the
        // main thread); 0 = already on OPFS, n/a = nothing referenced was staged (e.g. virtual-Blob input).
        const stagingMsFmt = typeof runOptions.stagingMs === "number" ? runOptions.stagingMs.toFixed(1) : "n/a";
        trace(
          `[perf] command timings command=${formatCommandForTrace(command)}` +
            ` threads=${parseRequestedThreadCount(request) ?? 1} exitCode=${exitCode === null ? "n/a" : exitCode}` +
            ` stagingMs=${stagingMsFmt} setupMs=${fmt(setupMs)} computeMs=${fmt(computeMs)} teardownMs=${fmt(teardownMs)}` +
            ` totalMs=${(runEndedAtMs - runStartedAtMs).toFixed(1)} succeeded=${runSucceeded}`,
        );
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
  baseEnv,
  runEnv,
  requestedThreadCount,
  threaded,
}: {
  baseEnv?: RomWeaverEnv;
  runEnv?: RomWeaverEnv;
  requestedThreadCount: number | null;
  threaded: boolean;
}): RomWeaverEnv {
  const merged = {
    ...(baseEnv ?? {}),
    ...(runEnv ?? {}),
  };
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
  if (typeof runOptions?.trace === "boolean") output.trace = runOptions.trace;
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
