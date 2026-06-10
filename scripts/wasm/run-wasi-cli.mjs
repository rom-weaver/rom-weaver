#!/usr/bin/env node

import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { WASI } from 'node:wasi';
import { createWasmEnvImports } from './rom-weaver-runtime-utils.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_WASM_MODULE = resolve(REPO_ROOT, 'packages/rom-weaver-wasm/rom-weaver-app.wasm');
const DEFAULT_SHARED_MEMORY_INITIAL_PAGES = 256;
// 32768 pages * 64 KiB = 2 GiB. Must be <= the threaded wasm's imported memory maximum
// (--max-memory in .cargo/config.toml, also 2 GiB). Browser LZMA2 workers can need more than
// 1 GiB when several raw encoders run concurrently.
const DEFAULT_SHARED_MEMORY_MAX_PAGES = 32768;
const MAX_WASI_THREAD_ID = 0x1fffffff;
const THREAD_ID_COUNTER_INDEX = 0;
const THREAD_ID_COUNTER_INITIAL = 43;
const THREAD_WORKER_DATA_KEY = '__rom_weaver_wasi_thread';
const THREAD_WORKER_MODE_START = 'start';
const THREAD_WORKER_MODE_POOL = 'pool';
const THREAD_WORKER_POOL_READY = 'ready';
const THREAD_WORKER_POOL_RUN = 'run-thread';
const THREAD_WORKER_POOL_DONE = 'thread-done';
const THREAD_WORKER_POOL_FAIL = 'thread-failed';
const THREAD_WORKER_POOL_SHUTDOWN = 'shutdown';
const THREAD_SLOT_STATE_INDEX = 0;
const THREAD_SLOT_TID_INDEX = 1;
const THREAD_SLOT_START_ARG_INDEX = 2;
const THREAD_SLOT_ERROR_INDEX = 3;
const THREAD_SLOT_LENGTH = 4;
const THREAD_SLOT_STATE_IDLE = 0;
const THREAD_SLOT_STATE_REQUESTED = 1;
const THREAD_SLOT_STATE_STARTING = 2;
const THREAD_SLOT_STATE_RUNNING = 3;
const THREAD_SLOT_STATE_DONE = 4;
const THREAD_SLOT_STATE_FAILED = 5;
const THREAD_SLOT_STATE_SHUTDOWN = 6;
const WASI_ERRNO_AGAIN = 6;
const WASI_ERRNO_ENOSYS = 52;
const THREAD_DEBUG_ENV = 'ROM_WEAVER_WASI_THREAD_DEBUG';
const THREAD_POOL_SIZE_ENV = 'ROM_WEAVER_WASM_THREAD_POOL_SIZE';
const THREAD_PREWARM_ENV = 'ROM_WEAVER_WASM_PREWARM_THREADS';
const THREAD_DEBUG_LOG_FILE_ENV = 'ROM_WEAVER_WASI_THREAD_DEBUG_LOG_FILE';
const THREAD_START_ACK_TIMEOUT_MS = 30000;
const DEFAULT_THREAD_POOL_SIZE = 4;
const MAX_THREAD_POOL_SIZE = 256;

function parseArgs(argv) {
  let wasmModule = DEFAULT_WASM_MODULE;
  let commandArgs = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') {
      commandArgs = argv.slice(index + 1);
      break;
    }
    if (arg === '--wasm-module') {
      const next = argv[index + 1];
      if (!next) {
        throw new Error('--wasm-module requires a path value');
      }
      wasmModule = resolve(REPO_ROOT, next);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (commandArgs.length === 0) {
    throw new Error('missing command args; pass rom-weaver command args after `--`');
  }

  return { wasmModule, request: commandArgsToRunRequest(commandArgs) };
}

async function main() {
  const { wasmModule, request } = parseArgs(process.argv.slice(2));
  const requestStdin = createRequestStdin(request);
  const wasmBytes = readFileSync(wasmModule);
  const compiledModule = await WebAssembly.compile(wasmBytes);
  const moduleImports = WebAssembly.Module.imports(compiledModule);
  const threadIdState = createThreadIdState();
  const threadedMemory = needsEnvMemoryImport(moduleImports)
    ? createSharedThreadMemory()
    : undefined;
  const wasiArgs = ['rom-weaver-app'];
  try {
    const wasi = createWasiRuntime(wasiArgs, requestStdin.fd);
    const requestedThreadCount = readRequestThreadCount(request);
    const threadSpawner = createThreadSpawner({
      moduleImports,
      wasmModule: compiledModule,
      wasmMemory: threadedMemory,
      wasiArgs,
      threadIdState,
      spawnPoolSize: requestedThreadCount,
      allowPrewarmedPool: shouldPrewarmThreadPool(),
    });
    await threadSpawner.ready;
    const importObject = createImportObject({
      moduleImports,
      wasi,
      memory: threadedMemory,
      threadSpawner,
    });
    const instance = await WebAssembly.instantiate(compiledModule, importObject);
    const exitCode = wasi.start(instance);
    await threadSpawner.waitForWorkers();
    process.exitCode = Number.isInteger(exitCode) ? exitCode : 1;
  } finally {
    requestStdin.cleanup();
  }
}

function isThreadDebugEnabled() {
  const raw = process.env[THREAD_DEBUG_ENV];
  if (raw == null) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized.length > 0
    && normalized !== '0'
    && normalized !== 'false'
    && normalized !== 'off';
}

function threadDebugLog(message) {
  if (!isThreadDebugEnabled()) return;
  const role = isMainThread ? 'main' : 'worker';
  const pid = process.pid;
  const line = `[wasi-thread][${role}][pid=${pid}] ${message}`;
  const logFile = process.env[THREAD_DEBUG_LOG_FILE_ENV];
  if (typeof logFile === 'string' && logFile.trim().length > 0) {
    try {
      appendFileSync(logFile, `${line}\n`);
      return;
    } catch {
      // fall through to stderr
    }
  }
  console.error(line);
}

function createRequestStdin(request) {
  const tempDir = mkdtempSync(resolve(tmpdir(), 'rom-weaver-wasi-'));
  const requestPath = resolve(tempDir, 'request.json');
  writeFileSync(requestPath, `${JSON.stringify(normalizeRunRequest(request))}\n`);
  const fd = openSync(requestPath, 'r');
  let cleanedUp = false;
  return {
    fd,
    cleanup() {
      if (cleanedUp) return;
      cleanedUp = true;
      try {
        closeSync(fd);
      } catch {
        // best-effort cleanup
      }
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

function normalizeRunRequest(request) {
  if (request && typeof request === 'object' && request.command) {
    return {
      command: request.command,
      output: request.output ?? {},
    };
  }
  return {
    command: request,
    output: {},
  };
}

function readRequestThreadCount(request) {
  const normalized = normalizeRunRequest(request);
  const threads = normalized.command?.type === 'patch'
    ? normalized.command?.args?.args?.threads
    : normalized.command?.args?.threads;
  if (Number.isInteger(threads) && threads > 0) {
    return threads;
  }
  return DEFAULT_THREAD_POOL_SIZE;
}

function commandArgsToRunRequest(args) {
  const { command, index: commandIndex, subcommand } = locateCommand(args);
  const parsed = parseCommandTokens(args, commandIndex);
  const output = {};
  if (parsed.flags.has('json')) output.json = true;
  if (parsed.flags.has('trace')) output.trace = true;
  if (parsed.flags.has('progress')) output.progress = true;
  if (parsed.flags.has('no-progress')) output.progress = false;

  const commandRequest = createCommandRequest(command, subcommand);
  const commandArgs = command === 'patch' ? commandRequest.args.args : commandRequest.args;
  switch (command === 'patch' ? `patch-${subcommand}` : command) {
    case 'compress':
      Object.assign(commandArgs, {
        input: parsed.positionals,
        output: requireOptionValue(parsed, 'output'),
        ...(readOptionalValue(parsed, 'format') ? { format: readOptionalValue(parsed, 'format') } : {}),
        ...(readOptionValues(parsed, 'codec').length ? { codec: readOptionValues(parsed, 'codec') } : {}),
        ...(readOptionalValue(parsed, 'level') ? { level: readOptionalValue(parsed, 'level') } : {}),
      });
      break;
    case 'extract':
      Object.assign(commandArgs, {
        source: requirePositional(parsed, 0, 'extract source'),
        out_dir: requireOptionValue(parsed, 'out-dir'),
        ...(readOptionValues(parsed, 'select').length ? { select: readOptionValues(parsed, 'select') } : {}),
        ...(parsed.flags.has('rom-filter') ? { rom_filter: true } : {}),
        ...(parsed.flags.has('patch-filter') ? { patch_filter: true } : {}),
        ...(readOptionValues(parsed, 'checksum').length ? { checksum: readOptionValues(parsed, 'checksum') } : {}),
        ...(parsed.flags.has('split-bin') ? { split_bin: true } : {}),
        ...(parsed.flags.has('no-ignore') ? { no_ignore: true } : {}),
        ...(parsed.flags.has('no-nested-extract') ? { no_nested_extract: true } : {}),
        ...(parsed.flags.has('no-overwrite') ? { no_overwrite: true } : {}),
      });
      break;
    case 'checksum':
      Object.assign(commandArgs, {
        source: requirePositional(parsed, 0, 'checksum source'),
        algo: readOptionValues(parsed, 'algo'),
        ...(readOptionValues(parsed, 'select').length ? { select: readOptionValues(parsed, 'select') } : {}),
        ...(parsed.flags.has('rom-filter') ? { rom_filter: true } : {}),
        ...(parsed.flags.has('patch-filter') ? { patch_filter: true } : {}),
        ...(parsed.flags.has('no-extract') ? { no_extract: true } : {}),
        ...(parsed.flags.has('no-ignore') ? { no_ignore: true } : {}),
        ...(parsed.flags.has('strip-header') ? { strip_header: true } : {}),
        ...(parsed.flags.has('no-trim-fix') ? { no_trim_fix: true } : {}),
        ...(readOptionalNumber(parsed, 'start') !== null ? { start: readOptionalNumber(parsed, 'start') } : {}),
        ...(readOptionalNumber(parsed, 'length') !== null ? { length: readOptionalNumber(parsed, 'length') } : {}),
      });
      break;
    case 'patch-create':
      Object.assign(commandArgs, {
        original: requireOptionValue(parsed, 'original'),
        modified: requireOptionValue(parsed, 'modified'),
        format: requireOptionValue(parsed, 'format'),
        output: requireOptionValue(parsed, 'output'),
        ...(parsed.flags.has('ignore-checksum-validation') ? { ignore_checksum_validation: true } : {}),
        ...(readOptionalValue(parsed, 'xdelta-secondary') ? { xdelta_secondary: readOptionalValue(parsed, 'xdelta-secondary') } : {}),
      });
      break;
    case 'patch-apply':
      Object.assign(commandArgs, {
        input: requireOptionValue(parsed, 'input'),
        patches: readOptionValues(parsed, 'patch'),
        output: requireOptionValue(parsed, 'output'),
        ...(readOptionValues(parsed, 'select').length ? { select: readOptionValues(parsed, 'select') } : {}),
        ...(parsed.flags.has('rom-filter') ? { rom_filter: true } : {}),
        ...(parsed.flags.has('patch-filter') ? { patch_filter: true } : {}),
        ...(parsed.flags.has('no-extract') ? { no_extract: true } : {}),
        ...(parsed.flags.has('no-ignore') ? { no_ignore: true } : {}),
        ...(parsed.flags.has('no-compress') ? { no_compress: true } : {}),
        ...(readOptionalValue(parsed, 'compress-format') ? { compress_format: readOptionalValue(parsed, 'compress-format') } : {}),
        ...(readOptionValues(parsed, 'compress-codec').length ? { compress_codec: readOptionValues(parsed, 'compress-codec') } : {}),
        ...(readOptionalValue(parsed, 'compress-level') ? { compress_level: readOptionalValue(parsed, 'compress-level') } : {}),
        ...(readOptionValues(parsed, 'checksum-cache').length ? { checksum_cache: readOptionValues(parsed, 'checksum-cache') } : {}),
        ...(readOptionValues(parsed, 'validate-with-checksum').length
          ? { validate_with_checksums: readOptionValues(parsed, 'validate-with-checksum') }
          : {}),
        ...(parsed.flags.has('strip-header') ? { strip_header: true } : {}),
        ...(parsed.flags.has('add-header') ? { add_header: true } : {}),
        ...(parsed.flags.has('repair-checksum') ? { repair_checksum: true } : {}),
        ...(parsed.flags.has('ignore-checksum-validation') ? { ignore_checksum_validation: true } : {}),
      });
      break;
    case 'patch-validate':
      Object.assign(commandArgs, {
        input: requireOptionValue(parsed, 'input'),
        patches: readOptionValues(parsed, 'patch'),
        ...(readOptionValues(parsed, 'select').length ? { select: readOptionValues(parsed, 'select') } : {}),
        ...(parsed.flags.has('rom-filter') ? { rom_filter: true } : {}),
        ...(parsed.flags.has('patch-filter') ? { patch_filter: true } : {}),
        ...(parsed.flags.has('no-extract') ? { no_extract: true } : {}),
        ...(parsed.flags.has('no-ignore') ? { no_ignore: true } : {}),
        ...(readOptionValues(parsed, 'checksum-cache').length ? { checksum_cache: readOptionValues(parsed, 'checksum-cache') } : {}),
        ...(readOptionValues(parsed, 'validate-with-checksum').length
          ? { validate_with_checksums: readOptionValues(parsed, 'validate-with-checksum') }
          : {}),
        ...(readOptionalNumber(parsed, 'validate-with-size') !== null
          ? { validate_with_size: readOptionalNumber(parsed, 'validate-with-size') }
          : {}),
        ...(readOptionalNumber(parsed, 'validate-with-min-size') !== null
          ? { validate_with_min_size: readOptionalNumber(parsed, 'validate-with-min-size') }
          : {}),
        ...(parsed.flags.has('strip-header') ? { strip_header: true } : {}),
        ...(parsed.flags.has('ignore-checksum-validation') ? { ignore_checksum_validation: true } : {}),
      });
      break;
    default:
      throw new Error(`unsupported command: ${command === 'patch' ? `patch ${subcommand}` : command}`);
  }

  const threads = readOptionalThreadBudget(parsed);
  if (threads !== null) commandArgs.threads = threads;

  return Object.keys(output).length > 0
    ? { command: commandRequest, output }
    : commandRequest;
}

function locateCommand(args) {
  const supportedCommands = new Set(['compress', 'extract', 'checksum', 'patch']);
  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] ?? '').trim().toLowerCase();
    if (token === 'patch') {
      const subcommand = String(args[index + 1] ?? '').trim().toLowerCase();
      if (subcommand === 'apply' || subcommand === 'create' || subcommand === 'validate') {
        return { command: 'patch', index, subcommand };
      }
      throw new Error(`unsupported patch subcommand: ${subcommand || '(missing)'}`);
    }
    if (supportedCommands.has(token)) {
      return { command: token, index, subcommand: '' };
    }
  }
  throw new Error(`unable to locate supported command in args: ${args.join(' ')}`);
}

function createCommandRequest(command, subcommand) {
  if (command === 'patch') {
    return { type: 'patch', args: { type: subcommand, args: {} } };
  }
  return { type: command, args: {} };
}

function parseCommandTokens(args, commandIndex) {
  const flags = new Set();
  const options = new Map();
  const positionals = [];

  for (let index = 0; index < args.length; index += 1) {
    if (index === commandIndex) {
      if (String(args[index] ?? '').trim().toLowerCase() === 'patch') index += 1;
      continue;
    }
    const raw = String(args[index] ?? '');
    if (!raw.startsWith('--')) {
      if (index > commandIndex) positionals.push(raw);
      continue;
    }

    const withoutPrefix = raw.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    const name = equalsIndex >= 0 ? withoutPrefix.slice(0, equalsIndex) : withoutPrefix;
    let value = equalsIndex >= 0 ? withoutPrefix.slice(equalsIndex + 1) : null;
    if (
      value === null
      && index > commandIndex
      && index + 1 < args.length
      && !String(args[index + 1] ?? '').startsWith('--')
    ) {
      value = String(args[index + 1]);
      index += 1;
    }
    if (value === null) {
      flags.add(name);
      continue;
    }
    const values = options.get(name) ?? [];
    values.push(value);
    options.set(name, values);
  }

  return { flags, options, positionals };
}

function readOptionValues(parsed, name) {
  return parsed.options.get(name) ?? [];
}

function readOptionalValue(parsed, name) {
  return readOptionValues(parsed, name)[0] ?? null;
}

function readOptionalNumber(parsed, name) {
  const value = readOptionalValue(parsed, name);
  if (value === null) return null;
  const parsedNumber = Number.parseInt(value, 10);
  if (!Number.isFinite(parsedNumber) || parsedNumber < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsedNumber;
}

function readOptionalThreadBudget(parsed) {
  const value = readOptionalValue(parsed, 'threads');
  if (value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'auto') return 'auto';
  const parsedNumber = Number.parseInt(normalized, 10);
  if (!Number.isInteger(parsedNumber) || parsedNumber <= 0) {
    throw new Error('threads must be auto or a positive integer');
  }
  return parsedNumber;
}

function requireOptionValue(parsed, name) {
  const value = readOptionalValue(parsed, name);
  if (!value) throw new Error(`missing required --${name}`);
  return value;
}

function requirePositional(parsed, index, label) {
  const value = parsed.positionals[index];
  if (!value) throw new Error(`missing ${label}`);
  return value;
}

function parseThreadPoolSize(defaultValue) {
  const fallback = clampThreadPoolSize(defaultValue);
  const rawValue = process.env[THREAD_POOL_SIZE_ENV];
  if (rawValue == null || rawValue.trim().length === 0) {
    return fallback;
  }
  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${THREAD_POOL_SIZE_ENV} must be a positive integer; received: ${rawValue}`);
  }
  return clampThreadPoolSize(parsedValue);
}

function shouldPrewarmThreadPool() {
  const rawValue = process.env[THREAD_PREWARM_ENV];
  if (rawValue == null) {
    return false;
  }
  const normalized = rawValue.trim().toLowerCase();
  const enabled = normalized.length > 0
    && normalized !== '0'
    && normalized !== 'false'
    && normalized !== 'off';
  if (enabled) {
    threadDebugLog(`${THREAD_PREWARM_ENV} is ignored; WASI threads use one Worker per thread-spawn`);
  }
  return false;
}

function clampThreadPoolSize(value) {
  return Math.max(1, Math.min(MAX_THREAD_POOL_SIZE, Number(value) || DEFAULT_THREAD_POOL_SIZE));
}

function createWasiRuntime(args, stdinFd = undefined) {
  return new WASI({
    version: 'preview1',
    args,
    env: process.env,
    ...(stdinFd == null ? {} : { stdin: stdinFd }),
    preopens: {
      '.': process.cwd(),
      '/': '/',
    },
    returnOnExit: true,
  });
}

function createImportObject({ moduleImports, wasi, memory, threadSpawner }) {
  const importObject = {
    wasi_snapshot_preview1: wasi.wasiImport,
    env: createWasmEnvImports(memory),
  };
  if (needsWasiThreadSpawnImport(moduleImports)) {
    importObject.wasi = { 'thread-spawn': threadSpawner.spawn };
  }
  return importObject;
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
  if (!(controlBuffer instanceof SharedArrayBuffer)) {
    return null;
  }
  const control = new Int32Array(controlBuffer);
  if (control.length < THREAD_SLOT_LENGTH) {
    return null;
  }
  return control;
}

function signalThreadStartState(control, state) {
  if (!(control instanceof Int32Array) || control.length < THREAD_SLOT_LENGTH) {
    return;
  }
  Atomics.store(control, THREAD_SLOT_STATE_INDEX, state);
  Atomics.notify(control, THREAD_SLOT_STATE_INDEX, 1);
}

function storeThreadSpawnResult(wasmMemory, errorOrTidPtr, isError, value) {
  if (!(wasmMemory instanceof WebAssembly.Memory)) {
    return false;
  }
  if (!(wasmMemory.buffer instanceof SharedArrayBuffer)) {
    return false;
  }
  const pointer = Number(errorOrTidPtr);
  if (!Number.isInteger(pointer) || pointer < 0) {
    return false;
  }
  try {
    const result = new Int32Array(wasmMemory.buffer, pointer, 2);
    Atomics.store(result, 0, isError ? 1 : 0);
    Atomics.store(result, 1, Number(value) | 0);
    Atomics.notify(result, 1, 1);
    return true;
  } catch (error) {
    threadDebugLog(`failed to write thread-spawn result at ${pointer}: ${error instanceof Error ? error.message : String(error)}`);
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

function waitForThreadStartAck(control, tid) {
  const deadline = Date.now() + THREAD_START_ACK_TIMEOUT_MS;
  while (true) {
    const state = Atomics.load(control, THREAD_SLOT_STATE_INDEX);
    if (
      state === THREAD_SLOT_STATE_RUNNING
      || state === THREAD_SLOT_STATE_IDLE
    ) {
      return null;
    }
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
      Atomics.wait(
        control,
        THREAD_SLOT_STATE_INDEX,
        THREAD_SLOT_STATE_STARTING,
        Math.min(remainingMs, 100),
      );
      continue;
    }
    if (state !== THREAD_SLOT_STATE_REQUESTED) {
      return new Error(`wasi thread ${tid} entered unexpected start state ${state}`);
    }
    Atomics.wait(
      control,
      THREAD_SLOT_STATE_INDEX,
      THREAD_SLOT_STATE_REQUESTED,
      Math.min(remainingMs, 100),
    );
  }
}

function createThreadSpawner({
  moduleImports,
  wasmModule,
  wasmMemory,
  wasiArgs,
  threadIdState,
  spawnPoolSize = DEFAULT_THREAD_POOL_SIZE,
  allowPrewarmedPool = false,
}) {
  if (!needsWasiThreadSpawnImport(moduleImports)) {
    return {
      spawn: () => -WASI_ERRNO_ENOSYS,
      waitForWorkers: async () => {},
      ready: Promise.resolve(),
    };
  }
  if (!(wasmMemory instanceof WebAssembly.Memory)) {
    throw new Error(
      'threaded wasm module imports env.memory, but no shared WebAssembly.Memory was created',
    );
  }
  if (!(wasmMemory.buffer instanceof SharedArrayBuffer)) {
    throw new Error(
      'threaded wasm requires shared memory; env.memory is not backed by SharedArrayBuffer',
    );
  }

  if (allowPrewarmedPool && isMainThread) {
    return createPrewarmedThreadSpawner({
      wasmModule,
      wasmMemory,
      wasiArgs,
      threadIdState,
      spawnPoolSize,
    });
  }

  return createOnDemandThreadSpawner({
    wasmModule,
    wasmMemory,
    wasiArgs,
    threadIdState,
  });
}

function createOnDemandThreadSpawner({
  wasmModule,
  wasmMemory,
  wasiArgs,
  threadIdState,
}) {
  const activeWorkers = new Map();
  const workerCompletions = new Set();
  let firstThreadFailure = null;

  const wrapFailure = (tid, error) => {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`wasi thread ${tid} failed before completion: ${message}`);
  };

  const terminateOtherWorkers = (excludeTid = null) => {
    for (const [tid, worker] of activeWorkers.entries()) {
      if (excludeTid != null && tid === excludeTid) continue;
      void worker.terminate().catch(() => {});
    }
  };

  const recordFailure = (tid, error) => {
    if (!firstThreadFailure) {
      firstThreadFailure = error;
    }
    terminateOtherWorkers(tid);
  };

  function spawn(startArg) {
    const spawnArgCount = arguments.length;
    const errorOrTidPtr = spawnArgCount > 1 ? arguments[1] : undefined;
    const tid = allocateThreadId(threadIdState);
    if (tid < 0) {
      threadDebugLog(`thread-spawn rejected startArg=${startArg} errno=${tid} argc=${spawnArgCount}`);
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, Math.abs(tid), true);
    }

    let worker;
    try {
      worker = new Worker(new URL(import.meta.url), {
        type: 'module',
        workerData: {
          [THREAD_WORKER_DATA_KEY]: {
            mode: THREAD_WORKER_MODE_START,
            tid,
            startArg: Number(startArg) | 0,
            wasiArgs,
            wasmModule,
            wasmMemory,
            threadIdState,
          },
        },
      });
      threadDebugLog(`spawned tid=${tid} startArg=${Number(startArg) | 0} argc=${spawnArgCount} errPtr=${errorOrTidPtr ?? 'n/a'}`);
    } catch {
      threadDebugLog(`failed to spawn worker tid=${tid}`);
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, WASI_ERRNO_AGAIN, true);
    }

    activeWorkers.set(tid, worker);
    const completion = new Promise((resolve, reject) => {
      worker.once('error', (error) => {
        const wrapped = wrapFailure(tid, error);
        threadDebugLog(`worker error tid=${tid}: ${wrapped.message}`);
        recordFailure(tid, wrapped);
        reject(wrapped);
      });
      worker.once('exit', (code) => {
        threadDebugLog(`worker exit tid=${tid} code=${code}`);
        if (code === 0) {
          resolve();
          return;
        }
        const wrapped = new Error(`wasi thread ${tid} exited with code ${code}`);
        recordFailure(tid, wrapped);
        reject(wrapped);
      });
    }).finally(() => {
      activeWorkers.delete(tid);
      workerCompletions.delete(completion);
    });
    workerCompletions.add(completion);

    return finishThreadSpawn(wasmMemory, errorOrTidPtr, tid, false);
  }

  const waitForWorkers = async () => {
    if (workerCompletions.size === 0) {
      if (firstThreadFailure) {
        throw firstThreadFailure;
      }
      return;
    }
    const results = await Promise.allSettled([...workerCompletions]);
    if (firstThreadFailure) {
      throw firstThreadFailure;
    }
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected) {
      throw rejected.reason;
    }
  };

  return { spawn, waitForWorkers, ready: Promise.resolve() };
}

function createPrewarmedThreadSpawner({
  wasmModule,
  wasmMemory,
  wasiArgs,
  threadIdState,
  spawnPoolSize,
}) {
  const requestedThreads = Math.max(1, Number(spawnPoolSize) || DEFAULT_THREAD_POOL_SIZE);
  const requestedPoolSize = parseThreadPoolSize(
    Math.max(DEFAULT_THREAD_POOL_SIZE, requestedThreads),
  );
  const activeWorkers = new Map();
  const poolWorkers = [];
  let firstThreadFailure = null;
  let shutdownPromise = null;
  let isShuttingDown = false;

  const recordFailure = (tid, error) => {
    if (!firstThreadFailure) {
      firstThreadFailure = error instanceof Error ? error : new Error(String(error));
    }
    threadDebugLog(`recorded thread failure tid=${tid}: ${firstThreadFailure.message}`);
  };

  const handlePoolMessage = (slot, message) => {
    if (!message || typeof message !== 'object') {
      return;
    }

    if (message.type === THREAD_WORKER_POOL_READY) {
      slot.online = true;
      slot.resolveReady?.();
      slot.resolveReady = null;
      slot.rejectReady = null;
      threadDebugLog(`pool worker ready index=${slot.index}`);
    }
  };

  const handlePoolWorkerFailure = (slot, error) => {
    if (isShuttingDown) {
      return;
    }
    const activeTid = slot.tid;
    const wrapped = new Error(
      `wasi pool worker ${slot.index} failed${activeTid == null ? '' : ` while running tid=${activeTid}`}: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (activeTid != null) {
      activeWorkers.delete(activeTid);
      recordFailure(activeTid, wrapped);
      Atomics.store(slot.control, THREAD_SLOT_ERROR_INDEX, 1);
      Atomics.store(slot.control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_FAILED);
      Atomics.notify(slot.control, THREAD_SLOT_STATE_INDEX, 1);
    } else if (slot.rejectReady) {
      slot.rejectReady(wrapped);
    } else if (!firstThreadFailure) {
      firstThreadFailure = wrapped;
    }
    slot.busy = false;
    slot.tid = null;
  };

  const poolReadyPromises = [];
  for (let index = 0; index < requestedPoolSize; index += 1) {
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
    const readyPromise = new Promise((resolveReady, rejectReady) => {
      slot.resolveReady = resolveReady;
      slot.rejectReady = rejectReady;
    });
    poolReadyPromises.push(readyPromise);
    const worker = new Worker(new URL(import.meta.url), {
      type: 'module',
      workerData: {
        [THREAD_WORKER_DATA_KEY]: {
          mode: THREAD_WORKER_MODE_POOL,
          wasiArgs,
          wasmModule,
          wasmMemory,
          threadIdState,
          controlBuffer: control.buffer,
        },
      },
    });
    slot.worker = worker;
    worker.on('message', (message) => handlePoolMessage(slot, message));
    worker.on('error', (error) => handlePoolWorkerFailure(slot, error));
    worker.on('exit', (code) => {
      if (code === 0) {
        return;
      }
      handlePoolWorkerFailure(slot, new Error(`pool worker exited with code ${code}`));
    });
    poolWorkers.push(slot);
  }

  const ready = Promise.all(poolReadyPromises).then(() => {
    threadDebugLog(`prewarmed thread pool online size=${requestedPoolSize}`);
  });

  const shutdownPool = async () => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    shutdownPromise = (async () => {
      isShuttingDown = true;
      for (const slot of poolWorkers) {
        try {
          slot.worker.postMessage({ type: THREAD_WORKER_POOL_SHUTDOWN });
        } catch {
          // ignored
        }
        Atomics.store(slot.control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_SHUTDOWN);
        Atomics.notify(slot.control, THREAD_SLOT_STATE_INDEX, 1);
      }
      await Promise.allSettled(poolWorkers.map(async (slot) => {
        const exitedCleanly = await Promise.race([
          new Promise((resolve) => {
            slot.worker.once('exit', () => resolve(true));
          }),
          new Promise((resolve) => {
            setTimeout(() => resolve(false), 250);
          }),
        ]);
        if (exitedCleanly) {
          return;
        }
        try {
          await slot.worker.terminate();
        } catch {
          // ignored
        }
      }));
    })();
    return shutdownPromise;
  };

  function spawn(startArg) {
    const spawnArgCount = arguments.length;
    const errorOrTidPtr = spawnArgCount > 1 ? arguments[1] : undefined;
    for (const [activeTid, activeSlot] of activeWorkers.entries()) {
      const state = Atomics.load(activeSlot.control, THREAD_SLOT_STATE_INDEX);
      if (state === THREAD_SLOT_STATE_IDLE) {
        activeSlot.busy = false;
        activeSlot.tid = null;
        activeWorkers.delete(activeTid);
        continue;
      }
      if (state === THREAD_SLOT_STATE_FAILED) {
        activeSlot.busy = false;
        activeSlot.tid = null;
        activeWorkers.delete(activeTid);
        recordFailure(activeTid, new Error(`wasi thread ${activeTid} failed in pool worker ${activeSlot.index}`));
      }
    }

    const tid = allocateThreadId(threadIdState);
    if (tid < 0) {
      threadDebugLog(`thread-spawn rejected startArg=${startArg} errno=${tid} argc=${spawnArgCount}`);
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, Math.abs(tid), true);
    }
    const slot = poolWorkers.find((candidate) => candidate.online
      && !candidate.busy
      && Atomics.load(candidate.control, THREAD_SLOT_STATE_INDEX) === THREAD_SLOT_STATE_IDLE);
    if (!slot) {
      threadDebugLog(`thread-spawn no idle worker tid=${tid} startArg=${Number(startArg) | 0} argc=${spawnArgCount}`);
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, WASI_ERRNO_AGAIN, true);
    }

    slot.busy = true;
    slot.tid = tid;
    activeWorkers.set(tid, slot);

    try {
      Atomics.store(slot.control, THREAD_SLOT_TID_INDEX, tid);
      Atomics.store(slot.control, THREAD_SLOT_START_ARG_INDEX, Number(startArg) | 0);
      Atomics.store(slot.control, THREAD_SLOT_ERROR_INDEX, 0);
      Atomics.store(slot.control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_REQUESTED);
      Atomics.notify(slot.control, THREAD_SLOT_STATE_INDEX, 1);
      threadDebugLog(`pool dispatch tid=${tid} worker=${slot.index} startArg=${Number(startArg) | 0} argc=${spawnArgCount} errPtr=${errorOrTidPtr ?? 'n/a'}`);
      const startAckError = waitForThreadStartAck(slot.control, tid);
      if (startAckError) {
        activeWorkers.delete(tid);
        slot.busy = false;
        slot.tid = null;
        threadDebugLog(`pool dispatch failed tid=${tid}: ${startAckError.message}`);
        return finishThreadSpawn(wasmMemory, errorOrTidPtr, WASI_ERRNO_AGAIN, true);
      }
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, tid, false);
    } catch (error) {
      activeWorkers.delete(tid);
      slot.busy = false;
      slot.tid = null;
      threadDebugLog(`pool dispatch failed tid=${tid}: ${error instanceof Error ? error.message : String(error)}`);
      return finishThreadSpawn(wasmMemory, errorOrTidPtr, WASI_ERRNO_AGAIN, true);
    }
  }

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
            recordFailure(tid, new Error(`wasi thread ${tid} failed in pool worker ${slot.index}`));
            slot.busy = false;
            slot.tid = null;
            activeWorkers.delete(tid);
            break;
          }
          Atomics.wait(slot.control, THREAD_SLOT_STATE_INDEX, state, 100);
        }
      }
    }
    activeWorkers.clear();
    await shutdownPool();
    if (firstThreadFailure) {
      throw firstThreadFailure;
    }
  };

  return { spawn, waitForWorkers, ready };
}

function getThreadWorkerPayload(data) {
  if (isMainThread) {
    return null;
  }
  if (!data || typeof data !== 'object') {
    return null;
  }
  if (!(THREAD_WORKER_DATA_KEY in data)) {
    return null;
  }
  const payload = data[THREAD_WORKER_DATA_KEY];
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  if (payload.mode !== THREAD_WORKER_MODE_START && payload.mode !== THREAD_WORKER_MODE_POOL) {
    return null;
  }
  return payload;
}

async function runThreadPoolWorker(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('missing worker payload for wasi thread pool worker');
  }
  const {
    wasmModule,
    wasmMemory,
    wasiArgs,
    threadIdState,
    controlBuffer,
  } = payload;
  if (!(wasmModule instanceof WebAssembly.Module)) {
    throw new Error('pool worker payload missing compiled WebAssembly.Module');
  }
  if (!(wasmMemory instanceof WebAssembly.Memory)) {
    throw new Error('pool worker payload missing shared WebAssembly.Memory');
  }
  if (!(wasmMemory.buffer instanceof SharedArrayBuffer)) {
    throw new Error('pool worker payload memory is not shared');
  }
  if (!parentPort) {
    throw new Error('pool worker requires parentPort');
  }
  const control = new Int32Array(controlBuffer);
  if (!(control.buffer instanceof SharedArrayBuffer) || control.length < THREAD_SLOT_LENGTH) {
    throw new Error('pool worker payload missing thread control buffer');
  }
  threadDebugLog('pool worker online');
  parentPort.postMessage({ type: THREAD_WORKER_POOL_READY });

  while (true) {
    while (Atomics.load(control, THREAD_SLOT_STATE_INDEX) === THREAD_SLOT_STATE_IDLE) {
      Atomics.wait(control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_IDLE);
    }
    const state = Atomics.load(control, THREAD_SLOT_STATE_INDEX);
    if (state === THREAD_SLOT_STATE_SHUTDOWN) {
      return;
    }
    if (state === THREAD_SLOT_STATE_FAILED) {
      Atomics.wait(control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_FAILED, 100);
      continue;
    }
    if (state !== THREAD_SLOT_STATE_REQUESTED) {
      continue;
    }
    const tid = Atomics.load(control, THREAD_SLOT_TID_INDEX) | 0;
    const startArg = Atomics.load(control, THREAD_SLOT_START_ARG_INDEX) | 0;
    Atomics.store(control, THREAD_SLOT_ERROR_INDEX, 0);
    Atomics.store(control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_STARTING);
    Atomics.notify(control, THREAD_SLOT_STATE_INDEX, 1);
    threadDebugLog(`pool worker running tid=${tid} startArg=${startArg}`);
    try {
      await runSpawnedThread({
        mode: THREAD_WORKER_MODE_START,
        tid,
        startArg,
        wasmModule,
        wasmMemory,
        wasiArgs,
        threadIdState,
        startControlBuffer: control.buffer,
      });
      Atomics.store(control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_IDLE);
    } catch {
      Atomics.store(control, THREAD_SLOT_ERROR_INDEX, 1);
      Atomics.store(control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_FAILED);
    }
    Atomics.notify(control, THREAD_SLOT_STATE_INDEX, 1);
  }
}

async function runSpawnedThread(payload) {
  threadDebugLog('worker entry into runSpawnedThread');
  if (!payload || typeof payload !== 'object') {
    throw new Error('missing worker payload for wasi thread');
  }
  const {
    tid,
    startArg,
    wasiArgs,
    wasmModule,
    wasmMemory,
    threadIdState,
    startControlBuffer,
  } = payload;
  const startControl = threadStartControlFromBuffer(startControlBuffer);
  signalThreadStartState(startControl, THREAD_SLOT_STATE_STARTING);
  let startAcked = false;
  try {
    if (!(wasmModule instanceof WebAssembly.Module)) {
      throw new Error('worker payload missing compiled WebAssembly.Module');
    }
    if (!(wasmMemory instanceof WebAssembly.Memory)) {
      throw new Error('worker payload missing shared WebAssembly.Memory');
    }
    if (!(wasmMemory.buffer instanceof SharedArrayBuffer)) {
      throw new Error('worker payload memory is not shared');
    }

    const moduleImports = WebAssembly.Module.imports(wasmModule);
    const threadWasi = createWasiRuntime(
      Array.isArray(wasiArgs) && wasiArgs.length > 0 ? wasiArgs : ['rom-weaver'],
    );
    const threadSpawner = createThreadSpawner({
      moduleImports,
      wasmModule,
      wasmMemory,
      wasiArgs: Array.isArray(wasiArgs) && wasiArgs.length > 0 ? wasiArgs : ['rom-weaver'],
      threadIdState,
      allowPrewarmedPool: false,
    });
    await threadSpawner.ready;
    const importObject = createImportObject({
      moduleImports,
      wasi: threadWasi,
      memory: wasmMemory,
      threadSpawner,
    });

    const instance = await WebAssembly.instantiate(wasmModule, importObject);
    threadDebugLog(`worker tid=${Number(tid) | 0} entering wasi_thread_start startArg=${Number(startArg) | 0}`);
    if (typeof threadWasi.finalizeBindings === 'function') {
      threadWasi.finalizeBindings(instance, { memory: wasmMemory });
    } else {
      threadWasi.initialize(instance);
    }
    if (typeof instance.exports.wasi_thread_start !== 'function') {
      throw new Error('threaded wasm module does not export wasi_thread_start');
    }
    signalThreadStartState(startControl, THREAD_SLOT_STATE_RUNNING);
    startAcked = true;
    instance.exports.wasi_thread_start(Number(tid) | 0, Number(startArg) | 0);
    threadDebugLog(`worker tid=${Number(tid) | 0} completed wasi_thread_start`);
    await threadSpawner.waitForWorkers();
    threadDebugLog(`worker tid=${Number(tid) | 0} completed nested worker waits`);
  } catch (error) {
    if (!startAcked) {
      signalThreadStartState(startControl, THREAD_SLOT_STATE_FAILED);
    }
    throw error;
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

function createSharedThreadMemory() {
  const initialPages = parsePositiveIntEnv(
    'ROM_WEAVER_WASM_SHARED_MEMORY_INITIAL_PAGES',
    DEFAULT_SHARED_MEMORY_INITIAL_PAGES,
  );
  const maxPages = parsePositiveIntEnv(
    'ROM_WEAVER_WASM_SHARED_MEMORY_MAX_PAGES',
    DEFAULT_SHARED_MEMORY_MAX_PAGES,
  );
  if (maxPages < initialPages) {
    throw new Error(
      'ROM_WEAVER_WASM_SHARED_MEMORY_MAX_PAGES must be >= ROM_WEAVER_WASM_SHARED_MEMORY_INITIAL_PAGES',
    );
  }
  return new WebAssembly.Memory({
    initial: initialPages,
    maximum: maxPages,
    shared: true,
  });
}

function parsePositiveIntEnv(name, fallback) {
  const rawValue = process.env[name];
  if (rawValue == null || rawValue.trim().length === 0) {
    return fallback;
  }
  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${name} must be a positive integer; received: ${rawValue}`);
  }
  return parsedValue;
}

const threadWorkerMode = getThreadWorkerPayload(workerData);
if (isThreadDebugEnabled() && !isMainThread) {
  threadDebugLog(`worker bootstrap mode=${threadWorkerMode?.mode ?? 'main'}`);
}
const run = threadWorkerMode?.mode === THREAD_WORKER_MODE_START
  ? runSpawnedThread(threadWorkerMode)
  : threadWorkerMode?.mode === THREAD_WORKER_MODE_POOL
    ? runThreadPoolWorker(threadWorkerMode)
    : main();

run.catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
