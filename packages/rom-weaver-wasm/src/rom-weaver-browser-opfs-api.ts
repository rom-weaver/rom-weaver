// @ts-nocheck
import * as wasiShim from '@bjorn3/browser_wasi_shim';
import {
  clampRomWeaverBrowserThreadRequest,
  collectRomWeaverRunInputPaths,
  normalizeRomWeaverRunRequest,
  readRomWeaverRequestedThreadCount,
  readRomWeaverRunRequestCommand,
  withRomWeaverDefaultThreads,
} from './rom-weaver-command.ts';
import {
  createJsonLineParser,
  createTraceJsonLineParser,
  createWasmEnvImports,
  normalizeGuestPath,
} from './rom-weaver-runtime-utils.ts';
import {
  BrowserMemoryRandomAccessFile,
  BrowserOpfsRandomAccessFile,
  BrowserVirtualRandomAccessFile,
  addRandomAccessFileIoStats,
  createRandomAccessFileIoStats,
  isBlobLike,
  isVirtualFileProxy,
  randomAccessFileIoStatsHaveData,
} from './browser-opfs-io-adapters.ts';
export {
  __createBrowserOpfsRandomAccessFileForTest,
  __createBrowserVirtualRandomAccessFileForTest,
} from './browser-opfs-io-adapters.ts';
import type {
  FileSystemDirectoryHandleLike,
  RomWeaverBrowserOpfsOptions,
  RomWeaverBrowserOpfsRunOptions,
  RomWeaverBrowserSyncAccessMode,
  RomWeaverDefaultThreads,
  RomWeaverEnv,
  RomWeaverRunInput,
  RomWeaverRunJsonEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
  RomWeaverRunOptions,
  RomWeaverRunOutput,
  RomWeaverRunRequest,
  RomWeaverRunResult,
} from './rom-weaver-types.d.ts';

type AnyRecord = Record<string, any>;
type LineHandler = (line: string) => void;
type TraceLine = (line: string) => void;
type BrowserOpfsCreateOptions = RomWeaverBrowserOpfsOptions & {
  threadScratchFilePoolSize?: number;
};
type BrowserOpfsRunOptions = RomWeaverBrowserOpfsRunOptions &
  RomWeaverRunJsonOptions<RomWeaverRunJsonEvent, unknown> & {
    __streamBroadcastChannelName?: string;
    __streamRequestId?: number;
    onStderrLine?: LineHandler;
    onStdoutLine?: LineHandler;
    hostSelect?: (request: string) => number;
    preopenOutputPaths?: string[];
    threadScratchFilePoolSize?: number;
  };
type BrowserOpfsRuntimePayload = AnyRecord;

export interface RomWeaverBrowserOpfsRunner {
  dispose(): Promise<void>;
  fs: null;
  mode: 'browser-opfs';
  opfsGuestPath: string;
  opfsHandle: unknown;
  run(commandOrRequest: RomWeaverRunInput, options?: RomWeaverBrowserOpfsRunOptions): Promise<RomWeaverRunResult>;
  runJson<TEvent = RomWeaverRunJsonEvent, TTraceEvent = unknown>(
    commandOrRequest: RomWeaverRunInput,
    options?: RomWeaverRunJsonOptions<TEvent, TTraceEvent> & RomWeaverBrowserOpfsRunOptions,
  ): Promise<RomWeaverRunJsonResult<TEvent, TTraceEvent>>;
  runtimeMounts: string[];
  threaded: boolean;
  wasmUrl: string | null;
  workGuestPath: string;
  writableRoots: string[];
}

const DEFAULT_WORK_GUEST_PATH = '/work';
const DEFAULT_BROWSER_WASM_URLS = [
  new URL('../rom-weaver-app.wasm', import.meta.url).href,
  new URL('./rom-weaver-app.wasm', import.meta.url).href,
];
const DEFAULT_SCRATCH_FILE_POOL_SIZE = 16;
const DEFAULT_THREAD_SCRATCH_FILE_POOL_SIZE = DEFAULT_SCRATCH_FILE_POOL_SIZE;
const DEFAULT_SHARED_MEMORY_INITIAL_PAGES = 256;
// 32768 pages * 64 KiB = 2 GiB, matching the threaded wasm's linked maximum from
// scripts/build-wasm-app.sh. Threaded wasm needs shared memory, which must declare a fixed maximum,
// so the cap cannot be omitted. Most engines reserve address space lazily, but constrained browsers
// can reject the 2 GiB reservation before small commands run; default construction falls back to
// smaller compatible maxima below.
const DEFAULT_SHARED_MEMORY_MAX_PAGES = 32768;
const FALLBACK_SHARED_MEMORY_MAX_PAGES = [
  24576,
  16384,
  8192,
  4096,
];
const PATH_SEPARATOR_REGEX = /[/\\]+/;
const SCRATCH_DIRECTORY_NAME = '.rom-weaver-opfs-scratch';
const SCRATCH_FILE_CREATE_CONCURRENCY = 16;
const OPFS_COPY_CHUNK_SIZE = 8 * 1024 * 1024;
const OPFS_SEQUENTIAL_WRITE_BUFFER_BYTES = 8 * 1024 * 1024;
const OPFS_SEQUENTIAL_DIRECT_WRITE_MIN_BYTES = 2 * 1024 * 1024;
const DEFAULT_BROWSER_THREAD_COUNT = 4;
const DEFAULT_BROWSER_THREAD_POOL_SIZE = 4;
const MAX_BROWSER_THREAD_POOL_SIZE = 64;
const BROWSER_THREAD_POOL_HEADROOM = 4;
const DEFAULT_BROWSER_RAYON_GLOBAL_THREADS = DEFAULT_BROWSER_THREAD_COUNT;
const MAX_BROWSER_RAYON_GLOBAL_THREADS = 8;
const ATOMICS_WAIT_SLICE_MS = 100;
const ATOMICS_WAIT_TIMEOUT_MS = 8000;
const MAX_WASI_THREAD_ID = 0x1fffffff;
const THREAD_ID_COUNTER_INDEX = 0;
const THREAD_ID_COUNTER_INITIAL = 43;
const THREAD_START_ACK_TIMEOUT_MS = ATOMICS_WAIT_TIMEOUT_MS;
const THREAD_SLOT_STATE_INDEX = 0;
const THREAD_SLOT_TID_INDEX = 1;
const THREAD_SLOT_START_ARG_INDEX = 2;
const THREAD_SLOT_ERROR_INDEX = 3;
const THREAD_SLOT_LENGTH = 4;
const THREAD_SLOT_STATE_IDLE = 0;
const THREAD_SLOT_STATE_REQUESTED = 1;
const THREAD_SLOT_STATE_STARTING = 2;
const THREAD_SLOT_STATE_RUNNING = 3;
const THREAD_SLOT_STATE_FAILED = 5;
const THREAD_SLOT_STATE_SHUTDOWN = 6;
const THREAD_WORKER_READY_TIMEOUT_MS = 5000;
const THREAD_WORKER_BUSY_RETRY_INTERVAL_MS = 25;
const THREAD_WORKER_BUSY_RETRY_TIMEOUT_MS = 30000;
const WASI_ERRNO_AGAIN = 6;
const WASI_ERRNO_ENOSYS = 52;
const THREAD_WORKER_MOUNT_CACHE = createBrowserOpfsMountCache();

export async function createRomWeaverBrowserOpfs(options: BrowserOpfsCreateOptions = {}) {
  assertDedicatedWorkerRuntime();

  const workGuestPath = normalizeGuestPath(
    options.workGuestPath ?? options.opfsGuestPath ?? DEFAULT_WORK_GUEST_PATH,
    { label: 'workGuestPath' },
  );
  const opfsHandle = options.opfsHandle ?? (await navigator.storage.getDirectory());
  assertDirectoryHandle(opfsHandle, 'opfsHandle');
  await verifyWritableOpfsRoot(opfsHandle);

  const { module, wasmUrl } = await resolveBrowserModule({
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
  const baseDefaultThreads = resolveConfiguredDefaultThreads(
    options,
    resolveBrowserDefaultThreads(),
  );
  const threadWorkerPool = threaded && importsWasiThreadSpawn
    ? createBrowserWasiThreadWorkerPool({
        initialSize: resolveBrowserThreadPoolSizeFromCount(
          baseDefaultThreads ?? resolveBrowserDefaultThreads(),
        ),
        threadWorkerUrl: options.threadWorkerUrl,
      })
    : null;
  const mountCache = createBrowserOpfsMountCache();
  await seedBrowserOpfsScratchPools({
    mountCache,
    mountHandles: baseMountHandles,
    runtimeMounts,
    scratchFilePoolSize: normalizeScratchFilePoolSize(),
    syncAccessMode: resolveRunSyncAccessMode({
      baseMode: options.syncAccessMode,
      threaded,
    }),
    virtualOnlyMounts: Boolean(options.virtualOnlyMounts ?? false),
    writableRoots: baseWritableRoots,
  });
  if (threadWorkerPool) {
    await threadWorkerPool.ready;
  }

  const runner = {
    async dispose() {
      await mountCache.dispose();
      await threadWorkerPool?.dispose();
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
      const trace = createRunTrace(runOptions);
      trace(
        `[browser-opfs] run start command=${formatCommandForTrace(command)} threaded=${threaded} wasm=${basenameForTrace(wasmUrl)}`,
      );
      if (runOptions.invalidateMountCacheBeforeRun) {
        trace('[browser-opfs] invalidate mount cache before run start');
        await mountCache.invalidateMountPaths(runtimeMounts);
        trace('[browser-opfs] invalidate mount cache before run done');
      }
      const env = createRunEnv({
        baseEnv: options.env,
        runEnv: runOptions.env,
        requestedThreadCount: parseRequestedThreadCount(request),
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

      const closeables: any[] = [];
      let runSucceeded = false;
      const resolvedSyncAccessMode = resolveRunSyncAccessMode({
        baseMode: options.syncAccessMode,
        runMode: runOptions.syncAccessMode,
        threaded,
      });
      const wasiArgs = [
        runOptions.program ?? options.program ?? options.argv0 ?? 'rom-weaver',
      ];
      const requestStdin = serializeRunRequestForStdin(request);
      const writableRoots = normalizeWritableRoots({
        workGuestPath,
        writableDirectories: runOptions.writableDirectories,
        inherited: baseWritableRoots,
      });
      const resolvedVirtualOnlyMounts =
        Boolean(runOptions.virtualOnlyMounts ?? options.virtualOnlyMounts ?? false);
      const knownInputPaths = normalizeKnownInputPaths([
        ...(Array.isArray(options.knownInputPaths) ? options.knownInputPaths : []),
        ...(Array.isArray(runOptions.knownInputPaths) ? runOptions.knownInputPaths : []),
      ]);
      const preopenOutputPaths = normalizePreopenOutputPaths([
        ...(Array.isArray(options.preopenOutputPaths) ? options.preopenOutputPaths : []),
        ...(Array.isArray(runOptions.preopenOutputPaths) ? runOptions.preopenOutputPaths : []),
      ]);
      const resolvedMainScratchFilePoolSize = normalizeScratchFilePoolSize(
        runOptions.scratchFilePoolSize ?? options.scratchFilePoolSize,
      );
      const resolvedThreadScratchFilePoolSize = normalizeScratchFilePoolSize(
        runOptions.threadScratchFilePoolSize
          ?? options.threadScratchFilePoolSize
          ?? runOptions.scratchFilePoolSize
          ?? options.scratchFilePoolSize
          ?? DEFAULT_THREAD_SCRATCH_FILE_POOL_SIZE,
      );
      const threadSpawner = createBrowserWasiThreadSpawner({
        streamBroadcastChannelName: runOptions.__streamBroadcastChannelName,
        streamRequestId: runOptions.__streamRequestId,
        trace,
        moduleImports,
        threadIdState,
        threadWorkerUrl: runOptions.threadWorkerUrl ?? options.threadWorkerUrl,
        threadWorkerPool:
          runOptions.threadWorkerUrl && runOptions.threadWorkerUrl !== options.threadWorkerUrl
            ? null
            : threadWorkerPool,
        wasmMemory,
        wasmModule: module,
        wasiArgs,
        envList,
        runtime: {
          cwdMountPath: workGuestPath,
          debugWasi: Boolean(runOptions.debugWasi ?? options.debugWasi ?? false),
          invalidateMountCacheAfterRun: Boolean(runOptions.invalidateMountCacheAfterRun),
          mountHandles,
          request,
          runtimeMounts,
          knownInputPaths,
          preopenOutputPaths,
          scratchFilePoolSize: resolvedMainScratchFilePoolSize,
          threadScratchFilePoolSize: resolvedThreadScratchFilePoolSize,
          syncAccessMode: resolvedSyncAccessMode,
          virtualFiles,
          writableRoots,
        },
      });
      trace(
        `[browser-opfs] build wasi fds start mounts=${runtimeMounts.length} syncAccess=${resolvedSyncAccessMode} scratch=${resolvedMainScratchFilePoolSize}`,
      );
      const {
        fds,
        mounts,
        stdoutCollector,
        stderrCollector,
        stdoutChunks,
        stderrChunks,
      } = await buildBrowserOpfsWasiFds({
        cwdMountPath: workGuestPath,
        request,
        stdin: requestStdin,
        runtimeMounts,
        mountHandles,
        knownInputPaths,
        preopenOutputPaths,
        stderrLineHandler: runOptions.onStderrLine,
        stdoutLineHandler: runOptions.onStdoutLine,
        virtualFiles,
        scratchFilePoolSize: resolvedMainScratchFilePoolSize,
        writableRoots,
        syncAccessMode: resolvedSyncAccessMode,
        mountCache,
        runCloseables: closeables,
        trace,
        virtualOnlyMounts: resolvedVirtualOnlyMounts,
      });
      trace(`[browser-opfs] build wasi fds done fds=${fds.length} mounts=${mounts.length}`);

      try {
        trace('[browser-opfs] instantiate start');
        const wasi = new wasiShim.WASI(
          wasiArgs,
          envList,
          fds,
          { debug: Boolean(runOptions.debugWasi ?? options.debugWasi ?? false) },
        );
        installDirectWasiFileIoImports(wasi, trace);

        const instance = await WebAssembly.instantiate(module, {
          wasi_snapshot_preview1: wasi.wasiImport,
          env: createWasmEnvImports(wasmMemory, runOptions.hostSelect),
          ...(importsWasiThreadSpawn ? { wasi: { 'thread-spawn': threadSpawner.spawn } } : {}),
        });
        trace('[browser-opfs] instantiate done');

        trace('[browser-opfs] thread spawner ready wait start');
        await threadSpawner.ready;
        trace('[browser-opfs] thread spawner ready');
        let exitCode;
        try {
          trace('[browser-opfs] wasi.start start');
          exitCode = wasi.start(instance);
          trace(`[browser-opfs] wasi.start returned exitCode=${String(exitCode)}`);
        } catch (error) {
          trace(`[browser-opfs] wasi.start threw ${formatErrorForTrace(error)}`);
          await throwWithThreadFailure(error, threadSpawner);
        }
        trace('[browser-opfs] waitForWorkers start');
        await threadSpawner.waitForWorkers();
        trace('[browser-opfs] waitForWorkers done');
        traceFlushOpenWasiFileDescriptors(trace, wasi.fds, '[browser-opfs] flush fd write buffers');
        traceDirectWasiFileIoStats(trace, wasi, '[browser-opfs] direct file io');
        traceRandomAccessFileIoStats(trace, fds, '[browser-opfs] random access file io');
        trace('[browser-opfs] flush mounts start');
        await flushBrowserOpfsMounts(mounts, trace);
        trace('[browser-opfs] flush mounts done');
        runSucceeded = true;
        stdoutCollector.flush();
        stderrCollector.flush();
        const stdout = decodeChunks(stdoutChunks);
        const stderr = decodeChunks(stderrChunks);

        return {
          command,
          exitCode,
          request,
          stdout,
          stderr,
          ok: exitCode === 0,
        };
      } catch (error) {
        trace(`[browser-opfs] run failed ${formatErrorForTrace(error)}`);
        stdoutCollector.flush();
        stderrCollector.flush();
        const stdout = decodeChunks(stdoutChunks);
        const stderr = decodeChunks(stderrChunks);

        return {
          command,
          exitCode: 1,
          request,
          stdout,
          stderr,
          ok: false,
          error,
        };
      } finally {
        trace(`[browser-opfs] cleanup start succeeded=${runSucceeded}`);
        closeSyncFiles(closeables);
        await cleanupBrowserOpfsMounts(mounts);
        if (!runSucceeded || runOptions.invalidateMountCacheAfterRun) await mountCache.invalidateMounts(mounts);
        trace('[browser-opfs] cleanup done');
      }
    },

    async runJson<TEvent = RomWeaverRunJsonEvent, TTraceEvent = unknown>(
      commandOrRequest: RomWeaverRunInput,
      runOptions: BrowserOpfsRunOptions & RomWeaverRunJsonOptions<TEvent, TTraceEvent> = {},
    ): Promise<RomWeaverRunJsonResult<TEvent, TTraceEvent>> {
      const trace = createRunTrace(runOptions);
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
    mode: 'browser-opfs',
    fs: null,
    opfsHandle,
    opfsGuestPath: workGuestPath,
    workGuestPath,
    runtimeMounts,
    threaded,
    wasmUrl,
    writableRoots: baseWritableRoots,
    run: (commandOrRequest: RomWeaverRunInput, runOptions?: BrowserOpfsRunOptions) =>
      runner.run(commandOrRequest, runOptions),
    runJson: <TEvent = RomWeaverRunJsonEvent, TTraceEvent = unknown>(
      commandOrRequest: RomWeaverRunInput,
      runOptions?: BrowserOpfsRunOptions & RomWeaverRunJsonOptions<TEvent, TTraceEvent>,
    ) => runner.runJson<TEvent, TTraceEvent>(commandOrRequest, runOptions),
  };
}

export async function __runRomWeaverBrowserWasiThread(payload: BrowserOpfsRuntimePayload = {}) {
  assertDedicatedWorkerRuntime();

  const {
    debugWasi,
    envList,
    runtime,
    stderrLineHandler,
    stdoutLineHandler,
    startArg,
    threadIdState,
    threadWorkerUrl,
    tid,
    wasiArgs,
    wasmMemory,
    wasmModule,
  } = payload;

  if (!(wasmModule instanceof WebAssembly.Module)) {
    throw new Error('browser wasi thread payload missing compiled WebAssembly.Module');
  }
  if (!(wasmMemory instanceof WebAssembly.Memory)) {
    throw new Error('browser wasi thread payload missing shared WebAssembly.Memory');
  }
  if (!(wasmMemory.buffer instanceof SharedArrayBuffer)) {
    throw new Error('browser wasi thread payload memory is not shared');
  }

  const trace = createLineTrace(stderrLineHandler);
  trace(
    `[browser-opfs-thread] start tid=${tid ?? 'unknown'} startArg=${startArg ?? 'unknown'} args=${formatArgsForTrace(Array.isArray(wasiArgs) ? wasiArgs : [])} virtualFiles=${summarizeRawVirtualFiles(runtime?.virtualFiles)}`,
  );
  const moduleImports = WebAssembly.Module.imports(wasmModule);
  const startControl = threadStartControlFromBuffer(payload.startControlBuffer);
  signalThreadStartState(startControl, THREAD_SLOT_STATE_STARTING);
  let startAcked = false;
  const closeables = [];
  const normalizedRuntimeMounts = normalizeRuntimeMounts(runtime?.runtimeMounts);
  const normalizedMountHandles = await resolveThreadRuntimeMountHandles({
    runtime,
    runtimeMounts: normalizedRuntimeMounts,
    trace,
  });
  if (runtime?.invalidateMountCacheBeforeRun) {
    trace(`[browser-opfs-thread] invalidate mount cache before run start tid=${tid ?? 'unknown'}`);
    await THREAD_WORKER_MOUNT_CACHE.invalidateMountPaths(normalizedRuntimeMounts);
    trace(`[browser-opfs-thread] invalidate mount cache before run done tid=${tid ?? 'unknown'}`);
  }
  let runSucceeded = false;
  let mounts = [];

  try {
    trace(`[browser-opfs-thread] build wasi fds start tid=${tid ?? 'unknown'}`);
    const built = await buildBrowserOpfsWasiFds({
      cwdMountPath: runtime?.cwdMountPath,
      stdin: undefined,
      request: runtime?.request,
      runtimeMounts: normalizedRuntimeMounts,
      mountHandles: normalizedMountHandles,
      knownInputPaths: runtime?.knownInputPaths,
      preopenOutputPaths: runtime?.preopenOutputPaths,
      stderrLineHandler,
      stdoutLineHandler,
      scratchFilePoolSize: runtime?.threadScratchFilePoolSize ?? runtime?.scratchFilePoolSize,
      virtualFiles: normalizeVirtualFiles(runtime?.virtualFiles),
      virtualOnlyMounts: resolveThreadVirtualOnlyMounts(runtime),
      writableRoots: Array.isArray(runtime?.writableRoots) ? runtime.writableRoots : [],
      syncAccessMode: runtime?.syncAccessMode,
      mountCache: THREAD_WORKER_MOUNT_CACHE,
      runCloseables: closeables,
      trace,
    });
    mounts = built.mounts;
    trace(`[browser-opfs-thread] build wasi fds done tid=${tid ?? 'unknown'} mounts=${mounts.length}`);
    const threadWasi = new wasiShim.WASI(
      Array.isArray(wasiArgs) && wasiArgs.length > 0 ? wasiArgs.map((value) => String(value)) : ['rom-weaver'],
      Array.isArray(envList) ? envList.map((value) => String(value)) : [],
      built.fds,
      { debug: Boolean(debugWasi ?? runtime?.debugWasi ?? false) },
    );
    installDirectWasiFileIoImports(threadWasi, trace);
    const nestedThreadSpawner = createBrowserWasiThreadSpawner({
      allowWorkerPool: false,
      streamBroadcastChannelName: payload.__streamBroadcastChannelName,
      streamRequestId: payload.__streamRequestId,
      moduleImports,
      threadIdState,
      threadWorkerUrl,
      wasmMemory,
      wasmModule,
      wasiArgs,
      envList,
      runtime,
      trace,
    });
    trace(`[browser-opfs-thread] instantiate start tid=${tid ?? 'unknown'}`);
    const instance = await WebAssembly.instantiate(wasmModule, {
      wasi_snapshot_preview1: threadWasi.wasiImport,
      env: createWasmEnvImports(wasmMemory),
      ...(needsWasiThreadSpawnImport(moduleImports)
        ? { wasi: { 'thread-spawn': nestedThreadSpawner.spawn } }
        : {}),
    });
    trace(`[browser-opfs-thread] instantiate done tid=${tid ?? 'unknown'}`);

    threadWasi.inst = instance;
    if (typeof instance.exports.wasi_thread_start !== 'function') {
      throw new Error('threaded wasm module does not export wasi_thread_start');
    }
    signalThreadStartState(startControl, THREAD_SLOT_STATE_RUNNING);
    startAcked = true;
    trace(`[browser-opfs-thread] wasi_thread_start start tid=${tid ?? 'unknown'}`);
    instance.exports.wasi_thread_start(Number(tid) | 0, Number(startArg) | 0);
    trace(`[browser-opfs-thread] wasi_thread_start returned tid=${tid ?? 'unknown'}`);
    trace(`[browser-opfs-thread] nested waitForWorkers start tid=${tid ?? 'unknown'}`);
    await nestedThreadSpawner.waitForWorkers();
    trace(`[browser-opfs-thread] nested waitForWorkers done tid=${tid ?? 'unknown'}`);
    traceFlushOpenWasiFileDescriptors(trace, threadWasi.fds, `[browser-opfs-thread] flush fd write buffers tid=${tid ?? 'unknown'}`);
    traceDirectWasiFileIoStats(trace, threadWasi, `[browser-opfs-thread] direct file io tid=${tid ?? 'unknown'}`);
    traceRandomAccessFileIoStats(trace, built.fds, `[browser-opfs-thread] random access file io tid=${tid ?? 'unknown'}`);
    await flushBrowserOpfsMounts(mounts, trace);
    runSucceeded = true;
  } catch (error) {
    trace(`[browser-opfs-thread] failed tid=${tid ?? 'unknown'} ${formatErrorForTrace(error)}`);
    if (!startAcked) signalThreadStartState(startControl, THREAD_SLOT_STATE_FAILED);
    throw error;
  } finally {
    trace(`[browser-opfs-thread] cleanup start tid=${tid ?? 'unknown'} succeeded=${runSucceeded}`);
    closeSyncFiles(closeables);
    await cleanupBrowserOpfsMounts(mounts);
    if (!runSucceeded || runtime?.invalidateMountCacheAfterRun) await THREAD_WORKER_MOUNT_CACHE.invalidateMounts(mounts);
    trace(`[browser-opfs-thread] cleanup done tid=${tid ?? 'unknown'}`);
  }
}

export async function __disposeRomWeaverBrowserThreadMountCache() {
  await THREAD_WORKER_MOUNT_CACHE.dispose();
}

export async function __primeRomWeaverBrowserThreadRuntime(runtime = {}, onTraceNonJsonLine) {
  assertDedicatedWorkerRuntime();
  const trace = createLineTrace(onTraceNonJsonLine);
  const normalizedRuntimeMounts = normalizeRuntimeMounts(runtime?.runtimeMounts);
  if (!normalizedRuntimeMounts.length) return;
  trace(`[browser-opfs-thread] prewarm scratch start mounts=${normalizedRuntimeMounts.length}`);
  const normalizedMountHandles = await resolveThreadRuntimeMountHandles({
    runtime,
    runtimeMounts: normalizedRuntimeMounts,
    trace,
  });
  await seedBrowserOpfsScratchPools({
    mountCache: THREAD_WORKER_MOUNT_CACHE,
    mountHandles: normalizedMountHandles,
    runtimeMounts: normalizedRuntimeMounts,
    scratchFilePoolSize: runtime?.threadScratchFilePoolSize ?? runtime?.scratchFilePoolSize,
    syncAccessMode: runtime?.syncAccessMode,
    virtualOnlyMounts: resolveThreadVirtualOnlyMounts(runtime),
    writableRoots: Array.isArray(runtime?.writableRoots) ? runtime.writableRoots : [],
  });
  trace('[browser-opfs-thread] prewarm scratch done');
}

function createRunEnv({ baseEnv, runEnv, requestedThreadCount, threaded }) {
  const merged = {
    ...(baseEnv ?? {}),
    ...(runEnv ?? {}),
  };
  if (!threaded) return merged;
  applyBrowserThreadedRayonEnvDefaults(merged, requestedThreadCount);
  return merged;
}

function applyBrowserThreadedRayonEnvDefaults(env, requestedThreadCount) {
  if (!env || typeof env !== 'object') return;
  if (Object.hasOwn(env, 'RAYON_NUM_THREADS') || Object.hasOwn(env, 'RAYON_RS_NUM_CPUS')) return;
  const resolved = resolveBrowserGlobalRayonThreads(requestedThreadCount);
  env.RAYON_NUM_THREADS = String(resolved);
  env.RAYON_RS_NUM_CPUS = String(resolved);
}

function resolveBrowserGlobalRayonThreads(requestedThreadCount) {
  if (!Number.isInteger(requestedThreadCount) || requestedThreadCount <= 0) {
    return DEFAULT_BROWSER_RAYON_GLOBAL_THREADS;
  }
  return Math.max(1, Math.min(MAX_BROWSER_RAYON_GLOBAL_THREADS, requestedThreadCount));
}

function readRunOutputOverrides(runOptions) {
  const output = {};
  if (typeof runOptions?.json === 'boolean') output.json = runOptions.json;
  if (typeof runOptions?.trace === 'boolean') output.trace = runOptions.trace;
  if (typeof runOptions?.progress === 'boolean') output.progress = runOptions.progress;
  if (typeof runOptions?.interactiveSelectionEnabled === 'boolean') {
    output.interactive_selection_enabled = runOptions.interactiveSelectionEnabled;
  }
  if (typeof runOptions?.interactive_selection_enabled === 'boolean') {
    output.interactive_selection_enabled = runOptions.interactive_selection_enabled;
  }
  return output;
}

function serializeRunRequestForStdin(request) {
  return `${JSON.stringify(request, runRequestJsonReplacer)}\n`;
}

function runRequestJsonReplacer(_key, value) {
  if (typeof value !== 'bigint') return value;
  if (
    value > BigInt(Number.MAX_SAFE_INTEGER)
    || value < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new TypeError('rom-weaver run request bigint values must fit in a JSON-safe number');
  }
  return Number(value);
}

async function resolveThreadRuntimeMountHandles({ runtime, runtimeMounts, trace }) {
  const mountHandles = normalizeMountHandleMap({ mountHandles: runtime?.mountHandles });
  const missingMounts = runtimeMounts.filter((mountPath) => !mountHandles[mountPath]);
  if (missingMounts.length === 0) {
    trace?.(`[browser-opfs-thread] mount handles provided count=${Object.keys(mountHandles).length}`);
    return mountHandles;
  }

  const opfsHandle = await navigator.storage.getDirectory();
  assertDirectoryHandle(opfsHandle, 'thread opfsHandle');
  for (const mountPath of missingMounts) mountHandles[mountPath] = opfsHandle;
  trace?.(
    `[browser-opfs-thread] mount handles resolved in worker missing=${missingMounts.length} total=${Object.keys(mountHandles).length}`,
  );
  return mountHandles;
}

function createThreadWorkerRuntimePayload(runtime) {
  if (!runtime || typeof runtime !== 'object') return runtime;
  const {
    mountHandles: _mountHandles,
    preopenOutputPaths: _preopenOutputPaths,
    ...rest
  } = runtime;
  return {
    ...rest,
    resolveMountHandlesInWorker: true,
    virtualOnlyMounts: true,
  };
}

function createRunTrace(runOptions) {
  return createLineTrace(runOptions?.onTraceNonJsonLine);
}

function createLineTrace(onTraceNonJsonLine) {
  const trace = typeof onTraceNonJsonLine === 'function' ? onTraceNonJsonLine : null;
  return (line) => {
    if (!trace) return;
    try {
      trace(String(line));
    } catch {
      // Trace callbacks are diagnostic only and must not affect runtime behavior.
    }
  };
}

function summarizeRawVirtualFiles(value) {
  if (!Array.isArray(value) || value.length === 0) return 'count=0';
  return summarizeVirtualFileEntries(value, (entry) => (
    entry?.source ?? entry?.file ?? entry?.blob ?? entry?.bytes ?? entry?.data ?? entry?.proxy
  ));
}

function summarizeNormalizedVirtualFiles(value) {
  if (!Array.isArray(value) || value.length === 0) return 'count=0';
  return summarizeVirtualFileEntries(value, (entry) => entry?.source);
}

function hasVirtualFiles(value) {
  return Array.isArray(value) && value.length > 0;
}

function resolveThreadVirtualOnlyMounts(runtime) {
  return Boolean(runtime?.virtualOnlyMounts ?? true);
}

function summarizeVirtualFileEntries(value, readSource) {
  let proxyCount = 0;
  let directCount = 0;
  let totalBytes = 0;
  for (const entry of value) {
    const source = readSource(entry);
    if (isVirtualFileProxy(source)) {
      proxyCount += 1;
      totalBytes += Number(source.size) || 0;
      continue;
    }
    directCount += 1;
    totalBytes += Number(source?.size ?? source?.byteLength ?? 0) || 0;
  }
  return `count=${value.length} proxy=${proxyCount} direct=${directCount} bytes=${totalBytes}`;
}

function formatArgsForTrace(args) {
  if (!Array.isArray(args) || args.length === 0) return '[]';
  return JSON.stringify(args.map((value) => basenameForTrace(value)));
}

function formatCommandForTrace(command) {
  if (!command || typeof command !== 'object') return 'unknown';
  try {
    return truncateForTrace(JSON.stringify(toTraceValue(command)));
  } catch {
    return String(command?.type ?? 'unknown');
  }
}

function toTraceValue(value) {
  if (typeof value === 'string') return basenameForTrace(value);
  if (Array.isArray(value)) return value.map((entry) => toTraceValue(entry));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) out[key] = toTraceValue(entry);
  return out;
}

function basenameForTrace(value) {
  const text = String(value ?? '');
  if (!text.includes('/')) return text;
  return text.slice(text.lastIndexOf('/') + 1) || text;
}

function formatErrorForTrace(error) {
  if (error instanceof Error) return `${error.name}:${truncateForTrace(error.message)}`;
  return truncateForTrace(String(error));
}

function truncateForTrace(value, maxLength = 180) {
  const text = String(value ?? '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}...`;
}

function createBrowserOpfsMountCache() {
  let disposed = false;
  const mountsByPath = new Map();

  return {
    async acquire({ directoryHandle, mountPath, syncAccessMode, virtualOnly, writableRoots }) {
      if (disposed) throw new Error('browser OPFS mount cache is disposed');
      const writableRootsKey = writableRoots.join('\0');
      const current = mountsByPath.get(mountPath) ?? null;
      if (
        current
        && current.syncAccessMode === syncAccessMode
        && current.virtualOnly === Boolean(virtualOnly)
        && current.writableRootsKey === writableRootsKey
        && await directoryHandlesMatch(current.directoryHandle, directoryHandle)
      ) {
        return current;
      }
      if (current) {
        mountsByPath.delete(mountPath);
        await current.dispose();
      }
      const mount = await BrowserOpfsMount.create({
        directoryHandle,
        mountPath,
        syncAccessMode,
        virtualOnly,
        writableRoots,
      });
      mountsByPath.set(mountPath, mount);
      return mount;
    },

    async invalidateMounts(mounts) {
      const seen = new Set(mounts ?? []);
      for (const mount of seen) {
        if (!mount || typeof mount !== 'object') continue;
        const current = mountsByPath.get(mount.mountPath);
        if (current !== mount) continue;
        mountsByPath.delete(mount.mountPath);
        await mount.dispose();
      }
    },

    async invalidateMountPaths(mountPaths) {
      const lookup = new Set(mountPaths ?? []);
      for (const [mountPath, mount] of mountsByPath) {
        if (!lookup.has(mountPath)) continue;
        mountsByPath.delete(mountPath);
        await mount.dispose();
      }
    },

    async dispose() {
      disposed = true;
      const mounts = [...mountsByPath.values()];
      mountsByPath.clear();
      for (const mount of mounts) {
        await mount.dispose();
      }
    },
  };
}

async function seedBrowserOpfsScratchPools({
  mountCache,
  mountHandles,
  runtimeMounts,
  scratchFilePoolSize,
  syncAccessMode,
  virtualOnlyMounts,
  writableRoots,
}) {
  for (const mountPath of runtimeMounts ?? []) {
    const handle = mountHandles?.[mountPath];
    if (!handle) continue;
    const mount = await mountCache.acquire({
      directoryHandle: handle,
      mountPath,
      syncAccessMode,
      virtualOnly: virtualOnlyMounts,
      writableRoots,
    });
    await mount.ensureScratchPool({ scratchFilePoolSize });
  }
}

async function directoryHandlesMatch(left, right) {
  if (left === right) return true;
  if (typeof left?.isSameEntry === 'function') {
    try {
      return await left.isSameEntry(right);
    } catch {
      // ignored
    }
  }
  if (typeof right?.isSameEntry === 'function') {
    try {
      return await right.isSameEntry(left);
    } catch {
      // ignored
    }
  }
  return false;
}

async function buildBrowserOpfsWasiFds({
  cwdMountPath,
  request,
  stdin,
  runtimeMounts,
  mountHandles,
  knownInputPaths,
  preopenOutputPaths,
  stderrLineHandler,
  stdoutLineHandler,
  virtualFiles,
  scratchFilePoolSize,
  writableRoots,
  syncAccessMode,
  mountCache,
  runCloseables,
  trace,
  virtualOnlyMounts = false,
}) {
  trace?.(
    `[browser-opfs] build fds enter mounts=${Array.isArray(runtimeMounts) ? runtimeMounts.length : 0} virtualOnly=${Boolean(virtualOnlyMounts)} virtualFiles=${summarizeNormalizedVirtualFiles(virtualFiles)}`,
  );
  const stdinBytes = normalizeStdin(stdin);
  const stdoutCollector = createOutputCollector(wasiShim.ConsoleStdout, {
    onLine: stdoutLineHandler,
  });
  const stderrCollector = createOutputCollector(wasiShim.ConsoleStdout, {
    onLine: stderrLineHandler,
  });

  const fds = [
    new wasiShim.OpenFile(new wasiShim.File(stdinBytes)),
    stdoutCollector.fd,
    stderrCollector.fd,
  ];
  const mounts = [];
  let cwdMount = null;
  try {
    for (const mountPath of runtimeMounts) {
      trace?.(`[browser-opfs] mount acquire start path=${mountPath}`);
      const handle = mountHandles[mountPath];
      if (!handle) {
        throw new Error(
          `No directory handle provided for runtime mount ${mountPath}. `
            + 'Provide options.mountHandles or runOptions.mountHandles.',
        );
      }

      const mount = await mountCache.acquire({
        directoryHandle: handle,
        mountPath,
        syncAccessMode,
        virtualOnly: virtualOnlyMounts,
        writableRoots,
      });
      mounts.push(mount);
      trace?.(`[browser-opfs] mount acquire done path=${mountPath}`);
      await mount.startRun({
        runCloseables,
        scratchFilePoolSize,
        virtualFiles,
        trace,
      });
      trace?.(`[browser-opfs] mount startRun done path=${mountPath}`);
      await mount.preopenOutputPaths({ paths: preopenOutputPaths, trace });
      fds.push(new PreparedWasiPreopenDirectory(mount));
      if (mountPath === cwdMountPath) cwdMount = mount;
    }
  } catch (error) {
    trace?.(`[browser-opfs] build fds failed ${formatErrorForTrace(error)}`);
    closeSyncFiles(runCloseables);
    await cleanupBrowserOpfsMounts(mounts);
    throw error;
  }

  if (cwdMount) {
    fds.push(new PreparedWasiPreopenDirectory(cwdMount, { preopenName: '.' }));
  }
  if (virtualOnlyMounts) {
    trace?.('[browser-opfs] sync mounted input paths start for virtual-only mount');
  }
  const syncSummary = await syncMountedInputPathsFromOpfs({
    cwdMountPath,
    knownInputPaths,
    mounts,
    mountHandles,
    request,
    runtimeMounts,
    trace,
  });
  if (virtualOnlyMounts) {
    trace?.(
      `[browser-opfs] sync mounted input paths done for virtual-only mount paths=${syncSummary.paths} hydrated=${syncSummary.hydrated} missing=${syncSummary.missing}`,
    );
  }
  trace?.(`[browser-opfs] build fds leave fds=${fds.length} mounts=${mounts.length}`);

  return {
    fds,
    mounts,
    stdoutCollector,
    stderrCollector,
    stdoutChunks: stdoutCollector.chunks,
    stderrChunks: stderrCollector.chunks,
  };
}

function installDirectWasiFileIoImports(wasi, trace) {
  const imports = wasi?.wasiImport;
  if (!imports || imports.__romWeaverDirectFileIo) return;
  const stats = createDirectWasiFileIoStats();
  const originalFdRead = imports.fd_read;
  const originalFdPread = imports.fd_pread;
  const originalFdWrite = imports.fd_write;
  const originalFdPwrite = imports.fd_pwrite;
  imports.fd_read = (fd, iovsPtr, iovsLen, nreadPtr) => {
    const fdObj = wasi.fds?.[fd];
    if (!fdObj || typeof fdObj.fd_read_into !== 'function') {
      return originalFdRead(fd, iovsPtr, iovsLen, nreadPtr);
    }
    return directWasiFileRead({
      fdObj,
      iovsLen,
      iovsPtr,
      nreadPtr,
      original: () => originalFdRead(fd, iovsPtr, iovsLen, nreadPtr),
      stats,
      wasi,
    });
  };
  imports.fd_pread = (fd, iovsPtr, iovsLen, offset, nreadPtr) => {
    const fdObj = wasi.fds?.[fd];
    if (!fdObj || typeof fdObj.fd_pread_into !== 'function') {
      return originalFdPread(fd, iovsPtr, iovsLen, offset, nreadPtr);
    }
    return directWasiFileRead({
      fdObj,
      iovsLen,
      iovsPtr,
      nreadPtr,
      offset,
      original: () => originalFdPread(fd, iovsPtr, iovsLen, offset, nreadPtr),
      stats,
      wasi,
    });
  };
  imports.fd_write = (fd, iovsPtr, iovsLen, nwrittenPtr) => {
    const fdObj = wasi.fds?.[fd];
    if (!fdObj || typeof fdObj.fd_write !== 'function') {
      return originalFdWrite(fd, iovsPtr, iovsLen, nwrittenPtr);
    }
    return directWasiFileWrite({
      fdObj,
      iovsLen,
      iovsPtr,
      nwrittenPtr,
      original: () => originalFdWrite(fd, iovsPtr, iovsLen, nwrittenPtr),
      stats,
      wasi,
    });
  };
  imports.fd_pwrite = (fd, iovsPtr, iovsLen, offset, nwrittenPtr) => {
    const fdObj = wasi.fds?.[fd];
    if (!fdObj || typeof fdObj.fd_pwrite !== 'function') {
      return originalFdPwrite(fd, iovsPtr, iovsLen, offset, nwrittenPtr);
    }
    return directWasiFileWrite({
      fdObj,
      iovsLen,
      iovsPtr,
      nwrittenPtr,
      offset,
      original: () => originalFdPwrite(fd, iovsPtr, iovsLen, offset, nwrittenPtr),
      stats,
      wasi,
    });
  };
  imports.__romWeaverDirectFileIoStats = stats;
  imports.__romWeaverDirectFileIo = true;
  trace?.('[browser-opfs] direct file io imports installed');
}

function createDirectWasiFileIoStats() {
  return {
    readBytes: 0,
    readCalls: 0,
    readMs: 0,
    writeBytes: 0,
    writeCalls: 0,
    writeMs: 0,
  };
}

function traceDirectWasiFileIoStats(trace, wasi, label) {
  if (typeof trace !== 'function') return;
  const stats = wasi?.wasiImport?.__romWeaverDirectFileIoStats;
  if (!stats || (stats.readCalls === 0 && stats.writeCalls === 0)) return;
  trace(
    `${label} readCalls=${stats.readCalls} readBytes=${stats.readBytes} readMs=${stats.readMs.toFixed(1)} readMiBps=${formatIoMiBps(stats.readBytes, stats.readMs)} writeCalls=${stats.writeCalls} writeBytes=${stats.writeBytes} writeMs=${stats.writeMs.toFixed(1)} writeMiBps=${formatIoMiBps(stats.writeBytes, stats.writeMs)}`,
  );
}

function traceRandomAccessFileIoStats(trace, fds, label) {
  if (typeof trace !== 'function') return;
  const stats = collectRandomAccessFileIoStats(fds);
  if (!randomAccessFileIoStatsHaveData(stats)) return;
  trace(
    `${label}`
    + ` blobReadCalls=${stats.blobReadCalls} blobReadBytes=${stats.blobReadBytes} blobReadMs=${stats.blobReadMs.toFixed(1)} blobReadMiBps=${formatIoMiBps(stats.blobReadBytes, stats.blobReadMs)}`
    + ` blobCacheHits=${stats.blobCacheHits} blobCacheMisses=${stats.blobCacheMisses} blobCacheHitBytes=${stats.blobCacheHitBytes} blobCacheFillBytes=${stats.blobCacheFillBytes}`
    + ` opfsReadCalls=${stats.opfsReadCalls} opfsReadBytes=${stats.opfsReadBytes} opfsReadMs=${stats.opfsReadMs.toFixed(1)} opfsReadMiBps=${formatIoMiBps(stats.opfsReadBytes, stats.opfsReadMs)}`
    + ` opfsCacheHits=${stats.opfsCacheHits} opfsCacheMisses=${stats.opfsCacheMisses} opfsCacheHitBytes=${stats.opfsCacheHitBytes} opfsCacheFillBytes=${stats.opfsCacheFillBytes}`
    + ` opfsWriteCalls=${stats.opfsWriteCalls} opfsWriteBytes=${stats.opfsWriteBytes} opfsWriteMs=${stats.opfsWriteMs.toFixed(1)} opfsWriteMiBps=${formatIoMiBps(stats.opfsWriteBytes, stats.opfsWriteMs)}`
    + ` opfsFlushCalls=${stats.opfsFlushCalls} opfsFlushMs=${stats.opfsFlushMs.toFixed(1)}`,
  );
}

function collectRandomAccessFileIoStats(fds) {
  const stats = createRandomAccessFileIoStats();
  const seenFiles = new Set();
  const seenEntries = new Set();

  const addFile = (file) => {
    if (!file || seenFiles.has(file) || typeof file.snapshotIoStats !== 'function') return;
    seenFiles.add(file);
    addRandomAccessFileIoStats(stats, file.snapshotIoStats());
  };

  const visitEntry = (entry) => {
    if (!entry || typeof entry !== 'object' || seenEntries.has(entry)) return;
    seenEntries.add(entry);
    addFile(entry.file);
    addFile(entry.inode?.file);
    if (entry.mount?.contents instanceof Map) visitEntries(entry.mount.contents);
    if (entry.contents instanceof Map) visitEntries(entry.contents);
  };

  const visitEntries = (entries) => {
    for (const entry of entries.values()) visitEntry(entry);
  };

  for (const fd of fds ?? []) visitEntry(fd);
  return stats;
}

function formatIoMiBps(bytes, elapsedMs) {
  if (!(elapsedMs > 0) || !(bytes > 0)) return '0.0';
  return ((bytes / 1048576) / (elapsedMs / 1000)).toFixed(1);
}

function traceFlushOpenWasiFileDescriptors(trace, fds, label) {
  const startMs = monotonicNowMs();
  let flushedCount = 0;
  let flushedBytes = 0;
  if (Array.isArray(fds)) {
    for (const fd of fds) {
      if (!fd || typeof fd.pendingWriteBufferLength !== 'function' || typeof fd.flushPendingWrite !== 'function') {
        continue;
      }
      const pendingBytes = fd.pendingWriteBufferLength();
      if (pendingBytes <= 0) continue;
      const ret = fd.flushPendingWrite();
      if (ret !== wasiShim.wasi.ERRNO_SUCCESS) {
        throw new Error(`failed to flush buffered WASI fd writes: errno=${ret}`);
      }
      flushedCount += 1;
      flushedBytes += pendingBytes;
    }
  }
  if (flushedCount > 0) {
    const elapsedMs = monotonicNowMs() - startMs;
    trace?.(`${label} count=${flushedCount} bytes=${flushedBytes} ms=${elapsedMs.toFixed(1)} MiBps=${formatIoMiBps(flushedBytes, elapsedMs)}`);
  }
}

function monotonicNowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function directWasiFileRead({
  fdObj,
  iovsLen,
  iovsPtr,
  nreadPtr,
  offset,
  original,
  stats,
  wasi,
}) {
  const memory = wasi?.inst?.exports?.memory;
  if (!(memory instanceof WebAssembly.Memory)) return original();

  const buffer = new DataView(memory.buffer);
  const buffer8 = new Uint8Array(memory.buffer);
  const iovecs = wasiShim.wasi.Iovec.read_bytes_array(buffer, iovsPtr, iovsLen);
  let nread = 0;
  let currentOffset = offset === undefined ? null : BigInt(offset);
  try {
    for (const iovec of iovecs) {
      const target = buffer8.subarray(iovec.buf, iovec.buf + iovec.buf_len);
      const callStartMs = monotonicNowMs();
      const result = currentOffset === null
        ? fdObj.fd_read_into(target)
        : fdObj.fd_pread_into(target, currentOffset);
      stats.readCalls += 1;
      stats.readMs += monotonicNowMs() - callStartMs;
      if (result.ret !== wasiShim.wasi.ERRNO_SUCCESS) {
        if (nread === 0 && result.ret === wasiShim.wasi.ERRNO_NOTSUP) return original();
        buffer.setUint32(nreadPtr, nread, true);
        return result.ret;
      }
      const bytesRead = Math.max(0, Math.min(Number(result.nread) || 0, iovec.buf_len));
      stats.readBytes += bytesRead;
      nread += bytesRead;
      if (currentOffset !== null) currentOffset += BigInt(bytesRead);
      if (bytesRead !== iovec.buf_len) break;
    }
    buffer.setUint32(nreadPtr, nread, true);
    return wasiShim.wasi.ERRNO_SUCCESS;
  } catch (error) {
    if (nread === 0) return original();
    throw error;
  }
}

function directWasiFileWrite({
  fdObj,
  iovsLen,
  iovsPtr,
  nwrittenPtr,
  offset,
  original,
  stats,
  wasi,
}) {
  const memory = wasi?.inst?.exports?.memory;
  if (!(memory instanceof WebAssembly.Memory)) return original();

  const buffer = new DataView(memory.buffer);
  const buffer8 = new Uint8Array(memory.buffer);
  const iovecs = wasiShim.wasi.Ciovec.read_bytes_array(buffer, iovsPtr, iovsLen);
  let nwritten = 0;
  let currentOffset = offset === undefined ? null : BigInt(offset);
  try {
    for (const iovec of iovecs) {
      const source = buffer8.subarray(iovec.buf, iovec.buf + iovec.buf_len);
      const callStartMs = monotonicNowMs();
      const result = currentOffset === null
        ? fdObj.fd_write(source)
        : fdObj.fd_pwrite(source, currentOffset);
      stats.writeCalls += 1;
      stats.writeMs += monotonicNowMs() - callStartMs;
      if (result.ret !== wasiShim.wasi.ERRNO_SUCCESS) {
        if (nwritten === 0 && result.ret === wasiShim.wasi.ERRNO_NOTSUP) return original();
        buffer.setUint32(nwrittenPtr, nwritten, true);
        return result.ret;
      }
      const bytesWritten = Math.max(0, Math.min(Number(result.nwritten) || 0, source.byteLength));
      stats.writeBytes += bytesWritten;
      nwritten += bytesWritten;
      if (currentOffset !== null) currentOffset += BigInt(bytesWritten);
      if (bytesWritten !== source.byteLength) break;
    }
    buffer.setUint32(nwrittenPtr, nwritten, true);
    return wasiShim.wasi.ERRNO_SUCCESS;
  } catch (error) {
    if (nwritten === 0) return original();
    throw error;
  }
}

class BrowserOpfsMount {
  [key: string]: any;

  static async create({
    directoryHandle,
    mountPath,
    syncAccessMode,
    virtualOnly,
    writableRoots,
  }) {
    const ownedFiles = [];
    const contents = virtualOnly
      ? new Map()
      : await buildOpfsInodeMap({
          closeables: ownedFiles,
          directoryHandle,
          guestPath: mountPath,
          syncAccessMode,
          writableRoots,
        });
    return new BrowserOpfsMount({
      contents,
      directoryHandle,
      mountPath,
      ownedFiles,
      syncAccessMode,
      virtualOnly: Boolean(virtualOnly),
      writableRoots,
    });
  }

  constructor({
    contents,
    directoryHandle,
    mountPath,
    ownedFiles,
    syncAccessMode,
    virtualOnly,
    writableRoots,
  }) {
    this.contents = contents;
    this.directoryHandle = directoryHandle;
    this.mountPath = mountPath;
    this.ownedFiles = ownedFiles;
    this.syncAccessMode = syncAccessMode;
    this.virtualOnly = Boolean(virtualOnly);
    this.writableRoots = writableRoots;
    this.writableRootsKey = writableRoots.join('\0');
    this.virtualRestores = null;
    this.scratchDirectoryHandle = null;
    this.scratchFiles = [];
    this.scratchPool = [];
    this.trace = null;
  }

  isWritablePath(guestPath) {
    return isGuestPathWithinRoots(guestPath, this.writableRoots);
  }

  takeScratchFile() {
    const file = this.scratchPool.pop() ?? null;
    if (file) file.truncate(0);
    return file;
  }

  resetScratchPool({ trace } = {}) {
    let truncatedFiles = 0;
    let reclaimedBytes = 0;
    for (const file of this.scratchFiles) {
      let size = 0;
      try {
        size = Math.max(0, Number(file.size()) || 0);
      } catch {
        size = 0;
      }
      if (size > 0) {
        file.truncate(0);
        truncatedFiles += 1;
        reclaimedBytes += size;
      }
    }
    this.scratchPool = [...this.scratchFiles];
    if (truncatedFiles > 0) {
      trace?.(
        `[browser-opfs] mount scratch reset path=${this.mountPath} files=${truncatedFiles} bytes=${reclaimedBytes}`,
      );
    }
  }

  async ensureScratchPool({ scratchFilePoolSize, trace } = {}) {
    const desiredSize = normalizeScratchFilePoolSize(scratchFilePoolSize);
    if (this.scratchFiles.length >= desiredSize) return;
    const additionalFileCount = desiredSize - this.scratchFiles.length;
    trace?.(
      `[browser-opfs] mount scratch seed start path=${this.mountPath} size=${desiredSize} add=${additionalFileCount}`,
    );
    const scratch = this.virtualOnly
      ? createMemoryScratchFilePool({
          closeables: this.ownedFiles,
          scratchFilePoolSize: additionalFileCount,
        })
      : await createScratchFilePool({
          closeables: this.ownedFiles,
          directoryHandle: this.directoryHandle,
          scratchFilePoolSize: additionalFileCount,
          syncAccessMode: this.syncAccessMode,
        });
    this.scratchDirectoryHandle = scratch.directoryHandle;
    this.scratchFiles.push(...scratch.files);
    this.scratchPool = [...this.scratchFiles];
    trace?.(
      `[browser-opfs] mount scratch seed done path=${this.mountPath} files=${this.scratchFiles.length}`,
    );
  }

  async startRun({ runCloseables, scratchFilePoolSize, virtualFiles, trace }) {
    void runCloseables;
    this.finishRun();
    this.trace = typeof trace === 'function' ? trace : null;
    trace?.(
      `[browser-opfs] mount virtual files start path=${this.mountPath} ${summarizeNormalizedVirtualFiles(virtualFiles)}`,
    );
    if (Array.isArray(virtualFiles) && virtualFiles.length > 0) {
      this.virtualRestores = addVirtualFilesToMount({
        contents: this.contents,
        mountPath: this.mountPath,
        trace,
        virtualFiles,
      });
    } else {
      this.virtualRestores = [];
    }
    trace?.(
      `[browser-opfs] mount virtual files done path=${this.mountPath} mounted=${this.virtualRestores.length}`,
    );
    await this.ensureScratchPool({ scratchFilePoolSize, trace });
    this.scratchPool = [...this.scratchFiles];
  }

  finishRun() {
    if (Array.isArray(this.virtualRestores) && this.virtualRestores.length > 0) {
      restoreVirtualFiles(this.virtualRestores);
    }
    this.virtualRestores = null;
    this.trace = null;
  }

  async preopenOutputPaths({ paths, trace } = {}) {
    if (this.virtualOnly) return;
    const normalizedPaths = normalizePreopenOutputPaths(paths);
    if (normalizedPaths.length === 0) return;
    let preopened = 0;
    for (const guestPath of normalizedPaths) {
      if (!isGuestPathWithinMount(guestPath, this.mountPath)) continue;
      await this.preopenOutputPath(guestPath);
      preopened += 1;
    }
    if (preopened > 0) {
      trace?.(`[browser-opfs] mount preopen outputs path=${this.mountPath} files=${preopened}`);
    }
  }

  async preopenOutputPath(guestPath) {
    if (!this.isWritablePath(guestPath)) {
      throw new Error(`Browser OPFS output path is not writable: ${guestPath}`);
    }
    const relativePath = guestPath === this.mountPath ? '' : guestPath.slice(this.mountPath.length + 1);
    const parts = normalizeWasiRelativePathParts(relativePath);
    if (parts === null || parts.length === 0) {
      throw new Error(`Browser OPFS output path must be a file inside ${this.mountPath}: ${guestPath}`);
    }

    let entries = this.contents;
    let directoryHandle = this.directoryHandle;
    for (const part of parts.slice(0, -1)) {
      let entry = entries.get(part) ?? null;
      if (!entry) {
        entry = new wasiShim.Directory(new Map());
        entries.set(part, entry);
      }
      if (!(entry instanceof wasiShim.Directory)) {
        throw new Error(`Browser OPFS output parent is not a directory: ${guestPath}`);
      }
      directoryHandle = await directoryHandle.getDirectoryHandle(part, { create: true });
      entries = entry.contents;
    }

    const name = parts[parts.length - 1];
    const existing = entries.get(name) ?? null;
    if (existing instanceof wasiShim.Directory) {
      throw new Error(`Browser OPFS output path is a directory: ${guestPath}`);
    }
    if (existing instanceof WasiRandomAccessFileInode && typeof existing.file?.close === 'function') {
      try {
        existing.file.close();
      } catch {
        // ignore stale output handle cleanup failures; the new handle below owns the path.
      }
    }

    const fileHandle = await directoryHandle.getFileHandle(name, { create: true });
    const syncHandle = await openSyncAccessHandle({
      fileHandle,
      mode: writableSyncAccessMode(this.syncAccessMode),
    });
    const file = new BrowserOpfsRandomAccessFile(syncHandle);
    file.truncate(0);
    this.trackOwnedFile(file);
    entries.set(name, new WasiRandomAccessFileInode(file));
  }

  trackOwnedFile(file) {
    this.ownedFiles.push(file);
  }

  async dispose() {
    this.finishRun();
    await this.cleanupScratchPool();
    closeSyncFiles(this.ownedFiles);
    this.ownedFiles = [];
    this.scratchPool = [];
    this.scratchFiles = [];
    this.scratchDirectoryHandle = null;
  }

  async cleanupScratchPool() {
    if (!this.scratchDirectoryHandle) return;
    for (const file of this.scratchFiles) {
      if (!file.scratchName) continue;
      try {
        await this.scratchDirectoryHandle.removeEntry(file.scratchName);
      } catch {
        // ignore best-effort scratch cleanup failures
      }
    }
    try {
      for await (const [name] of this.scratchDirectoryHandle.entries()) {
        try {
          await this.scratchDirectoryHandle.removeEntry(name);
        } catch {
          // ignore best-effort scratch cleanup failures
        }
      }
    } catch {
      // ignore best-effort scratch cleanup failures
    }
  }
}

class PreparedWasiPreopenDirectory extends wasiShim.PreopenDirectory {
  [key: string]: any;

  constructor(mount, options = {}) {
    super(options.preopenName ?? mount.mountPath, mount.contents);
    this.mount = mount;
  }

  path_open(dirflags, pathStr, oflags, fsRightsBase, fsRightsInheriting, fdFlags) {
    const pathRet = validateWasiRelativePath(pathStr);
    if (pathRet !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: pathRet, fd_obj: null };

    const guestPath = joinGuestPath(this.mount.mountPath, pathStr);
    let entry = findEntryInDirectory(this.mount.contents, pathStr);
    if (!entry) {
      if ((oflags & wasiShim.wasi.OFLAGS_CREAT) !== wasiShim.wasi.OFLAGS_CREAT) {
        return { ret: wasiShim.wasi.ERRNO_NOENT, fd_obj: null };
      }
      if (!this.mount.isWritablePath(guestPath)) {
        return { ret: wasiShim.wasi.ERRNO_ROFS, fd_obj: null };
      }
      const created = createInMemoryEntry(this.mount.contents, pathStr, {
        directory: (oflags & wasiShim.wasi.OFLAGS_DIRECTORY) === wasiShim.wasi.OFLAGS_DIRECTORY,
        mount: this.mount,
      });
      if (created !== wasiShim.wasi.ERRNO_SUCCESS) {
        this.mount.trace?.(
          `[browser-opfs] path create failed path=${basenameForTrace(pathStr)} errno=${created}`,
        );
        return { ret: created, fd_obj: null };
      }
      entry = findEntryInDirectory(this.mount.contents, pathStr);
      if (!entry) return { ret: wasiShim.wasi.ERRNO_IO, fd_obj: null };
    } else if ((oflags & wasiShim.wasi.OFLAGS_EXCL) === wasiShim.wasi.OFLAGS_EXCL) {
      return { ret: wasiShim.wasi.ERRNO_EXIST, fd_obj: null };
    } else if (!this.mount.isWritablePath(guestPath) && requestsWriteRights(fsRightsBase, oflags)) {
      return { ret: wasiShim.wasi.ERRNO_PERM, fd_obj: null };
    }

    if (pathRequiresDirectory(pathStr, oflags) && !(entry instanceof wasiShim.Directory)) {
      return { ret: wasiShim.wasi.ERRNO_NOTDIR, fd_obj: null };
    }

    return entry.path_open(oflags, fsRightsBase, fdFlags);
  }

  path_create_directory(pathStr) {
    const pathRet = validateWasiRelativePath(pathStr);
    if (pathRet !== wasiShim.wasi.ERRNO_SUCCESS) return pathRet;

    if (pathIsDirectoryInDirectory(this.mount.contents, pathStr)) {
      return wasiShim.wasi.ERRNO_SUCCESS;
    }
    const guestPath = joinGuestPath(this.mount.mountPath, pathStr);
    if (!this.mount.isWritablePath(guestPath)) {
      return wasiShim.wasi.ERRNO_ROFS;
    }
    return createInMemoryEntry(this.mount.contents, pathStr, {
      directory: true,
      mount: this.mount,
    });
  }

  path_link(pathStr, inode, _allowDir) {
    const pathRet = validateWasiRelativePath(pathStr);
    if (pathRet !== wasiShim.wasi.ERRNO_SUCCESS) return pathRet;

    const guestPath = joinGuestPath(this.mount.mountPath, pathStr);
    if (!this.mount.isWritablePath(guestPath)) {
      return wasiShim.wasi.ERRNO_ROFS;
    }
    return setEntryInDirectory(this.mount.contents, pathStr, inode);
  }

  path_unlink(pathStr) {
    const pathRet = validateWasiRelativePath(pathStr);
    if (pathRet !== wasiShim.wasi.ERRNO_SUCCESS) {
      return { ret: pathRet, inode_obj: null };
    }

    const guestPath = joinGuestPath(this.mount.mountPath, pathStr);
    if (!this.mount.isWritablePath(guestPath)) {
      return { ret: wasiShim.wasi.ERRNO_ROFS, inode_obj: null };
    }
    return unlinkEntryFromDirectory(this.mount.contents, pathStr);
  }

  path_unlink_file(pathStr) {
    const pathRet = validateWasiRelativePath(pathStr);
    if (pathRet !== wasiShim.wasi.ERRNO_SUCCESS) return pathRet;

    const entry = findEntryInDirectory(this.mount.contents, pathStr);
    if (!entry) return wasiShim.wasi.ERRNO_NOENT;
    if (entry instanceof wasiShim.Directory) return wasiShim.wasi.ERRNO_ISDIR;
    const { ret } = this.path_unlink(pathStr);
    return ret;
  }

  path_remove_directory(pathStr) {
    const pathRet = validateWasiRelativePath(pathStr);
    if (pathRet !== wasiShim.wasi.ERRNO_SUCCESS) return pathRet;

    const entry = findEntryInDirectory(this.mount.contents, pathStr);
    if (!(entry instanceof wasiShim.Directory)) return wasiShim.wasi.ERRNO_NOTDIR;
    if (entry.contents.size > 0) return wasiShim.wasi.ERRNO_NOTEMPTY;
    const { ret } = this.path_unlink(pathStr);
    return ret;
  }
}

class WasiRandomAccessFileInode extends wasiShim.Inode {
  [key: string]: any;

  constructor(file, options = {}) {
    super();
    this.file = file;
    this.readonly = Boolean(options.readonly);
    this.scratchBacked = Boolean(options.scratchBacked);
    this.closeOnLastFdClose = Boolean(options.closeOnLastFdClose);
    this.openRefCount = 0;
  }

  path_open(oflags, fsRightsBase, fdFlags) {
    if (this.readonly && requestsWriteRights(fsRightsBase, oflags)) {
      return { ret: wasiShim.wasi.ERRNO_PERM, fd_obj: null };
    }
    const openRet = this.prepareOpenFile();
    if (openRet !== wasiShim.wasi.ERRNO_SUCCESS) {
      return { ret: openRet, fd_obj: null };
    }
    if ((oflags & wasiShim.wasi.OFLAGS_TRUNC) === wasiShim.wasi.OFLAGS_TRUNC) {
      if (this.readonly) return { ret: wasiShim.wasi.ERRNO_PERM, fd_obj: null };
      this.file.truncate(0);
    }
    const fd = new OpenWasiRandomAccessFile(this);
    this.registerOpenFile();
    if (fdFlags & wasiShim.wasi.FDFLAGS_APPEND) fd.fd_seek(0n, wasiShim.wasi.WHENCE_END);
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, fd_obj: fd };
  }

  prepareOpenFile() {
    if (this.closeOnLastFdClose && this.openRefCount === 0 && typeof this.file?.reopen === 'function') {
      this.file.reopen();
    }
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  registerOpenFile() {
    this.openRefCount += 1;
  }

  releaseOpenFile() {
    if (this.openRefCount > 0) this.openRefCount -= 1;
    if (this.openRefCount !== 0 || !this.closeOnLastFdClose) return wasiShim.wasi.ERRNO_SUCCESS;
    if (typeof this.file?.close !== 'function') return wasiShim.wasi.ERRNO_SUCCESS;
    try {
      this.file.close();
      return wasiShim.wasi.ERRNO_SUCCESS;
    } catch {
      return wasiShim.wasi.ERRNO_IO;
    }
  }

  get size() {
    return BigInt(this.file.size());
  }

  stat() {
    return new wasiShim.wasi.Filestat(this.ino, wasiShim.wasi.FILETYPE_REGULAR_FILE, this.size);
  }
}

export function __createWasiRandomAccessFileInodeForTest(file, options = {}) {
  return new WasiRandomAccessFileInode(file, options);
}

function normalizeWasiReadResult(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return { bytesRead: 0, ret: wasiShim.wasi.ERRNO_IO };
  const integral = Math.trunc(numeric);
  if (integral >= 0) return { bytesRead: integral, ret: wasiShim.wasi.ERRNO_SUCCESS };
  const errno = Math.abs(integral);
  if (errno > 0 && errno <= 0xffff) return { bytesRead: 0, ret: errno };
  return { bytesRead: 0, ret: wasiShim.wasi.ERRNO_IO };
}

function emitWasiReadErrorTrace(scope, rawValue, retCode) {
  if (typeof console === 'undefined') return;
  const log = typeof console.debug === 'function' ? console.debug : console.log;
  log.call(console, `[rom-weaver trace] browser-opfs: ${scope} readAt returned error-like value`, {
    rawValue,
    retCode,
  });
}

class OpenWasiRandomAccessFile extends wasiShim.Fd {
  [key: string]: any;

  constructor(inode) {
    super();
    this.inode = inode;
    this.position = 0n;
    this.writeBuffer = null;
    this.writeBufferStart = 0n;
    this.writeBufferLength = 0;
    this.closed = false;
  }

  fd_allocate(offset, len) {
    if (this.closed) return wasiShim.wasi.ERRNO_BADF;
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return flushRet;
    const requested = BigInt(offset) + BigInt(len);
    if (BigInt(this.inode.file.size()) >= requested) return wasiShim.wasi.ERRNO_SUCCESS;
    if (typeof this.inode.file.allocateAtLeast === 'function') {
      this.inode.file.allocateAtLeast(Number(requested));
    } else {
      this.inode.file.truncate(Number(requested));
    }
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  fd_fdstat_get() {
    if (this.closed) {
      return {
        ret: wasiShim.wasi.ERRNO_BADF,
        fdstat: null,
      };
    }
    return {
      ret: wasiShim.wasi.ERRNO_SUCCESS,
      fdstat: new wasiShim.wasi.Fdstat(wasiShim.wasi.FILETYPE_REGULAR_FILE, 0),
    };
  }

  fd_filestat_get() {
    if (this.closed) return { ret: wasiShim.wasi.ERRNO_BADF, filestat: null };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: flushRet, filestat: null };
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, filestat: this.inode.stat() };
  }

  fd_filestat_set_size(size) {
    if (this.closed) return wasiShim.wasi.ERRNO_BADF;
    if (this.inode.readonly) return wasiShim.wasi.ERRNO_BADF;
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return flushRet;
    const nextSize = Number(size);
    this.inode.file.truncate(nextSize);
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  fd_read(size) {
    if (this.closed) return { ret: wasiShim.wasi.ERRNO_BADF, data: new Uint8Array(0) };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) {
      return { ret: flushRet, data: new Uint8Array(0) };
    }
    const buffer = new Uint8Array(size);
    const rawRead = this.inode.file.readAt(this.position, buffer);
    const readResult = normalizeWasiReadResult(rawRead);
    if (readResult.ret !== wasiShim.wasi.ERRNO_SUCCESS) {
      emitWasiReadErrorTrace('fd_read', rawRead, readResult.ret);
      return { ret: readResult.ret, data: new Uint8Array(0) };
    }
    const bytesRead = Math.max(0, Math.min(readResult.bytesRead, buffer.byteLength));
    this.position += BigInt(bytesRead);
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, data: buffer.subarray(0, bytesRead) };
  }

  fd_pread(size, offset) {
    if (this.closed) return { ret: wasiShim.wasi.ERRNO_BADF, data: new Uint8Array(0) };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) {
      return { ret: flushRet, data: new Uint8Array(0) };
    }
    const buffer = new Uint8Array(size);
    const rawRead = this.inode.file.readAt(offset, buffer);
    const readResult = normalizeWasiReadResult(rawRead);
    if (readResult.ret !== wasiShim.wasi.ERRNO_SUCCESS) {
      emitWasiReadErrorTrace('fd_pread', rawRead, readResult.ret);
      return { ret: readResult.ret, data: new Uint8Array(0) };
    }
    const bytesRead = Math.max(0, Math.min(readResult.bytesRead, buffer.byteLength));
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, data: buffer.subarray(0, bytesRead) };
  }

  fd_read_into(target) {
    if (this.closed) return { ret: wasiShim.wasi.ERRNO_BADF, nread: 0 };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: flushRet, nread: 0 };
    if (!this.inode.file.supportsDirectWasmRead) {
      return { ret: wasiShim.wasi.ERRNO_NOTSUP, nread: 0 };
    }
    const rawRead = this.inode.file.readAt(this.position, target);
    const readResult = normalizeWasiReadResult(rawRead);
    if (readResult.ret !== wasiShim.wasi.ERRNO_SUCCESS) {
      emitWasiReadErrorTrace('fd_read_into', rawRead, readResult.ret);
      return { ret: readResult.ret, nread: 0 };
    }
    const bytesRead = Math.max(0, Math.min(readResult.bytesRead, target.byteLength));
    this.position += BigInt(bytesRead);
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, nread: bytesRead };
  }

  fd_pread_into(target, offset) {
    if (this.closed) return { ret: wasiShim.wasi.ERRNO_BADF, nread: 0 };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: flushRet, nread: 0 };
    if (!this.inode.file.supportsDirectWasmRead) {
      return { ret: wasiShim.wasi.ERRNO_NOTSUP, nread: 0 };
    }
    const rawRead = this.inode.file.readAt(offset, target);
    const readResult = normalizeWasiReadResult(rawRead);
    if (readResult.ret !== wasiShim.wasi.ERRNO_SUCCESS) {
      emitWasiReadErrorTrace('fd_pread_into', rawRead, readResult.ret);
      return { ret: readResult.ret, nread: 0 };
    }
    const bytesRead = Math.max(0, Math.min(readResult.bytesRead, target.byteLength));
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, nread: bytesRead };
  }

  fd_seek(offset, whence) {
    if (this.closed) return { ret: wasiShim.wasi.ERRNO_BADF, offset: this.position };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: flushRet, offset: this.position };
    let nextPosition;
    switch (whence) {
      case wasiShim.wasi.WHENCE_SET:
        nextPosition = BigInt(offset);
        break;
      case wasiShim.wasi.WHENCE_CUR:
        nextPosition = this.position + BigInt(offset);
        break;
      case wasiShim.wasi.WHENCE_END:
        nextPosition = BigInt(this.inode.file.size()) + BigInt(offset);
        break;
      default:
        return { ret: wasiShim.wasi.ERRNO_INVAL, offset: 0n };
    }
    if (nextPosition < 0n) return { ret: wasiShim.wasi.ERRNO_INVAL, offset: 0n };
    this.position = nextPosition;
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, offset: this.position };
  }

  fd_tell() {
    if (this.closed) return { ret: wasiShim.wasi.ERRNO_BADF, offset: this.position };
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, offset: this.position };
  }

  fd_write(data) {
    if (this.closed) return { ret: wasiShim.wasi.ERRNO_BADF, nwritten: 0 };
    if (this.inode.readonly) return { ret: wasiShim.wasi.ERRNO_BADF, nwritten: 0 };
    if (data.byteLength === 0) return { ret: wasiShim.wasi.ERRNO_SUCCESS, nwritten: 0 };
    if (!this.inode.file.supportsBufferedSequentialWrite) {
      const bytesWritten = this.inode.file.writeAt(this.position, data);
      this.position += BigInt(bytesWritten);
      return { ret: wasiShim.wasi.ERRNO_SUCCESS, nwritten: bytesWritten };
    }
    return this.bufferSequentialWrite(data);
  }

  fd_pwrite(data, offset) {
    if (this.closed) return { ret: wasiShim.wasi.ERRNO_BADF, nwritten: 0 };
    if (this.inode.readonly) return { ret: wasiShim.wasi.ERRNO_BADF, nwritten: 0 };
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: flushRet, nwritten: 0 };
    const bytesWritten = this.inode.file.writeAt(offset, data);
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, nwritten: bytesWritten };
  }

  fd_sync() {
    if (this.closed) return wasiShim.wasi.ERRNO_BADF;
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return flushRet;
    this.inode.file.flush();
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  fd_close() {
    if (this.closed) return wasiShim.wasi.ERRNO_SUCCESS;
    const flushRet = this.flushPendingWrite();
    if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return flushRet;
    this.closed = true;
    this.writeBuffer = null;
    this.writeBufferLength = 0;
    this.writeBufferStart = 0n;
    return this.inode.releaseOpenFile();
  }

  pendingWriteBufferLength() {
    if (this.closed) return 0;
    return this.writeBufferLength;
  }

  ensureWriteBuffer() {
    if (!this.writeBuffer) {
      this.writeBuffer = new Uint8Array(OPFS_SEQUENTIAL_WRITE_BUFFER_BYTES);
    }
    return this.writeBuffer;
  }

  flushPendingWrite() {
    if (this.closed) return wasiShim.wasi.ERRNO_BADF;
    if (this.writeBufferLength <= 0) return wasiShim.wasi.ERRNO_SUCCESS;
    const source = this.writeBuffer.subarray(0, this.writeBufferLength);
    const bytesWritten = this.inode.file.writeAt(this.writeBufferStart, source);
    if (bytesWritten !== this.writeBufferLength) {
      if (bytesWritten > 0 && bytesWritten < this.writeBufferLength) {
        this.writeBuffer.copyWithin(0, bytesWritten, this.writeBufferLength);
        this.writeBufferStart += BigInt(bytesWritten);
        this.writeBufferLength -= bytesWritten;
      }
      return wasiShim.wasi.ERRNO_IO;
    }
    this.writeBufferLength = 0;
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  bufferSequentialWrite(data) {
    if (this.closed) return { ret: wasiShim.wasi.ERRNO_BADF, nwritten: 0 };
    let nwritten = 0;
    while (nwritten < data.byteLength) {
      if (this.writeBufferLength > 0) {
        const expectedPosition = this.writeBufferStart + BigInt(this.writeBufferLength);
        if (this.position !== expectedPosition) {
          const flushRet = this.flushPendingWrite();
          if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: flushRet, nwritten };
        }
      }

      if (this.writeBufferLength === 0) {
        this.writeBufferStart = this.position;
        const remaining = data.byteLength - nwritten;
        if (remaining >= OPFS_SEQUENTIAL_DIRECT_WRITE_MIN_BYTES) {
          const source = data.subarray(nwritten);
          const bytesWritten = this.inode.file.writeAt(this.position, source);
          this.position += BigInt(bytesWritten);
          nwritten += bytesWritten;
          if (bytesWritten !== source.byteLength) break;
          continue;
        }
      }

      const buffer = this.ensureWriteBuffer();
      const available = buffer.byteLength - this.writeBufferLength;
      if (available <= 0) {
        const flushRet = this.flushPendingWrite();
        if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: flushRet, nwritten };
        continue;
      }
      const chunkLength = Math.min(data.byteLength - nwritten, available);
      buffer.set(data.subarray(nwritten, nwritten + chunkLength), this.writeBufferLength);
      this.writeBufferLength += chunkLength;
      this.position += BigInt(chunkLength);
      nwritten += chunkLength;
      if (this.writeBufferLength >= buffer.byteLength) {
        const flushRet = this.flushPendingWrite();
        if (flushRet !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: flushRet, nwritten };
      }
    }
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, nwritten };
  }
}

async function buildOpfsInodeMap({
  closeables,
  directoryHandle,
  guestPath,
  syncAccessMode,
  writableRoots,
}) {
  const entries = new Map();

  for await (const [entryName, entryHandle] of directoryHandle.entries()) {
    const entryGuestPath = joinGuestPath(guestPath, entryName);
    if (entryHandle.kind === 'directory') {
      const nested = await buildOpfsInodeMap({
        closeables,
        directoryHandle: entryHandle,
        guestPath: entryGuestPath,
        syncAccessMode,
        writableRoots,
      });
      entries.set(entryName, new wasiShim.Directory(nested));
      continue;
    }

    if (entryHandle.kind !== 'file') continue;

    const writable = isGuestPathWithinRoots(entryGuestPath, writableRoots);
    const syncHandle = await openSyncAccessHandle({
      fileHandle: entryHandle,
      mode: writable ? syncAccessMode : 'read-only',
    });
    const file = new BrowserOpfsRandomAccessFile(syncHandle);
    closeables.push(file);
    entries.set(entryName, new WasiRandomAccessFileInode(file, { readonly: !writable }));
  }

  return entries;
}

function addVirtualFilesToMount({ contents, mountPath, trace, virtualFiles }) {
  const restores = [];
  for (const entry of virtualFiles ?? []) {
    if (!isGuestPathWithinMount(entry.path, mountPath)) {
      trace?.(`[browser-opfs] virtual file skipped outside mount path=${basenameForTrace(entry.path)} mount=${mountPath}`);
      continue;
    }
    const relativePath = entry.path === mountPath ? '' : entry.path.slice(mountPath.length + 1);
    addVirtualFileEntry(contents, relativePath, entry.source, restores, trace);
  }
  return restores;
}

function addVirtualFileEntry(contents, relativePath, source, restores, trace) {
  const parts = normalizeWasiRelativePathParts(relativePath);
  if (parts === null || parts.length === 0) {
    throw new TypeError(`virtual file path must be inside a mounted directory: ${relativePath}`);
  }
  let entries = contents;
  for (const part of parts.slice(0, -1)) {
    const existing = entries.get(part) ?? null;
    if (!existing) {
      const directory = new wasiShim.Directory(new Map());
      entries.set(part, directory);
      entries = directory.contents;
      continue;
    }
    if (!(existing.contents instanceof Map)) {
      throw new Error(`virtual file parent path is not a directory: ${relativePath}`);
    }
    entries = existing.contents;
  }
  const file = new BrowserVirtualRandomAccessFile(source, { trace });
  const name = parts[parts.length - 1];
  trace?.(
    `[browser-opfs] virtual file mounted name=${name} proxy=${Boolean(file.proxy)} size=${file.size()}`,
  );
  restores.push({
    entries,
    hadExisting: entries.has(name),
    name,
    value: entries.get(name) ?? null,
  });
  entries.set(name, new WasiRandomAccessFileInode(file, { closeOnLastFdClose: true, readonly: true }));
}

function restoreVirtualFiles(restores) {
  for (let index = restores.length - 1; index >= 0; index -= 1) {
    const restore = restores[index];
    const current = restore.entries.get(restore.name) ?? null;
    if (current instanceof WasiRandomAccessFileInode && typeof current.file?.close === 'function') {
      try {
        current.file.close();
      } catch {
        // ignore best-effort virtual-file cleanup failures
      }
    }
    if (restore.hadExisting) {
      restore.entries.set(restore.name, restore.value);
      continue;
    }
    restore.entries.delete(restore.name);
  }
}

async function flushBrowserOpfsMounts(mounts, trace) {
  for (const mount of mounts) {
    await flushInMemoryEntriesToOpfs(mount.directoryHandle, mount.contents);
    await replaceScratchBackedEntriesWithOpfsHandles({
      directoryHandle: mount.directoryHandle,
      entries: mount.contents,
      mount,
    });
    mount.resetScratchPool?.({ trace });
  }
}

async function replaceScratchBackedEntriesWithOpfsHandles({
  directoryHandle,
  entries,
  mount,
}) {
  for (const [name, entry] of entries) {
    if (entry instanceof WasiRandomAccessFileInode) {
      if (!entry.scratchBacked) continue;
      const fileHandle = await directoryHandle.getFileHandle(name, { create: true });
      const syncHandle = await openSyncAccessHandle({
        fileHandle,
        mode: writableSyncAccessMode(mount.syncAccessMode),
      });
      const file = new BrowserOpfsRandomAccessFile(syncHandle);
      mount.trackOwnedFile(file);
      entry.file = file;
      entry.scratchBacked = false;
      continue;
    }
    if (entry instanceof wasiShim.Directory) {
      const childHandle = await directoryHandle.getDirectoryHandle(name, { create: true });
      await replaceScratchBackedEntriesWithOpfsHandles({
        directoryHandle: childHandle,
        entries: entry.contents,
        mount,
      });
    }
  }
}

async function flushInMemoryEntriesToOpfs(directoryHandle, entries) {
  for (const [name, entry] of entries) {
    if (entry instanceof WasiRandomAccessFileInode) {
      if (entry.scratchBacked) {
        const fileHandle = await directoryHandle.getFileHandle(name, { create: true });
        await copyRandomAccessFileToHandle(entry.file, fileHandle);
      } else if (typeof entry.file?.flush === 'function') {
        entry.file.flush();
      }
      continue;
    }

    if (entry instanceof wasiShim.Directory) {
      const childHandle = await directoryHandle.getDirectoryHandle(name, { create: true });
      await flushInMemoryEntriesToOpfs(childHandle, entry.contents);
      continue;
    }

    if (entry instanceof wasiShim.File) {
      const fileHandle = await directoryHandle.getFileHandle(name, { create: true });
      await writeFileHandle(fileHandle, entry.data);
    }
  }
}

async function syncMountedInputPathsFromOpfs({
  cwdMountPath,
  knownInputPaths,
  mounts,
  mountHandles,
  request,
  runtimeMounts,
  trace,
}) {
  const inputPaths = collectMountedInputPaths(request, knownInputPaths);
  const summary = { paths: inputPaths.length, hydrated: 0, missing: 0 };
  if (inputPaths.length === 0) return summary;
  const mountsByPath = new Map(mounts.map((mount) => [mount.mountPath, mount]));
  for (const path of inputPaths) {
    const resolved = resolveMountedGuestPath(path, mountHandles, runtimeMounts, { cwdMountPath });
    if (!resolved) continue;
    const mount = mountsByPath.get(resolved.mountPath);
    if (!mount) continue;
    const relativePath = resolved.relativeParts.join('/');
    if (relativePath.length === 0 || pathExistsInDirectory(mount.contents, relativePath)) continue;
    const hydrated = await hydrateMountedInputPathFromOpfs({
      mount,
      relativeParts: resolved.relativeParts,
      rootHandle: resolved.handle,
    });
    if (hydrated) {
      summary.hydrated += 1;
    } else {
      summary.missing += 1;
      trace?.(`[browser-opfs] sync mounted input path missing path=${basenameForTrace(path)}`);
    }
  }
  return summary;
}

function collectMountedInputPaths(request, knownInputPaths) {
  return collectRomWeaverRunInputPaths(request, {
    knownInputPaths: normalizeKnownInputPaths(knownInputPaths),
  });
}

async function hydrateMountedInputPathFromOpfs({ mount, relativeParts, rootHandle }) {
  if (!Array.isArray(relativeParts) || relativeParts.length === 0) return false;
  let entries = mount.contents;
  let directoryHandle = rootHandle;
  for (const part of relativeParts.slice(0, -1)) {
    let entry = entries.get(part) ?? null;
    if (!entry) {
      try {
        directoryHandle = await directoryHandle.getDirectoryHandle(part, { create: false });
      } catch {
        return false;
      }
      entry = new wasiShim.Directory(new Map());
      entries.set(part, entry);
    } else {
      try {
        directoryHandle = await directoryHandle.getDirectoryHandle(part, { create: false });
      } catch {
        return false;
      }
    }
    if (!(entry instanceof wasiShim.Directory)) return false;
    entries = entry.contents;
  }

  const name = relativeParts[relativeParts.length - 1];
  if (entries.has(name)) return true;

  const guestPath = joinGuestPath(mount.mountPath, relativeParts.join('/'));
  const writable = mount.isWritablePath(guestPath);
  try {
    const fileHandle = await directoryHandle.getFileHandle(name, { create: false });
    const syncHandle = await openSyncAccessHandle({
      fileHandle,
      mode: writable ? mount.syncAccessMode : 'read-only',
    });
    const file = new BrowserOpfsRandomAccessFile(syncHandle);
    mount.trackOwnedFile(file);
    entries.set(name, new WasiRandomAccessFileInode(file, { readonly: !writable }));
    return true;
  } catch {
    // ignored
  }

  try {
    await directoryHandle.getDirectoryHandle(name, { create: false });
    entries.set(name, new wasiShim.Directory(new Map()));
    return true;
  } catch {
    // ignored
  }
  return false;
}

function resolveMountedGuestPath(path, mountHandles, runtimeMounts, { cwdMountPath } = {}) {
  const rawPath = String(path ?? '').trim();
  const candidatePaths = [normalizeGuestPath(rawPath, { label: 'prepared request path' })];
  if (rawPath && !rawPath.startsWith('/') && cwdMountPath) {
    candidatePaths.push(joinGuestPath(cwdMountPath, rawPath));
  }
  const sortedMounts = [...runtimeMounts].sort((a, b) => b.length - a.length);
  for (const normalizedPath of candidatePaths) {
    for (const mountPath of sortedMounts) {
      if (normalizedPath !== mountPath && !normalizedPath.startsWith(`${mountPath}/`)) continue;
      const handle = mountHandles[mountPath];
      if (!handle) return null;
      const relative = normalizedPath === mountPath ? '' : normalizedPath.slice(mountPath.length + 1);
      return {
        handle,
        mountPath,
        relativeParts: relative ? normalizeRelativePathParts(relative, { label: normalizedPath }) : [],
      };
    }
  }
  return null;
}

function requestsWriteRights(fsRightsBase, oflags) {
  return (BigInt(fsRightsBase) & BigInt(wasiShim.wasi.RIGHTS_FD_WRITE)) === BigInt(wasiShim.wasi.RIGHTS_FD_WRITE)
    || (oflags & wasiShim.wasi.OFLAGS_TRUNC) === wasiShim.wasi.OFLAGS_TRUNC
    || (oflags & wasiShim.wasi.OFLAGS_CREAT) === wasiShim.wasi.OFLAGS_CREAT;
}

function pathExistsInDirectory(contents, pathStr) {
  return Boolean(findEntryInDirectory(contents, pathStr));
}

function pathIsDirectoryInDirectory(contents, pathStr) {
  const entry = findEntryInDirectory(contents, pathStr);
  return Boolean(entry && entry instanceof wasiShim.Directory);
}

function findEntryInDirectory(contents, pathStr) {
  if (!(contents instanceof Map)) return null;
  const parts = normalizeWasiRelativePathParts(pathStr);
  if (parts === null) return null;
  if (parts.length === 0) return new wasiShim.Directory(contents);

  let currentEntries = contents;
  let entry = null;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    entry = currentEntries.get(part) ?? null;
    if (!entry) return null;
    if (index === parts.length - 1) return entry;
    if (!(entry.contents instanceof Map)) return null;
    currentEntries = entry.contents;
  }
  return null;
}

function createInMemoryEntry(contents, pathStr, { directory, mount }) {
  const parts = normalizeWasiRelativePathParts(pathStr);
  if (parts === null) return wasiShim.wasi.ERRNO_NOTCAPABLE;
  if (parts.length === 0) return wasiShim.wasi.ERRNO_EXIST;
  const parent = resolveParentDirectory(contents, parts);
  if (parent.ret !== wasiShim.wasi.ERRNO_SUCCESS) return parent.ret;
  if (parent.entries.has(parent.name)) return wasiShim.wasi.ERRNO_EXIST;
  if (directory) {
    parent.entries.set(parent.name, new wasiShim.Directory(new Map()));
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  const file = mount?.takeScratchFile?.() ?? null;
  if (!file) return wasiShim.wasi.ERRNO_NOSPC;
  parent.entries.set(
    parent.name,
    new WasiRandomAccessFileInode(file, { scratchBacked: true }),
  );
  return wasiShim.wasi.ERRNO_SUCCESS;
}

function setEntryInDirectory(contents, pathStr, inode) {
  const parts = normalizeWasiRelativePathParts(pathStr);
  if (parts === null) return wasiShim.wasi.ERRNO_NOTCAPABLE;
  if (parts.length === 0) return wasiShim.wasi.ERRNO_INVAL;
  const parent = resolveParentDirectory(contents, parts);
  if (parent.ret !== wasiShim.wasi.ERRNO_SUCCESS) return parent.ret;
  const existing = parent.entries.get(parent.name) ?? null;
  if (existing && copyInodeContents(existing, inode)) {
    return wasiShim.wasi.ERRNO_SUCCESS;
  }
  parent.entries.set(parent.name, inode);
  return wasiShim.wasi.ERRNO_SUCCESS;
}

function copyInodeContents(target, source) {
  if (!(target instanceof WasiRandomAccessFileInode) || target.readonly) return false;
  if (source instanceof WasiRandomAccessFileInode) {
    copyRandomAccessFileSync(source.file, target.file);
    return true;
  }
  const bytes = readInodeBytes(source);
  if (!bytes) return false;
  target.file.truncate(0);
  if (bytes.byteLength > 0) target.file.writeAt(0, bytes);
  target.file.flush();
  return true;
}

function readInodeBytes(inode) {
  if (inode instanceof wasiShim.File) {
    return inode.data instanceof Uint8Array ? inode.data : new Uint8Array(inode.data ?? []);
  }
  return null;
}

async function createScratchFilePool({
  closeables,
  directoryHandle,
  scratchFilePoolSize,
  syncAccessMode,
}) {
  const count = normalizeScratchFilePoolSize(scratchFilePoolSize);
  if (count === 0) {
    return { directoryHandle: null, files: [], pool: [] };
  }

  const scratchDirectoryHandle = await directoryHandle.getDirectoryHandle(
    SCRATCH_DIRECTORY_NAME,
    { create: true },
  );
  const token = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  const files = new Array(count);
  await forEachRangeConcurrently({
    count,
    limit: Math.min(count, SCRATCH_FILE_CREATE_CONCURRENCY),
    async run(index) {
      const scratchName = `${token}-${index}.tmp`;
      const fileHandle = await scratchDirectoryHandle.getFileHandle(scratchName, { create: true });
      const syncHandle = await openSyncAccessHandle({
        fileHandle,
        mode: writableSyncAccessMode(syncAccessMode),
      });
      const file = new BrowserOpfsRandomAccessFile(syncHandle, { scratchName });
      files[index] = file;
      closeables.push(file);
    },
  });
  return {
    directoryHandle: scratchDirectoryHandle,
    files,
    pool: [...files],
  };
}

async function forEachRangeConcurrently({
  count,
  limit,
  run,
}) {
  const total = Math.max(0, Number(count) || 0);
  if (total === 0) return;
  const parallel = Math.max(1, Math.floor(Number(limit) || 1));
  let nextIndex = 0;
  const workers = [];
  const workerCount = Math.min(parallel, total);
  for (let worker = 0; worker < workerCount; worker += 1) {
    workers.push((async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= total) return;
        await run(index);
      }
    })());
  }
  await Promise.all(workers);
}

function createMemoryScratchFilePool({ closeables, scratchFilePoolSize }) {
  const count = normalizeScratchFilePoolSize(scratchFilePoolSize);
  const files = [];
  for (let index = 0; index < count; index += 1) {
    const file = new BrowserMemoryRandomAccessFile();
    files.push(file);
    closeables.push(file);
  }
  return {
    directoryHandle: null,
    files,
    pool: [...files],
  };
}

function normalizeScratchFilePoolSize(value) {
  if (value === undefined || value === null) return DEFAULT_SCRATCH_FILE_POOL_SIZE;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SCRATCH_FILE_POOL_SIZE;
  return Math.floor(parsed);
}

function writableSyncAccessMode(mode) {
  return mode === 'read-only' ? undefined : mode;
}

async function cleanupBrowserOpfsMounts(mounts) {
  for (const mount of mounts) {
    mount.finishRun();
    if (Array.isArray(mount.scratchFiles) && mount.scratchFiles.length > 0) {
      mount.scratchPool = [...mount.scratchFiles];
    }
  }
}

function copyRandomAccessFileSync(source, target) {
  if (source === target) return;
  const size = Number(source.size());
  const buffer = new Uint8Array(OPFS_COPY_CHUNK_SIZE);
  target.truncate(size);
  let offset = 0;
  while (offset < size) {
    const length = Math.min(buffer.byteLength, size - offset);
    const view = buffer.subarray(0, length);
    const read = source.readAt(offset, view);
    if (read <= 0) break;
    target.writeAt(offset, view.subarray(0, read));
    offset += read;
  }
  target.flush();
}

async function copyRandomAccessFileToHandle(source, fileHandle) {
  const size = Number(source.size());
  if (typeof fileHandle.createSyncAccessHandle === 'function') {
    const accessHandle = await openSyncAccessHandle({ fileHandle, mode: 'readwrite' });
    try {
      const buffer = new Uint8Array(OPFS_COPY_CHUNK_SIZE);
      accessHandle.truncate(0);
      let offset = 0;
      while (offset < size) {
        const length = Math.min(buffer.byteLength, size - offset);
        const view = buffer.subarray(0, length);
        const read = source.readAt(offset, view);
        if (read <= 0) break;
        accessHandle.write(view.subarray(0, read), { at: offset });
        offset += read;
      }
      accessHandle.truncate(offset);
      accessHandle.flush();
    } finally {
      accessHandle.close();
    }
    return;
  }

  const writable = await fileHandle.createWritable({ keepExistingData: false });
  let writeError = null;
  try {
    const buffer = new Uint8Array(OPFS_COPY_CHUNK_SIZE);
    let offset = 0;
    while (offset < size) {
      const length = Math.min(buffer.byteLength, size - offset);
      const view = buffer.subarray(0, length);
      const read = source.readAt(offset, view);
      if (read <= 0) break;
      await writable.write({
        data: view.slice(0, read),
        position: offset,
        type: 'write',
      });
      offset += read;
    }
    await writable.truncate(size);
  } catch (error) {
    writeError = error;
    throw error;
  } finally {
    await closeWritableStream(writable, writeError);
  }
}

function unlinkEntryFromDirectory(contents, pathStr) {
  const parts = normalizeWasiRelativePathParts(pathStr);
  if (parts === null) return { ret: wasiShim.wasi.ERRNO_NOTCAPABLE, inode_obj: null };
  if (parts.length === 0) return { ret: wasiShim.wasi.ERRNO_INVAL, inode_obj: null };
  const parent = resolveParentDirectory(contents, parts);
  if (parent.ret !== wasiShim.wasi.ERRNO_SUCCESS) return { ret: parent.ret, inode_obj: null };
  const entry = parent.entries.get(parent.name) ?? null;
  if (!entry) return { ret: wasiShim.wasi.ERRNO_NOENT, inode_obj: null };
  parent.entries.delete(parent.name);
  return { ret: wasiShim.wasi.ERRNO_SUCCESS, inode_obj: entry };
}

function resolveParentDirectory(contents, parts) {
  let entries = contents;
  for (const part of parts.slice(0, -1)) {
    const entry = entries.get(part) ?? null;
    if (!entry) return { ret: wasiShim.wasi.ERRNO_NOENT, entries: null, name: null };
    if (!(entry.contents instanceof Map)) {
      return { ret: wasiShim.wasi.ERRNO_NOTDIR, entries: null, name: null };
    }
    entries = entry.contents;
  }
  return { ret: wasiShim.wasi.ERRNO_SUCCESS, entries, name: parts[parts.length - 1] };
}

function normalizeWasiRelativePathParts(pathStr) {
  const value = String(pathStr);
  if (value.startsWith('/') || value.includes('\0')) return null;
  const parts = [];
  for (const token of value.split('/')) {
    if (token === '' || token === '.') continue;
    if (token === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(token);
  }
  return parts;
}

function validateWasiRelativePath(pathStr) {
  const value = String(pathStr);
  if (value.startsWith('/')) return wasiShim.wasi.ERRNO_NOTCAPABLE;
  if (value.includes('\0')) return wasiShim.wasi.ERRNO_INVAL;

  const parts = [];
  for (const token of value.split('/')) {
    if (token === '' || token === '.') continue;
    if (token === '..') {
      if (parts.length === 0) return wasiShim.wasi.ERRNO_NOTCAPABLE;
      parts.pop();
      continue;
    }
    parts.push(token);
  }

  return wasiShim.wasi.ERRNO_SUCCESS;
}

function pathRequiresDirectory(pathStr, oflags) {
  return (oflags & wasiShim.wasi.OFLAGS_DIRECTORY) === wasiShim.wasi.OFLAGS_DIRECTORY
    || String(pathStr).endsWith('/');
}

function createOutputCollector(ConsoleStdout, options = {}) {
  const chunks = [];
  const lineStream = createTextLineStream(options.onLine);
  return {
    chunks,
    flush() {
      lineStream?.flush();
    },
    fd: new ConsoleStdout((bytes) => {
      const chunk = copyUint8Array(bytes);
      chunks.push(chunk);
      lineStream?.push(chunk);
    }),
  };
}

function createTextLineStream(onLine) {
  if (typeof onLine !== 'function') return null;
  const decoder = new TextDecoder();
  let pending = '';

  return {
    push(bytes) {
      pending += decoder.decode(bytes, { stream: true });
      emitCompleteLines();
    },
    flush() {
      pending += decoder.decode();
      if (pending.length > 0) {
        emitLine(pending);
        pending = '';
      }
    },
  };

  function emitCompleteLines() {
    let lineEnd = pending.indexOf('\n');
    while (lineEnd !== -1) {
      emitLine(pending.slice(0, lineEnd));
      pending = pending.slice(lineEnd + 1);
      lineEnd = pending.indexOf('\n');
    }
  }

  function emitLine(line) {
    onLine(line.endsWith('\r') ? line.slice(0, -1) : line);
  }
}

function decodeChunks(chunks) {
  const decoder = new TextDecoder();
  let output = '';
  for (const chunk of chunks) {
    output += decoder.decode(chunk, { stream: true });
  }
  output += decoder.decode();
  return output;
}

async function openSyncAccessHandle({ fileHandle, mode }) {
  if (mode === undefined) return fileHandle.createSyncAccessHandle();
  try {
    return await fileHandle.createSyncAccessHandle({ mode });
  } catch (error) {
    if (mode === 'read-only') return fileHandle.createSyncAccessHandle();
    throw error;
  }
}

function closeSyncFiles(files) {
  for (const file of files) {
    try {
      file.close();
    } catch {
      // ignore best-effort close failures
    }
  }
}

async function verifyWritableOpfsRoot(rootHandle) {
  const probeName = `.rw-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const probeFile = await rootHandle.getFileHandle(probeName, { create: true });
  let accessHandle = null;
  try {
    accessHandle = await openSyncAccessHandle({ fileHandle: probeFile, mode: 'readwrite' });
    accessHandle.write(new Uint8Array([0x52, 0x57]), { at: 0 });
    accessHandle.flush();
  } catch (error) {
    throw new Error(`OPFS root is not writable with sync access handles: ${error}`);
  } finally {
    if (accessHandle) {
      try {
        accessHandle.close();
      } catch {
        // ignore best-effort close failures
      }
    }
    try {
      await rootHandle.removeEntry(probeName);
    } catch {
      // ignore best-effort cleanup failures
    }
  }
}

async function writeFileHandle(fileHandle, data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data ?? []);
  if (typeof fileHandle.createSyncAccessHandle === 'function') {
    const accessHandle = await openSyncAccessHandle({ fileHandle, mode: 'readwrite' });
    try {
      accessHandle.truncate(0);
      if (bytes.byteLength > 0) accessHandle.write(bytes, { at: 0 });
      accessHandle.truncate(bytes.byteLength);
      accessHandle.flush();
    } finally {
      accessHandle.close();
    }
    return;
  }

  const writable = await fileHandle.createWritable({ keepExistingData: false });
  let writeError = null;
  try {
    await writable.write(bytes);
  } catch (error) {
    writeError = error;
    throw error;
  } finally {
    await closeWritableStream(writable, writeError);
  }
}

async function closeWritableStream(writable, priorError) {
  if (priorError) {
    if (typeof writable.abort === 'function') {
      try {
        await writable.abort(priorError);
      } catch {
        // Preserve the write/truncate error that caused the stream to enter an errored state.
      }
    } else {
      try {
        await writable.close();
      } catch {
        // Preserve the write/truncate error that caused the stream to enter an errored state.
      }
    }
    throw priorError;
  }
  await writable.close();
}

function normalizeMountHandleMap({ mountHandles }) {
  const normalized = {};
  if (!mountHandles) return normalized;

  for (const [guestPath, handle] of Object.entries(mountHandles)) {
    const normalizedGuestPath = normalizeGuestPath(guestPath, {
      label: `mountHandles[${guestPath}]`,
    });
    assertDirectoryHandle(handle, `mountHandles[${guestPath}]`);
    normalized[normalizedGuestPath] = handle;
  }

  return normalized;
}

function normalizeVirtualFiles(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError('virtualFiles must be an array');
  return value.map((entry, index) => normalizeVirtualFile(entry, index));
}

function normalizeVirtualFile(entry, index) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError(`virtualFiles[${index}] must be an object`);
  }
  const path = normalizeGuestPath(entry.path, { label: `virtualFiles[${index}].path` });
  const source = entry.source ?? entry.file ?? entry.blob ?? entry.bytes ?? entry.data;
  const proxy = entry.proxy;
  if (isVirtualFileProxy(proxy)) return { path, source: proxy };
  if (isVirtualFileProxy(source)) return { path, source };
  if (isBlobLike(source)) {
    if (typeof FileReaderSync !== 'function') {
      throw new Error('Blob virtual files require FileReaderSync in a dedicated worker');
    }
    return { path, source };
  }
  if (source instanceof Uint8Array || source instanceof ArrayBuffer) return { path, source };
  throw new TypeError(`virtualFiles[${index}].source must be a Blob, File, Uint8Array, or ArrayBuffer`);
}

function normalizeWritableRoots({
  workGuestPath,
  writableDirectories,
  inherited,
}) {
  const roots = new Set(inherited ?? [workGuestPath]);
  for (const root of normalizeGuestPathList(writableDirectories, 'writableDirectories')) roots.add(root);
  return [...roots].sort((a, b) => a.localeCompare(b));
}

function normalizeGuestPathList(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array of guest paths`);
  return value.map((entry) => normalizeGuestPath(String(entry), { label }));
}

function normalizeKnownInputPaths(value) {
  return normalizeGuestPathList(value, 'knownInputPaths');
}

function normalizePreopenOutputPaths(value) {
  return normalizeGuestPathList(value, 'preopenOutputPaths');
}

function isGuestPathWithinRoots(path, roots) {
  const normalizedPath = normalizeGuestPath(path, { label: 'guest path' });
  for (const root of roots) {
    if (normalizedPath === root || normalizedPath.startsWith(`${root}/`)) return true;
  }
  return false;
}

function isGuestPathWithinMount(path, mountPath) {
  return path === mountPath || path.startsWith(`${mountPath}/`);
}

function joinGuestPath(...parts) {
  const joined = parts
    .map((part, index) => {
      const value = String(part ?? '');
      if (index === 0) return value.replace(/\/+$/, '');
      return value.replace(/^\/+/, '').replace(/\/+$/, '');
    })
    .filter((part) => part.length > 0)
    .join('/');
  return normalizeGuestPath(joined.startsWith('/') ? joined : `/${joined}`, { label: 'guest path' });
}

function normalizeRelativePathParts(value, { label = 'relative path' } = {}) {
  const parts = String(value ?? '')
    .replace(/^\/+/, '')
    .split(PATH_SEPARATOR_REGEX)
    .filter((part) => part.length > 0);
  for (const part of parts) {
    if (part === '.' || part === '..' || part.includes('\0')) {
      throw new TypeError(`${label} contains an unsafe path segment`);
    }
  }
  return parts;
}

function createBrowserWasiThreadWorkerPool({ initialSize, threadWorkerUrl }) {
  const resolvedThreadWorkerUrl = resolveThreadWorkerUrl(threadWorkerUrl);
  const workers = [];
  let disposed = false;
  let nextCommandId = 1;

  const rejectShell = (slot, error) => {
    slot.rejectReady?.(error);
    slot.resolveReady = null;
    slot.rejectReady = null;
  };

  const failShell = (shell, error) => {
    shell.terminated = true;
    try {
      shell.worker?.terminate();
    } catch {
      // ignored
    }
    rejectShell(shell, error);
    const command = shell.currentCommand;
    if (!command) return;
    command.failure = error;
    Atomics.store(command.control, THREAD_SLOT_ERROR_INDEX, 1);
    signalThreadStartState(command.control, THREAD_SLOT_STATE_FAILED);
    command.rejectReady?.(error);
    command.resolveDone?.();
    shell.currentCommand = null;
  };

  const handleShellMessage = (shell, message) => {
    if (message.type === 'shell-ready') {
      shell.online = true;
      shell.resolveReady?.();
      shell.resolveReady = null;
      shell.rejectReady = null;
      return;
    }
    const command = shell.currentCommand;
    if (!command || message.commandId !== command.commandId) return;
    if (message.type === 'ready') {
      command.readyResolved = true;
      command.resolveReady?.();
      command.resolveReady = null;
      command.rejectReady = null;
      return;
    }
    if (message.type === 'command-done') {
      shell.currentCommand = null;
      command.resolveDone?.();
      return;
    }
    if (message.type === 'error') {
      const error = annotateThreadWorkerError(
        deserializeThreadWorkerError(message.error),
        command,
        resolvedThreadWorkerUrl,
      );
      command.failure = error;
      Atomics.store(command.control, THREAD_SLOT_ERROR_INDEX, 1);
      signalThreadStartState(command.control, THREAD_SLOT_STATE_FAILED);
      if (Number.isInteger(message.tid)) {
        command.tid = message.tid;
        return;
      }
      command.resolveDone?.();
      shell.currentCommand = null;
      command.rejectReady?.(error);
    }
  };

  const createShell = (index) => {
    const slot = {
      index,
      worker: null,
      online: false,
      currentCommand: null,
      readyTimer: null,
      ready: null,
      resolveReady: null,
      rejectReady: null,
      terminated: false,
    };
    slot.ready = new Promise((resolveReady, rejectReady) => {
      slot.resolveReady = resolveReady;
      slot.rejectReady = rejectReady;
    }).finally(() => {
      if (slot.readyTimer) clearTimeout(slot.readyTimer);
      slot.readyTimer = null;
    });
    slot.readyTimer = setTimeout(() => {
      failShell(slot, new Error(
        `browser wasi thread worker ${slot.index} did not become ready within ${THREAD_WORKER_READY_TIMEOUT_MS}ms`
        + ` (workerUrl=${resolvedThreadWorkerUrl})`,
      ));
    }, THREAD_WORKER_READY_TIMEOUT_MS);

    const worker = new Worker(resolvedThreadWorkerUrl, { type: 'module' });
    slot.worker = worker;
    worker.addEventListener('message', (event) => handleShellMessage(slot, event.data ?? {}));
    worker.addEventListener('error', (event) => {
      event.preventDefault?.();
      const error = createThreadWorkerLoadError(event, slot.currentCommand ?? slot, resolvedThreadWorkerUrl);
      failShell(slot, error);
    });
    worker.addEventListener('messageerror', (event) => {
      event.preventDefault?.();
      failShell(slot, new Error(
        `browser wasi thread worker ${slot.index} could not receive its message`
        + ` (workerUrl=${resolvedThreadWorkerUrl})`,
      ));
    });
    worker.postMessage({ mode: 'pool-shell' });
    return slot;
  };

  const ensureSize = async (size) => {
    if (disposed) throw new Error('browser wasi thread worker pool is disposed');
    const targetSize = Math.min(Math.max(0, size), MAX_BROWSER_THREAD_POOL_SIZE);
    while (workers.length < targetSize) workers.push(createShell(workers.length));
    await Promise.all(workers.slice(0, targetSize).map((slot) => slot.ready));
  };

  const selectAvailableShells = async (poolSize, trace, commandId) => {
    const deadline = Date.now() + THREAD_WORKER_BUSY_RETRY_TIMEOUT_MS;
    while (true) {
      const available = workers.filter((shell) => !shell.terminated && !shell.currentCommand);
      if (available.length >= poolSize) return available.slice(0, poolSize);
      if (Date.now() >= deadline) {
        const busyShell = workers.find((shell) => !shell.terminated && shell.currentCommand);
        if (busyShell) throw new Error(`browser wasi thread worker ${busyShell.index} is already busy`);
        throw new Error('browser wasi thread worker pool does not have enough available workers');
      }
      await new Promise((resolve) => setTimeout(resolve, THREAD_WORKER_BUSY_RETRY_INTERVAL_MS));
    }
  };

  const isReady = (size) => {
    if (disposed) return false;
    const targetSize = Math.min(Math.max(0, size), MAX_BROWSER_THREAD_POOL_SIZE);
    if (targetSize === 0) return true;
    if (workers.length < targetSize) return false;
    return workers.slice(0, targetSize).every((slot) => slot.online
      && !slot.terminated
      && !slot.currentCommand);
  };

  const createCommand = ({
    poolSize,
    streamBroadcastChannelName,
    streamRequestId,
    trace,
    debugWasi,
    envList,
    runtime,
    threadIdState,
    threadWorkerUrl,
    wasiArgs,
    wasmMemory,
    wasmModule,
  }) => {
    const commandId = nextCommandId;
    nextCommandId += 1;
    const commandStartMs = monotonicNowMs();
    trace?.(`[browser-opfs] thread pool command create id=${commandId} poolSize=${poolSize}`);
    const command = {
      commandId,
      debugWasi,
      envList,
      ready: null,
      runtime,
      slots: [],
      streamBroadcastChannelName,
      streamRequestId,
      threadIdState,
      threadWorkerUrl: resolvedThreadWorkerUrl,
      wasiArgs,
      wasmMemory,
      wasmModule,
      shutdown: async () => {
        const shutdownStartMs = monotonicNowMs();
        trace?.(`[browser-opfs] thread pool command shutdown start id=${commandId}`);
        for (const slot of command.slots) {
          if (slot.shell.currentCommand !== slot) continue;
          while (true) {
            const state = Atomics.load(slot.control, THREAD_SLOT_STATE_INDEX);
            if (
              state === THREAD_SLOT_STATE_IDLE
              || state === THREAD_SLOT_STATE_FAILED
              || state === THREAD_SLOT_STATE_SHUTDOWN
            ) {
              break;
            }
            trace?.(
              `[browser-opfs] thread pool command shutdown wait worker=${slot.index} state=${state} id=${commandId}`,
            );
            waitForAtomicsStateChange(slot.control, THREAD_SLOT_STATE_INDEX, state);
          }
          Atomics.store(slot.control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_SHUTDOWN);
          Atomics.notify(slot.control, THREAD_SLOT_STATE_INDEX, 1);
        }
        await Promise.allSettled(command.slots.map((slot) => slot.done));
        trace?.(`[browser-opfs] thread pool command shutdown done id=${commandId} ms=${(monotonicNowMs() - shutdownStartMs).toFixed(1)}`);
      },
    };
    command.ready = ensureSize(poolSize).then(async () => {
      const ensureMs = monotonicNowMs() - commandStartMs;
      if (threadWorkerUrl && resolveThreadWorkerUrl(threadWorkerUrl) !== resolvedThreadWorkerUrl) {
        throw new Error(
          `browser wasi thread worker pool URL mismatch: ${resolvedThreadWorkerUrl} !== ${threadWorkerUrl}`,
        );
      }
      const selectStartMs = monotonicNowMs();
      const shells = await selectAvailableShells(poolSize, trace, commandId);
      const selectMs = monotonicNowMs() - selectStartMs;
      trace?.(
        `[browser-opfs] thread pool command selected workers id=${commandId} workers=${shells.map((shell) => shell.index).join(',')}`,
      );
      const postStartMs = monotonicNowMs();
      for (const shell of shells) {
        if (shell.terminated) throw new Error(`browser wasi thread worker ${shell.index} is not available`);
        const control = new Int32Array(
          new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * THREAD_SLOT_LENGTH),
        );
        control[THREAD_SLOT_STATE_INDEX] = THREAD_SLOT_STATE_IDLE;
        control[THREAD_SLOT_TID_INDEX] = 0;
        control[THREAD_SLOT_START_ARG_INDEX] = 0;
        control[THREAD_SLOT_ERROR_INDEX] = 0;
        const commandSlot = {
          commandId,
          index: shell.index,
          worker: shell.worker,
          shell,
          control,
          online: true,
          busy: false,
          tid: null,
          failure: null,
          readyResolved: false,
          resolveReady: null,
          rejectReady: null,
          resolveDone: null,
        };
        commandSlot.ready = new Promise((resolveReady, rejectReady) => {
          commandSlot.resolveReady = resolveReady;
          commandSlot.rejectReady = rejectReady;
        });
        commandSlot.done = new Promise((resolveDone) => {
          commandSlot.resolveDone = resolveDone;
        });
        shell.currentCommand = commandSlot;
        command.slots.push(commandSlot);
        const payload = {
          mode: 'pool-command',
          commandId,
          __streamBroadcastChannelName: streamBroadcastChannelName,
          __streamRequestId: streamRequestId,
          controlBuffer: control.buffer,
          debugWasi,
          envList,
          runtime: createThreadWorkerRuntimePayload(runtime),
          threadIdState,
          threadWorkerUrl: resolvedThreadWorkerUrl,
          wasiArgs,
          wasmMemory,
          wasmModule,
        };
        trace?.(`[browser-opfs] thread pool command post worker=${shell.index} id=${commandId}`);
        try {
          shell.worker.postMessage(payload);
          trace?.(`[browser-opfs] thread pool command post returned worker=${shell.index} id=${commandId}`);
        } catch (error) {
          trace?.(
            `[browser-opfs] thread pool command post failed worker=${shell.index} id=${commandId} ${formatErrorForTrace(error)}`,
          );
          commandSlot.failure = error;
          commandSlot.rejectReady?.(error);
          commandSlot.resolveDone?.();
          shell.currentCommand = null;
          throw error;
        }
      }
      const postMs = monotonicNowMs() - postStartMs;
      await Promise.all(command.slots.map((slot) => slot.ready));
      trace?.(
        `[browser-opfs] thread pool command ready id=${commandId} slots=${command.slots.length}`
        + ` ensureMs=${ensureMs.toFixed(1)} selectMs=${selectMs.toFixed(1)} postMs=${postMs.toFixed(1)}`
        + ` readyMs=${(monotonicNowMs() - commandStartMs).toFixed(1)}`,
      );
    });
    return command;
  };

  const dispose = async () => {
    disposed = true;
    for (const slot of workers) {
      try {
        slot.worker?.postMessage({ mode: 'shutdown' });
      } catch {
        // ignored
      }
      slot.worker?.terminate();
      slot.terminated = true;
    }
    workers.length = 0;
  };

  return {
    createCommand,
    dispose,
    isReady,
    ready: ensureSize(initialSize),
    resolvedThreadWorkerUrl,
  };
}

function createBrowserWasiThreadSpawner({
  allowWorkerPool = true,
  streamBroadcastChannelName,
  streamRequestId,
  trace,
  moduleImports,
  threadIdState,
  threadWorkerUrl,
  threadWorkerPool,
  wasmMemory,
  wasmModule,
  wasiArgs,
  envList,
  runtime,
}) {
  if (!needsWasiThreadSpawnImport(moduleImports)) {
    return {
      spawn: () => -WASI_ERRNO_ENOSYS,
      ready: Promise.resolve(),
      waitForWorkers: async () => {},
    };
  }
  if (!(wasmMemory instanceof WebAssembly.Memory)) {
    throw new Error('threaded wasm module imports wasi.thread-spawn, but no shared WebAssembly.Memory was created');
  }
  if (!(wasmMemory.buffer instanceof SharedArrayBuffer)) {
    throw new Error('threaded wasm requires shared memory backed by SharedArrayBuffer');
  }

  const activeWorkers = new Map();
  let firstThreadFailure = null;
  const resolvedThreadWorkerUrl = resolveThreadWorkerUrl(threadWorkerUrl);
  trace?.(
    `[browser-opfs] thread spawner create pooled=${Boolean(allowWorkerPool && threadWorkerPool)} worker=${basenameForTrace(resolvedThreadWorkerUrl)}`,
  );
  if (allowWorkerPool && threadWorkerPool) {
    const poolSize = resolveBrowserThreadPoolSizeFromRequest(runtime?.request);
    const command = threadWorkerPool.createCommand({
      poolSize,
      streamBroadcastChannelName,
      streamRequestId,
      trace,
      debugWasi: Boolean(runtime?.debugWasi ?? false),
      envList,
      runtime,
      threadIdState,
      threadWorkerUrl,
      wasiArgs,
      wasmMemory,
      wasmModule,
    });
    return createBrowserWasiThreadSpawnerForCommand({
      command,
      threadIdState,
      trace,
      wasmMemory,
    });
  }

  const recordFailure = (tid, error) => {
    const wrapped = wrapThreadFailure(tid, error);
    if (!firstThreadFailure) firstThreadFailure = wrapped;
    for (const [activeTid, slot] of activeWorkers.entries()) {
      if (activeTid === tid) continue;
      try {
        slot.worker?.terminate();
      } catch {
        // ignored
      }
    }
    return wrapped;
  };

  const spawn = function spawn(startArg) {
    const errorOrTidPtr = arguments.length > 1 ? arguments[1] : undefined;
    trace?.(`[browser-opfs] thread spawn requested startArg=${Number(startArg) | 0}`);
    for (const [activeTid, slot] of activeWorkers.entries()) {
      const state = Atomics.load(slot.control, THREAD_SLOT_STATE_INDEX);
      if (state === THREAD_SLOT_STATE_IDLE) {
        slot.busy = false;
        slot.tid = null;
        activeWorkers.delete(activeTid);
        continue;
      }
      if (state === THREAD_SLOT_STATE_FAILED) {
        slot.busy = false;
        slot.tid = null;
        activeWorkers.delete(activeTid);
        recordFailure(activeTid, new Error(`wasi thread ${activeTid} failed in browser worker ${slot.index}`));
      }
    }

    const tid = allocateThreadId(threadIdState);
    if (tid < 0) {
      trace?.(`[browser-opfs] thread spawn allocation failed errno=${Math.abs(tid)}`);
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, Math.abs(tid), true);
    }

    let slot;
    try {
      slot = createStandaloneBrowserWasiThread({
        debugWasi: Boolean(runtime?.debugWasi ?? false),
        envList,
        index: `standalone-${tid}`,
        runtime,
        startArg,
        streamBroadcastChannelName,
        streamRequestId,
        threadIdState,
        threadWorkerUrl: resolvedThreadWorkerUrl,
        tid,
        trace,
        wasiArgs,
        wasmMemory,
        wasmModule,
      });
    } catch (error) {
      trace?.(`[browser-opfs] thread spawn worker create failed tid=${tid} ${formatErrorForTrace(error)}`);
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, WASI_ERRNO_AGAIN, true);
    }
    activeWorkers.set(tid, slot);
    trace?.(`[browser-opfs] thread spawn dispatched tid=${tid} worker=${slot.index}`);

    const startAckError = waitForThreadStartAck(slot.control, tid);
    if (startAckError) {
      activeWorkers.delete(tid);
      slot.busy = false;
      slot.tid = null;
      recordFailure(tid, startAckError);
      trace?.(`[browser-opfs] thread spawn ack failed tid=${tid} ${formatErrorForTrace(startAckError)}`);
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, WASI_ERRNO_AGAIN, true);
    }

    trace?.(`[browser-opfs] thread spawn acked tid=${tid} worker=${slot.index}`);
    return finishThreadSpawn(wasmMemory, errorOrTidPtr, tid, false);
  };

  const waitForWorkers = async () => {
    trace?.(`[browser-opfs] thread wait start active=${activeWorkers.size}`);
    while (activeWorkers.size > 0) {
      for (const [tid, slot] of activeWorkers.entries()) {
        while (true) {
          const state = Atomics.load(slot.control, THREAD_SLOT_STATE_INDEX);
          if (state === THREAD_SLOT_STATE_IDLE) {
            slot.busy = false;
            slot.tid = null;
            activeWorkers.delete(tid);
            trace?.(`[browser-opfs] thread completed tid=${tid} worker=${slot.index}`);
            break;
          }
          if (state === THREAD_SLOT_STATE_FAILED) {
            recordFailure(tid, slot.failure || new Error(`wasi thread ${tid} failed in browser worker ${slot.index}`));
            slot.busy = false;
            slot.tid = null;
            activeWorkers.delete(tid);
            break;
          }
          waitForAtomicsStateChange(slot.control, THREAD_SLOT_STATE_INDEX, state);
        }
      }
    }
    if (firstThreadFailure) throw firstThreadFailure;
    trace?.('[browser-opfs] thread wait done');
  };

  return { spawn, ready: Promise.resolve(), waitForWorkers };
}

function createBrowserWasiThreadSpawnerForCommand({
  command,
  threadIdState,
  trace,
  wasmMemory,
}) {
  const activeWorkers = new Map();
  let firstThreadFailure = null;

  const recordFailure = (tid, error) => {
    const wrapped = wrapThreadFailure(tid, error);
    if (!firstThreadFailure) firstThreadFailure = wrapped;
    return wrapped;
  };

  const reapCompletedWorkers = () => {
    for (const [activeTid, slot] of activeWorkers.entries()) {
      const state = Atomics.load(slot.control, THREAD_SLOT_STATE_INDEX);
      if (state === THREAD_SLOT_STATE_IDLE) {
        slot.busy = false;
        slot.tid = null;
        activeWorkers.delete(activeTid);
        continue;
      }
      if (state === THREAD_SLOT_STATE_FAILED) {
        slot.busy = false;
        slot.tid = null;
        activeWorkers.delete(activeTid);
        recordFailure(activeTid, slot.failure || new Error(`wasi thread ${activeTid} failed in browser worker ${slot.index}`));
      }
    }
  };

  const findIdlePooledWorker = () => command.slots.find((candidate) => candidate.online
    && !candidate.busy
    && Atomics.load(candidate.control, THREAD_SLOT_STATE_INDEX) === THREAD_SLOT_STATE_IDLE);

  const findWaitablePooledWorker = () => {
    for (const slot of activeWorkers.values()) {
      const state = Atomics.load(slot.control, THREAD_SLOT_STATE_INDEX);
      if (
        state !== THREAD_SLOT_STATE_IDLE
        && state !== THREAD_SLOT_STATE_FAILED
        && state !== THREAD_SLOT_STATE_SHUTDOWN
      ) {
        return { slot, state };
      }
    }
    for (const slot of command.slots) {
      const state = Atomics.load(slot.control, THREAD_SLOT_STATE_INDEX);
      if (
        slot.online
        && state !== THREAD_SLOT_STATE_IDLE
        && state !== THREAD_SLOT_STATE_FAILED
        && state !== THREAD_SLOT_STATE_SHUTDOWN
      ) {
        return { slot, state };
      }
    }
    return null;
  };

  const waitForIdlePooledWorker = (tid) => {
    const deadline = createWaitDeadline(THREAD_WORKER_BUSY_RETRY_TIMEOUT_MS);
    let tracedWait = false;
    while (true) {
      reapCompletedWorkers();
      if (firstThreadFailure) return null;
      const idleSlot = findIdlePooledWorker();
      if (idleSlot) return idleSlot;

      const waitable = findWaitablePooledWorker();
      if (!waitable) return null;
      if (!tracedWait) {
        trace?.(
          `[browser-opfs] thread spawn waiting for idle pooled worker tid=${tid} command=${command.commandId}`
          + ` active=${activeWorkers.size} slots=${command.slots.length}`,
        );
        tracedWait = true;
      }
      const waitResult = waitForAtomicsStateChange(
        waitable.slot.control,
        THREAD_SLOT_STATE_INDEX,
        waitable.state,
        { deadline },
      );
      if (waitResult === 'timed-out') {
        trace?.(
          `[browser-opfs] thread spawn wait for idle pooled worker timed out tid=${tid} command=${command.commandId}`
          + ` active=${activeWorkers.size} slots=${command.slots.length}`,
        );
        return null;
      }
    }
  };

  const spawn = function spawn(startArg) {
    const errorOrTidPtr = arguments.length > 1 ? arguments[1] : undefined;
    trace?.(`[browser-opfs] thread spawn requested startArg=${Number(startArg) | 0} command=${command.commandId}`);
    reapCompletedWorkers();

    const tid = allocateThreadId(threadIdState);
    if (tid < 0) {
      trace?.(`[browser-opfs] thread spawn allocation failed errno=${Math.abs(tid)} command=${command.commandId}`);
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, Math.abs(tid), true);
    }

    const slot = findIdlePooledWorker() ?? waitForIdlePooledWorker(tid);
    if (!slot) {
      trace?.(
        `[browser-opfs] thread spawn no idle pooled worker tid=${tid} command=${command.commandId}`,
      );
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, WASI_ERRNO_AGAIN, true);
    }

    slot.busy = true;
    slot.tid = tid;
    activeWorkers.set(tid, slot);
    Atomics.store(slot.control, THREAD_SLOT_TID_INDEX, tid);
    Atomics.store(slot.control, THREAD_SLOT_START_ARG_INDEX, Number(startArg) | 0);
    Atomics.store(slot.control, THREAD_SLOT_ERROR_INDEX, 0);
    Atomics.store(slot.control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_REQUESTED);
    Atomics.notify(slot.control, THREAD_SLOT_STATE_INDEX, 1);
    trace?.(`[browser-opfs] thread spawn dispatched tid=${tid} worker=${slot.index} command=${command.commandId}`);

    const startAckError = waitForThreadStartAck(slot.control, tid);
    if (startAckError) {
      activeWorkers.delete(tid);
      slot.busy = false;
      slot.tid = null;
      recordFailure(tid, startAckError);
      trace?.(`[browser-opfs] thread spawn ack failed tid=${tid} ${formatErrorForTrace(startAckError)}`);
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, WASI_ERRNO_AGAIN, true);
    }

    trace?.(`[browser-opfs] thread spawn acked tid=${tid} worker=${slot.index} command=${command.commandId}`);
    return finishThreadSpawn(wasmMemory, errorOrTidPtr, tid, false);
  };

  const waitForWorkers = async () => {
    trace?.(`[browser-opfs] thread wait start active=${activeWorkers.size} command=${command.commandId}`);
    while (activeWorkers.size > 0) {
      for (const [tid, slot] of activeWorkers.entries()) {
        while (true) {
          const state = Atomics.load(slot.control, THREAD_SLOT_STATE_INDEX);
          if (state === THREAD_SLOT_STATE_IDLE) {
            slot.busy = false;
            slot.tid = null;
            activeWorkers.delete(tid);
            trace?.(`[browser-opfs] thread completed tid=${tid} worker=${slot.index} command=${command.commandId}`);
            break;
          }
          if (state === THREAD_SLOT_STATE_FAILED) {
            recordFailure(tid, slot.failure || new Error(`wasi thread ${tid} failed in browser worker ${slot.index}`));
            slot.busy = false;
            slot.tid = null;
            activeWorkers.delete(tid);
            break;
          }
          waitForAtomicsStateChange(slot.control, THREAD_SLOT_STATE_INDEX, state);
        }
      }
    }
    await command.shutdown();
    if (firstThreadFailure) throw firstThreadFailure;
    trace?.(`[browser-opfs] thread wait done command=${command.commandId}`);
  };

  const ready = command.ready.catch(async (error) => {
    await command.shutdown();
    throw error;
  });

  return { spawn, ready, waitForWorkers };
}

function resolveBrowserThreadPoolSizeFromRequest(request) {
  return resolveBrowserThreadPoolSizeFromCount(parseRequestedThreadCount(request));
}

function resolveBrowserThreadPoolSizeFromCount(requestedThreadCount) {
  if (requestedThreadCount === null || requestedThreadCount <= 1) return 0;
  const requested = Math.min(Math.max(1, requestedThreadCount), MAX_BROWSER_THREAD_POOL_SIZE);
  return Math.min(requested + BROWSER_THREAD_POOL_HEADROOM, MAX_BROWSER_THREAD_POOL_SIZE);
}

function parseRequestedThreadCount(request) {
  return readRomWeaverRequestedThreadCount(
    request,
    browserThreadRequestOptions(DEFAULT_BROWSER_THREAD_COUNT),
  );
}

function wrapThreadFailure(tid, error) {
  const message = error instanceof Error ? error.message : String(error);
  const out = new Error(`wasi thread ${tid} failed before completion: ${message}`);
  if (error instanceof Error && typeof error.stack === 'string') out.stack = error.stack;
  return out;
}

function createThreadWorkerLoadError(event, slot, workerUrl) {
  const originalError = event?.error instanceof Error ? event.error : null;
  const parts = [
    `browser wasi thread worker ${slot.index} failed`,
    `workerUrl=${workerUrl}`,
    `tid=${slot.tid ?? 'ready'}`,
  ];
  const message = typeof event?.message === 'string' && event.message.trim() ? event.message.trim() : '';
  if (message) parts.push(`message=${message}`);
  if (typeof event?.filename === 'string' && event.filename.trim()) parts.push(`filename=${event.filename.trim()}`);
  if (Number.isFinite(event?.lineno)) parts.push(`line=${event.lineno}`);
  if (Number.isFinite(event?.colno)) parts.push(`column=${event.colno}`);
  const out = new Error(parts.join('; '));
  if (originalError) {
    out.cause = originalError;
    if (typeof originalError.stack === 'string') out.stack = originalError.stack;
  }
  return out;
}

function annotateThreadWorkerError(error, slot, workerUrl) {
  const message = error instanceof Error ? error.message : String(error);
  const out = new Error(
    `browser wasi thread worker ${slot.index} failed`
    + ` (workerUrl=${workerUrl}, tid=${slot.tid ?? 'ready'}): ${message}`,
  );
  if (error instanceof Error) {
    out.name = error.name;
    out.cause = error;
    if (typeof error.stack === 'string') out.stack = error.stack;
  }
  return out;
}

function deserializeThreadWorkerError(error) {
  const out = new Error(error && typeof error.message === 'string' ? error.message : 'browser wasi thread worker failed');
  if (error && typeof error.name === 'string') out.name = error.name;
  if (error && typeof error.stack === 'string') out.stack = error.stack;
  if (error && error.cause) out.cause = deserializeThreadWorkerError(error.cause);
  return out;
}

async function throwWithThreadFailure(error, threadSpawner) {
  try {
    await threadSpawner.waitForWorkers();
  } catch (threadError) {
    const baseMessage = error instanceof Error ? error.message : String(error);
    const threadMessage = threadError instanceof Error ? threadError.message : String(threadError);
    const out = new Error(`${baseMessage}; ${threadMessage}`);
    if (error instanceof Error && typeof error.stack === 'string') out.stack = error.stack;
    throw out;
  }
  throw error;
}

function storeThreadSpawnResult(wasmMemory, errorOrTidPtr, isError, value) {
  if (!(wasmMemory instanceof WebAssembly.Memory)) return false;
  if (!(wasmMemory.buffer instanceof SharedArrayBuffer)) return false;
  const pointer = Number(errorOrTidPtr);
  if (!Number.isInteger(pointer) || pointer < 0) return false;
  try {
    const result = new Int32Array(wasmMemory.buffer, pointer, 2);
    Atomics.store(result, 0, isError ? 1 : 0);
    Atomics.store(result, 1, Number(value) | 0);
    Atomics.notify(result, 1, 1);
    return true;
  } catch {
    return false;
  }
}

function finishThreadSpawn(wasmMemory, errorOrTidPtr, tidOrErrno, isError = false) {
  const usesResultPointer = errorOrTidPtr !== undefined;
  if (!usesResultPointer) {
    return isError ? -Math.abs(Number(tidOrErrno) || WASI_ERRNO_AGAIN) : tidOrErrno;
  }
  const value = Math.abs(Number(tidOrErrno) || WASI_ERRNO_AGAIN);
  const stored = storeThreadSpawnResult(wasmMemory, errorOrTidPtr, isError, value);
  return stored && !isError ? 0 : 1;
}

function createThreadIdState() {
  const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  state[THREAD_ID_COUNTER_INDEX] = THREAD_ID_COUNTER_INITIAL;
  return state;
}

function allocateThreadId(threadIdState) {
  if (!(threadIdState instanceof Int32Array) || threadIdState.length <= THREAD_ID_COUNTER_INDEX) {
    return -WASI_ERRNO_ENOSYS;
  }
  if (!(threadIdState.buffer instanceof SharedArrayBuffer)) {
    return -WASI_ERRNO_ENOSYS;
  }
  const tid = Atomics.add(threadIdState, THREAD_ID_COUNTER_INDEX, 1);
  if (tid <= 0 || tid > MAX_WASI_THREAD_ID) {
    return -WASI_ERRNO_AGAIN;
  }
  return tid;
}

function threadStartControlFromBuffer(controlBuffer) {
  if (!(controlBuffer instanceof SharedArrayBuffer)) return null;
  const control = new Int32Array(controlBuffer);
  if (control.length < THREAD_SLOT_LENGTH) return null;
  return control;
}

function signalThreadStartState(control, state) {
  if (!(control instanceof Int32Array) || control.length < THREAD_SLOT_LENGTH) return;
  Atomics.store(control, THREAD_SLOT_STATE_INDEX, state);
  Atomics.notify(control, THREAD_SLOT_STATE_INDEX, 1);
}

function createWaitDeadline(timeoutMs) {
  return Date.now() + Math.max(0, Number(timeoutMs) || 0);
}

function waitForAtomicsStateChange(control, index, expectedState, options = {}) {
  const {
    deadline,
    sliceMs = ATOMICS_WAIT_SLICE_MS,
  } = options;
  const slice = Math.max(1, Number(sliceMs) || ATOMICS_WAIT_SLICE_MS);
  if (typeof deadline === 'number') {
    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return 'timed-out';
      const result = Atomics.wait(control, index, expectedState, Math.min(remainingMs, slice));
      if (result !== 'timed-out') return result;
      if (remainingMs <= slice) return 'timed-out';
    }
  }
  return Atomics.wait(control, index, expectedState, slice);
}

function waitForThreadStartAck(control, tid) {
  const deadline = createWaitDeadline(THREAD_START_ACK_TIMEOUT_MS);
  while (true) {
    const state = Atomics.load(control, THREAD_SLOT_STATE_INDEX);
    if (state === THREAD_SLOT_STATE_RUNNING || state === THREAD_SLOT_STATE_IDLE) return null;
    if (state === THREAD_SLOT_STATE_FAILED) {
      return new Error(`wasi thread ${tid} failed before start acknowledgement`);
    }
    if (state === THREAD_SLOT_STATE_SHUTDOWN) {
      return new Error(`wasi thread ${tid} was shut down before start acknowledgement`);
    }
    if (state === THREAD_SLOT_STATE_STARTING) {
      const waitResult = waitForAtomicsStateChange(
        control,
        THREAD_SLOT_STATE_INDEX,
        THREAD_SLOT_STATE_STARTING,
        { deadline },
      );
      if (waitResult === 'timed-out') {
        return new Error(`wasi thread ${tid} start acknowledgement timed out`);
      }
      continue;
    }
    if (state !== THREAD_SLOT_STATE_REQUESTED) {
      return new Error(`wasi thread ${tid} entered unexpected start state ${state}`);
    }
    const waitResult = waitForAtomicsStateChange(
      control,
      THREAD_SLOT_STATE_INDEX,
      THREAD_SLOT_STATE_REQUESTED,
      { deadline },
    );
    if (waitResult === 'timed-out') {
      return new Error(`wasi thread ${tid} start acknowledgement timed out`);
    }
  }
}

function needsEnvMemoryImport(moduleImports) {
  return moduleImports.some(
    (descriptor) => descriptor.module === 'env'
      && descriptor.name === 'memory'
      && descriptor.kind === 'memory',
  );
}

function needsWasiThreadSpawnImport(moduleImports) {
  return moduleImports.some(
    (descriptor) => descriptor.module === 'wasi'
      && descriptor.name === 'thread-spawn'
      && descriptor.kind === 'function',
  );
}

function createSharedThreadMemory({ initialPages, maximumPages } = {}) {
  const initial = normalizePositiveInteger(
    initialPages,
    DEFAULT_SHARED_MEMORY_INITIAL_PAGES,
    'sharedMemoryInitialPages',
  );
  const hasConfiguredMaximum = maximumPages !== undefined && maximumPages !== null;
  const maximum = normalizePositiveInteger(
    maximumPages,
    DEFAULT_SHARED_MEMORY_MAX_PAGES,
    'sharedMemoryMaximumPages',
  );
  if (maximum < initial) {
    throw new Error('sharedMemoryMaximumPages must be >= sharedMemoryInitialPages');
  }
  const candidates = hasConfiguredMaximum
    ? [maximum]
    : [
        maximum,
        ...FALLBACK_SHARED_MEMORY_MAX_PAGES.filter((candidate) => candidate < maximum && candidate >= initial),
      ];
  let allocationError = null;
  for (const candidate of candidates) {
    try {
      return new WebAssembly.Memory({ initial, maximum: candidate, shared: true });
    } catch (error) {
      if (!isSharedMemoryAllocationError(error)) throw error;
      allocationError = error;
    }
  }
  throw allocationError ?? new RangeError('failed to allocate shared wasm memory');
}

function isSharedMemoryAllocationError(error) {
  if (error instanceof RangeError) return true;
  const message = String(error?.message || '');
  return /\b(out of memory|allocation|reserve|could not allocate)\b/i.test(message);
}

function normalizePositiveInteger(value, fallback, label) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return parsed;
}

function resolveBrowserDefaultThreads(root = globalThis) {
  const hardwareConcurrency = Number(root?.navigator?.hardwareConcurrency);
  if (Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0) {
    return Math.max(1, Math.min(DEFAULT_BROWSER_THREAD_COUNT, Math.floor(hardwareConcurrency)));
  }
  return DEFAULT_BROWSER_THREAD_COUNT;
}

function resolveConfiguredDefaultThreads(options, fallback) {
  if (options && Object.hasOwn(options, 'defaultThreads')) {
    return normalizeDefaultThreads(options.defaultThreads);
  }
  return fallback;
}

function normalizeDefaultThreads(value) {
  if (
    value === undefined
    || value === null
    || value === false
    || value === 0
    || value === '0'
    || value === 'off'
  ) {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new TypeError(`defaultThreads must be a positive integer; received: ${value}`);
  }
  return Math.max(1, Math.min(MAX_BROWSER_THREAD_POOL_SIZE, parsed));
}

function browserThreadRequestOptions(defaultThreads = DEFAULT_BROWSER_THREAD_COUNT) {
  return {
    autoThreads: DEFAULT_BROWSER_THREAD_COUNT,
    defaultThreads,
    maxThreads: MAX_BROWSER_THREAD_POOL_SIZE,
  };
}

function assertThreadedWasmRuntimeSupported({ wasmUrl }) {
  if (canUseThreadedWasmRuntime()) return;
  throw new Error(
    `threaded wasm requires SharedArrayBuffer and cross-origin isolation (COOP/COEP); selected ${wasmUrl ?? 'WebAssembly.Module'} cannot run in this browser runtime`,
  );
}

function resolveRunSyncAccessMode({ baseMode, runMode, threaded }) {
  if (runMode !== undefined && runMode !== null) return runMode;
  if (baseMode !== undefined && baseMode !== null) return baseMode;
  return threaded ? 'readwrite-unsafe' : undefined;
}

function resolveThreadWorkerUrl(value) {
  if (value instanceof URL) return value.href;
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return new URL('./workers/browser-wasi-thread-worker.ts', import.meta.url).href;
}

function assertDedicatedWorkerRuntime() {
  if (typeof navigator === 'undefined' || typeof self === 'undefined') {
    throw new Error('createRomWeaverBrowserOpfs can only run in a browser runtime');
  }

  if (typeof window !== 'undefined') {
    throw new Error(
      'createRomWeaverBrowserOpfs must run in a Dedicated Worker. '
        + 'FileSystemSyncAccessHandle is not available on the main thread.',
    );
  }

  if (typeof FileSystemSyncAccessHandle === 'undefined') {
    throw new Error(
      'FileSystemSyncAccessHandle is not available in this runtime. '
        + 'Run inside a secure-context Dedicated Worker with OPFS support.',
    );
  }
}

function assertDirectoryHandle(handle, label) {
  if (!isDirectoryHandle(handle)) {
    throw new TypeError(`${label} must be a FileSystemDirectoryHandle`);
  }
}

function isDirectoryHandle(handle) {
  return Boolean(
    handle
      && typeof handle === 'object'
      && handle.kind === 'directory'
      && typeof handle.entries === 'function'
      && typeof handle.getDirectoryHandle === 'function'
      && typeof handle.getFileHandle === 'function',
  );
}

async function resolveBrowserModule({
  module,
  wasmUrl,
} = {}) {
  if (module instanceof WebAssembly.Module) {
    return {
      module,
      wasmUrl: normalizeConfiguredWasmUrls(wasmUrl, [null])[0],
    };
  }

  const resolvedWasmUrls = normalizeConfiguredWasmUrls(wasmUrl, DEFAULT_BROWSER_WASM_URLS);
  return compileBrowserModuleFromUrls(resolvedWasmUrls);
}

function canUseThreadedWasmRuntime() {
  return typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated === true;
}

function normalizeConfiguredWasmUrls(url, fallbacks) {
  if (url instanceof URL) return [url.href];
  if (typeof url === 'string' && url.trim().length > 0) return [url];
  return fallbacks;
}

async function compileBrowserModuleFromUrls(urls) {
  let lastError = null;
  for (const url of urls) {
    if (!url) continue;
    try {
      return await compileBrowserModuleFromUrl(url);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('no wasm module URL was configured');
}

async function compileBrowserModuleFromUrl(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch wasm module from ${url}: ${response.status} ${response.statusText}`);
  }
  if (typeof WebAssembly.compileStreaming === 'function') {
    try {
      return {
        module: await WebAssembly.compileStreaming(response.clone()),
        wasmUrl: String(url),
      };
    } catch (_streamingError) {
      // Fallback for runtimes/servers that do not satisfy streaming compile constraints.
    }
  }
  const bytes = await response.arrayBuffer();
  return {
    module: await WebAssembly.compile(bytes),
    wasmUrl: String(url),
  };
}

function normalizeRuntimeMounts(mounts) {
  if (!Array.isArray(mounts) || mounts.length === 0) {
    throw new TypeError('runtimeMounts must be a non-empty array of guest paths');
  }
  return mounts.map((mountPath) => normalizeGuestPath(String(mountPath), {
    label: 'runtime mount guest path',
  }));
}

function normalizeStdin(stdin) {
  if (stdin === undefined || stdin === null) return new Uint8Array();
  if (typeof stdin === 'string') return new TextEncoder().encode(stdin);
  if (stdin instanceof Uint8Array) return stdin;
  if (stdin instanceof ArrayBuffer) return new Uint8Array(stdin);
  throw new TypeError('stdin must be a string, Uint8Array, ArrayBuffer, or undefined');
}

function copyUint8Array(data) {
  const copied = new Uint8Array(data.byteLength);
  copied.set(data);
  return copied;
}
