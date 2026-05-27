import * as wasiShim from '@bjorn3/browser_wasi_shim';
import {
  createJsonLineParser,
  createTraceJsonLineParser,
  createWasmEnvImports,
  normalizeGuestPath,
} from './rom-weaver-runtime-utils.mjs';

const DEFAULT_WORK_GUEST_PATH = '/work';
const DEFAULT_BROWSER_WASM_URLS = [
  new URL('../rom-weaver-cli.wasm', import.meta.url).href,
  new URL('./rom-weaver-cli.wasm', import.meta.url).href,
];
const DEFAULT_BROWSER_THREADED_WASM_URLS = [
  new URL('../rom-weaver-cli-threaded.wasm', import.meta.url).href,
  new URL('./rom-weaver-cli-threaded.wasm', import.meta.url).href,
];
const DEFAULT_SCRATCH_FILE_POOL_SIZE = 256;
const DEFAULT_THREAD_SCRATCH_FILE_POOL_SIZE = 16;
const DEFAULT_SHARED_MEMORY_INITIAL_PAGES = 256;
const DEFAULT_SHARED_MEMORY_MAX_PAGES = 16384;
const PATH_SEPARATOR_REGEX = /[/\\]+/;
const SCRATCH_DIRECTORY_NAME = '.rom-weaver-opfs-scratch';
const OPFS_COPY_CHUNK_SIZE = 8 * 1024 * 1024;
const DEFAULT_BROWSER_THREAD_COUNT = 4;
const DEFAULT_BROWSER_THREAD_POOL_SIZE = 4;
const MAX_BROWSER_THREAD_POOL_SIZE = 64;
const THREAD_AWARE_COMMANDS = new Set([
  'batch-header-fixer',
  'checksum',
  'compress',
  'extract',
  'patch-apply',
  'patch-create',
  'trim',
]);
const MAX_WASI_THREAD_ID = 0x1fffffff;
const THREAD_ID_COUNTER_INDEX = 0;
const THREAD_ID_COUNTER_INITIAL = 43;
const THREAD_START_ACK_TIMEOUT_MS = 30000;
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
const WASI_ERRNO_AGAIN = 6;
const WASI_ERRNO_ENOSYS = 52;
const THREAD_WORKER_MOUNT_CACHE = createBrowserOpfsMountCache();

export async function createRomWeaverBrowserOpfs(options = {}) {
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
    preferThreadedWasm: options.preferThreadedWasm,
    threadedWasmUrl: options.threadedWasmUrl,
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
        initialSize: resolveBrowserThreadPoolSize([
          '--threads',
          String(baseDefaultThreads ?? resolveBrowserDefaultThreads()),
        ]),
        threadWorkerUrl: options.threadWorkerUrl,
      })
    : null;
  const mountCache = createBrowserOpfsMountCache();
  threadWorkerPool?.ready.catch(() => undefined);

  const runner = {
    async dispose() {
      await mountCache.dispose();
      await threadWorkerPool?.dispose();
    },

    async run(args = [], runOptions = {}) {
      const normalizedArgs = withDefaultThreadArgs(
        normalizeArgs(args),
        resolveConfiguredDefaultThreads(runOptions, baseDefaultThreads),
      );
      const env = createRunEnv({
        baseEnv: options.env,
        runEnv: runOptions.env,
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
      await prepareKnownCliPaths({
        args: normalizedArgs,
        mountHandles,
        runtimeMounts,
      });

      const closeables = [];
      let runSucceeded = false;
      const resolvedSyncAccessMode = resolveRunSyncAccessMode({
        baseMode: options.syncAccessMode,
        runMode: runOptions.syncAccessMode,
        threaded,
      });
      const wasiArgs = [
        runOptions.program ?? options.program ?? options.argv0 ?? 'rom-weaver',
        ...normalizedArgs,
      ];
      const writableRoots = normalizeWritableRoots({
        workGuestPath,
        writableDirectories: runOptions.writableDirectories,
        inherited: baseWritableRoots,
      });
      const resolvedMainScratchFilePoolSize = runOptions.scratchFilePoolSize
        ?? options.scratchFilePoolSize;
      const resolvedThreadScratchFilePoolSize = resolvedMainScratchFilePoolSize
        ?? DEFAULT_THREAD_SCRATCH_FILE_POOL_SIZE;
      const threadSpawner = createBrowserWasiThreadSpawner({
        streamBroadcastChannelName: runOptions.__streamBroadcastChannelName,
        streamRequestId: runOptions.__streamRequestId,
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
          mountHandles,
          runtimeMounts,
          scratchFilePoolSize: resolvedMainScratchFilePoolSize,
          threadScratchFilePoolSize: resolvedThreadScratchFilePoolSize,
          syncAccessMode: resolvedSyncAccessMode,
          virtualFiles,
          writableRoots,
        },
      });
      const {
        fds,
        mounts,
        stdoutCollector,
        stderrCollector,
        stdoutChunks,
        stderrChunks,
      } = await buildBrowserOpfsWasiFds({
        args: normalizedArgs,
        cwdMountPath: workGuestPath,
        stdin: runOptions.stdin,
        runtimeMounts,
        mountHandles,
        stderrLineHandler: runOptions.onStderrLine,
        stdoutLineHandler: runOptions.onStdoutLine,
        virtualFiles,
        scratchFilePoolSize: resolvedMainScratchFilePoolSize,
        writableRoots,
        syncAccessMode: resolvedSyncAccessMode,
        mountCache,
        runCloseables: closeables,
      });

      try {
        const wasi = new wasiShim.WASI(
          wasiArgs,
          envList,
          fds,
          { debug: Boolean(runOptions.debugWasi ?? options.debugWasi ?? false) },
        );

        const instance = await WebAssembly.instantiate(module, {
          wasi_snapshot_preview1: wasi.wasiImport,
          env: createWasmEnvImports(wasmMemory),
          ...(importsWasiThreadSpawn ? { wasi: { 'thread-spawn': threadSpawner.spawn } } : {}),
        });

        await threadSpawner.ready;
        let exitCode;
        try {
          exitCode = wasi.start(instance);
        } catch (error) {
          await throwWithThreadFailure(error, threadSpawner);
        }
        await threadSpawner.waitForWorkers();
        await flushBrowserOpfsMounts(mounts);
        runSucceeded = true;
        stdoutCollector.flush();
        stderrCollector.flush();
        const stdout = decodeChunks(stdoutChunks);
        const stderr = decodeChunks(stderrChunks);

        return {
          args: normalizedArgs,
          exitCode,
          stdout,
          stderr,
          ok: exitCode === 0,
        };
      } catch (error) {
        stdoutCollector.flush();
        stderrCollector.flush();
        const stdout = decodeChunks(stdoutChunks);
        const stderr = decodeChunks(stderrChunks);

        return {
          args: normalizedArgs,
          exitCode: 1,
          stdout,
          stderr,
          ok: false,
          error,
        };
      } finally {
        closeSyncFiles(closeables);
        await cleanupBrowserOpfsMounts(mounts);
        await cleanupScratchDirectoriesFromHandles({
          mountHandles,
          runtimeMounts,
        });
        if (!runSucceeded) await mountCache.invalidateMounts(mounts);
      }
    },

    async runJson(args = [], runOptions = {}) {
      const parsed = createJsonLineParser({
        onEvent: runOptions.onEvent,
        onNonJsonLine: runOptions.onNonJsonLine,
      });
      const parsedTrace = createTraceJsonLineParser({
        onTraceEvent: runOptions.onTraceEvent,
        onTraceNonJsonLine: runOptions.onTraceNonJsonLine,
      });
      const result = await this.run(['--json', ...normalizeArgs(args)], {
        ...runOptions,
        onStderrLine(line) {
          parsedTrace.pushLine(line);
        },
        onStdoutLine(line) {
          parsed.pushLine(line);
        },
      });

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
    run: (args, runOptions) => runner.run(args, runOptions),
    runJson: (args, runOptions) => runner.runJson(args, runOptions),
  };
}

export async function __runRomWeaverBrowserWasiThread(payload = {}) {
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

  const moduleImports = WebAssembly.Module.imports(wasmModule);
  const startControl = threadStartControlFromBuffer(payload.startControlBuffer);
  signalThreadStartState(startControl, THREAD_SLOT_STATE_STARTING);
  let startAcked = false;
  const closeables = [];
  const normalizedRuntimeMounts = normalizeRuntimeMounts(runtime?.runtimeMounts);
  const normalizedMountHandles = normalizeMountHandleMap({ mountHandles: runtime?.mountHandles });
  let runSucceeded = false;
  let mounts = [];

  try {
    const built = await buildBrowserOpfsWasiFds({
      cwdMountPath: runtime?.cwdMountPath,
      stdin: undefined,
      runtimeMounts: normalizedRuntimeMounts,
      mountHandles: normalizedMountHandles,
      stderrLineHandler,
      stdoutLineHandler,
      scratchFilePoolSize: runtime?.threadScratchFilePoolSize ?? runtime?.scratchFilePoolSize,
      virtualFiles: normalizeVirtualFiles(runtime?.virtualFiles),
      writableRoots: Array.isArray(runtime?.writableRoots) ? runtime.writableRoots : [],
      syncAccessMode: runtime?.syncAccessMode,
      mountCache: THREAD_WORKER_MOUNT_CACHE,
      runCloseables: closeables,
    });
    mounts = built.mounts;
    const threadWasi = new wasiShim.WASI(
      Array.isArray(wasiArgs) && wasiArgs.length > 0 ? wasiArgs.map((value) => String(value)) : ['rom-weaver'],
      Array.isArray(envList) ? envList.map((value) => String(value)) : [],
      built.fds,
      { debug: Boolean(debugWasi ?? runtime?.debugWasi ?? false) },
    );
    const nestedThreadSpawner = createBrowserWasiThreadSpawner({
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
    });
    const instance = await WebAssembly.instantiate(wasmModule, {
      wasi_snapshot_preview1: threadWasi.wasiImport,
      env: createWasmEnvImports(wasmMemory),
      ...(needsWasiThreadSpawnImport(moduleImports)
        ? { wasi: { 'thread-spawn': nestedThreadSpawner.spawn } }
        : {}),
    });

    threadWasi.inst = instance;
    if (typeof instance.exports.wasi_thread_start !== 'function') {
      throw new Error('threaded wasm module does not export wasi_thread_start');
    }
    signalThreadStartState(startControl, THREAD_SLOT_STATE_RUNNING);
    startAcked = true;
    instance.exports.wasi_thread_start(Number(tid) | 0, Number(startArg) | 0);
    await nestedThreadSpawner.waitForWorkers();
    await flushBrowserOpfsMounts(mounts);
    runSucceeded = true;
  } catch (error) {
    if (!startAcked) signalThreadStartState(startControl, THREAD_SLOT_STATE_FAILED);
    throw error;
  } finally {
    closeSyncFiles(closeables);
    await cleanupBrowserOpfsMounts(mounts);
    await cleanupScratchDirectoriesFromHandles({
      mountHandles: normalizedMountHandles,
      runtimeMounts: normalizedRuntimeMounts,
    });
    if (!runSucceeded) await THREAD_WORKER_MOUNT_CACHE.invalidateMounts(mounts);
  }
}

export async function __disposeRomWeaverBrowserThreadMountCache() {
  await THREAD_WORKER_MOUNT_CACHE.dispose();
}

function createRunEnv({ baseEnv, runEnv }) {
  return {
    ...(baseEnv ?? {}),
    ...(runEnv ?? {}),
  };
}

function createBrowserOpfsMountCache() {
  let disposed = false;
  const mountsByPath = new Map();

  return {
    async acquire({ directoryHandle, mountPath, syncAccessMode, writableRoots }) {
      if (disposed) throw new Error('browser OPFS mount cache is disposed');
      const writableRootsKey = writableRoots.join('\0');
      const current = mountsByPath.get(mountPath) ?? null;
      if (
        current
        && current.syncAccessMode === syncAccessMode
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
  args,
  cwdMountPath,
  stdin,
  runtimeMounts,
  mountHandles,
  stderrLineHandler,
  stdoutLineHandler,
  virtualFiles,
  scratchFilePoolSize,
  writableRoots,
  syncAccessMode,
  mountCache,
  runCloseables,
}) {
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
        writableRoots,
      });
      mounts.push(mount);
      await mount.startRun({
        runCloseables,
        scratchFilePoolSize,
        virtualFiles,
      });
      fds.push(new PreparedWasiPreopenDirectory(mount));
      if (mountPath === cwdMountPath) cwdMount = mount;
    }
  } catch (error) {
    closeSyncFiles(runCloseables);
    await cleanupBrowserOpfsMounts(mounts);
    throw error;
  }

  if (cwdMount) {
    fds.push(new PreparedWasiPreopenDirectory(cwdMount, { preopenName: '.' }));
  }
  await syncMountedInputPathsFromOpfs({
    args,
    mounts,
    mountHandles,
    runtimeMounts,
  });

  return {
    fds,
    mounts,
    stdoutCollector,
    stderrCollector,
    stdoutChunks: stdoutCollector.chunks,
    stderrChunks: stderrCollector.chunks,
  };
}

class BrowserOpfsMount {
  static async create({
    directoryHandle,
    mountPath,
    syncAccessMode,
    writableRoots,
  }) {
    const ownedFiles = [];
    const contents = await buildOpfsInodeMap({
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
      writableRoots,
    });
  }

  constructor({
    contents,
    directoryHandle,
    mountPath,
    ownedFiles,
    syncAccessMode,
    writableRoots,
  }) {
    this.contents = contents;
    this.directoryHandle = directoryHandle;
    this.mountPath = mountPath;
    this.ownedFiles = ownedFiles;
    this.syncAccessMode = syncAccessMode;
    this.writableRoots = writableRoots;
    this.writableRootsKey = writableRoots.join('\0');
    this.virtualRestores = null;
    this.scratchDirectoryHandle = null;
    this.scratchFiles = [];
    this.scratchPool = [];
  }

  isWritablePath(guestPath) {
    return isGuestPathWithinRoots(guestPath, this.writableRoots);
  }

  takeScratchFile() {
    const file = this.scratchPool.pop() ?? null;
    if (file) file.truncate(0);
    return file;
  }

  async startRun({ runCloseables, scratchFilePoolSize, virtualFiles }) {
    this.finishRun();
    if (Array.isArray(virtualFiles) && virtualFiles.length > 0) {
      this.virtualRestores = addVirtualFilesToMount({
        contents: this.contents,
        mountPath: this.mountPath,
        virtualFiles,
      });
    } else {
      this.virtualRestores = [];
    }
    const scratch = await createScratchFilePool({
      closeables: runCloseables,
      directoryHandle: this.directoryHandle,
      scratchFilePoolSize,
      syncAccessMode: this.syncAccessMode,
    });
    this.scratchDirectoryHandle = scratch.directoryHandle;
    this.scratchFiles = scratch.files;
    this.scratchPool = scratch.pool;
  }

  finishRun() {
    if (Array.isArray(this.virtualRestores) && this.virtualRestores.length > 0) {
      restoreVirtualFiles(this.virtualRestores);
    }
    this.virtualRestores = null;
  }

  trackOwnedFile(file) {
    this.ownedFiles.push(file);
  }

  async dispose() {
    this.finishRun();
    closeSyncFiles(this.ownedFiles);
    this.ownedFiles = [];
    this.scratchPool = [];
    this.scratchFiles = [];
    this.scratchDirectoryHandle = null;
  }
}

class PreparedWasiPreopenDirectory extends wasiShim.PreopenDirectory {
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

class BrowserOpfsRandomAccessFile {
  constructor(syncHandle, options = {}) {
    this.syncHandle = syncHandle;
    this.scratchName = options.scratchName ?? null;
    this.closed = false;
  }

  readAt(offset, dst) {
    return this.syncHandle.read(dst, { at: Number(offset) });
  }

  writeAt(offset, src) {
    return this.syncHandle.write(src, { at: Number(offset) });
  }

  size() {
    return this.syncHandle.getSize();
  }

  truncate(size) {
    this.syncHandle.truncate(Number(size));
  }

  flush() {
    this.syncHandle.flush();
  }

  close() {
    if (this.closed) return;
    try {
      this.flush();
    } finally {
      this.syncHandle.close();
      this.closed = true;
    }
  }
}

class BrowserVirtualRandomAccessFile {
  constructor(source) {
    this.source = source;
    this.proxy = isVirtualFileProxy(source) ? source : null;
    this.reader = isBlobLike(source) ? new FileReaderSync() : null;
    this.slots = this.proxy ? normalizeVirtualFileProxySlots(this.proxy) : [];
    this.closed = false;
  }

  readAt(offset, dst) {
    if (this.closed) return 0;
    const start = Number(offset);
    if (!Number.isFinite(start) || start < 0 || start >= this.size()) return 0;
    const length = Math.min(dst.byteLength, this.size() - start);
    if (length <= 0) return 0;
    if (this.proxy) return this.readProxyAt(start, dst, length);
    if (this.source instanceof Uint8Array) {
      dst.set(this.source.subarray(start, start + length));
      return length;
    }
    if (this.source instanceof ArrayBuffer) {
      dst.set(new Uint8Array(this.source, start, length));
      return length;
    }
    const bytes = new Uint8Array(this.reader.readAsArrayBuffer(this.source.slice(start, start + length)));
    dst.set(bytes);
    return bytes.byteLength;
  }

  readProxyAt(offset, dst, requestedLength) {
    const slot = this.acquireProxySlot();
    const length = Math.min(requestedLength, slot.data.byteLength);
    if (length <= 0) return 0;
    const low = offset >>> 0;
    const high = Math.floor(offset / 2 ** 32) >>> 0;
    Atomics.store(slot.control, 1, low);
    Atomics.store(slot.control, 2, high);
    Atomics.store(slot.control, 3, length);
    Atomics.store(slot.control, 4, 0);
    Atomics.store(slot.control, 5, 0);
    Atomics.store(slot.control, 0, 1);
    Atomics.notify(slot.control, 0, 1);
    while (Atomics.load(slot.control, 0) !== 2) {
      const state = Atomics.load(slot.control, 0);
      const result = Atomics.wait(slot.control, 0, state, 30000);
      if (result === 'timed-out') {
        throw new Error(`virtual file read timed out for ${this.proxy.id}`);
      }
    }
    if (Atomics.load(slot.control, 5) !== 0) {
      Atomics.store(slot.control, 0, 0);
      throw new Error(`virtual file read failed for ${this.proxy.id}`);
    }
    const bytesRead = Math.max(0, Math.min(Atomics.load(slot.control, 4), length));
    if (bytesRead > 0) dst.set(slot.data.subarray(0, bytesRead));
    Atomics.store(slot.control, 0, 0);
    Atomics.notify(slot.control, 0, 1);
    return bytesRead;
  }

  acquireProxySlot() {
    while (true) {
      for (const slot of this.slots) {
        if (Atomics.compareExchange(slot.control, 0, 0, 3) === 0) return slot;
      }
      const first = this.slots[0];
      if (!first) throw new Error(`virtual file proxy has no read slots for ${this.proxy.id}`);
      const state = Atomics.load(first.control, 0);
      Atomics.wait(first.control, 0, state, 10);
    }
  }

  writeAt() {
    return 0;
  }

  size() {
    if (this.proxy) return Number(this.proxy.size || 0);
    if (this.source instanceof Uint8Array || this.source instanceof ArrayBuffer) {
      return this.source.byteLength;
    }
    return Number(this.source.size || 0);
  }

  truncate() {}

  flush() {}

  close() {
    this.closed = true;
  }
}

class WasiRandomAccessFileInode extends wasiShim.Inode {
  constructor(file, options = {}) {
    super();
    this.file = file;
    this.readonly = Boolean(options.readonly);
    this.scratchBacked = Boolean(options.scratchBacked);
  }

  path_open(oflags, fsRightsBase, fdFlags) {
    if (this.readonly && requestsWriteRights(fsRightsBase, oflags)) {
      return { ret: wasiShim.wasi.ERRNO_PERM, fd_obj: null };
    }
    if ((oflags & wasiShim.wasi.OFLAGS_TRUNC) === wasiShim.wasi.OFLAGS_TRUNC) {
      if (this.readonly) return { ret: wasiShim.wasi.ERRNO_PERM, fd_obj: null };
      this.file.truncate(0);
    }
    const fd = new OpenWasiRandomAccessFile(this);
    if (fdFlags & wasiShim.wasi.FDFLAGS_APPEND) fd.fd_seek(0n, wasiShim.wasi.WHENCE_END);
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, fd_obj: fd };
  }

  get size() {
    return BigInt(this.file.size());
  }

  stat() {
    return new wasiShim.wasi.Filestat(this.ino, wasiShim.wasi.FILETYPE_REGULAR_FILE, this.size);
  }
}

class OpenWasiRandomAccessFile extends wasiShim.Fd {
  constructor(inode) {
    super();
    this.inode = inode;
    this.position = 0n;
  }

  fd_allocate(offset, len) {
    const requested = BigInt(offset) + BigInt(len);
    if (BigInt(this.inode.file.size()) < requested) {
      this.inode.file.truncate(Number(requested));
    }
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  fd_fdstat_get() {
    return {
      ret: wasiShim.wasi.ERRNO_SUCCESS,
      fdstat: new wasiShim.wasi.Fdstat(wasiShim.wasi.FILETYPE_REGULAR_FILE, 0),
    };
  }

  fd_filestat_get() {
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, filestat: this.inode.stat() };
  }

  fd_filestat_set_size(size) {
    if (this.inode.readonly) return wasiShim.wasi.ERRNO_BADF;
    this.inode.file.truncate(Number(size));
    return wasiShim.wasi.ERRNO_SUCCESS;
  }

  fd_read(size) {
    const buffer = new Uint8Array(size);
    const bytesRead = this.inode.file.readAt(this.position, buffer);
    this.position += BigInt(bytesRead);
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, data: buffer.slice(0, bytesRead) };
  }

  fd_pread(size, offset) {
    const buffer = new Uint8Array(size);
    const bytesRead = this.inode.file.readAt(offset, buffer);
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, data: buffer.slice(0, bytesRead) };
  }

  fd_seek(offset, whence) {
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
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, offset: this.position };
  }

  fd_write(data) {
    if (this.inode.readonly) return { ret: wasiShim.wasi.ERRNO_BADF, nwritten: 0 };
    const bytesWritten = this.inode.file.writeAt(this.position, data);
    this.position += BigInt(bytesWritten);
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, nwritten: bytesWritten };
  }

  fd_pwrite(data, offset) {
    if (this.inode.readonly) return { ret: wasiShim.wasi.ERRNO_BADF, nwritten: 0 };
    const bytesWritten = this.inode.file.writeAt(offset, data);
    return { ret: wasiShim.wasi.ERRNO_SUCCESS, nwritten: bytesWritten };
  }

  fd_sync() {
    this.inode.file.flush();
    return wasiShim.wasi.ERRNO_SUCCESS;
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

function addVirtualFilesToMount({ contents, mountPath, virtualFiles }) {
  const restores = [];
  for (const entry of virtualFiles ?? []) {
    if (!isGuestPathWithinMount(entry.path, mountPath)) continue;
    const relativePath = entry.path === mountPath ? '' : entry.path.slice(mountPath.length + 1);
    addVirtualFileEntry(contents, relativePath, entry.source, restores);
  }
  return restores;
}

function addVirtualFileEntry(contents, relativePath, source, restores) {
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
  const file = new BrowserVirtualRandomAccessFile(source);
  const name = parts[parts.length - 1];
  restores.push({
    entries,
    hadExisting: entries.has(name),
    name,
    value: entries.get(name) ?? null,
  });
  entries.set(name, new WasiRandomAccessFileInode(file, { readonly: true }));
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

async function flushBrowserOpfsMounts(mounts) {
  for (const mount of mounts) {
    await flushInMemoryEntriesToOpfs(mount.directoryHandle, mount.contents);
    await replaceScratchBackedEntriesWithOpfsHandles({
      directoryHandle: mount.directoryHandle,
      entries: mount.contents,
      mount,
    });
    flushWritableInodeEntries(mount.contents);
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

function flushWritableInodeEntries(entries) {
  for (const entry of entries.values()) {
    if (entry instanceof wasiShim.Directory) {
      flushWritableInodeEntries(entry.contents);
      continue;
    }
    if (!(entry instanceof WasiRandomAccessFileInode) || entry.readonly) continue;
    try {
      entry.file.flush();
    } catch {
      // ignore best-effort flush failures
    }
  }
}

async function flushInMemoryEntriesToOpfs(directoryHandle, entries) {
  for (const [name, entry] of entries) {
    if (entry instanceof WasiRandomAccessFileInode) {
      if (entry.scratchBacked) {
        const fileHandle = await directoryHandle.getFileHandle(name, { create: true });
        await copyRandomAccessFileToHandle(entry.file, fileHandle);
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

async function prepareKnownCliPaths({ args, mountHandles, runtimeMounts }) {
  const prepared = collectCliPreparedPaths(args);
  for (const entry of prepared) {
    const resolved = resolveMountedGuestPath(entry.path, mountHandles, runtimeMounts);
    if (!resolved) continue;
    if (entry.type === 'dir') {
      await ensureDirectoryPath(resolved.handle, resolved.relativeParts);
      continue;
    }
    await ensureFilePath(resolved.handle, resolved.relativeParts, { truncate: entry.truncate });
  }
}

async function syncMountedInputPathsFromOpfs({
  args,
  mounts,
  mountHandles,
  runtimeMounts,
}) {
  const inputPaths = collectCliInputPaths(args);
  if (inputPaths.length === 0) return;
  const mountsByPath = new Map(mounts.map((mount) => [mount.mountPath, mount]));
  for (const path of inputPaths) {
    const resolved = resolveMountedGuestPath(path, mountHandles, runtimeMounts);
    if (!resolved) continue;
    const mount = mountsByPath.get(resolved.mountPath);
    if (!mount) continue;
    const relativePath = resolved.relativeParts.join('/');
    if (relativePath.length === 0 || pathExistsInDirectory(mount.contents, relativePath)) continue;
    await hydrateMountedInputPathFromOpfs({
      mount,
      relativeParts: resolved.relativeParts,
      rootHandle: resolved.handle,
    });
  }
}

function collectCliInputPaths(args) {
  if (!Array.isArray(args) || args.length === 0) return [];
  const commandIndex = findCommandIndex(args);
  if (commandIndex === -1) return [];
  const command = String(args[commandIndex] ?? '');
  const values = [];
  const positional = args[commandIndex + 1];

  switch (command) {
    case 'checksum':
    case 'compress':
    case 'extract':
    case 'inspect':
    case 'trim':
      if (isCliPathArg(positional)) values.push(positional);
      break;
    case 'patch-create':
      values.push(...collectCliOptionPathValues(args, commandIndex + 1, ['--original', '--modified']));
      break;
    case 'patch-apply':
      values.push(...collectCliOptionPathValues(args, commandIndex + 1, ['--input', '--patch']));
      break;
    default:
      break;
  }

  return [...new Set(values.map((value) => String(value)))];
}

function collectCliOptionPathValues(args, startIndex, names) {
  const out = [];
  const lookup = new Set(names);
  for (let index = startIndex; index < args.length; index += 1) {
    const arg = String(args[index] ?? '');
    if (lookup.has(arg)) {
      const value = args[index + 1];
      if (isCliPathArg(value)) out.push(value);
      index += 1;
      continue;
    }
    for (const name of names) {
      if (!arg.startsWith(`${name}=`)) continue;
      const value = arg.slice(name.length + 1);
      if (isCliPathArg(value)) out.push(value);
      break;
    }
  }
  return out;
}

function isCliPathArg(value) {
  return typeof value === 'string' && value.trim().length > 0 && !value.startsWith('-');
}

async function hydrateMountedInputPathFromOpfs({ mount, relativeParts, rootHandle }) {
  if (!Array.isArray(relativeParts) || relativeParts.length === 0) return;
  let entries = mount.contents;
  let directoryHandle = rootHandle;
  for (const part of relativeParts.slice(0, -1)) {
    let entry = entries.get(part) ?? null;
    if (!entry) {
      try {
        directoryHandle = await directoryHandle.getDirectoryHandle(part, { create: false });
      } catch {
        return;
      }
      entry = new wasiShim.Directory(new Map());
      entries.set(part, entry);
    } else {
      try {
        directoryHandle = await directoryHandle.getDirectoryHandle(part, { create: false });
      } catch {
        return;
      }
    }
    if (!(entry instanceof wasiShim.Directory)) return;
    entries = entry.contents;
  }

  const name = relativeParts[relativeParts.length - 1];
  if (entries.has(name)) return;

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
    return;
  } catch {
    // ignored
  }

  try {
    await directoryHandle.getDirectoryHandle(name, { create: false });
    entries.set(name, new wasiShim.Directory(new Map()));
  } catch {
    // ignored
  }
}

function collectCliPreparedPaths(args) {
  const out = [];
  let extractSourcePath = null;
  let extractOutDirPath = null;
  const commandIndex = findCommandIndex(args);
  if (commandIndex !== -1 && args[commandIndex] === 'extract') {
    const sourcePath = args[commandIndex + 1];
    if (typeof sourcePath === 'string' && !sourcePath.startsWith('-')) extractSourcePath = sourcePath;
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] ?? '');
    if (arg === '--output') {
      const value = args[index + 1];
      if (typeof value === 'string') out.push({ path: value, truncate: true, type: 'file' });
      index += 1;
      continue;
    }
    if (arg.startsWith('--output=')) {
      out.push({ path: arg.slice('--output='.length), truncate: true, type: 'file' });
      continue;
    }
    if (arg === '--out-dir') {
      const value = args[index + 1];
      if (typeof value === 'string') {
        extractOutDirPath = value;
        out.push({ path: value, type: 'dir' });
      }
      index += 1;
      continue;
    }
    if (arg.startsWith('--out-dir=')) {
      extractOutDirPath = arg.slice('--out-dir='.length);
      out.push({ path: extractOutDirPath, type: 'dir' });
    }
  }
  const directExtractOutputPath = predictDirectExtractOutputPath({
    outDirPath: extractOutDirPath,
    sourcePath: extractSourcePath,
  });
  if (directExtractOutputPath) out.push({ path: directExtractOutputPath, truncate: true, type: 'file' });
  return out;
}

function predictDirectExtractOutputPath({ outDirPath, sourcePath }) {
  const outputName = predictNodExtractOutputName(sourcePath);
  if (!(outputName && typeof outDirPath === 'string' && outDirPath.trim())) return null;
  return joinGuestPath(outDirPath, outputName);
}

function predictNodExtractOutputName(sourcePath) {
  if (typeof sourcePath !== 'string') return null;
  const baseName = sourcePath.split(PATH_SEPARATOR_REGEX).filter(Boolean).pop() || '';
  const extensionIndex = baseName.lastIndexOf('.');
  if (extensionIndex <= 0) return null;
  const extension = baseName.slice(extensionIndex + 1).toLowerCase();
  if (!['gcz', 'nfs', 'rvz', 'tgc', 'wbfs', 'wia'].includes(extension)) return null;
  return `${baseName.slice(0, extensionIndex)}.iso`;
}

function resolveMountedGuestPath(path, mountHandles, runtimeMounts) {
  const normalizedPath = normalizeGuestPath(path, { label: 'prepared CLI path' });
  const sortedMounts = [...runtimeMounts].sort((a, b) => b.length - a.length);
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
  const files = [];
  for (let index = 0; index < count; index += 1) {
    const scratchName = `${token}-${index}.tmp`;
    const fileHandle = await scratchDirectoryHandle.getFileHandle(scratchName, { create: true });
    const syncHandle = await openSyncAccessHandle({
      fileHandle,
      mode: writableSyncAccessMode(syncAccessMode),
    });
    syncHandle.truncate(0);
    const file = new BrowserOpfsRandomAccessFile(syncHandle, { scratchName });
    files.push(file);
    closeables.push(file);
  }
  return {
    directoryHandle: scratchDirectoryHandle,
    files,
    pool: [...files],
  };
}

function normalizeScratchFilePoolSize(value) {
  if (value === undefined || value === null) return DEFAULT_SCRATCH_FILE_POOL_SIZE;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new TypeError('scratchFilePoolSize must be a non-negative number');
  }
  return Math.floor(parsed);
}

function writableSyncAccessMode(mode) {
  return mode === 'read-only' ? undefined : mode;
}

async function cleanupBrowserOpfsMounts(mounts) {
  for (const mount of mounts) {
    mount.finishRun();
    if (!mount.scratchDirectoryHandle) continue;
    for (const file of mount.scratchFiles) {
      if (!file.scratchName) continue;
      try {
        await mount.scratchDirectoryHandle.removeEntry(file.scratchName);
      } catch {
        // ignore best-effort scratch cleanup failures
      }
    }
    try {
      for await (const [name] of mount.scratchDirectoryHandle.entries()) {
        try {
          await mount.scratchDirectoryHandle.removeEntry(name);
        } catch {
          // ignore best-effort scratch cleanup failures
        }
      }
    } catch {
      // ignore best-effort scratch cleanup failures
    }
    mount.scratchDirectoryHandle = null;
    mount.scratchFiles = [];
    mount.scratchPool = [];
  }
}

async function cleanupScratchDirectoriesFromHandles({
  mountHandles,
  runtimeMounts,
}) {
  for (const mountPath of runtimeMounts ?? []) {
    const handle = mountHandles?.[mountPath];
    if (!handle) continue;
    let scratchDirectoryHandle = null;
    try {
      scratchDirectoryHandle = await handle.getDirectoryHandle(SCRATCH_DIRECTORY_NAME, { create: false });
    } catch {
      continue;
    }
    try {
      for await (const [name] of scratchDirectoryHandle.entries()) {
        try {
          await scratchDirectoryHandle.removeEntry(name);
        } catch {
          // ignore best-effort scratch cleanup failures
        }
      }
    } catch {
      // ignore best-effort scratch cleanup failures
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

async function ensureDirectoryPath(rootHandle, relativeParts = []) {
  let current = rootHandle;
  for (const part of relativeParts) {
    current = await current.getDirectoryHandle(part, { create: true });
  }
  return current;
}

async function ensureFilePath(rootHandle, relativeParts, { truncate = false } = {}) {
  if (!Array.isArray(relativeParts) || relativeParts.length === 0) {
    throw new TypeError('file path must include a filename');
  }
  const fileName = relativeParts[relativeParts.length - 1];
  const parent = await ensureDirectoryPath(rootHandle, relativeParts.slice(0, -1));
  const fileHandle = await parent.getFileHandle(fileName, { create: true });
  if (truncate) await truncateFileHandle(fileHandle, 0);
  return fileHandle;
}

async function truncateFileHandle(fileHandle, size) {
  if (typeof fileHandle.createSyncAccessHandle === 'function') {
    const accessHandle = await openSyncAccessHandle({ fileHandle, mode: 'readwrite' });
    try {
      accessHandle.truncate(size);
      accessHandle.flush();
    } finally {
      accessHandle.close();
    }
    return;
  }
  const writable = await fileHandle.createWritable({ keepExistingData: true });
  let writeError = null;
  try {
    await writable.truncate(size);
  } catch (error) {
    writeError = error;
    throw error;
  } finally {
    await closeWritableStream(writable, writeError);
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

function isVirtualFileProxy(value) {
  return Boolean(
    value
      && typeof value === 'object'
      && typeof value.id === 'string'
      && Array.isArray(value.slots)
      && Number.isFinite(Number(value.size))
      && Number(value.size) >= 0,
  );
}

function normalizeVirtualFileProxySlots(proxy) {
  const slots = [];
  for (const slot of proxy.slots) {
    if (!isSharedArrayBufferLike(slot?.controlBuffer) || !isSharedArrayBufferLike(slot?.dataBuffer)) continue;
    const control = new Int32Array(slot.controlBuffer);
    if (control.length < 6) continue;
    slots.push({
      control,
      data: new Uint8Array(slot.dataBuffer),
    });
  }
  if (slots.length === 0) {
    throw new TypeError(`virtual file proxy has no usable shared read slots: ${proxy.id}`);
  }
  return slots;
}

function isSharedArrayBufferLike(value) {
  return Boolean(
    typeof SharedArrayBuffer === 'function'
      && value
      && typeof value === 'object'
      && Object.prototype.toString.call(value) === '[object SharedArrayBuffer]',
  );
}

function isBlobLike(value) {
  return typeof Blob !== 'undefined' && value instanceof Blob;
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
    const command = {
      commandId,
      ready: null,
      slots: [],
      shutdown: async () => {
        for (const slot of command.slots) {
          if (slot.shell.currentCommand !== slot) continue;
          Atomics.store(slot.control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_SHUTDOWN);
          Atomics.notify(slot.control, THREAD_SLOT_STATE_INDEX, 1);
        }
        await Promise.allSettled(command.slots.map((slot) => slot.done));
      },
    };
    command.ready = ensureSize(poolSize).then(async () => {
      if (threadWorkerUrl && resolveThreadWorkerUrl(threadWorkerUrl) !== resolvedThreadWorkerUrl) {
        throw new Error(
          `browser wasi thread worker pool URL mismatch: ${resolvedThreadWorkerUrl} !== ${threadWorkerUrl}`,
        );
      }
      const shells = workers.slice(0, poolSize);
      for (const shell of shells) {
        if (shell.terminated) throw new Error(`browser wasi thread worker ${shell.index} is not available`);
        if (shell.currentCommand) throw new Error(`browser wasi thread worker ${shell.index} is already busy`);
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
        shell.worker.postMessage({
          mode: 'pool-command',
          commandId,
          __streamBroadcastChannelName: streamBroadcastChannelName,
          __streamRequestId: streamRequestId,
          controlBuffer: control.buffer,
          debugWasi,
          envList,
          runtime,
          threadIdState,
          threadWorkerUrl: resolvedThreadWorkerUrl,
          wasiArgs,
          wasmMemory,
          wasmModule,
        });
      }
      await Promise.all(command.slots.map((slot) => slot.ready));
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
  streamBroadcastChannelName,
  streamRequestId,
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
  const poolWorkers = [];
  let firstThreadFailure = null;
  const resolvedThreadWorkerUrl = resolveThreadWorkerUrl(threadWorkerUrl);
  const poolSize = resolveBrowserThreadPoolSize(wasiArgs);
  if (threadWorkerPool) {
    const command = threadWorkerPool.createCommand({
      poolSize,
      streamBroadcastChannelName,
      streamRequestId,
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
      wasmMemory,
    });
  }

  const recordFailure = (tid, error) => {
    const wrapped = wrapThreadFailure(tid, error);
    if (!firstThreadFailure) firstThreadFailure = wrapped;
    for (const [activeTid, worker] of activeWorkers.entries()) {
      if (activeTid === tid) continue;
      worker.terminate();
    }
    return wrapped;
  };

  const poolReadyPromises = [];
  for (let index = 0; index < poolSize; index += 1) {
    const control = new Int32Array(
      new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * THREAD_SLOT_LENGTH),
    );
    control[THREAD_SLOT_STATE_INDEX] = THREAD_SLOT_STATE_IDLE;
    control[THREAD_SLOT_TID_INDEX] = 0;
    control[THREAD_SLOT_START_ARG_INDEX] = 0;
    control[THREAD_SLOT_ERROR_INDEX] = 0;
    const slot = {
      index,
      worker: null,
      control,
      online: false,
      busy: false,
      tid: null,
      resolveReady: null,
      rejectReady: null,
      readyTimer: null,
    };
    const handleThreadWorkerFailure = (slot, error) => {
      if (slot.tid != null) {
        activeWorkers.delete(slot.tid);
        Atomics.store(slot.control, THREAD_SLOT_ERROR_INDEX, 1);
        signalThreadStartState(slot.control, THREAD_SLOT_STATE_FAILED);
        recordFailure(slot.tid, error);
        slot.busy = false;
        slot.tid = null;
        return;
      }
      slot.rejectReady?.(error);
    };
    const ready = new Promise((resolveReady, rejectReady) => {
      slot.resolveReady = resolveReady;
      slot.rejectReady = rejectReady;
    }).finally(() => {
      if (slot.readyTimer) clearTimeout(slot.readyTimer);
      slot.readyTimer = null;
    });
    slot.readyTimer = setTimeout(() => {
      handleThreadWorkerFailure(
        slot,
        new Error(
          `browser wasi thread worker ${slot.index} did not become ready within ${THREAD_WORKER_READY_TIMEOUT_MS}ms`
          + ` (workerUrl=${resolvedThreadWorkerUrl})`,
        ),
      );
    }, THREAD_WORKER_READY_TIMEOUT_MS);
    poolReadyPromises.push(ready);
    const worker = new Worker(resolvedThreadWorkerUrl, { type: 'module' });
    slot.worker = worker;
    worker.addEventListener('message', (event) => {
      const message = event.data ?? {};
      if (message.type === 'ready') {
        slot.online = true;
        slot.resolveReady?.();
        slot.resolveReady = null;
        slot.rejectReady = null;
        return;
      }
      if (message.type === 'error') {
        const tid = Number.isInteger(message.tid) ? message.tid : slot.tid;
        const error = annotateThreadWorkerError(
          deserializeThreadWorkerError(message.error),
          slot,
          resolvedThreadWorkerUrl,
        );
        if (tid != null) {
          activeWorkers.delete(tid);
          slot.busy = false;
          slot.tid = null;
          Atomics.store(slot.control, THREAD_SLOT_ERROR_INDEX, 1);
          signalThreadStartState(slot.control, THREAD_SLOT_STATE_FAILED);
          recordFailure(tid, error);
          return;
        }
        slot.rejectReady?.(error);
      }
    });
    worker.addEventListener('error', (event) => {
      event.preventDefault?.();
      handleThreadWorkerFailure(slot, createThreadWorkerLoadError(event, slot, resolvedThreadWorkerUrl));
    });
    worker.addEventListener('messageerror', (event) => {
      event.preventDefault?.();
      handleThreadWorkerFailure(
        slot,
        new Error(
          `browser wasi thread worker ${slot.index} could not receive its startup payload`
          + ` (workerUrl=${resolvedThreadWorkerUrl}, tid=${slot.tid ?? 'ready'})`,
        ),
      );
    });
    worker.postMessage({
      mode: 'pool',
      __streamBroadcastChannelName: streamBroadcastChannelName,
      __streamRequestId: streamRequestId,
      controlBuffer: control.buffer,
      debugWasi: Boolean(runtime?.debugWasi ?? false),
      envList,
      runtime,
      threadIdState,
      threadWorkerUrl: resolvedThreadWorkerUrl,
      wasiArgs,
      wasmMemory,
      wasmModule,
    });
    poolWorkers.push(slot);
  }

  const spawn = function spawn(startArg) {
    const errorOrTidPtr = arguments.length > 1 ? arguments[1] : undefined;
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
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, Math.abs(tid), true);
    }

    const slot = poolWorkers.find((candidate) => candidate.online
      && !candidate.busy
      && Atomics.load(candidate.control, THREAD_SLOT_STATE_INDEX) === THREAD_SLOT_STATE_IDLE);
    if (!slot) {
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

    const startAckError = waitForThreadStartAck(slot.control, tid);
    if (startAckError) {
      activeWorkers.delete(tid);
      slot.busy = false;
      slot.tid = null;
      recordFailure(tid, startAckError);
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, WASI_ERRNO_AGAIN, true);
    }

    return finishThreadSpawn(wasmMemory, errorOrTidPtr, tid, false);
  };

  const waitForWorkers = async () => {
    while (activeWorkers.size > 0) {
      for (const [tid, slot] of activeWorkers.entries()) {
        while (true) {
          const state = Atomics.load(slot.control, THREAD_SLOT_STATE_INDEX);
          if (state === THREAD_SLOT_STATE_IDLE) {
            slot.busy = false;
            slot.tid = null;
            activeWorkers.delete(tid);
            break;
          }
          if (state === THREAD_SLOT_STATE_FAILED) {
            recordFailure(tid, new Error(`wasi thread ${tid} failed in browser worker ${slot.index}`));
            slot.busy = false;
            slot.tid = null;
            activeWorkers.delete(tid);
            break;
          }
          Atomics.wait(slot.control, THREAD_SLOT_STATE_INDEX, state, 100);
        }
      }
    }
    for (const slot of poolWorkers) {
      try {
        Atomics.store(slot.control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_SHUTDOWN);
        Atomics.notify(slot.control, THREAD_SLOT_STATE_INDEX, 1);
      } catch {
        // ignored
      }
      slot.worker.terminate();
    }
    if (firstThreadFailure) throw firstThreadFailure;
  };

  return { spawn, ready: Promise.all(poolReadyPromises), waitForWorkers };
}

function createBrowserWasiThreadSpawnerForCommand({
  command,
  threadIdState,
  wasmMemory,
}) {
  const activeWorkers = new Map();
  let firstThreadFailure = null;

  const recordFailure = (tid, error) => {
    const wrapped = wrapThreadFailure(tid, error);
    if (!firstThreadFailure) firstThreadFailure = wrapped;
    return wrapped;
  };

  const spawn = function spawn(startArg) {
    const errorOrTidPtr = arguments.length > 1 ? arguments[1] : undefined;
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

    const tid = allocateThreadId(threadIdState);
    if (tid < 0) {
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, Math.abs(tid), true);
    }

    const slot = command.slots.find((candidate) => candidate.online
      && !candidate.busy
      && Atomics.load(candidate.control, THREAD_SLOT_STATE_INDEX) === THREAD_SLOT_STATE_IDLE);
    if (!slot) {
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

    const startAckError = waitForThreadStartAck(slot.control, tid);
    if (startAckError) {
      activeWorkers.delete(tid);
      slot.busy = false;
      slot.tid = null;
      recordFailure(tid, startAckError);
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, WASI_ERRNO_AGAIN, true);
    }

    return finishThreadSpawn(wasmMemory, errorOrTidPtr, tid, false);
  };

  const waitForWorkers = async () => {
    while (activeWorkers.size > 0) {
      for (const [tid, slot] of activeWorkers.entries()) {
        while (true) {
          const state = Atomics.load(slot.control, THREAD_SLOT_STATE_INDEX);
          if (state === THREAD_SLOT_STATE_IDLE) {
            slot.busy = false;
            slot.tid = null;
            activeWorkers.delete(tid);
            break;
          }
          if (state === THREAD_SLOT_STATE_FAILED) {
            recordFailure(tid, slot.failure || new Error(`wasi thread ${tid} failed in browser worker ${slot.index}`));
            slot.busy = false;
            slot.tid = null;
            activeWorkers.delete(tid);
            break;
          }
          Atomics.wait(slot.control, THREAD_SLOT_STATE_INDEX, state, 100);
        }
      }
    }
    await command.shutdown();
    if (firstThreadFailure) throw firstThreadFailure;
  };

  const ready = command.ready.catch(async (error) => {
    await command.shutdown();
    throw error;
  });

  return { spawn, ready, waitForWorkers };
}

function resolveBrowserThreadPoolSize(wasiArgs) {
  const requestedThreadCount = parseRequestedThreadCount(wasiArgs);
  if (requestedThreadCount === null || requestedThreadCount <= 1) return 0;
  return Math.min(Math.max(1, requestedThreadCount), MAX_BROWSER_THREAD_POOL_SIZE);
}

function parseRequestedThreadCount(wasiArgs) {
  if (!Array.isArray(wasiArgs)) return null;
  for (let index = wasiArgs.length - 1; index >= 0; index -= 1) {
    if (wasiArgs[index] !== '--threads') continue;
    const parsed = Number.parseInt(String(wasiArgs[index + 1] ?? ''), 10);
    if (Number.isInteger(parsed) && parsed > 0) return Math.min(parsed, MAX_BROWSER_THREAD_POOL_SIZE);
    break;
  }
  return null;
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

function waitForThreadStartAck(control, tid) {
  const deadline = Date.now() + THREAD_START_ACK_TIMEOUT_MS;
  while (true) {
    const state = Atomics.load(control, THREAD_SLOT_STATE_INDEX);
    if (state === THREAD_SLOT_STATE_RUNNING || state === THREAD_SLOT_STATE_IDLE) return null;
    if (state === THREAD_SLOT_STATE_FAILED) {
      return new Error(`wasi thread ${tid} failed before start acknowledgement`);
    }
    if (state === THREAD_SLOT_STATE_SHUTDOWN) {
      return new Error(`wasi thread ${tid} was shut down before start acknowledgement`);
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return new Error(`wasi thread ${tid} start acknowledgement timed out`);
    }
    if (state === THREAD_SLOT_STATE_STARTING) {
      Atomics.wait(control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_STARTING, Math.min(remainingMs, 100));
      continue;
    }
    if (state !== THREAD_SLOT_STATE_REQUESTED) {
      return new Error(`wasi thread ${tid} entered unexpected start state ${state}`);
    }
    Atomics.wait(control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_REQUESTED, Math.min(remainingMs, 100));
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
  const maximum = normalizePositiveInteger(
    maximumPages,
    DEFAULT_SHARED_MEMORY_MAX_PAGES,
    'sharedMemoryMaximumPages',
  );
  if (maximum < initial) {
    throw new Error('sharedMemoryMaximumPages must be >= sharedMemoryInitialPages');
  }
  return new WebAssembly.Memory({ initial, maximum, shared: true });
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

function withDefaultThreadArgs(args, defaultThreads) {
  if (!defaultThreads || hasThreadArg(args)) return args;
  const commandIndex = findCommandIndex(args);
  if (commandIndex === -1 || !THREAD_AWARE_COMMANDS.has(args[commandIndex])) return args;
  return [...args, '--threads', String(defaultThreads)];
}

function hasThreadArg(args) {
  return args.some((arg) => arg === '--threads' || arg.startsWith('--threads='));
}

function findCommandIndex(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json' || arg === '--progress' || arg === '--no-progress' || arg === '--trace') continue;
    return index;
  }
  return -1;
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
  return new URL('./workers/browser-wasi-thread-worker.mjs', import.meta.url).href;
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
  preferThreadedWasm,
  threadedWasmUrl,
  wasmUrl,
} = {}) {
  if (module instanceof WebAssembly.Module) {
    return {
      module,
      wasmUrl: normalizeConfiguredWasmUrls(wasmUrl, [null])[0],
    };
  }

  const runtimeSupportsThreadedWasm = canUseThreadedWasmRuntime();
  const requestedThreadedWasm = preferThreadedWasm === undefined
    ? runtimeSupportsThreadedWasm
    : Boolean(preferThreadedWasm);
  const shouldUseThreadedWasm = requestedThreadedWasm && runtimeSupportsThreadedWasm;

  const hasExplicitWasmUrl = hasConfiguredWasmUrl(wasmUrl);
  const resolvedWasmUrls = normalizeConfiguredWasmUrls(wasmUrl, DEFAULT_BROWSER_WASM_URLS);
  const resolvedThreadedWasmUrls = normalizeConfiguredWasmUrls(
    threadedWasmUrl,
    hasExplicitWasmUrl ? [] : DEFAULT_BROWSER_THREADED_WASM_URLS,
  );
  const useThreadedCandidate = shouldUseThreadedWasm && resolvedThreadedWasmUrls.length > 0;
  const primaryUrls = useThreadedCandidate ? resolvedThreadedWasmUrls : resolvedWasmUrls;
  return compileBrowserModuleFromUrls(primaryUrls);
}

function canUseThreadedWasmRuntime() {
  return typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated === true;
}

function hasConfiguredWasmUrl(url) {
  return url instanceof URL || (typeof url === 'string' && url.trim().length > 0);
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

function normalizeArgs(args) {
  if (!Array.isArray(args)) throw new TypeError('args must be an array of strings');
  return args.map((value) => String(value));
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
