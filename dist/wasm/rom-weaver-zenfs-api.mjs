import {
  createRomWeaverWasiRunner,
  parseJsonLines,
  parseTraceJsonLines,
} from './rom-weaver-wasi-api.mjs';

export async function createRomWeaverZenFsNode(options = {}) {
  const zenfs = await import('@zenfs/core');
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');

  const guestMounts = normalizeGuestMountMap({
    defaultTmpHostPath: nodeOs.tmpdir(),
    defaultCwdHostPath: process.cwd(),
    resolveHostPath: (pathLike) => nodePath.resolve(pathLike),
    mounts: options.mounts,
    includeHostRoot: options.includeHostRoot,
    mountCwd: options.mountCwd,
    cwdGuestPath: options.cwdGuestPath,
    cwdHostPath: options.cwdHostPath,
    mountTmp: options.mountTmp,
    tmpGuestPath: options.tmpGuestPath,
    tmpHostPath: options.tmpHostPath,
  });

  const zenMounts = {
    '/': zenfs.InMemory,
  };
  const preopens = {};

  for (const [guestPath, hostPath] of Object.entries(guestMounts)) {
    nodeFs.mkdirSync(hostPath, { recursive: true });
    zenMounts[guestPath] = {
      backend: zenfs.Passthrough,
      fs: nodeFs,
      prefix: hostPath,
    };
    preopens[guestPath] = hostPath;
  }

  await zenfs.configure({
    mounts: zenMounts,
    defaultDirectories: true,
  });

  const tmpGuestPath = normalizeGuestPath(options.tmpGuestPath ?? '/tmp');
  const runner = createRomWeaverWasiRunner({
    wasmPath: options.wasmPath,
    argv0: options.argv0,
    useDefaultPreopens: false,
    preopens: {
      ...preopens,
      ...(options.preopens ?? {}),
    },
    env: {
      ROM_WEAVER_TMPDIR: tmpGuestPath,
      ...(options.env ?? {}),
    },
  });

  return {
    mode: 'node',
    fs: zenfs.fs,
    guestMounts,
    run: (args, runOptions) => runner.run(args, runOptions),
    async runJson(args, runOptions = {}) {
      const result = await runner.run(['--json', ...normalizeArgs(args)], runOptions);
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
}

export async function createRomWeaverZenFsBrowser(options = {}) {
  assertDedicatedWorkerRuntime();

  const zenfs = await import('@zenfs/core');
  const zenDom = await import('@zenfs/dom');
  const wasiShim = await import('@bjorn3/browser_wasi_shim');

  const opfsGuestPath = normalizeGuestPath(options.opfsGuestPath ?? '/opfs');
  const tmpGuestPath = normalizeGuestPath(options.tmpGuestPath ?? '/tmp');
  const opfsHandle = options.opfsHandle ?? (await navigator.storage.getDirectory());

  assertDirectoryHandle(opfsHandle, 'opfsHandle');

  await zenfs.configure({
    mounts: {
      '/': zenfs.InMemory,
      [opfsGuestPath]: {
        backend: zenDom.WebAccess,
        handle: opfsHandle,
      },
      [tmpGuestPath]: zenfs.InMemory,
    },
    defaultDirectories: true,
  });

  const module = await resolveBrowserModule(options.module, options.wasmUrl);
  const runtimeMounts = normalizeRuntimeMounts(
    options.runtimeMounts ?? [opfsGuestPath, tmpGuestPath],
  );

  const baseMountHandles = normalizeMountHandleMap({
    opfsGuestPath,
    opfsHandle,
    mountHandles: options.mountHandles,
  });

  const runner = {
    async run(args = [], runOptions = {}) {
      const normalizedArgs = normalizeArgs(args);
      const env = {
        ROM_WEAVER_TMPDIR: tmpGuestPath,
        ...(options.env ?? {}),
        ...(runOptions.env ?? {}),
      };
      const envList = Object.entries(env).map(([key, value]) => `${key}=${String(value)}`);

      const mountHandles = {
        ...baseMountHandles,
        ...normalizeMountHandleMap({
          opfsGuestPath,
          opfsHandle,
          mountHandles: runOptions.mountHandles,
        }),
      };

      const syncAccessMode = runOptions.syncAccessMode ?? options.syncAccessMode;
      const {
        fds,
        closeHandles,
        stdoutChunks,
        stderrChunks,
      } = await buildBrowserWasiFds({
        wasiShim,
        stdin: runOptions.stdin,
        runtimeMounts,
        mountHandles,
        tmpGuestPath,
        syncAccessMode,
      });

      try {
        const wasi = new wasiShim.WASI(
          [runOptions.program ?? options.program ?? options.argv0 ?? 'rom-weaver', ...normalizedArgs],
          envList,
          fds,
          { debug: Boolean(runOptions.debugWasi ?? options.debugWasi ?? false) },
        );

        const instance = await WebAssembly.instantiate(module, {
          wasi_snapshot_preview1: wasi.wasiImport,
        });

        const exitCode = wasi.start(instance);
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
        closeSyncAccessHandles(closeHandles);
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
    mode: 'browser',
    fs: zenfs.fs,
    opfsHandle,
    opfsGuestPath,
    runtimeMounts,
    run: (args, runOptions) => runner.run(args, runOptions),
    runJson: (args, runOptions) => runner.runJson(args, runOptions),
  };
}

export async function syncZenFsToWasmerDirectory() {
  throw new Error(
    'syncZenFsToWasmerDirectory is no longer used. '
      + 'Browser runtime now mounts OPFS directly for zero-copy execution.',
  );
}

export async function syncWasmerDirectoryToZenFs() {
  throw new Error(
    'syncWasmerDirectoryToZenFs is no longer used. '
      + 'Browser runtime now mounts OPFS directly for zero-copy execution.',
  );
}

async function buildBrowserWasiFds({
  wasiShim,
  stdin,
  runtimeMounts,
  mountHandles,
  tmpGuestPath,
  syncAccessMode,
}) {
  const closeHandles = [];
  const stdinBytes = normalizeStdin(stdin);
  const stdoutCollector = createOutputCollector(wasiShim.ConsoleStdout);
  const stderrCollector = createOutputCollector(wasiShim.ConsoleStdout);

  const fds = [
    new wasiShim.OpenFile(new wasiShim.File(stdinBytes)),
    stdoutCollector.fd,
    stderrCollector.fd,
  ];

  for (const mountPath of runtimeMounts) {
    if (mountPath === tmpGuestPath && !(mountPath in mountHandles)) {
      fds.push(new wasiShim.PreopenDirectory(mountPath, new Map()));
      continue;
    }

    const handle = mountHandles[mountPath];
    if (!handle) {
      throw new Error(
        `No directory handle provided for runtime mount ${mountPath}. `
          + 'Provide options.mountHandles or runOptions.mountHandles.',
      );
    }

    const preopenContents = await buildOpfsInodeMap({
      wasiShim,
      directoryHandle: handle,
      closeHandles,
      syncAccessMode,
    });

    fds.push(createStrictOpfsPreopenDirectory(wasiShim, mountPath, preopenContents));
  }

  return {
    fds,
    closeHandles,
    stdoutChunks: stdoutCollector.chunks,
    stderrChunks: stderrCollector.chunks,
  };
}

function createStrictOpfsPreopenDirectory(wasiShim, mountPath, contents) {
  const rofsErrno = wasiShim.wasi.ERRNO_ROFS;
  const oCreat = wasiShim.wasi.OFLAGS_CREAT;

  class StrictOpfsPreopenDirectory extends wasiShim.PreopenDirectory {
    path_open(
      dirflags,
      pathStr,
      oflags,
      fsRightsBase,
      fsRightsInheriting,
      fdFlags,
    ) {
      if ((oflags & oCreat) === oCreat) {
        return { ret: rofsErrno, fd_obj: null };
      }
      return super.path_open(
        dirflags,
        pathStr,
        oflags,
        fsRightsBase,
        fsRightsInheriting,
        fdFlags,
      );
    }

    path_create_directory(_path) {
      return rofsErrno;
    }

    path_link(_pathStr, _inode, _allowDir) {
      return rofsErrno;
    }

    path_unlink(_pathStr) {
      return { ret: rofsErrno, inode_obj: null };
    }

    path_unlink_file(_pathStr) {
      return rofsErrno;
    }

    path_remove_directory(_pathStr) {
      return rofsErrno;
    }
  }

  return new StrictOpfsPreopenDirectory(mountPath, contents);
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

async function buildOpfsInodeMap({
  wasiShim,
  directoryHandle,
  closeHandles,
  syncAccessMode,
}) {
  const entries = new Map();

  for await (const [entryName, entryHandle] of directoryHandle.entries()) {
    if (entryHandle.kind === 'directory') {
      const nested = await buildOpfsInodeMap({
        wasiShim,
        directoryHandle: entryHandle,
        closeHandles,
        syncAccessMode,
      });
      entries.set(entryName, new wasiShim.Directory(nested));
      continue;
    }

    if (entryHandle.kind !== 'file') {
      continue;
    }

    const syncHandle = await openSyncAccessHandle(entryHandle, syncAccessMode);
    closeHandles.push(syncHandle);
    entries.set(
      entryName,
      new wasiShim.SyncOPFSFile(syncHandle, {
        readonly: syncAccessMode === 'read-only',
      }),
    );
  }

  return entries;
}

async function openSyncAccessHandle(fileHandle, mode) {
  if (mode === undefined) {
    return fileHandle.createSyncAccessHandle();
  }

  return fileHandle.createSyncAccessHandle({ mode });
}

function closeSyncAccessHandles(handles) {
  for (const handle of handles) {
    try {
      handle.close();
    } catch {
      // ignore best-effort close failures
    }
  }
}

function normalizeMountHandleMap({ opfsGuestPath, opfsHandle, mountHandles }) {
  const normalized = {
    [opfsGuestPath]: opfsHandle,
  };

  if (!mountHandles) {
    return normalized;
  }

  for (const [guestPath, handle] of Object.entries(mountHandles)) {
    const normalizedGuestPath = normalizeGuestPath(guestPath);
    assertDirectoryHandle(handle, `mountHandles[${guestPath}]`);
    normalized[normalizedGuestPath] = handle;
  }

  return normalized;
}

function assertDedicatedWorkerRuntime() {
  if (typeof navigator === 'undefined' || typeof self === 'undefined') {
    throw new Error('createRomWeaverZenFsBrowser can only run in a browser runtime');
  }

  if (typeof window !== 'undefined') {
    throw new Error(
      'createRomWeaverZenFsBrowser must run in a Dedicated Worker. '
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

function normalizeGuestMountMap({
  defaultTmpHostPath,
  defaultCwdHostPath,
  resolveHostPath,
  mounts = {},
  includeHostRoot = false,
  mountCwd = true,
  cwdGuestPath = '/work',
  cwdHostPath = defaultCwdHostPath,
  mountTmp = true,
  tmpGuestPath = '/tmp',
  tmpHostPath = defaultTmpHostPath,
}) {
  const result = {};

  if (includeHostRoot) {
    result['/'] = '/';
  }

  if (mountCwd) {
    result[normalizeGuestPath(cwdGuestPath)] = normalizeHostPath(cwdHostPath, resolveHostPath);
  }

  if (mountTmp) {
    result[normalizeGuestPath(tmpGuestPath)] = normalizeHostPath(tmpHostPath, resolveHostPath);
  }

  for (const [guestPath, hostPath] of Object.entries(mounts)) {
    result[normalizeGuestPath(guestPath)] = normalizeHostPath(hostPath, resolveHostPath);
  }

  return result;
}

async function resolveBrowserModule(module, wasmUrl) {
  if (module instanceof WebAssembly.Module) {
    return module;
  }

  const url = wasmUrl ?? './rom-weaver-cli.wasm';
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch wasm module from ${url}: ${response.status} ${response.statusText}`);
  }

  const bytes = await response.arrayBuffer();
  return WebAssembly.compile(bytes);
}

function normalizeGuestPath(pathLike) {
  if (typeof pathLike !== 'string' || pathLike.trim().length === 0) {
    throw new TypeError('guest path must be a non-empty string');
  }

  let normalized = pathLike.trim();
  if (!normalized.startsWith('/')) {
    normalized = `/${normalized}`;
  }
  if (normalized.length > 1) {
    normalized = normalized.replace(/\/+$/, '');
  }

  return normalized;
}

function normalizeHostPath(pathLike, resolveHostPath) {
  if (typeof pathLike !== 'string' || pathLike.trim().length === 0) {
    throw new TypeError('host path must be a non-empty string');
  }
  return resolveHostPath(pathLike);
}

function normalizeRuntimeMounts(mounts) {
  if (!Array.isArray(mounts) || mounts.length === 0) {
    throw new TypeError('runtimeMounts must be a non-empty array of guest paths');
  }
  return mounts.map((mountPath) => normalizeGuestPath(String(mountPath)));
}

function normalizeArgs(args) {
  if (!Array.isArray(args)) {
    throw new TypeError('args must be an array of strings');
  }
  return args.map((value) => String(value));
}

function normalizeStdin(stdin) {
  if (stdin === undefined || stdin === null) {
    return new Uint8Array();
  }
  if (typeof stdin === 'string') {
    return new TextEncoder().encode(stdin);
  }
  if (stdin instanceof Uint8Array) {
    return stdin;
  }
  if (stdin instanceof ArrayBuffer) {
    return new Uint8Array(stdin);
  }
  throw new TypeError('stdin must be a string, Uint8Array, ArrayBuffer, or undefined');
}

function copyUint8Array(data) {
  const copied = new Uint8Array(data.byteLength);
  copied.set(data);
  return copied;
}
