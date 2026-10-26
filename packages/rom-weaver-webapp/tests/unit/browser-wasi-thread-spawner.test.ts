import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NestedThreadWorkerSlot } from "../../src/wasm/browser-wasi-nested-thread-workers.ts";
import type { BrowserWasiThreadPoolCommand } from "../../src/wasm/browser-wasi-thread-pool.ts";
import {
  createThreadIdState,
  THREAD_SLOT_ERROR_INDEX,
  THREAD_SLOT_LENGTH,
  THREAD_SLOT_START_ARG_INDEX,
  THREAD_SLOT_STATE_FAILED,
  THREAD_SLOT_STATE_IDLE,
  THREAD_SLOT_STATE_INDEX,
  THREAD_SLOT_STATE_RUNNING,
  THREAD_SLOT_STATE_SHUTDOWN,
  THREAD_SLOT_TID_INDEX,
  type ThreadStartControl,
} from "../../src/wasm/browser-wasi-thread-protocol.ts";

const fake = vi.hoisted(() => ({
  ackError: null as Error | null,
  acquireError: null as Error | null,
  acquired: [] as { control: Int32Array; startArg: number; tid: number }[],
  drains: 0,
  listOptions: [] as Record<string, unknown>[],
  released: [] as (number | string)[],
  retired: [] as (number | string)[],
  slotState: 3,
}));

vi.mock("../../src/wasm/browser-wasi-nested-thread-workers.ts", () => ({
  acquireNestedThreadWorkerList: vi.fn((options: Record<string, unknown>) => {
    fake.listOptions.push(options);
    let nextIndex = 0;
    return {
      acquire: (tid: number, startArg: number) => {
        if (fake.acquireError) throw fake.acquireError;
        const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4));
        Atomics.store(control, 0, fake.slotState);
        fake.acquired.push({ control, startArg, tid });
        nextIndex += 1;
        return {
          busy: true,
          control,
          done: Promise.resolve(),
          failure: null,
          index: nextIndex,
          resolveDone: () => undefined,
          tid,
          worker: null,
        } as unknown as NestedThreadWorkerSlot;
      },
      drain: async () => {
        fake.drains += 1;
      },
      release: (slot: NestedThreadWorkerSlot) => fake.released.push(slot.index),
      retire: (slot: NestedThreadWorkerSlot) => fake.retired.push(slot.index),
    };
  }),
}));

// The real ack barrier blocks on Atomics.wait until a worker thread answers; no worker exists here,
// so the ack outcome is injected instead of simulated.
vi.mock("../../src/wasm/browser-wasi-thread-protocol.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/wasm/browser-wasi-thread-protocol.ts")>();
  return { ...actual, waitForThreadStartAck: vi.fn(() => fake.ackError) };
});

const { createBrowserWasiThreadSpawner } = await import("../../src/wasm/browser-wasi-thread-spawner.ts");

const THREAD_SPAWN_IMPORT: WebAssembly.ModuleImportDescriptor[] = [
  { kind: "function", module: "wasi", name: "thread-spawn" },
];

function makeControl(): ThreadStartControl {
  return new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * THREAD_SLOT_LENGTH)) as ThreadStartControl;
}

let wasmModule: WebAssembly.Module;
let wasmMemory: WebAssembly.Memory;
let trace: string[];

beforeEach(async () => {
  fake.ackError = null;
  fake.acquireError = null;
  fake.acquired.length = 0;
  fake.drains = 0;
  fake.listOptions.length = 0;
  fake.released.length = 0;
  fake.retired.length = 0;
  fake.slotState = THREAD_SLOT_STATE_RUNNING;
  trace = [];
  wasmModule = await WebAssembly.compile(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
  wasmMemory = new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const nestedSpawner = (overrides: Record<string, unknown> = {}) =>
  createBrowserWasiThreadSpawner({
    moduleImports: THREAD_SPAWN_IMPORT,
    threadIdState: createThreadIdState(),
    trace: (line) => trace.push(line),
    wasmMemory,
    wasmModule,
    ...overrides,
  });

function setAcquiredState(index: number, state: number) {
  const entry = fake.acquired[index];
  if (!entry) throw new Error(`no acquired worker at ${index}`);
  Atomics.store(entry.control, THREAD_SLOT_STATE_INDEX, state);
}

function setAllAcquiredStates(state: number) {
  for (const entry of fake.acquired) Atomics.store(entry.control, THREAD_SLOT_STATE_INDEX, state);
}

describe("createBrowserWasiThreadSpawner guards", () => {
  it("returns an ENOSYS stub when the module never imports wasi.thread-spawn", async () => {
    const spawner = createBrowserWasiThreadSpawner({
      moduleImports: [{ kind: "memory", module: "env", name: "memory" }],
      threadIdState: createThreadIdState(),
      wasmModule,
    });

    expect(spawner.spawn(0)).toBe(-52);
    await expect(spawner.ready).resolves.toBeUndefined();
    await expect(spawner.waitForWorkers()).resolves.toBeUndefined();
  });

  it("refuses a threaded module with no shared memory", () => {
    expect(() =>
      createBrowserWasiThreadSpawner({
        moduleImports: THREAD_SPAWN_IMPORT,
        threadIdState: createThreadIdState(),
        wasmModule,
      }),
    ).toThrow("threaded wasm module imports wasi.thread-spawn, but no shared WebAssembly.Memory was created");
  });

  it("refuses a memory that is not SharedArrayBuffer backed", () => {
    expect(() =>
      createBrowserWasiThreadSpawner({
        moduleImports: THREAD_SPAWN_IMPORT,
        threadIdState: createThreadIdState(),
        wasmMemory: new WebAssembly.Memory({ initial: 1 }),
        wasmModule,
      }),
    ).toThrow("threaded wasm requires shared memory backed by SharedArrayBuffer");
  });
});

describe("nested thread spawner", () => {
  it("dispatches a thread and returns its tid once the worker acks", () => {
    const spawner = nestedSpawner();

    const tid = spawner.spawn(1234);

    expect(tid).toBeGreaterThan(0);
    expect(fake.acquired).toMatchObject([{ startArg: 1234, tid }]);
    expect(trace.some((line) => line.includes(`thread spawn dispatched tid=${tid} worker=1`))).toBe(true);
    expect(trace.some((line) => line.includes(`thread spawn acked tid=${tid}`))).toBe(true);
  });

  it("returns a negative errno when the thread id counter is unusable", () => {
    const spawner = nestedSpawner({ threadIdState: new Int32Array(1) });

    expect(spawner.spawn(0)).toBe(-52);
    expect(fake.acquired).toHaveLength(0);
    expect(trace.some((line) => line.includes("thread spawn allocation failed errno=52"))).toBe(true);
  });

  it("reports the errno through the result pointer when the spawn fails", () => {
    fake.acquireError = new Error("worker limit reached");
    const spawner = nestedSpawner();

    expect(spawner.spawn(0, 32)).toBe(1);
    const result = new DataView(wasmMemory.buffer);
    expect(result.getInt32(32, true)).toBe(1);
    expect(result.getInt32(36, true)).toBe(6);
  });

  it("returns EAGAIN when no worker can be acquired", () => {
    fake.acquireError = new Error("worker limit reached");
    const spawner = nestedSpawner();

    expect(spawner.spawn(0)).toBe(-6);
    expect(trace.some((line) => line.includes("thread spawn worker acquire failed"))).toBe(true);
  });

  it("retires the worker and records the failure when the start ack fails", async () => {
    fake.ackError = new Error("start never acknowledged");
    const spawner = nestedSpawner();

    expect(spawner.spawn(0)).toBe(-6);
    expect(fake.retired).toEqual([1]);
    expect(trace.some((line) => line.includes("thread spawn ack failed"))).toBe(true);
    await expect(spawner.waitForWorkers()).rejects.toThrow("failed before completion: start never acknowledged");
  });

  it("writes the tid through the result pointer when the guest supplies one", () => {
    const spawner = nestedSpawner();

    expect(spawner.spawn(7, 16)).toBe(0);
    const result = new DataView(wasmMemory.buffer);
    // The guest result block is {isError: i32, tidOrErrno: i32}.
    expect(result.getInt32(16, true)).toBe(0);
    expect(result.getInt32(20, true)).toBeGreaterThan(0);
  });

  it("parks a finished worker on the next spawn and reports completion in waitForWorkers", async () => {
    const spawner = nestedSpawner();
    expect(spawner.spawn(0)).toBeGreaterThan(0);

    setAcquiredState(0, THREAD_SLOT_STATE_IDLE);
    spawner.spawn(1);
    expect(fake.released).toEqual([1]);

    setAllAcquiredStates(THREAD_SLOT_STATE_IDLE);
    await spawner.waitForWorkers();
    expect(fake.released).toEqual([1, 2]);
    expect(trace.some((line) => line.includes("thread completed tid="))).toBe(true);
  });

  it("retires a worker that failed after start and surfaces it from waitForWorkers", async () => {
    const spawner = nestedSpawner();
    spawner.spawn(0);
    setAcquiredState(0, THREAD_SLOT_STATE_FAILED);

    await expect(spawner.waitForWorkers()).rejects.toThrow(/failed before completion/);
    expect(fake.retired).toEqual([1]);
  });

  it("retires the sibling workers as soon as one thread fails", async () => {
    const spawner = nestedSpawner();
    spawner.spawn(0);
    spawner.spawn(1);
    setAcquiredState(0, THREAD_SLOT_STATE_FAILED);

    await expect(spawner.waitForWorkers()).rejects.toThrow(/failed before completion/);
    expect([...fake.retired].sort((left, right) => Number(left) - Number(right))).toEqual([1, 2]);
  });

  it("retires a sibling that failed while the next spawn is being dispatched", async () => {
    const spawner = nestedSpawner();
    spawner.spawn(0);
    setAcquiredState(0, THREAD_SLOT_STATE_FAILED);

    expect(spawner.spawn(1)).toBeGreaterThan(0);
    expect(fake.retired).toEqual([1]);

    setAcquiredState(1, THREAD_SLOT_STATE_IDLE);
    await expect(spawner.waitForWorkers()).rejects.toThrow(/failed before completion/);
  });

  it("drains its own worker list only when it owns one", async () => {
    const owning = nestedSpawner();
    await owning.waitForWorkers();
    expect(fake.drains).toBe(1);

    const borrowed = nestedSpawner({ allowWorkerPool: false });
    await borrowed.waitForWorkers();
    expect(fake.drains).toBe(1);
  });

  it("forwards the run identity to the nested worker list", () => {
    const runtime = { debugWasi: true, request: { command: { args: {}, type: "probe" }, output: {} } };
    nestedSpawner({ envList: ["A=1"], runtime, wasiArgs: ["rom-weaver"] });

    expect(fake.listOptions[0]).toMatchObject({
      debugWasi: true,
      envList: ["A=1"],
      runtime,
      wasiArgs: ["rom-weaver"],
    });
  });
});

type PooledSlot = {
  busy: boolean;
  control: ThreadStartControl;
  failure: Error | null;
  index: number;
  online: boolean;
  tid: number | null;
};

function makePooledCommand(slotCount: number, overrides: Partial<BrowserWasiThreadPoolCommand> = {}) {
  const slots: PooledSlot[] = Array.from({ length: slotCount }, (_value, index) => {
    const control = makeControl();
    Atomics.store(control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_IDLE);
    return { busy: false, control, failure: null, index, online: true, tid: null };
  });
  const shutdown = vi.fn(async () => undefined);
  return {
    command: {
      commandId: 42,
      ready: Promise.resolve(),
      shutdown,
      slots,
      ...overrides,
    } as unknown as BrowserWasiThreadPoolCommand,
    shutdown: overrides.shutdown ?? shutdown,
    slots,
  };
}

function pooledSpawner(command: BrowserWasiThreadPoolCommand, threadIdState: unknown = createThreadIdState()) {
  const createCommand = vi.fn(() => command);
  return {
    createCommand,
    spawner: createBrowserWasiThreadSpawner({
      moduleImports: THREAD_SPAWN_IMPORT,
      runtime: { request: { command: { args: { threads: 4 }, type: "compress" }, output: {} } },
      threadIdState,
      threadWorkerPool: {
        createCommand,
        dispose: async () => undefined,
        isReady: () => true,
        ready: Promise.resolve(),
        resolvedThreadWorkerUrl: "/thread-worker.js",
      },
      trace: (line) => trace.push(line),
      wasmMemory,
      wasmModule,
    }),
  };
}

function firstSlot(slots: PooledSlot[]): PooledSlot {
  const slot = slots[0];
  if (!slot) throw new Error("fixture must provide a slot");
  return slot;
}

describe("pooled thread spawner", () => {
  it("sizes the pool command from the run request", () => {
    const { command } = makePooledCommand(2);
    const { createCommand } = pooledSpawner(command);

    expect(createCommand).toHaveBeenCalledTimes(1);
    expect(createCommand.mock.calls[0]?.[0]).toMatchObject({ poolSize: 8 });
  });

  it("arms an idle slot and returns the tid once the worker acks", () => {
    const { command, slots } = makePooledCommand(2);
    const { spawner } = pooledSpawner(command);
    const armed = firstSlot(slots);

    const tid = spawner.spawn(99);

    expect(tid).toBeGreaterThan(0);
    expect(armed.busy).toBe(true);
    expect(armed.tid).toBe(tid);
    expect(Atomics.load(armed.control, THREAD_SLOT_TID_INDEX)).toBe(tid);
    expect(Atomics.load(armed.control, THREAD_SLOT_START_ARG_INDEX)).toBe(99);
    expect(Atomics.load(armed.control, THREAD_SLOT_ERROR_INDEX)).toBe(0);
    expect(trace.some((line) => line.includes(`thread spawn acked tid=${tid} worker=0 command=42`))).toBe(true);
  });

  it("returns a negative errno when the thread id counter is unusable", () => {
    const { command } = makePooledCommand(1);
    const { spawner } = pooledSpawner(command, null);

    expect(spawner.spawn(0)).toBe(-52);
    expect(trace.some((line) => line.includes("thread spawn allocation failed errno=52 command=42"))).toBe(true);
  });

  it("returns EAGAIN when every slot is offline", () => {
    const { command, slots } = makePooledCommand(1);
    for (const slot of slots) slot.online = false;
    const { spawner } = pooledSpawner(command);

    expect(spawner.spawn(0)).toBe(-6);
    expect(trace.some((line) => line.includes("thread spawn no idle pooled worker"))).toBe(true);
  });

  it("poisons a slot whose start is never acknowledged and drops it without blocking", async () => {
    fake.ackError = new Error("ack timed out");
    const { command, shutdown, slots } = makePooledCommand(1);
    const slot = firstSlot(slots);
    const { spawner } = pooledSpawner(command);

    expect(spawner.spawn(0)).toBe(-6);
    expect(Atomics.load(slot.control, THREAD_SLOT_STATE_INDEX)).toBe(THREAD_SLOT_STATE_SHUTDOWN);
    // The poisoned slot stays busy so no later spawn reuses it.
    expect(slot.busy).toBe(true);

    await expect(spawner.waitForWorkers()).rejects.toThrow("failed before completion: ack timed out");
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(trace.some((line) => line.includes("thread abandoned tid="))).toBe(true);
  });

  it("frees a completed slot and shuts the command down in waitForWorkers", async () => {
    const { command, shutdown, slots } = makePooledCommand(1);
    const slot = firstSlot(slots);
    const { spawner } = pooledSpawner(command);

    expect(spawner.spawn(0)).toBeGreaterThan(0);
    Atomics.store(slot.control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_IDLE);

    await spawner.waitForWorkers();
    expect(slot.busy).toBe(false);
    expect(slot.tid).toBeNull();
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(trace.some((line) => line.includes("thread wait done command=42"))).toBe(true);
  });

  it("surfaces a slot that failed after start", async () => {
    const { command, slots } = makePooledCommand(1);
    const slot = firstSlot(slots);
    const { spawner } = pooledSpawner(command);
    const tid = spawner.spawn(0);
    slot.failure = new Error("worker aborted");
    Atomics.store(slot.control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_FAILED);

    await expect(spawner.waitForWorkers()).rejects.toThrow(
      `wasi thread ${tid} failed before completion: worker aborted`,
    );
  });

  it("reaps a failed slot on the next spawn and refuses to dispatch after that failure", () => {
    const { command, slots } = makePooledCommand(1);
    const slot = firstSlot(slots);
    const { spawner } = pooledSpawner(command);
    spawner.spawn(0);
    Atomics.store(slot.control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_FAILED);

    expect(spawner.spawn(1)).toBe(-6);
    expect(slot.busy).toBe(false);
    expect(slot.tid).toBeNull();
  });

  it("reuses a slot that went idle between spawns", () => {
    const { command, slots } = makePooledCommand(1);
    const slot = firstSlot(slots);
    const { spawner } = pooledSpawner(command);

    const first = spawner.spawn(0);
    Atomics.store(slot.control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_IDLE);

    const second = spawner.spawn(1);
    expect(second).toBeGreaterThan(first);
    expect(slot.tid).toBe(second);
  });

  it("gives up with EAGAIN when every pooled worker stays busy", () => {
    const { command } = makePooledCommand(1);
    const { spawner } = pooledSpawner(command);

    expect(spawner.spawn(0)).toBeGreaterThan(0);
    // The saturation wait is Atomics.wait against a word only a real worker thread can change, so
    // the clock is moved past the deadline instead of spending it.
    let clockCalls = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      clockCalls += 1;
      return clockCalls === 1 ? 1_000_000 : 1_000_000 + clockCalls * 1_000_000;
    });

    // The single slot is still REQUESTED, so the second spawn has nothing to hand out.
    expect(spawner.spawn(1)).toBe(-6);
    expect(trace.some((line) => line.includes("waiting for idle pooled worker"))).toBe(true);
    expect(trace.some((line) => line.includes("wait for idle pooled worker timed out"))).toBe(true);
  });

  it("shuts the command down and rethrows when the pool command never becomes ready", async () => {
    const failure = new Error("pool never warmed");
    const shutdown = vi.fn(async () => undefined);
    const { command } = makePooledCommand(1, { ready: Promise.reject(failure), shutdown });
    const { spawner } = pooledSpawner(command);

    await expect(spawner.ready).rejects.toBe(failure);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("bounds the shutdown wait so a wedged worker cannot hang teardown", async () => {
    vi.useFakeTimers();
    const { command } = makePooledCommand(1, { shutdown: vi.fn(() => new Promise<void>(() => undefined)) });
    const { spawner } = pooledSpawner(command);

    const waited = spawner.waitForWorkers();
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(waited).resolves.toBeUndefined();
    expect(trace.some((line) => line.includes("thread pool command shutdown wait timed out command=42"))).toBe(true);
  });
});
