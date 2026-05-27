import { describe, expect, it } from 'vitest';
import { createRomWeaverBrowserOpfs } from '../src/rom-weaver-browser-opfs-api.mjs';
import {
  BrowserRomWeaverWorkerClient,
  createBrowserWorkerClient,
} from '../src/workers/browser-worker-client.mjs';
import {
  assertRunJsonSucceeded,
  getGuestFileSize,
  joinGuestPath,
  runFullFormatMatrix,
  runPatchMatrix,
  runProgressMatrix,
  toBytes,
  withTempFixture,
  writeGuestPatternFile,
  writeGuestFile,
} from './test-helpers.mjs';

const RUN_1GB_STRESS = typeof __ROM_WEAVER_WASM_STRESS_1GB__ !== 'undefined'
  && __ROM_WEAVER_WASM_STRESS_1GB__ === true;
const SCRATCH_DIRECTORY_NAME = '.rom-weaver-opfs-scratch';
// Minimal WASI module: write a running JSON line, spin, then write succeeded.
const STREAMING_WASI_MODULE_BYTES = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 12, 2, 96, 4, 127, 127, 127, 127, 1,
  127, 96, 0, 0, 2, 35, 1, 22, 119, 97, 115, 105, 95, 115, 110, 97, 112,
  115, 104, 111, 116, 95, 112, 114, 101, 118, 105, 101, 119, 49, 8, 102,
  100, 95, 119, 114, 105, 116, 101, 0, 0, 3, 2, 1, 1, 5, 3, 1, 0, 1, 7,
  19, 2, 6, 109, 101, 109, 111, 114, 121, 2, 0, 6, 95, 115, 116, 97, 114,
  116, 0, 1, 10, 88, 1, 86, 1, 1, 127, 65, 0, 65, 32, 54, 2, 0, 65, 4,
  65, 63, 54, 2, 0, 65, 1, 65, 0, 65, 1, 65, 8, 16, 0, 26, 65, 0, 33, 0,
  2, 64, 3, 64, 32, 0, 65, 128, 202, 181, 238, 1, 79, 13, 1, 32, 0, 65,
  1, 106, 33, 0, 12, 0, 11, 0, 11, 65, 0, 65, 128, 1, 54, 2, 0, 65, 4, 65,
  62, 54, 2, 0, 65, 1, 65, 0, 65, 1, 65, 8, 16, 0, 26, 11, 11, 137, 1, 2,
  0, 65, 32, 11, 63, 123, 34, 99, 111, 109, 109, 97, 110, 100, 34, 58, 34,
  115, 116, 114, 101, 97, 109, 45, 116, 101, 115, 116, 34, 44, 34, 115, 116,
  97, 116, 117, 115, 34, 58, 34, 114, 117, 110, 110, 105, 110, 103, 34, 44,
  34, 108, 97, 98, 101, 108, 34, 58, 34, 115, 116, 97, 114, 116, 101, 100,
  34, 125, 10, 0, 65, 128, 1, 11, 62, 123, 34, 99, 111, 109, 109, 97, 110,
  100, 34, 58, 34, 115, 116, 114, 101, 97, 109, 45, 116, 101, 115, 116, 34,
  44, 34, 115, 116, 97, 116, 117, 115, 34, 58, 34, 115, 117, 99, 99, 101,
  101, 100, 101, 100, 34, 44, 34, 108, 97, 98, 101, 108, 34, 58, 34, 100,
  111, 110, 101, 34, 125, 10,
]);

function runJsonFromWorker(worker) {
  return (args, options) => worker.runJson(args, options);
}

function delay(ms, value = null) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

async function waitForCondition(
  predicate,
  {
    timeoutMs = 10000,
    pollMs = 20,
    label = 'condition',
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(pollMs);
  }
  throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms`);
}

async function countScratchFiles(rootHandle) {
  try {
    const scratchHandle = await rootHandle.getDirectoryHandle(SCRATCH_DIRECTORY_NAME, { create: false });
    let count = 0;
    for await (const _entry of scratchHandle.entries()) count += 1;
    return count;
  } catch {
    return 0;
  }
}

async function observeScratchPeak(rootHandle, { isDone, timeoutMs = 20000, pollMs = 10 } = {}) {
  const done = typeof isDone === 'function' ? isDone : () => false;
  const deadline = Date.now() + timeoutMs;
  let peak = 0;
  while (!done() && Date.now() < deadline) {
    peak = Math.max(peak, await countScratchFiles(rootHandle));
    await delay(pollMs);
  }
  peak = Math.max(peak, await countScratchFiles(rootHandle));
  return peak;
}

function createVirtualFileProxy(path, sourceBytes, options = {}) {
  const bytes = sourceBytes instanceof Uint8Array ? sourceBytes : toBytes(sourceBytes);
  const firstReadDelayMs = Math.max(0, Number(options.firstReadDelayMs) || 0);
  const id = `test-virtual-file-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const slots = Array.from({ length: 2 }, () => ({
    controlBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 6),
    dataBuffer: new SharedArrayBuffer(1024),
  }));
  let closed = false;
  let requestCount = 0;
  let timer = null;
  const pendingCompletions = new Set();
  const completeProxyRead = (control, data, chunk, delayMs) => {
    const finalize = () => {
      if (closed) return;
      data.set(chunk);
      Atomics.store(control, 4, chunk.byteLength);
      Atomics.store(control, 5, 0);
      Atomics.store(control, 0, 2);
      Atomics.notify(control, 0, 1);
    };
    if (delayMs <= 0) {
      finalize();
      return;
    }
    const completion = setTimeout(() => {
      pendingCompletions.delete(completion);
      finalize();
    }, delayMs);
    pendingCompletions.add(completion);
  };
  const pump = () => {
    if (closed) return;
    for (const slot of slots) {
      const control = new Int32Array(slot.controlBuffer);
      if (Atomics.compareExchange(control, 0, 1, 3) !== 1) continue;
      const data = new Uint8Array(slot.dataBuffer);
      const offset = (Atomics.load(control, 1) >>> 0) + (Atomics.load(control, 2) >>> 0) * 2 ** 32;
      const length = Math.max(0, Math.min(Atomics.load(control, 3), data.byteLength));
      const chunk = bytes.subarray(offset, offset + length);
      const delayMs = requestCount === 0 ? firstReadDelayMs : 0;
      requestCount += 1;
      completeProxyRead(control, data, chunk, delayMs);
    }
    timer = setTimeout(pump, 0);
  };
  pump();
  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      for (const completion of pendingCompletions) clearTimeout(completion);
      pendingCompletions.clear();
    },
    virtualFile: {
      path,
      proxy: {
        id,
        maxChunkSize: 1024,
        size: bytes.byteLength,
        slots,
      },
    },
  };
}

class CloneFailingInitWorker {
  constructor() {
    this.messages = [];
    this.listeners = new Map();
  }

  postMessage(message) {
    this.messages.push(message);
    if (message.type === 'init' && message.options?.preferThreadedWasm !== false) {
      throw new DOMException('The object could not be cloned.', 'DataCloneError');
    }
    queueMicrotask(() => {
      this.dispatchMessage({
        mode: 'browser-opfs',
        requestId: message.requestId,
        threaded: false,
        type: message.type === 'dispose' ? 'disposed' : 'ready',
        wasmUrl: message.options?.wasmUrl ?? null,
      });
    });
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchMessage(data) {
    for (const listener of this.listeners.get('message') || []) {
      listener({ data });
    }
  }

  terminate() {
    this.listeners.clear();
  }
}

async function runMatrix(matrixRunner, worker, options) {
  await matrixRunner({
    runJson: runJsonFromWorker(worker),
    ...options,
  });
}

async function runJsonAndAssert(worker, args, command) {
  assertRunJsonSucceeded(await worker.runJson(args), { command });
}

async function runCompressExtractChecksumSequence({
  worker,
  sourcePath,
  archivePath,
  extractDir,
  extractedPath,
}) {
  await runJsonAndAssert(worker, [
    'compress',
    sourcePath,
    '--format',
    'gz',
    '--output',
    archivePath,
    '--threads',
    '1',
  ], 'compress');

  await runJsonAndAssert(worker, [
    'extract',
    archivePath,
    '--out-dir',
    extractDir,
    '--threads',
    '1',
  ], 'extract');

  await runJsonAndAssert(worker, [
    'checksum',
    sourcePath,
    '--algo',
    'crc32',
    '--no-extract',
  ], 'checksum');

  await runJsonAndAssert(worker, [
    'checksum',
    extractedPath,
    '--algo',
    'crc32',
    '--no-extract',
  ], 'checksum');
}

describe('rom-weaver-wasm browser runner parity', () => {
  it('requires createRomWeaverBrowserOpfs to run in a dedicated worker', async () => {
    await expect(createRomWeaverBrowserOpfs()).rejects.toThrow(/Dedicated Worker/i);
  });

  it('runJson executes checksum through browser worker runner', async () => {
    await withTempFixture(async ({ sourcePath, worker }) => {
      const result = await worker.runJson([
        'checksum',
        sourcePath,
        '--algo',
        'crc32',
        '--no-extract',
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(result.args[0]).toBe('--json');
      expect(Array.isArray(result.events)).toBe(true);
      expect(result.events.length).toBeGreaterThan(0);

      const terminal = result.events.at(-1);
      expect(terminal.status).toBe('succeeded');
      expect(terminal.command).toBe('checksum');
    });
  });

  it('runJson reads virtual browser File inputs without OPFS staging', async () => {
    await withTempFixture(async ({ worker }) => {
      const virtualPath = '/work/input/direct-file/input.bin';
      const virtual = createVirtualFileProxy(virtualPath, 'direct virtual input');
      let result;
      try {
        result = await worker.runJson([
          'checksum',
          virtualPath,
          '--algo',
          'crc32',
          '--no-extract',
        ], {
          virtualFiles: [virtual.virtualFile],
        });
      } finally {
        virtual.close();
      }

      const terminal = assertRunJsonSucceeded(result, { command: 'checksum' });
      expect(terminal.label).toMatch(/crc32=/i);
    });
  });

  it('runJson does not leak virtual files into later runs', async () => {
    await withTempFixture(async ({ worker }) => {
      const virtualPath = '/work/input/direct-file/input.bin';
      const virtual = createVirtualFileProxy(virtualPath, 'direct virtual input');
      try {
        const first = await worker.runJson([
          'checksum',
          virtualPath,
          '--algo',
          'crc32',
          '--no-extract',
        ], {
          virtualFiles: [virtual.virtualFile],
        });
        assertRunJsonSucceeded(first, { command: 'checksum' });
      } finally {
        virtual.close();
      }

      const second = await worker.runJson([
        'checksum',
        virtualPath,
        '--algo',
        'crc32',
        '--no-extract',
      ]);
      expect(second.ok).toBe(false);
      expect(second.exitCode).not.toBe(0);
    });
  });

  it('runJson fails stalled virtual proxy reads quickly and recovers from stale slot completions', async () => {
    await withTempFixture(async ({ worker }) => {
      const virtualPath = '/work/input/direct-file/input.bin';
      const virtual = createVirtualFileProxy(virtualPath, 'direct virtual input', {
        firstReadDelayMs: 9000,
      });
      try {
        const startMs = Date.now();
        const first = await worker.runJson([
          'checksum',
          virtualPath,
          '--algo',
          'crc32',
          '--no-extract',
        ], {
          virtualFiles: [virtual.virtualFile],
        });
        const elapsedMs = Date.now() - startMs;

        expect(first.ok).toBe(false);
        expect(first.exitCode).not.toBe(0);
        expect(elapsedMs).toBeLessThan(10_000);

        await delay(1500);
        const second = await worker.runJson([
          'checksum',
          virtualPath,
          '--algo',
          'crc32',
          '--no-extract',
        ], {
          virtualFiles: [virtual.virtualFile],
        });

        const terminal = assertRunJsonSucceeded(second, { command: 'checksum' });
        expect(terminal.label).toMatch(/crc32=/i);
      } finally {
        virtual.close();
      }
    });
  });

  it('runJson streams stdout events before the wasm process completes', async () => {
    const module = await WebAssembly.compile(STREAMING_WASI_MODULE_BYTES);
    await withTempFixture(async ({ worker }) => {
      let resolveFirstEvent;
      const firstEvent = new Promise((resolve) => {
        resolveFirstEvent = resolve;
      });
      const resultPromise = worker.runJson([], {
        onEvent(event) {
          if (event?.command === 'stream-test' && event.status === 'running') {
            resolveFirstEvent(event);
          }
        },
      });

      const streamedEvent = await Promise.race([firstEvent, delay(250)]);
      expect(streamedEvent).toMatchObject({
        command: 'stream-test',
        status: 'running',
      });
      await expect(Promise.race([resultPromise.then(() => 'settled'), delay(0, 'pending')]))
        .resolves
        .toBe('pending');

      const result = await resultPromise;
      assertRunJsonSucceeded(result, { command: 'stream-test' });
    }, {
      initOptions: {
        module,
      },
    });
  });

  it('browser client passes default threads when command args omit them', async () => {
    await withTempFixture(async ({ sourcePath, worker }) => {
      const result = await worker.runJson([
        'checksum',
        sourcePath,
        '--algo',
        'crc32',
        '--no-extract',
      ]);

      const terminal = assertRunJsonSucceeded(result, { command: 'checksum' });
      expect(result.args.slice(-2)).toEqual(['--threads', '3']);
      expect(terminal.requested_threads).toBe(3);
    }, {
      clientOptions: {
        defaultThreads: 3,
      },
    });
  });

  it('browser client does not override explicit command thread args', async () => {
    await withTempFixture(async ({ sourcePath, worker }) => {
      const result = await worker.runJson([
        'checksum',
        sourcePath,
        '--algo',
        'crc32',
        '--no-extract',
        '--threads',
        '2',
      ]);

      const terminal = assertRunJsonSucceeded(result, { command: 'checksum' });
      expect(result.args.slice(-2)).toEqual(['--threads', '2']);
      expect(terminal.requested_threads).toBe(2);
    }, {
      clientOptions: {
        defaultThreads: 3,
      },
    });
  });

  it('browser client caps explicit command thread args to the browser worker pool limit', async () => {
    await withTempFixture(async ({ sourcePath, worker }) => {
      const result = await worker.runJson([
        'checksum',
        sourcePath,
        '--algo',
        'crc32',
        '--no-extract',
        '--threads',
        '8',
      ]);

      const terminal = assertRunJsonSucceeded(result, { command: 'checksum' });
      expect(result.args.slice(-2)).toEqual(['--threads', '4']);
      expect(terminal.requested_threads).toBe(4);
    }, {
      clientOptions: {
        defaultThreads: 3,
      },
    });
  });

  it('browser client caps configured default threads to the browser worker pool limit', async () => {
    await withTempFixture(async ({ sourcePath, worker }) => {
      const result = await worker.runJson([
        'checksum',
        sourcePath,
        '--algo',
        'crc32',
        '--no-extract',
      ]);

      const terminal = assertRunJsonSucceeded(result, { command: 'checksum' });
      expect(result.args.slice(-2)).toEqual(['--threads', '4']);
      expect(terminal.requested_threads).toBe(4);
    }, {
      clientOptions: {
        defaultThreads: 8,
      },
    });
  });

  it('uses a single writable /work mount', async () => {
    await withTempFixture(async ({ sourcePath, worker, opfsHandle }) => {
      const outputPath = joinGuestPath('/work', 'single-mount-output.gz');
      const result = await worker.runJson([
        'compress',
        sourcePath,
        '--format',
        'gz',
        '--output',
        outputPath,
        '--threads',
        '1',
      ]);
      assertRunJsonSucceeded(result, { command: 'compress' });
      expect(await getGuestFileSize(opfsHandle, outputPath)).toBeGreaterThan(0);
    });
  });

  it('run reports parser errors for unknown commands', async () => {
    await withTempFixture(async ({ worker }) => {
      const result = await worker.run(['definitely-not-a-command']);
      expect(result.exitCode).not.toBe(0);
      expect(result.ok).toBe(false);
      expect(result.stderr).toMatch(/unknown command/i);
    });
  });

  it('browser runner supports mounted guest paths', async () => {
    await withTempFixture(async ({ worker, opfsHandle, dir }) => {
      const nestedSourcePath = joinGuestPath(dir, 'roms', 'input.bin');
      await writeGuestFile(opfsHandle, nestedSourcePath, toBytes('nested guest fixture'));

      const result = await worker.runJson([
        'checksum',
        nestedSourcePath,
        '--algo',
        'crc32',
        '--no-extract',
      ]);

      assertRunJsonSucceeded(result, {
        command: 'checksum',
      });
    });
  });

  it('runJson emits trace events when --trace is enabled', async () => {
    await withTempFixture(async ({ sourcePath, worker }) => {
      let streamedTraceEvents = 0;
      let streamedTraceLines = 0;
      const result = await worker.runJson(
        [
          '--trace',
          'checksum',
          sourcePath,
          '--algo',
          'crc32',
          '--no-extract',
        ],
        {
          onTraceEvent() {
            streamedTraceEvents += 1;
          },
          onTraceNonJsonLine() {
            streamedTraceLines += 1;
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(result.traceEvents.length + result.traceNonJsonLines.length).toBeGreaterThan(0);
      expect(streamedTraceEvents + streamedTraceLines).toBeGreaterThan(0);
    });
  });

  it('runJson emits progress events for compress, extract, and patch-apply', async () => {
    await withTempFixture(async ({ dir, sourcePath, worker, opfsHandle }) => {
      await runMatrix(runProgressMatrix, worker, {
        opfsHandle,
        dir,
        sourcePath,
        appliedOutputName: 'applied-output',
      });
    });
  });

  it('runJson integration matrix covers chd, zip, and patch wasm paths', async () => {
    await withTempFixture(async ({ dir, sourcePath, worker, opfsHandle, fixtures }) => {
      await runMatrix(runPatchMatrix, worker, {
        opfsHandle,
        dir,
        sourcePath,
        fixtures,
      });
    });
  });

  it('runJson full format matrix covers patch and container registries', async () => {
    await withTempFixture(async ({ dir, worker, opfsHandle, fixtures }) => {
      await runMatrix(runFullFormatMatrix, worker, {
        opfsHandle,
        dir,
        fixtures,
      });
    });
  });

  it('runner supports explicit wasm module URL paths', async () => {
    await withTempFixture(async ({ init, sourcePath, worker }) => {
      const canUseThreadedWasm = typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated === true;
      expect(init.threaded).toBe(canUseThreadedWasm);
      expect(init.wasmUrl).toContain(canUseThreadedWasm ? 'rom-weaver-cli-threaded.wasm' : 'rom-weaver-cli.wasm');
      const result = await worker.runJson([
        'checksum',
        sourcePath,
        '--algo',
        'crc32',
        '--no-extract',
      ]);

      assertRunJsonSucceeded(result, {
        command: 'checksum',
      });
    }, {
      initOptions: {
        wasmUrl: new URL('../rom-weaver-cli.wasm', import.meta.url).href,
      },
    });
  });

  it('runner honors preferThreadedWasm=false with explicit wasm URL paths', async () => {
    await withTempFixture(async ({ init, sourcePath, worker }) => {
      expect(init.threaded).toBe(false);
      expect(init.wasmUrl).toContain('rom-weaver-cli.wasm');
      const result = await worker.runJson([
        'checksum',
        sourcePath,
        '--algo',
        'crc32',
        '--no-extract',
      ]);

      assertRunJsonSucceeded(result, {
        command: 'checksum',
      });
    }, {
      initOptions: {
        preferThreadedWasm: false,
        wasmUrl: new URL('../rom-weaver-cli.wasm', import.meta.url).href,
      },
    });
  });

  it('runner auto-selects threaded wasm when runtime capability is available', async () => {
    await withTempFixture(async ({ init }) => {
      const canUseThreadedWasm = typeof SharedArrayBuffer === 'function' && globalThis.crossOriginIsolated === true;
      expect(init.threaded).toBe(canUseThreadedWasm);
      expect(init.wasmUrl).toContain(canUseThreadedWasm ? 'rom-weaver-cli-threaded.wasm' : 'rom-weaver-cli.wasm');
    }, {
      initOptions: {
        wasmUrl: new URL('../rom-weaver-cli.wasm', import.meta.url).href,
        threadedWasmUrl: new URL('../rom-weaver-cli-threaded.wasm', import.meta.url).href,
      },
    });
  });

  it('runner initializes the threaded wasm module when selected', async () => {
    await withTempFixture(async ({ init, sourcePath, worker }) => {
      expect(init.threaded).toBe(true);
      expect(init.wasmUrl).toContain('rom-weaver-cli-threaded.wasm');

      const result = await worker.runJson([
        'checksum',
        sourcePath,
        '--algo',
        'crc32',
        '--no-extract',
        '--threads',
        '1',
      ]);

      assertRunJsonSucceeded(result, {
        command: 'checksum',
      });
    }, {
      initOptions: {
        wasmUrl: new URL('../rom-weaver-cli-threaded.wasm', import.meta.url).href,
      },
    });
  });

  it('threaded browser runner executes parallel checksum work with wasm workers', async () => {
    await withTempFixture(async ({ dir, init, worker, opfsHandle }) => {
      expect(init.threaded).toBe(true);
      const sourcePath = joinGuestPath(dir, 'threaded-checksum-source.bin');
      await writeGuestPatternFile(opfsHandle, sourcePath, 32 * 1024 * 1024);

      let resolveRunningEvent;
      const firstRunningEvent = new Promise((resolve) => {
        resolveRunningEvent = resolve;
      });
      const resultPromise = worker.runJson(
        [
          'checksum',
          sourcePath,
          '--algo',
          'crc32',
          '--algo',
          'sha1',
          '--algo',
          'sha256',
          '--algo',
          'blake3',
          '--no-extract',
          '--threads',
          '4',
        ],
        {
          onEvent(event) {
            if (
              event?.command === 'checksum'
              && event.status === 'running'
              && typeof event.percent === 'number'
              && event.percent > 0
              && event.percent < 100
            ) {
              resolveRunningEvent(event);
            }
          },
        },
      );

      const streamedEvent = await Promise.race([firstRunningEvent, delay(5000)]);
      await expect(Promise.race([resultPromise.then(() => 'settled'), delay(0, 'pending')]))
        .resolves
        .toBe('pending');

      const result = await resultPromise;
      expect(streamedEvent).toMatchObject({
        command: 'checksum',
        status: 'running',
      });

      const terminal = assertRunJsonSucceeded(result, {
        command: 'checksum',
      });
      expect(terminal.requested_threads).toBe(4);
      expect(terminal.effective_threads).toBeGreaterThan(1);
      expect(terminal.used_parallelism).toBe(true);
    }, {
      initOptions: {
        wasmUrl: new URL('../rom-weaver-cli-threaded.wasm', import.meta.url).href,
      },
    });
  });

  it('threaded browser runner reuses thread-worker pool shells across repeated commands', async () => {
    const probeChannelName = 'rom-weaver-thread-worker-probe-channel';
    const probeWorkerUrl = new URL('./browser-wasi-thread-worker-probe.mjs', import.meta.url).href;
    const probeChannel = new BroadcastChannel(probeChannelName);
    const probeMessages = [];
    const onProbeMessage = (event) => {
      if (event?.data?.type === 'thread-worker-spawned') {
        probeMessages.push(event.data);
      }
    };
    probeChannel.addEventListener('message', onProbeMessage);

    try {
      await withTempFixture(async ({ dir, init, worker, opfsHandle }) => {
        expect(init.threaded).toBe(true);
        const sourcePath = joinGuestPath(dir, 'threaded-worker-pool-reuse-source.bin');
        await writeGuestPatternFile(opfsHandle, sourcePath, 16 * 1024 * 1024);

        await waitForCondition(() => probeMessages.length >= 2, {
          label: 'thread-worker prewarm',
        });
        const countAfterInit = probeMessages.length;

        const threadedChecksumArgs = [
          'checksum',
          sourcePath,
          '--algo',
          'crc32',
          '--algo',
          'sha1',
          '--algo',
          'sha256',
          '--algo',
          'blake3',
          '--no-extract',
          '--threads',
          '4',
        ];

        const firstResult = await worker.runJson(threadedChecksumArgs);
        assertRunJsonSucceeded(firstResult, {
          command: 'checksum',
        });

        await waitForCondition(() => probeMessages.length > countAfterInit, {
          label: 'thread-worker pool growth',
        });
        const countAfterFirstRun = probeMessages.length;

        const secondResult = await worker.runJson(threadedChecksumArgs);
        assertRunJsonSucceeded(secondResult, {
          command: 'checksum',
        });

        await delay(150);
        expect(probeMessages.length).toBe(countAfterFirstRun);
      }, {
        initOptions: {
          defaultThreads: 2,
          threadWorkerUrl: probeWorkerUrl,
          wasmUrl: new URL('../rom-weaver-cli-threaded.wasm', import.meta.url).href,
        },
      });
    } finally {
      probeChannel.removeEventListener('message', onProbeMessage);
      probeChannel.close();
    }
  });

  it('threaded browser runner keeps default nested-thread scratch setup below legacy 256-per-thread behavior', async () => {
    await withTempFixture(async ({ dir, init, worker, opfsHandle }) => {
      expect(init.threaded).toBe(true);
      const sourcePath = joinGuestPath(dir, 'threaded-scratch-default-source.bin');
      await writeGuestPatternFile(opfsHandle, sourcePath, 32 * 1024 * 1024);

      let runSettled = false;
      const resultPromise = worker.runJson(
        [
          'checksum',
          sourcePath,
          '--algo',
          'crc32',
          '--algo',
          'sha1',
          '--algo',
          'sha256',
          '--algo',
          'blake3',
          '--no-extract',
          '--threads',
          '4',
        ],
      ).finally(() => {
        runSettled = true;
      });
      const peakScratchFiles = await observeScratchPeak(opfsHandle, {
        isDone: () => runSettled,
      });
      const result = await resultPromise;
      const terminal = assertRunJsonSucceeded(result, { command: 'checksum' });
      const scratchCountAfterFirstRun = await countScratchFiles(opfsHandle);

      expect(terminal.effective_threads).toBeGreaterThan(1);
      expect(peakScratchFiles).toBeGreaterThan(256);
      expect(peakScratchFiles).toBeLessThan(512);
      expect(scratchCountAfterFirstRun).toBeGreaterThan(256);
      expect(scratchCountAfterFirstRun).toBeLessThan(512);

      const second = await worker.runJson([
        'checksum',
        sourcePath,
        '--algo',
        'crc32',
        '--algo',
        'sha1',
        '--algo',
        'sha256',
        '--algo',
        'blake3',
        '--no-extract',
        '--threads',
        '4',
      ]);
      assertRunJsonSucceeded(second, { command: 'checksum' });
      expect(await countScratchFiles(opfsHandle)).toBe(scratchCountAfterFirstRun);
    }, {
      initOptions: {
        wasmUrl: new URL('../rom-weaver-cli-threaded.wasm', import.meta.url).href,
      },
    });
  });

  it('threaded browser runner applies explicit scratchFilePoolSize overrides to nested thread mounts', async () => {
    await withTempFixture(async ({ dir, init, worker, opfsHandle }) => {
      expect(init.threaded).toBe(true);
      const sourcePath = joinGuestPath(dir, 'threaded-scratch-override-source.bin');
      await writeGuestPatternFile(opfsHandle, sourcePath, 32 * 1024 * 1024);

      let runSettled = false;
      const resultPromise = worker.runJson(
        [
          'checksum',
          sourcePath,
          '--algo',
          'crc32',
          '--algo',
          'sha1',
          '--algo',
          'sha256',
          '--algo',
          'blake3',
          '--no-extract',
          '--threads',
          '4',
        ],
        {
          scratchFilePoolSize: 0,
        },
      ).finally(() => {
        runSettled = true;
      });
      const peakScratchFiles = await observeScratchPeak(opfsHandle, {
        isDone: () => runSettled,
      });
      const result = await resultPromise;
      const terminal = assertRunJsonSucceeded(result, { command: 'checksum' });

      expect(terminal.effective_threads).toBeGreaterThan(1);
      expect(peakScratchFiles).toBe(0);
      expect(await countScratchFiles(opfsHandle)).toBe(0);
    }, {
      initOptions: {
        wasmUrl: new URL('../rom-weaver-cli-threaded.wasm', import.meta.url).href,
      },
    });
  });

  it('runner rejects missing wasm artifacts', async () => {
    await expect(
      withTempFixture(async () => {}, {
        initOptions: {
          wasmUrl: new URL('../missing-rom-weaver-cli.wasm', import.meta.url).href,
        },
      }),
    ).rejects.toThrow(/failed to fetch wasm module/i);
  });

  it('runner stdin normalization accepts supported types and rejects invalid input', async () => {
    await withTempFixture(async ({ worker }) => {
      const unknownCommand = ['definitely-not-a-command'];
      const validStdinValues = [
        'stdin text',
        new Uint8Array([1, 2, 3]),
        new Uint8Array([4, 5, 6]).buffer,
      ];

      for (const stdin of validStdinValues) {
        const result = await worker.run(unknownCommand, { stdin });
        expect(result.exitCode).not.toBe(0);
        expect(result.ok).toBe(false);
      }

      await expect(
        worker.run(unknownCommand, { stdin: 123 }),
      ).rejects.toThrow(/stdin must be a string, Uint8Array, ArrayBuffer, or undefined/i);
    });
  });

  it('runJson stays stable across repeated wasm 7z codec create calls', async () => {
    await withTempFixture(async ({ dir, workDir, worker, opfsHandle }) => {
      const sourcePath = joinGuestPath(dir, 'repeat-lzma-source.bin');
      const sourceData = new Uint8Array(256 * 1024);
      for (let index = 0; index < sourceData.length; index += 1) {
        sourceData[index] = index % 251;
      }
      await writeGuestFile(opfsHandle, sourcePath, sourceData);

      for (const codec of ['store', 'deflate', 'bzip2', 'zstd', 'ppmd', 'lzma', 'lzma2']) {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const archivePath = joinGuestPath(workDir, `repeat-${codec}-${attempt}.7z`);
          const resolvedCodec = codec === 'store' ? codec : `${codec}:6`;
          const command = [
            'compress',
            sourcePath,
            '--format',
            '7z',
            '--output',
            archivePath,
            '--codec',
            resolvedCodec,
            '--threads',
            '1',
          ];
          const result = await worker.runJson(command);
          assertRunJsonSucceeded(result, { command: 'compress' });
        }
      }
    });
  });

  it('survives large-file memory pressure workloads without worker crashes', async () => {
    await withTempFixture(async ({ dir, workDir, worker, opfsHandle }) => {
      const sourcePath = joinGuestPath(dir, 'large-memory-source.bin');
      await writeGuestPatternFile(opfsHandle, sourcePath, 64 * 1024 * 1024);

      const archivePath = joinGuestPath(workDir, 'large-memory.gz');
      const extractDir = joinGuestPath(workDir, 'large-memory-extract');
      const extractedPath = joinGuestPath(extractDir, 'large-memory');

      await runCompressExtractChecksumSequence({
        worker,
        sourcePath,
        archivePath,
        extractDir,
        extractedPath,
      });
    });
  });

  it.runIf(RUN_1GB_STRESS)(
    'survives 1 GiB compress extract checksum and 100MB-class xdelta apply workload',
    async () => {
      await withTempFixture(async ({ dir, workDir, worker, opfsHandle }) => {
        const oneGiB = 1024 * 1024 * 1024;
        const mutatedTailBytes = 100 * 1024 * 1024;
        const sourcePath = joinGuestPath(dir, 'stress-1gb-source.bin');
        const modifiedPath = joinGuestPath(dir, 'stress-1gb-modified.bin');
        const archivePath = joinGuestPath(workDir, 'stress-1gb.gz');
        const extractDir = joinGuestPath(workDir, 'stress-1gb-extract');
        const extractedPath = joinGuestPath(extractDir, 'stress-1gb');
        const patchPath = joinGuestPath(workDir, 'stress-1gb-tail.xdelta');
        const appliedPath = joinGuestPath(workDir, 'stress-1gb-applied.bin');

        await writeGuestPatternFile(opfsHandle, sourcePath, oneGiB, {
          chunkSizeBytes: 4 * 1024 * 1024,
        });
        await writeGuestPatternFile(opfsHandle, modifiedPath, oneGiB, {
          chunkSizeBytes: 4 * 1024 * 1024,
          mutateFromOffset: oneGiB - mutatedTailBytes,
          mutateAdd: 29,
        });

        await runCompressExtractChecksumSequence({
          worker,
          sourcePath,
          archivePath,
          extractDir,
          extractedPath,
        });

        assertRunJsonSucceeded(
          await worker.runJson([
            'patch-create',
            '--original',
            sourcePath,
            '--modified',
            modifiedPath,
            '--format',
            'xdelta',
            '--output',
            patchPath,
            '--threads',
            '1',
          ]),
          { command: 'patch-create' },
        );

        const patchSize = await getGuestFileSize(opfsHandle, patchPath);
        expect(patchSize).toBeGreaterThan(80 * 1024 * 1024);

        assertRunJsonSucceeded(
          await worker.runJson([
            'patch-apply',
            '--input',
            extractedPath,
            '--patch',
            patchPath,
            '--output',
            appliedPath,
            '--threads',
            '1',
            '--no-compress',
          ]),
          { command: 'patch-apply' },
        );

        assertRunJsonSucceeded(
          await worker.runJson([
            'checksum',
            appliedPath,
            '--algo',
            'crc32',
            '--no-extract',
          ]),
          { command: 'checksum' },
        );
      });
    },
    45 * 60 * 1000,
  );
});

describe('rom-weaver-wasm browser worker client parity', () => {
  it('browser worker client initializes and runs checksum with runJson', async () => {
    await withTempFixture(async ({ init, sourcePath, worker }) => {
      expect(init.threaded).toBe(false);
      expect(init.wasmUrl).toContain('rom-weaver-cli.wasm');
      let streamedEvents = 0;
      const result = await worker.runJson(
        ['checksum', sourcePath, '--algo', 'crc32', '--no-extract'],
        {
          onEvent() {
            streamedEvents += 1;
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(streamedEvents).toBeGreaterThan(0);
      const terminal = result.events.at(-1);
      expect(terminal.status).toBe('succeeded');
      expect(terminal.command).toBe('checksum');

      const disposed = await worker.dispose();
      expect(disposed.disposed).toBe(true);
    }, {
      prefix: 'rom-weaver-wasm-worker-test-',
      sourceContents: 'rom-weaver worker fixture',
    });
  });

  it('browser worker client rejects runJson before init', async () => {
    const client = createBrowserWorkerClient();
    try {
      await expect(
        client.runJson(['checksum', '/work/does-not-exist.bin', '--algo', 'crc32', '--no-extract']),
      ).rejects.toMatchObject({
        kind: 'worker',
      });
    } finally {
      client.terminate();
    }
  });

  it('browser worker client rejects unsupported worker modes with typed kind', async () => {
    const client = createBrowserWorkerClient();
    try {
      await expect(
        client._send({ type: 'init', mode: 'invalid-mode', options: {} }),
      ).rejects.toMatchObject({
        kind: 'worker',
      });
    } finally {
      client.terminate();
    }
  });

  it('browser worker client rejects structured-clone init failures without single-thread fallback', async () => {
    const worker = new CloneFailingInitWorker();
    const client = new BrowserRomWeaverWorkerClient(worker, { defaultThreads: 4 });
    try {
      await expect(
        client.init({
          runtimeMounts: ['/work'],
          threadedWasmUrl: 'threaded.wasm',
          wasmUrl: 'single.wasm',
          workGuestPath: '/work',
        }),
      ).rejects.toMatchObject({
        kind: 'worker',
        name: 'DataCloneError',
      });

      const initMessages = worker.messages.filter((message) => message.type === 'init');
      expect(initMessages).toHaveLength(1);
      expect(initMessages[0].options).toMatchObject({ defaultThreads: 4 });
      expect(initMessages[0].options.preferThreadedWasm).not.toBe(false);
    } finally {
      client.terminate();
    }
  });

  it('browser worker client handles concurrent runJson calls after init', async () => {
    await withTempFixture(async ({ worker, opfsHandle, dir }) => {
      const sourceAPath = joinGuestPath(dir, 'a.bin');
      const sourceBPath = joinGuestPath(dir, 'b.bin');
      await writeGuestFile(opfsHandle, sourceAPath, toBytes('parallel fixture a'));
      await writeGuestFile(opfsHandle, sourceBPath, toBytes('parallel fixture b'));

      const [resultA, resultB] = await Promise.all([
        worker.runJson(['checksum', sourceAPath, '--algo', 'crc32', '--no-extract']),
        worker.runJson(['checksum', sourceBPath, '--algo', 'crc32', '--no-extract']),
      ]);

      for (const result of [resultA, resultB]) {
        assertRunJsonSucceeded(result, {
          command: 'checksum',
        });
      }
    });
  });

  it('browser worker client streams progress events for compress, extract, and patch-apply', async () => {
    await withTempFixture(async ({ dir, sourcePath, worker, opfsHandle }) => {
      await runMatrix(runProgressMatrix, worker, {
        opfsHandle,
        dir,
        sourcePath,
        appliedOutputName: 'patched-output',
      });
    }, {
      prefix: 'rom-weaver-wasm-worker-progress-',
      sourceFileName: 'source.bin',
      sourceContents: 'worker progress fixture',
    });
  });

  it('browser worker client integration matrix covers chd, zip, and patch wasm paths', async () => {
    await withTempFixture(async ({ dir, sourcePath, worker, opfsHandle, fixtures }) => {
      await runMatrix(runPatchMatrix, worker, {
        opfsHandle,
        dir,
        sourcePath,
        fixtures,
      });
    }, {
      prefix: 'rom-weaver-wasm-worker-matrix-',
      sourceFileName: 'source.bin',
      sourceContents: 'rom-weaver worker matrix fixture',
    });
  });

  it('browser worker client full format matrix covers patch and container registries', async () => {
    await withTempFixture(async ({ dir, worker, opfsHandle, fixtures }) => {
      await runMatrix(runFullFormatMatrix, worker, {
        opfsHandle,
        dir,
        fixtures,
      });
    }, {
      prefix: 'rom-weaver-wasm-worker-full-matrix-',
      sourceFileName: 'source.bin',
      sourceContents: 'rom-weaver worker full matrix fixture',
    });
  });
});
