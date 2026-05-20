import {
  createWasmEnvImports,
  normalizeGuestPath as normalizeSharedGuestPath,
  parseJsonLines,
  parseTraceJsonLines,
} from './rom-weaver-runtime-utils.mjs';
import * as wasiShim from '@bjorn3/browser_wasi_shim';
import * as zenfs from '@zenfs/core';
import * as zenDom from '@zenfs/dom';

export async function createRomWeaverZenFsNode(options = {}) {
  void options;
  throw new Error('createRomWeaverZenFsNode is unavailable in this browser-focused runtime.');
}

export async function createRomWeaverZenFsBrowser(options = {}) {
  assertDedicatedWorkerRuntime();

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
        opfsMounts,
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
          env: createWasmEnvImports(),
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
        await flushMutableOpfsEntries(opfsMounts);
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
  const opfsMounts = [];
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

    const preopen = new wasiShim.PreopenDirectory(mountPath, preopenContents);
    fds.push(preopen);
    opfsMounts.push({
      directoryHandle: handle,
      preopen,
    });
  }

  return {
    fds,
    opfsMounts,
    closeHandles,
    stdoutChunks: stdoutCollector.chunks,
    stderrChunks: stderrCollector.chunks,
  };
}

async function flushMutableOpfsEntries(opfsMounts) {
  for (const mount of opfsMounts || []) {
    const preopenDirectory = mount?.preopen?.dir;
    const directoryHandle = mount?.directoryHandle;
    const contents = preopenDirectory?.contents;
    if (!directoryHandle || !(contents instanceof Map)) {
      continue;
    }
    await flushDirectoryEntries(directoryHandle, contents);
  }
}

async function flushDirectoryEntries(directoryHandle, contents) {
  for (const [entryName, entryValue] of contents.entries()) {
    if (!entryName) {
      continue;
    }
    if (entryValue && typeof entryValue === 'object' && entryValue.contents instanceof Map) {
      const nestedHandle = await directoryHandle.getDirectoryHandle(entryName, { create: true });
      await flushDirectoryEntries(nestedHandle, entryValue.contents);
      continue;
    }
    const bytes = entryValue?.data instanceof Uint8Array ? entryValue.data : null;
    if (!bytes) {
      continue;
    }
    const fileHandle = await directoryHandle.getFileHandle(entryName, { create: true });
    const writable = await fileHandle.createWritable({ keepExistingData: false });
    try {
      if (bytes.byteLength) {
        await writable.write(bytes);
      }
    } finally {
      await writable.close();
    }
  }
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

  const resolvedUrl = wasmUrl
    ? new URL(String(wasmUrl), import.meta.url)
    : new URL('../rom-weaver-cli.wasm', import.meta.url);
  const response = await fetch(resolvedUrl);
  if (!response.ok) {
    throw new Error(
      `failed to fetch wasm module from ${resolvedUrl}: ${response.status} ${response.statusText}`,
    );
  }

  const bytes = await response.arrayBuffer();
  return WebAssembly.compile(bytes);
}

function normalizeGuestPath(pathLike) {
  return normalizeSharedGuestPath(pathLike, { label: 'guest path' });
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
