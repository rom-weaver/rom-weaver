import { describe, expect, it, vi } from "vitest";
import { createBrowserWasiThreadWorkerPool } from "../../src/wasm/browser-wasi-thread-pool.ts";
import { createRomWeaverBrowserOpfs } from "../../src/wasm/rom-weaver-browser-opfs-api.ts";
import {
  BrowserRomWeaverWorkerClient,
  createBrowserWorkerClient,
} from "../../src/wasm/workers/browser-worker-client.ts";
import {
  assertRunJsonSucceeded,
  getGuestFileSize,
  joinGuestPath,
  runFullFormatMatrix,
  runPatchMatrix,
  runProgressMatrix,
  toBytes,
  toTypedRunInput,
  withTempFixture,
  writeGuestFile,
  writeGuestGeneratedFile,
  writeGuestPatternFile,
} from "./test-helpers.mjs";

const RUN_1GB_STRESS = typeof __ROM_WEAVER_WASM_STRESS_1GB__ !== "undefined" && __ROM_WEAVER_WASM_STRESS_1GB__ === true;
const RUN_EXHAUSTIVE = typeof __ROM_WEAVER_WASM_EXHAUSTIVE__ !== "undefined" && __ROM_WEAVER_WASM_EXHAUSTIVE__ === true;
const LONG_MATRIX_TIMEOUT_MS = 10 * 60 * 1000;
// Minimal WASI module: write a running JSON line, spin, then write succeeded.
const STREAMING_WASI_MODULE_BYTES = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 12, 2, 96, 4, 127, 127, 127, 127, 1, 127, 96, 0, 0, 2, 35, 1, 22, 119, 97, 115, 105,
  95, 115, 110, 97, 112, 115, 104, 111, 116, 95, 112, 114, 101, 118, 105, 101, 119, 49, 8, 102, 100, 95, 119, 114, 105,
  116, 101, 0, 0, 3, 2, 1, 1, 5, 3, 1, 0, 1, 7, 19, 2, 6, 109, 101, 109, 111, 114, 121, 2, 0, 6, 95, 115, 116, 97, 114,
  116, 0, 1, 10, 88, 1, 86, 1, 1, 127, 65, 0, 65, 32, 54, 2, 0, 65, 4, 65, 63, 54, 2, 0, 65, 1, 65, 0, 65, 1, 65, 8, 16,
  0, 26, 65, 0, 33, 0, 2, 64, 3, 64, 32, 0, 65, 128, 202, 181, 238, 1, 79, 13, 1, 32, 0, 65, 1, 106, 33, 0, 12, 0, 11,
  0, 11, 65, 0, 65, 128, 1, 54, 2, 0, 65, 4, 65, 62, 54, 2, 0, 65, 1, 65, 0, 65, 1, 65, 8, 16, 0, 26, 11, 11, 137, 1, 2,
  0, 65, 32, 11, 63, 123, 34, 99, 111, 109, 109, 97, 110, 100, 34, 58, 34, 115, 116, 114, 101, 97, 109, 45, 116, 101,
  115, 116, 34, 44, 34, 115, 116, 97, 116, 117, 115, 34, 58, 34, 114, 117, 110, 110, 105, 110, 103, 34, 44, 34, 108, 97,
  98, 101, 108, 34, 58, 34, 115, 116, 97, 114, 116, 101, 100, 34, 125, 10, 0, 65, 128, 1, 11, 62, 123, 34, 99, 111, 109,
  109, 97, 110, 100, 34, 58, 34, 115, 116, 114, 101, 97, 109, 45, 116, 101, 115, 116, 34, 44, 34, 115, 116, 97, 116,
  117, 115, 34, 58, 34, 115, 117, 99, 99, 101, 101, 100, 101, 100, 34, 44, 34, 108, 97, 98, 101, 108, 34, 58, 34, 100,
  111, 110, 101, 34, 125, 10,
]);

function runJsonFromWorker(worker) {
  return (args, options) => worker.runJson(toTypedRunInput(args), options);
}

function delay(ms, value = null) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

async function waitForCondition(predicate, { timeoutMs = 10000, pollMs = 20, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(pollMs);
  }
  throw new Error(`timed out waiting for ${label} after ${timeoutMs}ms`);
}

class CloneFailingInitWorker {
  constructor() {
    this.messages = [];
    this.listeners = new Map();
  }

  postMessage(message) {
    this.messages.push(message);
    if (message.type === "init") {
      throw new DOMException("The object could not be cloned.", "DataCloneError");
    }
    queueMicrotask(() => {
      this.dispatchMessage({
        mode: "browser-opfs",
        requestId: message.requestId,
        threaded: false,
        type: message.type === "dispose" ? "disposed" : "ready",
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
    for (const listener of this.listeners.get("message") || []) {
      listener({ data });
    }
  }

  terminate() {
    this.listeners.clear();
  }
}

class FlakyPoolShellWorker {
  static created = [];
  static failedFirstShell = false;

  constructor() {
    this.index = FlakyPoolShellWorker.created.length;
    this.listeners = new Map();
    this.messages = [];
    this.terminated = false;
    FlakyPoolShellWorker.created.push(this);
  }

  postMessage(message) {
    this.messages.push(message);
    if (message?.mode === "pool-shell") {
      queueMicrotask(() => {
        if (this.terminated) return;
        if (!FlakyPoolShellWorker.failedFirstShell) {
          FlakyPoolShellWorker.failedFirstShell = true;
          this.dispatchError(new Error("synthetic shell-ready failure"));
          return;
        }
        this.dispatchMessage({ type: "shell-ready" });
      });
      return;
    }
    if (message?.mode === "pool-command") {
      queueMicrotask(() => {
        if (this.terminated) return;
        this.dispatchMessage({ commandId: message.commandId, type: "ready" });
        queueMicrotask(() => {
          if (!this.terminated) this.dispatchMessage({ commandId: message.commandId, type: "command-done" });
        });
      });
      return;
    }
    if (message?.mode === "shutdown") this.terminate();
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
    for (const listener of this.listeners.get("message") || []) {
      listener({ data });
    }
  }

  dispatchError(error) {
    const event = {
      error,
      message: error.message,
      preventDefault() {
        // synthetic worker error events have no default action to cancel
      },
    };
    for (const listener of this.listeners.get("error") || []) {
      listener(event);
    }
  }

  terminate() {
    this.terminated = true;
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

async function runCompressExtractChecksumSequence({ worker, sourcePath, archivePath, extractDir, extractedPath }) {
  await runJsonAndAssert(
    worker,
    ["compress", sourcePath, "--format", "zip", "--output", archivePath, "--threads", "1"],
    "compress",
  );

  await runJsonAndAssert(worker, ["extract", archivePath, "--out-dir", extractDir, "--threads", "1"], "extract");

  await runJsonAndAssert(worker, ["checksum", sourcePath, "--algo", "crc32", "--no-extract"], "checksum");

  await runJsonAndAssert(worker, ["checksum", extractedPath, "--algo", "crc32", "--no-extract"], "checksum");
}

describe("rom-weaver-wasm browser runner parity", () => {
  it("thread-worker pool replaces shells that fail before becoming ready", async () => {
    FlakyPoolShellWorker.created = [];
    FlakyPoolShellWorker.failedFirstShell = false;
    vi.stubGlobal("Worker", FlakyPoolShellWorker);

    const traceLines = [];
    const pool = createBrowserWasiThreadWorkerPool({
      initialSize: 0,
      threadWorkerUrl: "synthetic-thread-worker.js",
    });
    try {
      const command = pool.createCommand({
        debugWasi: false,
        envList: [],
        poolSize: 3,
        runtime: {},
        streamBroadcastChannelName: "",
        streamRequestId: null,
        threadIdState: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
        trace: (line) => traceLines.push(line),
        wasiArgs: [],
        wasmMemory: new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }),
        wasmModule: await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
      });

      await command.ready;

      expect(command.slots).toHaveLength(3);
      expect(FlakyPoolShellWorker.created).toHaveLength(4);
      expect(FlakyPoolShellWorker.created[0]?.terminated).toBe(true);
      expect(traceLines.some((line) => line.includes("thread pool replacing worker=0"))).toBe(true);

      await command.shutdown();
    } finally {
      await pool.dispose().catch(() => undefined);
      vi.unstubAllGlobals();
    }
  });

  it("makes OPFS sync writes readable after close without an explicit flush", async () => {
    const workerSource = `
      self.onmessage = async () => {
        const rootHandle = await navigator.storage.getDirectory();
        const directoryName = 'rom-weaver-close-no-flush-' + Date.now() + '-' + Math.random().toString(16).slice(2);
        const directoryHandle = await rootHandle.getDirectoryHandle(directoryName, { create: true });
        try {
          const fileHandle = await directoryHandle.getFileHandle('output.bin', { create: true });
          const accessHandle = await fileHandle.createSyncAccessHandle();
          const bytes = new TextEncoder().encode('close makes sync writes visible');
          accessHandle.truncate(0);
          accessHandle.write(bytes, { at: 0 });
          accessHandle.close();

          const file = await fileHandle.getFile();
          const actual = new Uint8Array(await file.arrayBuffer());
          self.postMessage({
            bytes: Array.from(actual),
            expected: Array.from(bytes),
            ok: file.size === bytes.byteLength && actual.every((value, index) => value === bytes[index]),
            size: file.size,
          });
        } catch (error) {
          self.postMessage({
            error: error instanceof Error ? error.message : String(error),
            ok: false,
          });
        } finally {
          await rootHandle.removeEntry(directoryName, { recursive: true }).catch(() => undefined);
        }
      };
    `;
    const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    const worker = new Worker(workerUrl, { type: "module" });
    try {
      const result = await new Promise((resolve, reject) => {
        worker.onmessage = (event) => resolve(event.data);
        worker.onerror = (event) => reject(event.error || new Error(event.message));
        worker.postMessage({});
      });
      expect(result.error || "").toBe("");
      expect(result.ok).toBe(true);
      expect(result.bytes).toEqual(result.expected);
    } finally {
      worker.terminate();
      URL.revokeObjectURL(workerUrl);
    }
  });

  it("requires createRomWeaverBrowserOpfs to run in a dedicated worker", async () => {
    await expect(createRomWeaverBrowserOpfs()).rejects.toThrow(/Dedicated Worker/i);
  });

  it("runJson executes checksum through browser worker runner", async () => {
    await withTempFixture(async ({ sourcePath, worker }) => {
      const result = await worker.runJson(["checksum", sourcePath, "--algo", "crc32", "--no-extract"]);

      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(result.request.output.json).toBe(true);
      expect(Array.isArray(result.events)).toBe(true);
      expect(result.events.length).toBeGreaterThan(0);

      const terminal = result.events.at(-1);
      expect(terminal.status).toBe("succeeded");
      expect(terminal.command).toBe("checksum");
      expect(terminal.elapsed_ms).toEqual(expect.any(Number));
    });
  });

  it("runJson streams stdout events before the wasm process completes", async () => {
    const module = await WebAssembly.compile(STREAMING_WASI_MODULE_BYTES);
    await withTempFixture(
      async ({ sourcePath, worker }) => {
        let resolveFirstEvent;
        const firstEvent = new Promise((resolve) => {
          resolveFirstEvent = resolve;
        });
        const resultPromise = worker.runJson(["checksum", sourcePath, "--algo", "crc32", "--no-extract"], {
          onEvent(event) {
            if (event?.command === "stream-test" && event.status === "running") {
              resolveFirstEvent(event);
            }
          },
        });

        const streamedEvent = await Promise.race([firstEvent, delay(250)]);
        expect(streamedEvent).toMatchObject({
          command: "stream-test",
          status: "running",
        });
        await expect(Promise.race([resultPromise.then(() => "settled"), delay(0, "pending")])).resolves.toBe("pending");

        const result = await resultPromise;
        assertRunJsonSucceeded(result, { command: "stream-test" });
      },
      {
        initOptions: {
          module,
        },
      },
    );
  });

  it("browser client passes default threads when command args omit them", async () => {
    await withTempFixture(
      async ({ sourcePath, worker }) => {
        const result = await worker.runJson(["checksum", sourcePath, "--algo", "crc32", "--no-extract"]);

        const terminal = assertRunJsonSucceeded(result, { command: "checksum" });
        expect(result.command.args.threads).toBe(3);
        expect(terminal.requested_threads).toBe(3);
      },
      {
        clientOptions: {
          defaultThreads: 3,
        },
      },
    );
  });

  it("browser client does not override explicit command thread args", async () => {
    await withTempFixture(
      async ({ sourcePath, worker }) => {
        const result = await worker.runJson([
          "checksum",
          sourcePath,
          "--algo",
          "crc32",
          "--no-extract",
          "--threads",
          "2",
        ]);

        const terminal = assertRunJsonSucceeded(result, { command: "checksum" });
        expect(result.command.args.threads).toBe(2);
        expect(terminal.requested_threads).toBe(2);
      },
      {
        clientOptions: {
          defaultThreads: 3,
        },
      },
    );
  });

  it("browser client normalizes explicit auto thread args to the browser default threads", async () => {
    await withTempFixture(
      async ({ sourcePath, worker }) => {
        const result = await worker.runJson([
          "checksum",
          sourcePath,
          "--algo",
          "crc32",
          "--no-extract",
          "--threads",
          "auto",
        ]);

        const terminal = assertRunJsonSucceeded(result, { command: "checksum" });
        expect(result.command.args.threads).toBe(3);
        expect(terminal.requested_threads).toBe(3);
      },
      {
        clientOptions: {
          defaultThreads: 3,
        },
      },
    );
  });

  it("browser client normalizes explicit --threads=auto args to the browser default threads", async () => {
    await withTempFixture(
      async ({ sourcePath, worker }) => {
        const result = await worker.runJson([
          "checksum",
          sourcePath,
          "--algo",
          "crc32",
          "--no-extract",
          "--threads=auto",
        ]);

        const terminal = assertRunJsonSucceeded(result, { command: "checksum" });
        expect(result.command.args.threads).toBe(3);
        expect(terminal.requested_threads).toBe(3);
      },
      {
        clientOptions: {
          defaultThreads: 3,
        },
      },
    );
  });

  it("browser client accepts explicit command thread args above the default thread count", async () => {
    await withTempFixture(
      async ({ sourcePath, worker }) => {
        const result = await worker.runJson([
          "checksum",
          sourcePath,
          "--algo",
          "crc32",
          "--no-extract",
          "--threads",
          "8",
        ]);

        const terminal = assertRunJsonSucceeded(result, { command: "checksum" });
        expect(result.command.args.threads).toBe(8);
        expect(terminal.requested_threads).toBe(8);
      },
      {
        clientOptions: {
          defaultThreads: 3,
        },
      },
    );
  });

  it("browser client accepts configured default threads above the default thread count", async () => {
    await withTempFixture(
      async ({ sourcePath, worker }) => {
        const result = await worker.runJson(["checksum", sourcePath, "--algo", "crc32", "--no-extract"]);

        const terminal = assertRunJsonSucceeded(result, { command: "checksum" });
        expect(result.command.args.threads).toBe(8);
        expect(terminal.requested_threads).toBe(8);
      },
      {
        clientOptions: {
          defaultThreads: 8,
        },
      },
    );
  });

  it("uses a single writable /work mount", async () => {
    await withTempFixture(async ({ sourcePath, worker, opfsHandle }) => {
      const outputPath = joinGuestPath("/work", "single-mount-output.zip");
      const result = await worker.runJson([
        "compress",
        sourcePath,
        "--format",
        "zip",
        "--output",
        outputPath,
        "--threads",
        "1",
      ]);
      assertRunJsonSucceeded(result, { command: "compress" });
      expect(await getGuestFileSize(opfsHandle, outputPath)).toBeGreaterThan(0);
    });
  });

  it("runJson reports typed request errors for unknown commands", async () => {
    await withTempFixture(async ({ worker }) => {
      await expect(worker.runJson(["definitely-not-a-command"])).rejects.toThrow(
        /typed command has unsupported.*type/i,
      );
    });
  });

  it("browser runner supports mounted guest paths", async () => {
    await withTempFixture(async ({ worker, opfsHandle, dir }) => {
      const nestedSourcePath = joinGuestPath(dir, "roms", "input.bin");
      await writeGuestFile(opfsHandle, nestedSourcePath, toBytes("nested guest fixture"));

      const result = await worker.runJson(["checksum", nestedSourcePath, "--algo", "crc32", "--no-extract"]);

      assertRunJsonSucceeded(result, {
        command: "checksum",
      });
    });
  });

  it("runJson emits trace events when --trace is enabled", async () => {
    await withTempFixture(async ({ sourcePath, worker }) => {
      let streamedTraceEvents = 0;
      let streamedTraceLines = 0;
      const result = await worker.runJson(["--trace", "checksum", sourcePath, "--algo", "crc32", "--no-extract"], {
        onTraceEvent() {
          streamedTraceEvents += 1;
        },
        onTraceNonJsonLine() {
          streamedTraceLines += 1;
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.ok).toBe(true);
      expect(result.traceEvents.length + result.traceNonJsonLines.length).toBeGreaterThan(0);
      expect(streamedTraceEvents + streamedTraceLines).toBeGreaterThan(0);
    });
  });

  it("runJson emits progress events for compress, extract, and patch-apply", async () => {
    await withTempFixture(async ({ dir, sourcePath, worker, opfsHandle }) => {
      await runMatrix(runProgressMatrix, worker, {
        appliedOutputName: "applied-output",
        dir,
        opfsHandle,
        sourcePath,
      });
    });
  });

  it(
    "runJson integration matrix covers chd, zip, and patch wasm paths",
    async () => {
      await withTempFixture(async ({ dir, sourcePath, worker, opfsHandle, fixtures }) => {
        await runMatrix(runPatchMatrix, worker, {
          dir,
          fixtures,
          opfsHandle,
          sourcePath,
        });
      });
    },
    LONG_MATRIX_TIMEOUT_MS,
  );

  it(
    "runJson full format matrix covers patch and container registries",
    async () => {
      await withTempFixture(async ({ dir, worker, opfsHandle, fixtures }) => {
        await runMatrix(runFullFormatMatrix, worker, {
          dir,
          fixtures,
          opfsHandle,
        });
      });
    },
    LONG_MATRIX_TIMEOUT_MS,
  );

  it.runIf(RUN_EXHAUSTIVE)(
    "runJson exhaustive matrix covers valid codec level and thread interactions",
    async () => {
      await withTempFixture(async ({ dir, worker, opfsHandle, fixtures }) => {
        await runMatrix(runFullFormatMatrix, worker, {
          dir,
          fixtures,
          opfsHandle,
          profile: "exhaustive",
        });
      });
    },
    45 * 60 * 1000,
  );

  it("runner supports explicit wasm module URL paths", async () => {
    await withTempFixture(
      async ({ init, sourcePath, worker }) => {
        const canUseThreadedWasm = typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated === true;
        expect(init.threaded).toBe(canUseThreadedWasm);
        expect(init.wasmUrl).toMatch(/rom-weaver-app(?:-threaded)?\.wasm/);
        const result = await worker.runJson(["checksum", sourcePath, "--algo", "crc32", "--no-extract"]);

        assertRunJsonSucceeded(result, {
          command: "checksum",
        });
      },
      {
        initOptions: {
          wasmUrl: new URL("../../src/wasm/rom-weaver-app.wasm", import.meta.url).href,
        },
      },
    );
  });

  it("runner auto-selects threaded wasm when runtime capability is available", async () => {
    await withTempFixture(
      async ({ init }) => {
        const canUseThreadedWasm = typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated === true;
        expect(init.threaded).toBe(canUseThreadedWasm);
        expect(init.wasmUrl).toMatch(/rom-weaver-app(?:-threaded)?\.wasm/);
      },
      {
        initOptions: {
          wasmUrl: new URL("../../src/wasm/rom-weaver-app.wasm", import.meta.url).href,
        },
      },
    );
  });

  it("runner initializes the configured wasm module URL", async () => {
    await withTempFixture(
      async ({ init, sourcePath, worker }) => {
        expect(init.threaded).toBe(true);
        expect(init.wasmUrl).toMatch(/rom-weaver-app(?:-threaded)?\.wasm/);

        const result = await worker.runJson([
          "checksum",
          sourcePath,
          "--algo",
          "crc32",
          "--no-extract",
          "--threads",
          "1",
        ]);

        assertRunJsonSucceeded(result, {
          command: "checksum",
        });
      },
      {
        initOptions: {
          wasmUrl: new URL("../../src/wasm/rom-weaver-app.wasm", import.meta.url).href,
        },
      },
    );
  });

  it("threaded browser runner executes parallel checksum work with wasm workers", async () => {
    await withTempFixture(
      async ({ dir, init, worker, opfsHandle }) => {
        expect(init.threaded).toBe(true);
        const sourcePath = joinGuestPath(dir, "threaded-checksum-source.bin");
        await writeGuestPatternFile(opfsHandle, sourcePath, 32 * 1024 * 1024);

        let resolveRunningEvent;
        const firstRunningEvent = new Promise((resolve) => {
          resolveRunningEvent = resolve;
        });
        const resultPromise = worker.runJson(
          [
            "checksum",
            sourcePath,
            "--algo",
            "crc32",
            "--algo",
            "sha1",
            "--algo",
            "sha256",
            "--algo",
            "blake3",
            "--no-extract",
            "--threads",
            "4",
          ],
          {
            onEvent(event) {
              if (
                event?.command === "checksum" &&
                event.status === "running" &&
                typeof event.percent === "number" &&
                event.percent > 0 &&
                event.percent < 100
              ) {
                resolveRunningEvent(event);
              }
            },
          },
        );

        const streamedEvent = await Promise.race([firstRunningEvent, delay(5000)]);
        await expect(Promise.race([resultPromise.then(() => "settled"), delay(0, "pending")])).resolves.toBe("pending");

        const result = await resultPromise;
        expect(streamedEvent).toMatchObject({
          command: "checksum",
          status: "running",
        });

        const terminal = assertRunJsonSucceeded(result, {
          command: "checksum",
        });
        expect(terminal.requested_threads).toBe(4);
        expect(terminal.effective_threads).toBeGreaterThan(1);
        expect(terminal.used_parallelism).toBe(true);
      },
      {
        initOptions: {
          wasmUrl: new URL("../../src/wasm/rom-weaver-app.wasm", import.meta.url).href,
        },
      },
    );
  });

  it(
    "threaded browser runner emits 7z lzma2 level 5 codec progress for large compress",
    async () => {
      await withTempFixture(
        async ({ dir, init, worker, opfsHandle }) => {
          expect(init.threaded).toBe(true);
          const sourceSize = 32 * 1024 * 1024;
          const sourcePath = joinGuestPath(dir, "threaded-7z-lzma2-large-source.bin");
          const archivePath = joinGuestPath(dir, "threaded-7z-lzma2-large.7z");
          const extractDir = joinGuestPath(dir, "threaded-7z-lzma2-large-extract");
          await writeGuestPatternFile(opfsHandle, sourcePath, sourceSize);

          const events = [];
          let resolveCodecEvent;
          const firstCodecEvent = new Promise((resolve) => {
            resolveCodecEvent = resolve;
          });
          const isCodecProgressEvent = (event) =>
            event.command === "compress" &&
            event.status === "running" &&
            event.format === "7z" &&
            event.stage === "create" &&
            event.label === "compressing `7z`" &&
            typeof event.percent === "number" &&
            event.percent > 0 &&
            event.percent < 100;
          const isQueueingInputEvent = (event) =>
            event.command === "compress" &&
            event.status === "running" &&
            event.format === "7z" &&
            event.stage === "create" &&
            event.label === "queueing input for `7z`";
          const resultPromise = worker.runJson(
            [
              "compress",
              sourcePath,
              "--format",
              "7z",
              "--codec",
              "lzma2:5",
              "--output",
              archivePath,
              "--threads",
              "10",
            ],
            {
              onEvent(event) {
                events.push(event);
                if (isCodecProgressEvent(event)) resolveCodecEvent(event);
              },
            },
          );

          const streamedCodecEvent = await Promise.race([firstCodecEvent, delay(15000)]);
          expect(streamedCodecEvent).toMatchObject({
            command: "compress",
            format: "7z",
            label: "compressing `7z`",
            status: "running",
          });
          const result = await resultPromise;
          const terminal = assertRunJsonSucceeded(result, {
            command: "compress",
          });
          expect(terminal.requested_threads).toBe(10);
          expect(terminal.effective_threads).toBeGreaterThan(1);
          expect(terminal.used_parallelism).toBe(true);
          expect(await getGuestFileSize(opfsHandle, archivePath)).toBeGreaterThan(0);
          const extractResult = await worker.runJson([
            "extract",
            archivePath,
            "--out-dir",
            extractDir,
            "--threads",
            "1",
          ]);
          assertRunJsonSucceeded(extractResult, {
            command: "extract",
          });
          expect(
            await getGuestFileSize(opfsHandle, joinGuestPath(extractDir, "threaded-7z-lzma2-large-source.bin")),
          ).toBe(sourceSize);
          expect(events.some((event) => isQueueingInputEvent(event))).toBe(false);
          expect(events.some((event) => isCodecProgressEvent(event))).toBe(true);
          expect(
            events.some(
              (event) =>
                event.command === "compress" &&
                event.status === "running" &&
                event.format === "7z" &&
                event.stage === "write" &&
                event.percent === null &&
                Number(event.details?.compressedBytesWritten || 0) > 0,
            ),
          ).toBe(false);
        },
        {
          initOptions: {
            wasmUrl: new URL("../../src/wasm/rom-weaver-app.wasm", import.meta.url).href,
          },
        },
      );
    },
    LONG_MATRIX_TIMEOUT_MS,
  );

  it(
    "threaded browser runner compresses small 7z lzma2 with constrained shared memory",
    async () => {
      await withTempFixture(
        async ({ dir, init, worker, opfsHandle }) => {
          expect(init.threaded).toBe(true);
          const sourceSize = 1024 * 1024;
          const sourcePath = joinGuestPath(dir, "threaded-7z-lzma2-constrained-source.bin");
          const archivePath = joinGuestPath(dir, "threaded-7z-lzma2-constrained.7z");
          const extractDir = joinGuestPath(dir, "threaded-7z-lzma2-constrained-extract");
          await writeGuestPatternFile(opfsHandle, sourcePath, sourceSize);

          const compressResult = await worker.runJson([
            "compress",
            sourcePath,
            "--format",
            "7z",
            "--codec",
            "lzma2:9",
            "--output",
            archivePath,
            "--threads",
            "4",
          ]);
          assertRunJsonSucceeded(compressResult, {
            command: "compress",
          });
          expect(await getGuestFileSize(opfsHandle, archivePath)).toBeGreaterThan(0);

          const extractResult = await worker.runJson([
            "extract",
            archivePath,
            "--out-dir",
            extractDir,
            "--threads",
            "1",
          ]);
          assertRunJsonSucceeded(extractResult, {
            command: "extract",
          });
          expect(
            await getGuestFileSize(opfsHandle, joinGuestPath(extractDir, "threaded-7z-lzma2-constrained-source.bin")),
          ).toBe(sourceSize);
        },
        {
          initOptions: {
            sharedMemoryMaximumPages: 16384,
            wasmUrl: new URL("../../src/wasm/rom-weaver-app.wasm", import.meta.url).href,
          },
        },
      );
    },
    LONG_MATRIX_TIMEOUT_MS,
  );

  it(
    "threaded browser runner compresses reduced-dict 7z lzma2 level 9 without worker traps",
    async () => {
      await withTempFixture(
        async ({ dir, init, worker, opfsHandle }) => {
          expect(init.threaded).toBe(true);
          const sourceSize = 32 * 1024 * 1024;
          const sourcePath = joinGuestPath(dir, "threaded-7z-lzma2-level9-source.bin");
          const archivePath = joinGuestPath(dir, "threaded-7z-lzma2-level9.7z");
          const extractDir = joinGuestPath(dir, "threaded-7z-lzma2-level9-extract");
          await writeGuestGeneratedFile(
            opfsHandle,
            sourcePath,
            sourceSize,
            (chunk) => {
              chunk.fill(0);
            },
            { chunkSizeBytes: 4 * 1024 * 1024 },
          );

          const events = [];
          const result = await worker.runJson(
            [
              "compress",
              sourcePath,
              "--format",
              "7z",
              "--codec",
              "lzma2:9",
              "--output",
              archivePath,
              "--threads",
              "10",
            ],
            {
              env: {
                // Keep this stress case on the parallel path by overriding the host-reported
                // memory budget for two 32 MiB level-9 LZMA2 dictionaries.
                ROM_WEAVER_7Z_MEM_BUDGET_MB: "1024",
              },
              onEvent(event) {
                events.push(event);
              },
            },
          );
          const terminal = assertRunJsonSucceeded(result, {
            command: "compress",
          });
          expect(terminal.requested_threads).toBe(10);
          expect(terminal.effective_threads).toBeGreaterThan(1);
          expect(terminal.used_parallelism).toBe(true);
          expect(await getGuestFileSize(opfsHandle, archivePath)).toBeGreaterThan(0);
          const codecProgressPercents = events
            .filter(
              (event) =>
                event.command === "compress" &&
                event.status === "running" &&
                event.format === "7z" &&
                event.stage === "create" &&
                event.label === "compressing `7z`" &&
                typeof event.percent === "number" &&
                event.percent > 0 &&
                event.percent < 100,
            )
            .map((event) => event.percent);
          expect(new Set(codecProgressPercents).size).toBeGreaterThanOrEqual(2);
          expect(codecProgressPercents.at(-1)).toBe(99);

          const extractResult = await worker.runJson([
            "extract",
            archivePath,
            "--out-dir",
            extractDir,
            "--threads",
            "1",
          ]);
          assertRunJsonSucceeded(extractResult, {
            command: "extract",
          });
          expect(
            await getGuestFileSize(opfsHandle, joinGuestPath(extractDir, "threaded-7z-lzma2-level9-source.bin")),
          ).toBe(sourceSize);
        },
        {
          initOptions: {
            wasmUrl: new URL("../../src/wasm/rom-weaver-app.wasm", import.meta.url).href,
          },
        },
      );
    },
    LONG_MATRIX_TIMEOUT_MS,
  );

  it("threaded browser runner reuses thread-worker pool shells across repeated commands", async () => {
    const probeChannelName = "rom-weaver-thread-worker-probe-channel";
    const probeWorkerUrl = new URL("./browser-wasi-thread-worker-probe.mjs", import.meta.url).href;
    const probeChannel = new BroadcastChannel(probeChannelName);
    const probeMessages = [];
    const onProbeMessage = (event) => {
      if (event?.data?.type === "thread-worker-spawned") {
        probeMessages.push(event.data);
      }
    };
    probeChannel.addEventListener("message", onProbeMessage);

    try {
      await withTempFixture(
        async ({ dir, init, worker, opfsHandle }) => {
          expect(init.threaded).toBe(true);
          const sourcePath = joinGuestPath(dir, "threaded-worker-pool-reuse-source.bin");
          await writeGuestPatternFile(opfsHandle, sourcePath, 16 * 1024 * 1024);

          await waitForCondition(() => probeMessages.length >= 2, {
            label: "thread-worker prewarm",
          });
          const countAfterInit = probeMessages.length;
          expect(countAfterInit).toBeGreaterThanOrEqual(2);

          const threadedChecksumArgs = [
            "checksum",
            sourcePath,
            "--algo",
            "crc32",
            "--algo",
            "sha1",
            "--algo",
            "sha256",
            "--algo",
            "blake3",
            "--no-extract",
            "--threads",
            "4",
          ];

          const firstResult = await worker.runJson(threadedChecksumArgs);
          assertRunJsonSucceeded(firstResult, {
            command: "checksum",
          });

          await delay(150);
          const countAfterFirstRun = probeMessages.length;
          expect(countAfterFirstRun).toBeGreaterThanOrEqual(countAfterInit);

          const secondResult = await worker.runJson(threadedChecksumArgs);
          assertRunJsonSucceeded(secondResult, {
            command: "checksum",
          });

          await delay(150);
          expect(probeMessages.length).toBe(countAfterFirstRun);
        },
        {
          initOptions: {
            defaultThreads: 2,
            threadWorkerUrl: probeWorkerUrl,
            wasmUrl: new URL("../../src/wasm/rom-weaver-app.wasm", import.meta.url).href,
          },
        },
      );
    } finally {
      probeChannel.removeEventListener("message", onProbeMessage);
      probeChannel.close();
    }
  });

  it("threaded browser runner applies safe Rayon global thread env defaults in pooled workers", async () => {
    const probeChannelName = "rom-weaver-thread-worker-probe-channel";
    const probeWorkerUrl = new URL("./browser-wasi-thread-worker-probe.mjs", import.meta.url).href;
    const probeChannel = new BroadcastChannel(probeChannelName);
    const payloadMessages = [];
    const onProbeMessage = (event) => {
      if (event?.data?.type === "thread-worker-payload") payloadMessages.push(event.data);
    };
    probeChannel.addEventListener("message", onProbeMessage);

    try {
      await withTempFixture(
        async ({ dir, init, worker, opfsHandle }) => {
          expect(init.threaded).toBe(true);
          const sourcePath = joinGuestPath(dir, "threaded-rayon-env-source.bin");
          await writeGuestPatternFile(opfsHandle, sourcePath, 8 * 1024 * 1024);

          const checksumArgs = [
            "checksum",
            sourcePath,
            "--algo",
            "crc32",
            "--algo",
            "sha1",
            "--algo",
            "sha256",
            "--algo",
            "blake3",
            "--no-extract",
            "--threads",
            "4",
          ];

          payloadMessages.length = 0;
          const defaultResult = await worker.runJson(checksumArgs);
          assertRunJsonSucceeded(defaultResult, { command: "checksum" });
          await waitForCondition(() => payloadMessages.length > 0, {
            label: "thread-worker payload env defaults",
          });
          const defaultEnvEntries = payloadMessages.flatMap((entry) =>
            Array.isArray(entry.envList) ? entry.envList : [],
          );
          expect(defaultEnvEntries).toContain("RAYON_NUM_THREADS=4");
          expect(defaultEnvEntries).toContain("RAYON_RS_NUM_CPUS=4");

          payloadMessages.length = 0;
          const overriddenResult = await worker.runJson(checksumArgs, {
            env: {
              RAYON_NUM_THREADS: "3",
            },
          });
          assertRunJsonSucceeded(overriddenResult, { command: "checksum" });
          await waitForCondition(() => payloadMessages.length > 0, {
            label: "thread-worker payload env overrides",
          });
          const overriddenEnvEntries = payloadMessages.flatMap((entry) =>
            Array.isArray(entry.envList) ? entry.envList : [],
          );
          expect(overriddenEnvEntries).toContain("RAYON_NUM_THREADS=3");
          expect(overriddenEnvEntries).not.toContain("RAYON_NUM_THREADS=4");
        },
        {
          initOptions: {
            defaultThreads: 2,
            threadWorkerUrl: probeWorkerUrl,
            wasmUrl: new URL("../../src/wasm/rom-weaver-app.wasm", import.meta.url).href,
          },
        },
      );
    } finally {
      probeChannel.removeEventListener("message", onProbeMessage);
      probeChannel.close();
    }
  });

  it("runner rejects missing wasm artifacts", async () => {
    await expect(
      withTempFixture(
        async () => {
          // no-op: init is expected to fail before this callback runs
        },
        {
          initOptions: {
            wasmUrl: new URL("../../src/wasm/missing-rom-weaver-app.wasm", import.meta.url).href,
          },
        },
      ),
    ).rejects.toThrow(/failed to fetch wasm module/i);
  });

  it("runner typed input normalization rejects invalid command objects", async () => {
    await withTempFixture(async ({ worker }) => {
      await expect(worker.runJson({ args: {}, type: "definitely-not-a-command" })).rejects.toThrow(
        /typed command has unsupported.*type/i,
      );

      await expect(worker.runJson({ args: {} })).rejects.toThrow(/typed command requires a string `type` field/i);
    });
  });

  it(
    "runJson stays stable across repeated wasm 7z codec create calls",
    async () => {
      await withTempFixture(async ({ dir, workDir, worker, opfsHandle }) => {
        const sourcePath = joinGuestPath(dir, "repeat-lzma-source.bin");
        const sourceData = new Uint8Array(256 * 1024);
        for (let index = 0; index < sourceData.length; index += 1) {
          sourceData[index] = index % 251;
        }
        await writeGuestFile(opfsHandle, sourcePath, sourceData);

        for (const codec of ["lzma2"]) {
          for (let attempt = 0; attempt < 4; attempt += 1) {
            const archivePath = joinGuestPath(workDir, `repeat-${codec}-${attempt}.7z`);
            const resolvedCodec = codec === "store" ? codec : `${codec}:6`;
            const command = [
              "compress",
              sourcePath,
              "--format",
              "7z",
              "--output",
              archivePath,
              "--codec",
              resolvedCodec,
              "--threads",
              "1",
            ];
            const result = await worker.runJson(command);
            assertRunJsonSucceeded(result, { command: "compress" });
          }
        }
      });
    },
    LONG_MATRIX_TIMEOUT_MS,
  );

  it("survives large-file memory pressure workloads without worker crashes", async () => {
    await withTempFixture(async ({ dir, workDir, worker, opfsHandle }) => {
      const sourcePath = joinGuestPath(dir, "large-memory-source.bin");
      await writeGuestPatternFile(opfsHandle, sourcePath, 64 * 1024 * 1024);

      const archivePath = joinGuestPath(workDir, "large-memory.zip");
      const extractDir = joinGuestPath(workDir, "large-memory-extract");
      const extractedPath = joinGuestPath(extractDir, "large-memory-source.bin");

      await runCompressExtractChecksumSequence({
        archivePath,
        extractDir,
        extractedPath,
        sourcePath,
        worker,
      });
    });
  });

  it.runIf(RUN_1GB_STRESS)(
    "survives 1 GiB compress extract checksum and 100MB-class xdelta apply workload",
    async () => {
      await withTempFixture(async ({ dir, workDir, worker, opfsHandle }) => {
        const oneGiB = 1024 * 1024 * 1024;
        const mutatedTailBytes = 100 * 1024 * 1024;
        const sourcePath = joinGuestPath(dir, "stress-1gb-source.bin");
        const modifiedPath = joinGuestPath(dir, "stress-1gb-modified.bin");
        const archivePath = joinGuestPath(workDir, "stress-1gb.zip");
        const extractDir = joinGuestPath(workDir, "stress-1gb-extract");
        const extractedPath = joinGuestPath(extractDir, "stress-1gb-source.bin");
        const patchPath = joinGuestPath(workDir, "stress-1gb-tail.xdelta");
        const appliedPath = joinGuestPath(workDir, "stress-1gb-applied.bin");

        await writeGuestPatternFile(opfsHandle, sourcePath, oneGiB, {
          chunkSizeBytes: 4 * 1024 * 1024,
        });
        await writeGuestPatternFile(opfsHandle, modifiedPath, oneGiB, {
          chunkSizeBytes: 4 * 1024 * 1024,
          mutateFromOffset: oneGiB - mutatedTailBytes,
        });

        await runCompressExtractChecksumSequence({
          archivePath,
          extractDir,
          extractedPath,
          sourcePath,
          worker,
        });

        assertRunJsonSucceeded(
          await worker.runJson([
            "patch",
            "create",
            "--original",
            sourcePath,
            "--modified",
            modifiedPath,
            "--format",
            "xdelta",
            "--output",
            patchPath,
            "--threads",
            "1",
          ]),
          { command: "patch-create" },
        );

        const patchSize = await getGuestFileSize(opfsHandle, patchPath);
        expect(patchSize).toBeGreaterThan(80 * 1024 * 1024);

        assertRunJsonSucceeded(
          await worker.runJson([
            "patch",
            "apply",
            "--input",
            extractedPath,
            "--patch",
            patchPath,
            "--output",
            appliedPath,
            "--threads",
            "1",
            "--no-compress",
          ]),
          { command: "patch-apply" },
        );

        assertRunJsonSucceeded(await worker.runJson(["checksum", appliedPath, "--algo", "crc32", "--no-extract"]), {
          command: "checksum",
        });
      });
    },
    45 * 60 * 1000,
  );
});

describe("rom-weaver-wasm browser worker client parity", () => {
  it("browser worker client initializes and runs checksum with runJson", async () => {
    await withTempFixture(
      async ({ init, sourcePath, worker }) => {
        const canUseThreadedWasm = typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated === true;
        expect(init.threaded).toBe(canUseThreadedWasm);
        expect(init.wasmUrl).toMatch(/rom-weaver-app(?:-threaded)?\.wasm/);
        let streamedEvents = 0;
        const result = await worker.runJson(["checksum", sourcePath, "--algo", "crc32", "--no-extract"], {
          onEvent() {
            streamedEvents += 1;
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.ok).toBe(true);
        expect(streamedEvents).toBeGreaterThan(0);
        const terminal = result.events.at(-1);
        expect(terminal.status).toBe("succeeded");
        expect(terminal.command).toBe("checksum");

        const disposed = await worker.dispose();
        expect(disposed.disposed).toBe(true);
      },
      {
        prefix: "rom-weaver-wasm-worker-test-",
        sourceContents: "rom-weaver worker fixture",
      },
    );
  });

  it("browser worker client rejects runJson before init", async () => {
    const client = createBrowserWorkerClient();
    try {
      await expect(
        client.runJson(["checksum", "/work/does-not-exist.bin", "--algo", "crc32", "--no-extract"]),
      ).rejects.toMatchObject({
        kind: "worker",
      });
    } finally {
      client.terminate();
    }
  });

  it("browser worker client rejects unsupported worker modes with typed kind", async () => {
    const client = createBrowserWorkerClient();
    try {
      await expect(client._send({ mode: "invalid-mode", options: {}, type: "init" })).rejects.toMatchObject({
        kind: "worker",
      });
    } finally {
      client.terminate();
    }
  });

  it("browser worker client rejects structured-clone init failures without retrying init options", async () => {
    const worker = new CloneFailingInitWorker();
    const client = new BrowserRomWeaverWorkerClient(worker, { defaultThreads: 4 });
    try {
      await expect(
        client.init({
          runtimeMounts: ["/work"],
          wasmUrl: "rom-weaver-app.wasm",
          workGuestPath: "/work",
        }),
      ).rejects.toMatchObject({
        kind: "worker",
        name: "DataCloneError",
      });

      const initMessages = worker.messages.filter((message) => message.type === "init");
      expect(initMessages).toHaveLength(1);
      expect(initMessages[0].options).toMatchObject({ defaultThreads: 4 });
    } finally {
      client.terminate();
    }
  });

  it("browser worker client handles concurrent runJson calls after init", async () => {
    await withTempFixture(async ({ worker, opfsHandle, dir }) => {
      const sourceAPath = joinGuestPath(dir, "a.bin");
      const sourceBPath = joinGuestPath(dir, "b.bin");
      await writeGuestFile(opfsHandle, sourceAPath, toBytes("parallel fixture a"));
      await writeGuestFile(opfsHandle, sourceBPath, toBytes("parallel fixture b"));

      const [resultA, resultB] = await Promise.all([
        worker.runJson(["checksum", sourceAPath, "--algo", "crc32", "--no-extract"]),
        worker.runJson(["checksum", sourceBPath, "--algo", "crc32", "--no-extract"]),
      ]);

      for (const result of [resultA, resultB]) {
        assertRunJsonSucceeded(result, {
          command: "checksum",
        });
      }
    });
  });

  it("browser worker client streams progress events for compress, extract, and patch-apply", async () => {
    await withTempFixture(
      async ({ dir, sourcePath, worker, opfsHandle }) => {
        await runMatrix(runProgressMatrix, worker, {
          appliedOutputName: "patched-output",
          dir,
          opfsHandle,
          sourcePath,
        });
      },
      {
        prefix: "rom-weaver-wasm-worker-progress-",
        sourceContents: "worker progress fixture",
        sourceFileName: "source.bin",
      },
    );
  });

  it(
    "browser worker client integration matrix covers chd, zip, and patch wasm paths",
    async () => {
      await withTempFixture(
        async ({ dir, sourcePath, worker, opfsHandle, fixtures }) => {
          await runMatrix(runPatchMatrix, worker, {
            dir,
            fixtures,
            opfsHandle,
            sourcePath,
          });
        },
        {
          prefix: "rom-weaver-wasm-worker-matrix-",
          sourceContents: "rom-weaver worker matrix fixture",
          sourceFileName: "source.bin",
        },
      );
    },
    LONG_MATRIX_TIMEOUT_MS,
  );

  it(
    "browser worker client full format matrix covers patch and container registries",
    async () => {
      await withTempFixture(
        async ({ dir, worker, opfsHandle, fixtures }) => {
          await runMatrix(runFullFormatMatrix, worker, {
            dir,
            fixtures,
            opfsHandle,
          });
        },
        {
          prefix: "rom-weaver-wasm-worker-full-matrix-",
          sourceContents: "rom-weaver worker full matrix fixture",
          sourceFileName: "source.bin",
        },
      );
    },
    LONG_MATRIX_TIMEOUT_MS,
  );
});
