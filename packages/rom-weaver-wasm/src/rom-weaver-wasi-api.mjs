import { mkdtempSync, openSync, closeSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { brotliDecompressSync } from 'node:zlib';
import { WASI } from 'node:wasi';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const WASM_PATH_CANDIDATES = [
  join(MODULE_DIR, 'rom-weaver-cli.wasm'),
  join(MODULE_DIR, '../rom-weaver-cli.wasm'),
  join(MODULE_DIR, '../../dist/wasm/rom-weaver-cli.wasm'),
  join(MODULE_DIR, '../../../dist/wasm/rom-weaver-cli.wasm'),
];

export const DEFAULT_WASM_PATH = WASM_PATH_CANDIDATES.find((candidate) => existsSync(candidate))
  ?? WASM_PATH_CANDIDATES[0];

export const DEFAULT_PREOPENS = {
  '/': '/',
  '/tmp': tmpdir(),
};

const SHARED_MEMORY_INITIAL_PAGES = 24;
const SHARED_MEMORY_MAX_PAGES = 16384;
const THREAD_SPAWN_UNAVAILABLE = 6;
const WASI_THREADS_WAIT_THREAD_START_MS = 5000;
const WASI_THREAD_WORKER_PATH_CANDIDATES = [
  join(MODULE_DIR, 'rom-weaver-wasi-thread-worker.mjs'),
  join(MODULE_DIR, '../rom-weaver-wasi-thread-worker.mjs'),
  join(MODULE_DIR, '../../dist/wasm/rom-weaver-wasi-thread-worker.mjs'),
  join(MODULE_DIR, '../../../dist/wasm/rom-weaver-wasi-thread-worker.mjs'),
];
const DEFAULT_WASI_THREAD_WORKER_PATH = WASI_THREAD_WORKER_PATH_CANDIDATES.find(
  (candidate) => existsSync(candidate),
) ?? WASI_THREAD_WORKER_PATH_CANDIDATES[0];

export function createWasmEnvImports(memory) {
  const imports = {
    __cxa_allocate_exception() {
      return 0;
    },
    __cxa_throw(pointer, typeInfo) {
      throw new Error(
        `rom-weaver wasm raised a C++ exception (pointer=${pointer}, type=${typeInfo})`,
      );
    },
  };

  if (memory !== undefined && memory !== null) {
    imports.memory = memory;
  }

  return imports;
}

export class RomWeaverWasiRunner {
  constructor(options = {}) {
    const useDefaultPreopens = options.useDefaultPreopens ?? true;
    this.wasmPath = options.wasmPath ?? DEFAULT_WASM_PATH;
    this.argv0 = options.argv0 ?? 'rom-weaver';
    this.env = { ...(options.env ?? {}) };
    this.preopens = {
      ...(useDefaultPreopens ? DEFAULT_PREOPENS : {}),
      ...(options.preopens ?? {}),
    };
    this.threadWorkerPath = options.threadWorkerPath ?? DEFAULT_WASI_THREAD_WORKER_PATH;
    this._compiledModulePromise = null;
  }

  async run(args = [], options = {}) {
    const normalizedArgs = normalizeArgs(args);
    const module = await this._loadModule();
    const preopens = {
      ...this.preopens,
      ...(options.preopens ?? {}),
    };
    const env = {
      ...this.env,
      ...(options.env ?? {}),
    };
    const stdinBuffer = normalizeStdin(options.stdin);
    const argv0 = options.argv0 ?? this.argv0;

    const tempDir = mkdtempSync(join(tmpdir(), 'rom-weaver-wasi-run-'));
    const stdinPath = join(tempDir, 'stdin.bin');
    const stdoutPath = join(tempDir, 'stdout.log');
    const stderrPath = join(tempDir, 'stderr.log');

    writeFileSync(stdinPath, stdinBuffer);
    writeFileSync(stdoutPath, '');
    writeFileSync(stderrPath, '');

    const stdinFd = openSync(stdinPath, 'r');
    const stdoutFd = openSync(stdoutPath, 'w+');
    const stderrFd = openSync(stderrPath, 'w+');

    let exitCode = 1;
    let trappedError = null;
    let threadedRuntime = null;

    try {
      const moduleInfo = readWasmModuleInfo(module);
      const sharedMemory = moduleInfo.requiresImportedSharedMemory
        ? createThreadedSharedMemory()
        : undefined;
      const wasi = new WASI({
        version: 'preview1',
        args: [argv0, ...normalizedArgs],
        env,
        preopens,
        stdin: stdinFd,
        stdout: stdoutFd,
        stderr: stderrFd,
        returnOnExit: true,
      });

      threadedRuntime = await createThreadedWasiRuntime({
        moduleInfo,
        module,
        wasi,
        sharedMemory,
        threadWorkerPath: options.threadWorkerPath ?? this.threadWorkerPath,
      });
      const imports = {
        wasi_snapshot_preview1: wasi.wasiImport,
        env: createWasmEnvImports(sharedMemory),
        ...threadedRuntime.imports,
      };

      const instance = await WebAssembly.instantiate(module, imports);

      threadedRuntime.setup(instance, module);
      exitCode = wasi.start(instance);
    } catch (error) {
      trappedError = error;
    } finally {
      if (trappedError !== null) {
        try {
          threadedRuntime?.dispose();
        } catch {
          // Ignore cleanup errors during finalization.
        }
      }
      closeSync(stdinFd);
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }

    const stdout = readFileSync(stdoutPath, 'utf8');
    const stderr = readFileSync(stderrPath, 'utf8');

    rmSync(tempDir, { recursive: true, force: true });

    const result = {
      args: normalizedArgs,
      exitCode,
      stdout,
      stderr,
      ok: trappedError === null && exitCode === 0,
    };

    if (trappedError !== null) {
      result.error = trappedError;
    }

    return result;
  }

  async runJson(args = [], options = {}) {
    const result = await this.run(['--json', ...normalizeArgs(args)], options);
    const parsed = parseJsonLines(result.stdout, {
      onEvent: options.onEvent,
      onNonJsonLine: options.onNonJsonLine,
    });
    const parsedTrace = parseTraceJsonLines(result.stderr, {
      onTraceEvent: options.onTraceEvent,
      onTraceNonJsonLine: options.onTraceNonJsonLine,
    });

    return {
      ...result,
      events: parsed.events,
      nonJsonLines: parsed.nonJsonLines,
      traceEvents: parsedTrace.traceEvents,
      traceNonJsonLines: parsedTrace.traceNonJsonLines,
    };
  }

  async _loadModule() {
    if (this._compiledModulePromise === null) {
      const wasmBytes = loadWasmBytes(this.wasmPath);
      this._compiledModulePromise = WebAssembly.compile(wasmBytes);
    }

    return this._compiledModulePromise;
  }

  async dispose() {}
}

export function createRomWeaverWasiRunner(options = {}) {
  return new RomWeaverWasiRunner(options);
}

export function createNodeFsRunner(options = {}) {
  const preopens = buildNodeFsPreopens(options);
  return createRomWeaverWasiRunner({
    ...options,
    useDefaultPreopens: false,
    preopens: {
      ...preopens,
      ...(options.preopens ?? {}),
    },
  });
}

export function buildNodeFsPreopens(options = {}) {
  const {
    includeHostRoot = false,
    mountCwd = true,
    cwdGuestPath = '/work',
    mountTmp = true,
    tmpGuestPath = '/tmp',
    tmpHostPath = tmpdir(),
    mounts = {},
  } = options;
  const preopens = {};

  if (includeHostRoot) {
    preopens['/'] = '/';
  }
  if (mountCwd) {
    preopens[normalizeGuestMountPath(cwdGuestPath)] = resolve(process.cwd());
  }
  if (mountTmp) {
    preopens[normalizeGuestMountPath(tmpGuestPath)] = resolveHostMountPath(tmpHostPath, 'tmpHostPath');
  }

  for (const [guestPath, hostPath] of Object.entries(mounts)) {
    preopens[normalizeGuestMountPath(guestPath)] = resolveHostMountPath(
      hostPath,
      `mounts[${guestPath}]`,
    );
  }

  return preopens;
}

export function parseJsonLines(text, options = {}) {
  const events = [];
  const nonJsonLines = [];
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
  const onNonJsonLine = typeof options.onNonJsonLine === 'function'
    ? options.onNonJsonLine
    : null;

  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }

    try {
      const event = JSON.parse(line);
      events.push(event);
      onEvent?.(event);
    } catch {
      nonJsonLines.push(line);
      onNonJsonLine?.(line);
    }
  }

  return { events, nonJsonLines };
}

export function parseTraceJsonLines(text, options = {}) {
  const traceEvents = [];
  const traceNonJsonLines = [];
  const onTraceEvent = typeof options.onTraceEvent === 'function' ? options.onTraceEvent : null;
  const onTraceNonJsonLine = typeof options.onTraceNonJsonLine === 'function'
    ? options.onTraceNonJsonLine
    : null;

  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) {
      continue;
    }

    try {
      const event = JSON.parse(line);
      traceEvents.push(event);
      onTraceEvent?.(event);
    } catch {
      traceNonJsonLines.push(line);
      onTraceNonJsonLine?.(line);
    }
  }

  return { traceEvents, traceNonJsonLines };
}

function readWasmModuleInfo(module) {
  const imports = WebAssembly.Module.imports(module);
  let requiresWasiThreadSpawn = false;
  let requiresImportedSharedMemory = false;

  for (const input of imports) {
    if (input.module === 'wasi' && input.name === 'thread-spawn') {
      requiresWasiThreadSpawn = true;
    }
    if (input.module === 'env' && input.name === 'memory' && input.kind === 'memory') {
      requiresImportedSharedMemory = true;
    }
  }

  return {
    requiresWasiThreadSpawn,
    requiresImportedSharedMemory,
  };
}

function createThreadedSharedMemory() {
  return new WebAssembly.Memory({
    initial: SHARED_MEMORY_INITIAL_PAGES,
    maximum: SHARED_MEMORY_MAX_PAGES,
    shared: true,
  });
}

function createWasiThreadImports(memory) {
  return {
    'thread-spawn': (startArg, errorOrTid) => threadSpawnUnavailable(memory, startArg, errorOrTid),
  };
}

function threadSpawnUnavailable(memory, _startArg, errorOrTid) {
  if (typeof errorOrTid === 'number' && memory instanceof WebAssembly.Memory) {
    try {
      const struct = new Int32Array(memory.buffer, errorOrTid, 2);
      Atomics.store(struct, 0, 1);
      Atomics.store(struct, 1, THREAD_SPAWN_UNAVAILABLE);
      Atomics.notify(struct, 1, 1);
      return 1;
    } catch {
      return 1;
    }
  }

  return -THREAD_SPAWN_UNAVAILABLE;
}

async function createThreadedWasiRuntime({
  moduleInfo,
  module,
  wasi,
  sharedMemory,
  threadWorkerPath,
}) {
  if (!moduleInfo.requiresWasiThreadSpawn) {
    return {
      imports: {},
      setup() {},
      dispose() {},
    };
  }

  if (!(sharedMemory instanceof WebAssembly.Memory)) {
    return createUnavailableThreadRuntime(sharedMemory);
  }

  const debugThreads = process.env.ROM_WEAVER_WASM_DEBUG_THREADS === '1';

  try {
    const [{ WASIThreads }, { Worker }] = await Promise.all([
      import('@emnapi/wasi-threads'),
      import('node:worker_threads'),
    ]);
    const workerUrl = pathToFileURL(resolveThreadWorkerPath(threadWorkerPath));
    const wasiThreads = new WASIThreads({
      wasi,
      waitThreadStart: WASI_THREADS_WAIT_THREAD_START_MS,
      printErr: debugThreads
        ? (message) => {
          process.stderr.write(`[rom-weaver-wasm pthread] ${message}\n`);
        }
        : undefined,
      onCreateWorker() {
        const worker = new Worker(workerUrl, {
          execArgv: ['--experimental-wasi-unstable-preview1'],
          name: 'rom-weaver-wasi-thread',
          type: 'module',
        });
        if (debugThreads) {
          worker.on('error', (error) => {
            process.stderr.write(
              `[rom-weaver-wasm pthread] worker error: ${String(error)}\n`,
            );
          });
          worker.on('exit', (code) => {
            process.stderr.write(`[rom-weaver-wasm pthread] worker exit: ${code}\n`);
          });
        }
        return worker;
      },
    });

    return {
      imports: wasiThreads.getImportObject(),
      setup(instance, compiledModule) {
        wasiThreads.setup(instance, compiledModule, sharedMemory);
      },
      dispose() {
        wasiThreads.terminateAllThreads();
      },
    };
  } catch (error) {
    if (process.env.ROM_WEAVER_WASM_DEBUG_THREADS === '1') {
      process.stderr.write(
        `[rom-weaver-wasm] pthread runtime unavailable; falling back to stub: ${String(error)}\n`,
      );
    }
    return createUnavailableThreadRuntime(sharedMemory);
  }
}

function createUnavailableThreadRuntime(sharedMemory) {
  return {
    imports: {
      wasi: createWasiThreadImports(sharedMemory),
    },
    setup() {},
    dispose() {},
  };
}

function resolveThreadWorkerPath(overridePath) {
  if (overridePath instanceof URL) {
    return fileURLToPath(overridePath);
  }
  if (typeof overridePath === 'string' && overridePath.trim().length > 0) {
    return resolve(overridePath);
  }
  return DEFAULT_WASI_THREAD_WORKER_PATH;
}

function loadWasmBytes(inputPath) {
  const resolvedPath = resolve(inputPath);

  if (existsSync(resolvedPath)) {
    const bytes = readFileSync(resolvedPath);
    if (resolvedPath.endsWith('.br')) {
      return brotliDecompressSync(bytes);
    }

    return bytes;
  }

  const brotliPath = `${resolvedPath}.br`;
  if (existsSync(brotliPath)) {
    return brotliDecompressSync(readFileSync(brotliPath));
  }

  throw new Error(
    `WASM artifact not found. Looked for ${resolvedPath} and ${brotliPath}`,
  );
}

function normalizeStdin(stdin) {
  if (stdin === undefined || stdin === null) {
    return Buffer.alloc(0);
  }

  if (typeof stdin === 'string') {
    return Buffer.from(stdin);
  }

  if (stdin instanceof Uint8Array) {
    return Buffer.from(stdin);
  }

  if (stdin instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(stdin));
  }

  throw new TypeError('stdin must be a string, Uint8Array, ArrayBuffer, or undefined');
}

function normalizeArgs(args) {
  if (!Array.isArray(args)) {
    throw new TypeError('args must be an array of strings');
  }

  return args.map((value) => String(value));
}

function normalizeGuestMountPath(pathLike) {
  if (typeof pathLike !== 'string' || pathLike.trim().length === 0) {
    throw new TypeError('guest mount path must be a non-empty string');
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

function resolveHostMountPath(pathLike, label) {
  if (typeof pathLike !== 'string' || pathLike.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }

  return resolve(pathLike);
}
