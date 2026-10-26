import { afterEach, beforeEach, expect, it } from "vitest";
import { createBrowserWasiThreadWorkerPool } from "../../src/wasm/browser-wasi-thread-pool.ts";
import { createThreadIdState } from "../../src/wasm/browser-wasi-thread-protocol.ts";
import { createBrowserWasiThreadSpawner } from "../../src/wasm/browser-wasi-thread-spawner.ts";
import { assertRunJsonSucceeded, joinGuestPath, withTempFixture, writeGuestPatternFile } from "./test-helpers.mjs";

const MIB = 1024 * 1024;
const PROBE_CHANNEL_NAME = "rom-weaver-thread-worker-probe-channel";
const PROBE_WORKER_URL = new URL("./browser-wasi-thread-worker-probe.mjs", import.meta.url).href;
const THREAD_SPAWN_IMPORT = [{ kind: "function", module: "wasi", name: "thread-spawn" }];
const EMPTY_WASM_MODULE = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
// Two requested threads size a pool command to six shells.
const TWO_THREAD_REQUEST = { command: { args: { threads: 2 }, type: "checksum" }, output: {} };
const POOL_SIZE = 6;

let unhandledRejections = [];
const recordRejection = (event) => unhandledRejections.push(event.reason);

beforeEach(() => {
  unhandledRejections = [];
  window.addEventListener("unhandledrejection", recordRejection);
});

afterEach(() => {
  window.removeEventListener("unhandledrejection", recordRejection);
  expect(unhandledRejections).toEqual([]);
});

/** A pool spawner as the runner builds it, plus the pool command it created, without running a guest. */
async function createPooledSpawner(pool, mountRootRelativeParts) {
  let command = null;
  const spawner = createBrowserWasiThreadSpawner({
    moduleImports: THREAD_SPAWN_IMPORT,
    runtime: {
      mountRootRelativeParts: { "/work": mountRootRelativeParts },
      request: TWO_THREAD_REQUEST,
      runtimeMounts: ["/work"],
    },
    threadIdState: createThreadIdState(),
    threadWorkerPool: {
      ...pool,
      createCommand: (options) => {
        command = pool.createCommand(options);
        return command;
      },
    },
    wasmMemory: new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }),
    wasmModule: await WebAssembly.compile(EMPTY_WASM_MODULE),
  });
  await spawner.ready;
  return { command, spawner };
}

it("a shell that fails to prime fails the command with its own error and is then reused", async () => {
  const pool = createBrowserWasiThreadWorkerPool({ initialSize: 0 });
  try {
    const broken = await createPooledSpawner(pool, [`missing-${crypto.randomUUID()}`]);
    expect(broken.command.slots).toHaveLength(POOL_SIZE);
    // What the guest's first spawn does: post the command, so every shell primes against a mount that is gone.
    broken.command.arm();
    await expect.poll(() => broken.command.slots.every((slot) => slot.failure), { timeout: 30_000 }).toBe(true);
    const failure = broken.command.slots[0].failure;
    expect(failure.name).toBe("NotFoundError");
    expect(failure.message).toMatch(/^browser wasi thread worker \d+ failed .*tid=ready/);

    await expect(broken.spawner.waitForWorkers()).rejects.toBe(failure);
    expect(pool.isReady(POOL_SIZE)).toBe(true);

    const healthy = await createPooledSpawner(pool, []);
    expect(healthy.command.slots.map((slot) => slot.shell)).toEqual(broken.command.slots.map((slot) => slot.shell));
    healthy.command.arm();
    await expect(healthy.spawner.waitForWorkers()).resolves.toBeUndefined();
    expect(healthy.command.slots.every((slot) => slot.primed && !slot.failure)).toBe(true);
  } finally {
    await pool.dispose();
  }
}, 60_000);

it("shuts down shells that are still priming and hands them to the next command", async () => {
  const pool = createBrowserWasiThreadWorkerPool({ initialSize: 0 });
  try {
    const first = await createPooledSpawner(pool, []);
    first.command.arm();
    // The shells cannot have answered yet, so every slot is shut down before it primed.
    expect(first.command.slots.some((slot) => slot.primed)).toBe(false);

    await expect(first.spawner.waitForWorkers()).resolves.toBeUndefined();
    // Each shell finished priming, then found SHUTDOWN rather than a request and returned its command.
    expect(first.command.slots.every((slot) => slot.primed && !slot.failure)).toBe(true);
    expect(pool.isReady(POOL_SIZE)).toBe(true);

    const second = await createPooledSpawner(pool, []);
    expect(second.command.slots.map((slot) => slot.shell)).toEqual(first.command.slots.map((slot) => slot.shell));
    // Never armed: shutdown releases the claimed shells without messaging them.
    await expect(second.spawner.waitForWorkers()).resolves.toBeUndefined();
    expect(second.command.slots.some((slot) => slot.armed)).toBe(false);
    expect(pool.isReady(POOL_SIZE)).toBe(true);
  } finally {
    await pool.dispose();
  }
}, 60_000);

function checksumArgs(path, threads) {
  return [
    "checksum",
    "--input",
    path,
    "--algo",
    "crc32",
    "--algo",
    "md5",
    "--algo",
    "sha1",
    "--no-extract",
    "--threads",
    String(threads),
  ];
}

async function tracedRun(worker, args) {
  const trace = [];
  const result = await worker.runJson(args, { onTraceNonJsonLine: (line) => trace.push(String(line)) });
  const terminal = assertRunJsonSucceeded(result, { command: "checksum" });
  return { checksums: terminal.details?.checksums, trace };
}

const traceIndex = (trace, pattern) => trace.findIndex((line) => pattern.test(line));

it("a threaded run posts to its shells only once the guest spawns", async () => {
  const probeChannel = new BroadcastChannel(PROBE_CHANNEL_NAME);
  const payloads = [];
  probeChannel.addEventListener("message", (event) => {
    if (event.data?.type === "thread-worker-payload") payloads.push(event.data);
  });
  try {
    await withTempFixture(
      async ({ dir, opfsHandle, worker }) => {
        const smallPath = joinGuestPath(dir, "small.bin");
        const largePath = joinGuestPath(dir, "large.bin");
        await writeGuestPatternFile(opfsHandle, smallPath, MIB);
        await writeGuestPatternFile(opfsHandle, largePath, 16 * MIB);

        // A small checksum hashes inline: its 16-thread budget claims shells but never sends them the command.
        const small = await tracedRun(worker, checksumArgs(smallPath, 16));
        expect(traceIndex(small.trace, /\[perf\] thread pool command ready id=\d+ slots=20 /)).toBeGreaterThanOrEqual(
          0,
        );
        expect(traceIndex(small.trace, /thread spawn requested/)).toBe(-1);
        expect(traceIndex(small.trace, /\[perf\] thread pool command armed/)).toBe(-1);
        const smallSerial = await tracedRun(worker, checksumArgs(smallPath, 1));
        expect(small.checksums).toEqual(smallSerial.checksums);
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(payloads).toEqual([]);

        // The large checksum spawns, so the shells are armed from inside the guest and still prime when it first spawns.
        const large = await tracedRun(worker, checksumArgs(largePath, 16));
        const started = traceIndex(large.trace, /\[perf\] wasi\.start start/);
        const armed = traceIndex(large.trace, /\[perf\] thread pool command armed id=\d+ slots=20 /);
        expect(started).toBeGreaterThanOrEqual(0);
        expect(armed).toBeGreaterThan(started);
        expect(large.trace.filter((line) => /thread spawn acked/.test(line)).length).toBeGreaterThan(0);
        // The shells prewarmed at init are reused: arming creates no worker.
        expect(large.trace.some((line) => /\[perf\] thread workers created=0 /.test(line))).toBe(true);
        await expect.poll(() => payloads.length).toBeGreaterThan(0);
        const largeSerial = await tracedRun(worker, checksumArgs(largePath, 1));
        expect(large.checksums).toEqual(largeSerial.checksums);
        // A one-thread budget claims no shell at all.
        expect(
          traceIndex(largeSerial.trace, /\[perf\] thread pool command ready id=\d+ slots=0 /),
        ).toBeGreaterThanOrEqual(0);
        expect(traceIndex(largeSerial.trace, /\[perf\] thread pool command armed/)).toBe(-1);
      },
      {
        clientOptions: { defaultThreads: 16 },
        initOptions: { defaultThreads: 16, threadWorkerUrl: PROBE_WORKER_URL },
      },
    );
  } finally {
    probeChannel.close();
  }
}, 120_000);
