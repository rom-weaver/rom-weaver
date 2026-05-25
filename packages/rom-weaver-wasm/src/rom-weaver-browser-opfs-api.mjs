import * as wasiShim from '@bjorn3/browser_wasi_shim';
import {
  createWasmEnvImports,
  normalizeGuestPath,
  parseJsonLines,
  parseTraceJsonLines,
} from './rom-weaver-runtime-utils.mjs';

const DEFAULT_WORK_GUEST_PATH = '/work';
const DEFAULT_SCRATCH_FILE_POOL_SIZE = 256;
const DEFAULT_SHARED_MEMORY_INITIAL_PAGES = 256;
const DEFAULT_SHARED_MEMORY_MAX_PAGES = 16384;
const PATH_SEPARATOR_REGEX = /[/\\]+/;
const SCRATCH_DIRECTORY_NAME = '.rom-weaver-opfs-scratch';
const OPFS_COPY_CHUNK_SIZE = 8 * 1024 * 1024;
const DEFAULT_BROWSER_THREAD_POOL_SIZE = 8;
const MAX_BROWSER_THREAD_POOL_SIZE = 64;
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
const WASI_ERRNO_AGAIN = 6;
const WASI_ERRNO_ENOSYS = 52;

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

  const runner = {
    async run(args = [], runOptions = {}) {
      const normalizedArgs = normalizeArgs(args);
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
      await prepareKnownCliPaths({
        args: normalizedArgs,
        mountHandles,
        runtimeMounts,
      });

      const closeables = [];
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
      const threadSpawner = createBrowserWasiThreadSpawner({
        moduleImports,
        threadIdState,
        threadWorkerUrl: runOptions.threadWorkerUrl ?? options.threadWorkerUrl,
        wasmMemory,
        wasmModule: module,
        wasiArgs,
        envList,
        runtime: {
          cwdMountPath: workGuestPath,
          debugWasi: Boolean(runOptions.debugWasi ?? options.debugWasi ?? false),
          mountHandles,
          runtimeMounts,
          scratchFilePoolSize: runOptions.scratchFilePoolSize ?? options.scratchFilePoolSize,
          syncAccessMode: resolvedSyncAccessMode,
          writableRoots,
        },
      });
      const {
        fds,
        mounts,
        stdoutChunks,
        stderrChunks,
      } = await buildBrowserOpfsWasiFds({
        cwdMountPath: workGuestPath,
        stdin: runOptions.stdin,
        runtimeMounts,
        mountHandles,
        scratchFilePoolSize: runOptions.scratchFilePoolSize ?? options.scratchFilePoolSize,
        writableRoots,
        syncAccessMode: resolvedSyncAccessMode,
        closeables,
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
      }
    },

    async runJson(args = [], runOptions = {}) {
      const result = await this.run(['--json', ...normalizeArgs(args)], runOptions);
      const parsed = parseJsonLines(result.stdout, {
        onEvent: runOptions.onEvent,
        onNonJsonLine: runOptions.onNonJsonLine,
      });
      const parsedTrace = parseTraceJsonLines(result.stderr, {
        onTraceEvent: runOptions.onTraceEvent,
        onTraceNonJsonLine: runOptions.onTraceNonJsonLine,
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
  let mounts = [];

  try {
    const built = await buildBrowserOpfsWasiFds({
      cwdMountPath: runtime?.cwdMountPath,
      stdin: undefined,
      runtimeMounts: normalizeRuntimeMounts(runtime?.runtimeMounts),
      mountHandles: normalizeMountHandleMap({ mountHandles: runtime?.mountHandles }),
      scratchFilePoolSize: runtime?.scratchFilePoolSize,
      writableRoots: Array.isArray(runtime?.writableRoots) ? runtime.writableRoots : [],
      syncAccessMode: runtime?.syncAccessMode,
      closeables,
    });
    mounts = built.mounts;
    const threadWasi = new wasiShim.WASI(
      Array.isArray(wasiArgs) && wasiArgs.length > 0 ? wasiArgs.map((value) => String(value)) : ['rom-weaver'],
      Array.isArray(envList) ? envList.map((value) => String(value)) : [],
      built.fds,
      { debug: Boolean(debugWasi ?? runtime?.debugWasi ?? false) },
    );
    const nestedThreadSpawner = createBrowserWasiThreadSpawner({
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
  } catch (error) {
    if (!startAcked) signalThreadStartState(startControl, THREAD_SLOT_STATE_FAILED);
    throw error;
  } finally {
    closeSyncFiles(closeables);
    await cleanupBrowserOpfsMounts(mounts);
  }
}

function createRunEnv({ baseEnv, runEnv }) {
  return {
    ...(baseEnv ?? {}),
    ...(runEnv ?? {}),
  };
}

async function buildBrowserOpfsWasiFds({
  cwdMountPath,
  stdin,
  runtimeMounts,
  mountHandles,
  scratchFilePoolSize,
  writableRoots,
  syncAccessMode,
  closeables,
}) {
  const stdinBytes = normalizeStdin(stdin);
  const stdoutCollector = createOutputCollector(wasiShim.ConsoleStdout);
  const stderrCollector = createOutputCollector(wasiShim.ConsoleStdout);

  const fds = [
    new wasiShim.OpenFile(new wasiShim.File(stdinBytes)),
    stdoutCollector.fd,
    stderrCollector.fd,
  ];
  const mounts = [];
  let cwdMount = null;

  for (const mountPath of runtimeMounts) {
    const handle = mountHandles[mountPath];
    if (!handle) {
      throw new Error(
        `No directory handle provided for runtime mount ${mountPath}. `
          + 'Provide options.mountHandles or runOptions.mountHandles.',
      );
    }

    const mount = await BrowserOpfsMount.create({
      closeables,
      directoryHandle: handle,
      mountPath,
      scratchFilePoolSize,
      syncAccessMode,
      writableRoots,
    });
    mounts.push(mount);
    fds.push(new PreparedWasiPreopenDirectory(mount));
    if (mountPath === cwdMountPath) cwdMount = mount;
  }

  if (cwdMount) {
    fds.push(new PreparedWasiPreopenDirectory(cwdMount, { preopenName: '.' }));
  }

  return {
    fds,
    mounts,
    stdoutChunks: stdoutCollector.chunks,
    stderrChunks: stderrCollector.chunks,
  };
}

class BrowserOpfsMount {
  static async create({
    closeables,
    directoryHandle,
    mountPath,
    scratchFilePoolSize,
    syncAccessMode,
    writableRoots,
  }) {
    const contents = await buildOpfsInodeMap({
      closeables,
      directoryHandle,
      guestPath: mountPath,
      syncAccessMode,
      writableRoots,
    });
    const scratch = await createScratchFilePool({
      closeables,
      directoryHandle,
      scratchFilePoolSize,
      syncAccessMode,
    });
    return new BrowserOpfsMount({
      contents,
      directoryHandle,
      mountPath,
      scratchDirectoryHandle: scratch.directoryHandle,
      scratchFiles: scratch.files,
      scratchPool: scratch.pool,
      writableRoots,
    });
  }

  constructor({
    contents,
    directoryHandle,
    mountPath,
    scratchDirectoryHandle,
    scratchFiles,
    scratchPool,
    writableRoots,
  }) {
    this.contents = contents;
    this.directoryHandle = directoryHandle;
    this.mountPath = mountPath;
    this.scratchDirectoryHandle = scratchDirectoryHandle;
    this.scratchFiles = scratchFiles;
    this.scratchPool = scratchPool;
    this.writableRoots = writableRoots;
  }

  isWritablePath(guestPath) {
    return isGuestPathWithinRoots(guestPath, this.writableRoots);
  }

  takeScratchFile() {
    const file = this.scratchPool.pop() ?? null;
    if (file) file.truncate(0);
    return file;
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

async function flushBrowserOpfsMounts(mounts) {
  for (const mount of mounts) {
    await flushInMemoryEntriesToOpfs(mount.directoryHandle, mount.contents);
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

function collectCliPreparedPaths(args) {
  const out = [];
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
      if (typeof value === 'string') out.push({ path: value, type: 'dir' });
      index += 1;
      continue;
    }
    if (arg.startsWith('--out-dir=')) {
      out.push({ path: arg.slice('--out-dir='.length), type: 'dir' });
    }
  }
  return out;
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
    if (!mount.scratchDirectoryHandle) continue;
    for (const file of mount.scratchFiles) {
      if (!file.scratchName) continue;
      try {
        await mount.scratchDirectoryHandle.removeEntry(file.scratchName);
      } catch {
        // ignore best-effort scratch cleanup failures
      }
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
  } finally {
    await writable.close();
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

function createOutputCollector(ConsoleStdout) {
  const chunks = [];
  return {
    chunks,
    fd: new ConsoleStdout((bytes) => {
      chunks.push(copyUint8Array(bytes));
    }),
  };
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
  try {
    await writable.truncate(size);
  } finally {
    await writable.close();
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
  try {
    await writable.write(bytes);
  } finally {
    await writable.close();
  }
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

function createBrowserWasiThreadSpawner({
  moduleImports,
  threadIdState,
  threadWorkerUrl,
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
  const poolSize = resolveBrowserThreadPoolSize(wasiArgs);
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
    };
    const ready = new Promise((resolveReady, rejectReady) => {
      slot.resolveReady = resolveReady;
      slot.rejectReady = rejectReady;
    });
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
        const error = deserializeThreadWorkerError(message.error);
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
      const error = event?.error instanceof Error
        ? event.error
        : new Error(event?.message || 'browser wasi thread worker error');
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
    });
    worker.postMessage({
      mode: 'pool',
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

function resolveBrowserThreadPoolSize(wasiArgs) {
  const requestedThreadCount = parseRequestedThreadCount(wasiArgs);
  return Math.min(
    Math.max(DEFAULT_BROWSER_THREAD_POOL_SIZE, requestedThreadCount * 2),
    MAX_BROWSER_THREAD_POOL_SIZE,
  );
}

function parseRequestedThreadCount(wasiArgs) {
  if (!Array.isArray(wasiArgs)) return DEFAULT_BROWSER_THREAD_POOL_SIZE;
  for (let index = wasiArgs.length - 1; index >= 0; index -= 1) {
    if (wasiArgs[index] !== '--threads') continue;
    const parsed = Number.parseInt(String(wasiArgs[index + 1] ?? ''), 10);
    if (Number.isInteger(parsed) && parsed > 0) return Math.min(parsed, MAX_BROWSER_THREAD_POOL_SIZE);
    break;
  }
  return DEFAULT_BROWSER_THREAD_POOL_SIZE;
}

function wrapThreadFailure(tid, error) {
  const message = error instanceof Error ? error.message : String(error);
  const out = new Error(`wasi thread ${tid} failed before completion: ${message}`);
  if (error instanceof Error && typeof error.stack === 'string') out.stack = error.stack;
  return out;
}

function deserializeThreadWorkerError(error) {
  const out = new Error(error && typeof error.message === 'string' ? error.message : 'browser wasi thread worker failed');
  if (error && typeof error.name === 'string') out.name = error.name;
  if (error && typeof error.stack === 'string') out.stack = error.stack;
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

function assertThreadedWasmRuntimeSupported({ wasmUrl }) {
  if (typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated === true) return;
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
      wasmUrl: typeof wasmUrl === 'string' ? wasmUrl : null,
    };
  }

  const url = preferThreadedWasm && threadedWasmUrl
    ? threadedWasmUrl
    : wasmUrl ?? './rom-weaver-cli.wasm';
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
