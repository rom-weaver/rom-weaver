import * as wasiShim from "@bjorn3/browser_wasi_shim";
import {
  buildBrowserOpfsWasiFds,
  cleanupBrowserOpfsMounts,
  createBrowserOpfsMountCache,
  normalizeMountHandleMap,
} from "./browser-opfs-mounts.ts";
import { attachOpfsProxyChannel } from "./browser-opfs-proxy-channel.ts";
import { OpfsProxyClient } from "./browser-opfs-proxy-client.ts";
import {
  assertDedicatedWorkerRuntime,
  assertDirectoryHandle,
  normalizeRuntimeMounts,
} from "./browser-opfs-runtime-env.ts";
import type {
  FileSystemDirectoryHandleLike,
  LineHandler,
  TraceLine,
  WasiThreadInstance,
} from "./browser-opfs-runtime-types.ts";
import {
  createLineTrace,
  formatArgsForTrace,
  formatErrorForTrace,
  installDirectWasiFileIoImports,
  summarizeRawVirtualFiles,
  traceDirectWasiFileIoStats,
  traceFlushOpenWasiFileDescriptors,
  traceRandomAccessFileIoStats,
} from "./browser-opfs-stdio-events.ts";
import { closeSyncFiles } from "./browser-opfs-sync-access.ts";
import {
  createBrowserWasiThreadSpawner,
  needsWasiThreadSpawnImport,
  type ThreadSpawnerRuntime,
} from "./browser-wasi-thread-pool.ts";
import {
  signalThreadStartState,
  THREAD_SLOT_STATE_FAILED,
  THREAD_SLOT_STATE_RUNNING,
  THREAD_SLOT_STATE_STARTING,
  threadStartControlFromBuffer,
} from "./browser-wasi-thread-protocol.ts";
import { createWasmEnvImports } from "./rom-weaver-runtime-utils.ts";

const THREAD_WORKER_MOUNT_CACHE = createBrowserOpfsMountCache();

/**
 * Message payload accepted by the thread runtime entry point. Mirrors the fields posted with
 * `mode: 'thread'` / `mode: 'pool-command'` worker messages (see browser-wasi-thread-pool.ts),
 * plus the per-thread line handlers the worker shell injects before delegating here.
 */
export interface BrowserWasiThreadRunPayload {
  __streamBroadcastChannelName?: string;
  __streamRequestId?: number;
  debugWasi?: boolean;
  envList?: unknown;
  runtime?: ThreadSpawnerRuntime;
  startArg?: number;
  startControlBuffer?: SharedArrayBuffer;
  stderrLineHandler?: LineHandler;
  stdoutLineHandler?: LineHandler;
  threadIdState?: unknown;
  tid?: number;
  wasiArgs?: unknown;
  wasmMemory?: WebAssembly.Memory;
  wasmModule?: WebAssembly.Module;
}

export async function __runRomWeaverBrowserWasiThread(payload: BrowserWasiThreadRunPayload = {}) {
  assertDedicatedWorkerRuntime();

  // A nested thread runs the same script this worker is already running, so its URL comes from our
  // own location rather than from `payload.threadWorkerUrl`. Taking it from the message would mean
  // spawning a worker at whatever URL the sender asked for, and that worker gets the shared wasm
  // memory - so the payload field is deliberately ignored here.
  const nestedThreadWorkerUrl = self.location.href;

  const {
    debugWasi,
    envList,
    runtime,
    stderrLineHandler,
    stdoutLineHandler,
    startArg,
    threadIdState,
    tid,
    wasiArgs,
    wasmMemory,
    wasmModule,
  } = payload;

  if (!(wasmModule instanceof WebAssembly.Module)) {
    throw new Error("browser wasi thread payload missing compiled WebAssembly.Module");
  }
  if (!(wasmMemory instanceof WebAssembly.Memory)) {
    throw new Error("browser wasi thread payload missing shared WebAssembly.Memory");
  }
  if (!(wasmMemory.buffer instanceof SharedArrayBuffer)) {
    throw new Error("browser wasi thread payload memory is not shared");
  }

  const trace = createLineTrace(stderrLineHandler);
  trace(
    `[browser-opfs-thread] start tid=${tid ?? "unknown"} startArg=${startArg ?? "unknown"} args=${formatArgsForTrace(Array.isArray(wasiArgs) ? wasiArgs : [])} virtualFiles=${summarizeRawVirtualFiles(runtime?.virtualFiles)}`,
  );
  const moduleImports = WebAssembly.Module.imports(wasmModule);
  const startControl = threadStartControlFromBuffer(payload.startControlBuffer);
  signalThreadStartState(startControl, THREAD_SLOT_STATE_STARTING);
  let startAcked = false;
  const closeables: unknown[] = [];
  const normalizedRuntimeMounts = normalizeRuntimeMounts(runtime?.runtimeMounts);
  const normalizedMountHandles = await resolveThreadRuntimeMountHandles({
    runtime,
    runtimeMounts: normalizedRuntimeMounts,
    trace,
  });
  if (runtime?.invalidateMountCacheBeforeRun) {
    trace(`[browser-opfs-thread] invalidate mount cache before run start tid=${tid ?? "unknown"}`);
    await THREAD_WORKER_MOUNT_CACHE.invalidateMountPaths(normalizedRuntimeMounts);
    trace(`[browser-opfs-thread] invalidate mount cache before run done tid=${tid ?? "unknown"}`);
  }
  let runSucceeded = false;
  let mounts: Awaited<ReturnType<typeof buildBrowserOpfsWasiFds>>["mounts"] = [];
  // Build a client over the forwarded channel so this thread's I/O goes through the runner's single
  // OPFS proxy - the only way a spawned WASI thread (which cannot path_open OPFS files itself) can
  // reach real OPFS files. The runner always forwards the channel, so the transfer is always present.
  if (!runtime?.opfsProxyTransfer) {
    throw new Error("browser OPFS thread runtime requires an opfsProxyTransfer channel");
  }
  const proxyClient = new OpfsProxyClient(attachOpfsProxyChannel(runtime.opfsProxyTransfer), { trace });

  try {
    trace(`[browser-opfs-thread] build wasi fds start tid=${tid ?? "unknown"}`);
    const built = await buildBrowserOpfsWasiFds({
      cwdMountPath: runtime?.cwdMountPath,
      knownInputPaths: runtime?.knownInputPaths,
      mountCache: THREAD_WORKER_MOUNT_CACHE,
      mountHandles: normalizedMountHandles,
      proxyClient,
      request: runtime?.request,
      runCloseables: closeables,
      runtimeMounts: normalizedRuntimeMounts,
      stderrLineHandler,
      stdin: undefined,
      stdoutLineHandler,
      syncAccessMode: runtime?.syncAccessMode,
      trace,
      virtualFiles: runtime?.virtualFiles,
      virtualOnlyMounts: resolveThreadVirtualOnlyMounts(runtime),
      writableRoots: Array.isArray(runtime?.writableRoots) ? runtime.writableRoots : [],
    });
    mounts = built.mounts;
    trace(`[browser-opfs-thread] build wasi fds done tid=${tid ?? "unknown"} mounts=${mounts.length}`);
    const threadWasi = new wasiShim.WASI(
      Array.isArray(wasiArgs) && wasiArgs.length > 0 ? wasiArgs.map((value) => String(value)) : ["rom-weaver"],
      Array.isArray(envList) ? envList.map((value) => String(value)) : [],
      built.fds,
      { debug: Boolean(debugWasi ?? runtime?.debugWasi ?? false) },
    );
    installDirectWasiFileIoImports(threadWasi, trace);
    const nestedThreadSpawner = createBrowserWasiThreadSpawner({
      allowWorkerPool: false,
      envList,
      moduleImports,
      runtime,
      streamBroadcastChannelName: payload.__streamBroadcastChannelName,
      streamRequestId: payload.__streamRequestId,
      threadIdState,
      threadWorkerPool: null,
      threadWorkerUrl: nestedThreadWorkerUrl,
      trace,
      wasiArgs,
      wasmMemory,
      wasmModule,
    });
    trace(`[browser-opfs-thread] instantiate start tid=${tid ?? "unknown"}`);
    const instance = (await WebAssembly.instantiate(wasmModule, {
      env: createWasmEnvImports(wasmMemory),
      wasi_snapshot_preview1: threadWasi.wasiImport,
      ...(needsWasiThreadSpawnImport(moduleImports) ? { wasi: { "thread-spawn": nestedThreadSpawner.spawn } } : {}),
    })) as WasiThreadInstance;
    trace(`[browser-opfs-thread] instantiate done tid=${tid ?? "unknown"}`);

    threadWasi.inst = instance;
    if (typeof instance.exports.wasi_thread_start !== "function") {
      throw new Error("threaded wasm module does not export wasi_thread_start");
    }
    signalThreadStartState(startControl, THREAD_SLOT_STATE_RUNNING);
    startAcked = true;
    trace(`[browser-opfs-thread] wasi_thread_start start tid=${tid ?? "unknown"}`);
    instance.exports.wasi_thread_start(Number(tid) | 0, Number(startArg) | 0);
    trace(`[browser-opfs-thread] wasi_thread_start returned tid=${tid ?? "unknown"}`);
    trace(`[browser-opfs-thread] nested waitForWorkers start tid=${tid ?? "unknown"}`);
    await nestedThreadSpawner.waitForWorkers();
    trace(`[browser-opfs-thread] nested waitForWorkers done tid=${tid ?? "unknown"}`);
    traceFlushOpenWasiFileDescriptors(
      trace,
      threadWasi.fds,
      `[browser-opfs-thread] flush fd write buffers tid=${tid ?? "unknown"}`,
    );
    traceDirectWasiFileIoStats(trace, threadWasi, `[perf] direct file io tid=${tid ?? "unknown"}`);
    traceRandomAccessFileIoStats(trace, built.fds, `[perf] random access file io tid=${tid ?? "unknown"}`);
    // Output files are written straight to OPFS through the proxy during the run; no materialization.
    runSucceeded = true;
  } catch (error) {
    trace(`[browser-opfs-thread] failed tid=${tid ?? "unknown"} ${formatErrorForTrace(error)}`);
    if (!startAcked) signalThreadStartState(startControl, THREAD_SLOT_STATE_FAILED);
    throw error;
  } finally {
    trace(`[browser-opfs-thread] cleanup start tid=${tid ?? "unknown"} succeeded=${runSucceeded}`);
    closeSyncFiles(closeables);
    await cleanupBrowserOpfsMounts(mounts);
    if (!runSucceeded || runtime?.invalidateMountCacheAfterRun)
      await THREAD_WORKER_MOUNT_CACHE.invalidateMounts(mounts);
    trace(`[browser-opfs-thread] cleanup done tid=${tid ?? "unknown"}`);
  }
}

export async function __disposeRomWeaverBrowserThreadMountCache() {
  await THREAD_WORKER_MOUNT_CACHE.dispose();
}

export async function __primeRomWeaverBrowserThreadRuntime(
  runtime: ThreadSpawnerRuntime = {},
  onTraceNonJsonLine?: LineHandler,
) {
  assertDedicatedWorkerRuntime();
  const trace = createLineTrace(onTraceNonJsonLine);
  const normalizedRuntimeMounts = normalizeRuntimeMounts(runtime?.runtimeMounts);
  if (!normalizedRuntimeMounts.length) return;
  trace(`[browser-opfs-thread] prewarm mount handles start mounts=${normalizedRuntimeMounts.length}`);
  // Resolve the OPFS directory handles up front so the first real run skips that latency. The mounts
  // themselves are built lazily on the first run, since they need that run's forwarded proxy channel.
  await resolveThreadRuntimeMountHandles({
    runtime,
    runtimeMounts: normalizedRuntimeMounts,
    trace,
  });
  trace("[browser-opfs-thread] prewarm mount handles done");
}

async function resolveThreadRuntimeMountHandles({
  runtime,
  runtimeMounts,
  trace,
}: {
  runtime?: ThreadSpawnerRuntime;
  runtimeMounts: string[];
  trace?: TraceLine;
}): Promise<Record<string, FileSystemDirectoryHandleLike>> {
  const mountHandles: Record<string, FileSystemDirectoryHandleLike> = normalizeMountHandleMap({
    mountHandles: runtime?.mountHandles,
  });
  const missingMounts = runtimeMounts.filter((mountPath) => !mountHandles[mountPath]);
  if (missingMounts.length === 0) {
    trace?.(`[browser-opfs-thread] mount handles provided count=${Object.keys(mountHandles).length}`);
    return mountHandles;
  }

  const opfsHandle = await navigator.storage.getDirectory();
  assertDirectoryHandle(opfsHandle, "thread opfsHandle");
  for (const mountPath of missingMounts) mountHandles[mountPath] = opfsHandle;
  trace?.(
    `[browser-opfs-thread] mount handles resolved in worker missing=${missingMounts.length} total=${Object.keys(mountHandles).length}`,
  );
  return mountHandles;
}

function resolveThreadVirtualOnlyMounts(runtime: ThreadSpawnerRuntime | undefined): boolean {
  return Boolean(runtime?.virtualOnlyMounts ?? true);
}
