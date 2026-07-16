#!/usr/bin/env node

import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, workerData } from 'node:worker_threads';
import { WASI } from 'node:wasi';
import { createWasmEnvImports } from './rom-weaver-runtime-utils.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_WASM_MODULE = resolve(REPO_ROOT, 'packages/rom-weaver-react/src/wasm/rom-weaver-app.wasm');
const DEFAULT_SHARED_MEMORY_INITIAL_PAGES = 256;
// 65536 pages * 64 KiB = 4 GiB. Must be <= the threaded wasm's imported memory maximum
// (--max-memory in .cargo/config.toml, also 4 GiB). Browser LZMA2 workers can need more than
// 1 GiB when several raw encoders run concurrently.
const DEFAULT_SHARED_MEMORY_MAX_PAGES = 65536;
const MAX_WASI_THREAD_ID = 0x1fffffff;
const THREAD_ID_COUNTER_INDEX = 0;
const THREAD_ID_COUNTER_INITIAL = 43;
const THREAD_WORKER_DATA_KEY = '__rom_weaver_wasi_thread';
const THREAD_WORKER_MODE_START = 'start';
const WASI_ERRNO_AGAIN = 6;
const WASI_ERRNO_ENOSYS = 52;
const THREAD_DEBUG_ENV = 'ROM_WEAVER_WASI_THREAD_DEBUG';
const THREAD_DEBUG_LOG_FILE_ENV = 'ROM_WEAVER_WASI_THREAD_DEBUG_LOG_FILE';

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
    const threadSpawner = createThreadSpawner({
      moduleImports,
      wasmModule: compiledModule,
      wasmMemory: threadedMemory,
      wasiArgs,
      threadIdState,
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

function createThreadSpawner({
  moduleImports,
  wasmModule,
  wasmMemory,
  wasiArgs,
  threadIdState,
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

function getThreadWorkerPayload(data) {
  if (isMainThread || !data || typeof data !== 'object') {
    return null;
  }
  const payload = data[THREAD_WORKER_DATA_KEY];
  return payload && typeof payload === 'object' && payload.mode === THREAD_WORKER_MODE_START
    ? payload
    : null;
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
  } = payload;
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
  instance.exports.wasi_thread_start(Number(tid) | 0, Number(startArg) | 0);
  threadDebugLog(`worker tid=${Number(tid) | 0} completed wasi_thread_start`);
  await threadSpawner.waitForWorkers();
  threadDebugLog(`worker tid=${Number(tid) | 0} completed nested worker waits`);
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
  : main();

run.catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exit(1);
});
