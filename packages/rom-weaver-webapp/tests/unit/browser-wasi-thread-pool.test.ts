import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ThreadPoolCommandSlot } from "../../src/wasm/browser-opfs-runtime-types.ts";
import {
  THREAD_SLOT_ERROR_INDEX,
  THREAD_SLOT_STATE_FAILED,
  THREAD_SLOT_STATE_IDLE,
  THREAD_SLOT_STATE_INDEX,
  THREAD_SLOT_STATE_RUNNING,
  THREAD_SLOT_STATE_SHUTDOWN,
} from "../../src/wasm/browser-wasi-thread-protocol.ts";

const probe = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("../../src/wasm/browser-wasi-thread-load-probe.ts", () => ({
  describeThreadWorkerErrorEvent: () => "event=Event(empty)",
  probeThreadWorkerLoadFailure: vi.fn((url: string) => {
    probe.calls.push(url);
  }),
}));

const { createBrowserWasiThreadWorkerPool, throwWithThreadFailure } =
  await import("../../src/wasm/browser-wasi-thread-pool.ts");

type Listener = (event: unknown) => void;

/** Stand-in for a dedicated Worker: records what the pool posts and lets a test drive its events. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  listeners = new Map<string, Listener[]>();
  posted: Record<string, unknown>[] = [];
  postMessageError: Error | null = null;
  terminateError: Error | null = null;
  terminated = false;

  constructor(
    readonly url: string,
    readonly options: unknown,
  ) {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  postMessage(message: Record<string, unknown>) {
    if (this.postMessageError) throw this.postMessageError;
    this.posted.push(message);
  }

  terminate() {
    if (this.terminateError) throw this.terminateError;
    this.terminated = true;
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  reply(data: unknown) {
    this.emit("message", { data });
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

let trace: string[];

function shellsOnline(count = FakeWorker.instances.length) {
  for (let index = 0; index < count; index += 1) {
    FakeWorker.instances[index]?.reply({ type: "shell-ready" });
  }
}

function commandReady(commandId: number, count = FakeWorker.instances.length) {
  for (let index = 0; index < count; index += 1) {
    FakeWorker.instances[index]?.reply({ commandId, type: "ready" });
  }
}

const wasmModule = {} as WebAssembly.Module;
const wasmMemory = {} as WebAssembly.Memory;

function commandOptions(overrides: Record<string, unknown> = {}) {
  return {
    debugWasi: false,
    envList: ["A=1"],
    poolSize: 1,
    runtime: undefined,
    threadIdState: null,
    trace: (line: string) => trace.push(line),
    wasiArgs: ["rom-weaver"],
    wasmMemory,
    wasmModule,
    ...overrides,
  };
}

// A shell the pool has given up on rejects its `ready` promise with nothing attached:
// once the replacement budget is spent, and when its worker refuses the handshake post.
// Both are the behaviour under test, so they are swallowed by name - any other
// unhandled rejection still fails the test that produced it.
const ABANDONED_SHELL_REJECTIONS = [/did not become ready within \d+ms/, /^worker is gone$/];
let unexpectedRejections: unknown[] = [];
const recordRejection = (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (!ABANDONED_SHELL_REJECTIONS.some((pattern) => pattern.test(message))) {
    unexpectedRejections.push(reason);
  }
};

beforeEach(() => {
  FakeWorker.instances = [];
  probe.calls = [];
  trace = [];
  unexpectedRejections = [];
  process.on("unhandledRejection", recordRejection);
  vi.stubGlobal("Worker", FakeWorker);
});

afterEach(() => {
  process.off("unhandledRejection", recordRejection);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(unexpectedRejections).toEqual([]);
});

describe("thread worker pool pre-warm", () => {
  it("creates no shell and resolves immediately for an empty pool", async () => {
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 0 });

    await expect(pool.ready).resolves.toBeUndefined();
    expect(FakeWorker.instances).toHaveLength(0);
    expect(pool.resolvedThreadWorkerUrl).toContain("thread-worker");
  });

  it("uses the configured worker url", () => {
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 0, threadWorkerUrl: "/custom-thread-worker.js" });

    expect(pool.resolvedThreadWorkerUrl).toBe("/custom-thread-worker.js");
  });

  it("starts the shells it was sized for and hands each one its pool-shell mode", async () => {
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 2 });

    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[0]?.options).toEqual({ type: "module" });
    expect(FakeWorker.instances[0]?.posted).toEqual([{ mode: "pool-shell" }]);

    shellsOnline();
    await expect(pool.ready).resolves.toBeUndefined();
    expect(pool.isReady(2)).toBe(true);
  });

  it("still resolves the pre-warm when every shell fails", async () => {
    vi.useFakeTimers();
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 1 });

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pool.ready).resolves.toBeUndefined();
  });
});

describe("thread worker pool isReady", () => {
  it("answers for every pool state", async () => {
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 2 });

    expect(pool.isReady(0)).toBe(true);
    expect(pool.isReady(2)).toBe(false);

    shellsOnline();
    await pool.ready;
    expect(pool.isReady(2)).toBe(true);
    expect(pool.isReady(3)).toBe(false);

    await pool.dispose();
    expect(pool.isReady(1)).toBe(false);
  });

  it("reports a pool whose shell is holding a command as not ready", async () => {
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 1 });
    shellsOnline();
    await pool.ready;

    const command = pool.createCommand(commandOptions());
    await flush();
    expect(pool.isReady(1)).toBe(false);

    commandReady(command.commandId);
    await command.ready;
    expect(pool.isReady(1)).toBe(false);
  });
});

describe("thread worker pool commands", () => {
  it("arms a slot per shell and posts the pool-command payload", async () => {
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 1 });
    shellsOnline();
    await pool.ready;

    const command = pool.createCommand(
      commandOptions({
        runtime: { cwdMountPath: "/work", mountHandles: { "/work": {} } },
        streamBroadcastChannelName: "rw-stream",
        streamRequestId: 4,
      }),
    );
    await flush();
    commandReady(command.commandId);
    await command.ready;

    expect(command.commandId).toBe(1);
    expect(command.slots).toHaveLength(1);
    const payload = FakeWorker.instances[0]?.posted[1];
    expect(payload).toMatchObject({
      __streamBroadcastChannelName: "rw-stream",
      __streamRequestId: 4,
      commandId: 1,
      envList: ["A=1"],
      mode: "pool-command",
      wasiArgs: ["rom-weaver"],
    });
    // Directory handles cannot cross into a nested worker, so the payload asks it to re-derive them.
    expect(payload?.runtime).toEqual({ cwdMountPath: "/work", resolveMountHandlesInWorker: true });
    expect(trace.some((line) => line.includes("[perf] thread pool command ready id=1 slots=1"))).toBe(true);
  });

  it("numbers commands in order", async () => {
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 1 });
    shellsOnline();
    await pool.ready;

    expect(pool.createCommand(commandOptions()).commandId).toBe(1);
    expect(pool.createCommand(commandOptions()).commandId).toBe(2);
  });

  it("grows the pool on demand for a larger command", async () => {
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 1 });
    shellsOnline();
    await pool.ready;

    const command = pool.createCommand(commandOptions({ poolSize: 3 }));
    await flush();
    expect(FakeWorker.instances).toHaveLength(3);

    shellsOnline();
    await flush();
    commandReady(command.commandId);
    await command.ready;
    expect(command.slots).toHaveLength(3);
  });

  it("rejects a command whose worker url does not match the pool's", async () => {
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 1, threadWorkerUrl: "/pool-worker.js" });
    shellsOnline();
    await pool.ready;

    const command = pool.createCommand(commandOptions({ threadWorkerUrl: "/other-worker.js" }));
    await expect(command.ready).rejects.toThrow(
      "browser wasi thread worker pool URL mismatch: /pool-worker.js !== /other-worker.js",
    );
  });

  it("tears the slot back down when the command post fails", async () => {
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 1 });
    shellsOnline();
    await pool.ready;
    const worker = FakeWorker.instances[0];
    if (!worker) throw new Error("fixture must create a shell");
    worker.postMessageError = new Error("worker is gone");

    const command = pool.createCommand(commandOptions());
    await expect(command.ready).rejects.toThrow("worker is gone");
    expect(trace.some((line) => line.includes("thread pool command post failed worker=0 id=1"))).toBe(true);
    // The shell is free again rather than left holding a dead command.
    expect(pool.isReady(1)).toBe(true);
  });
});

describe("thread worker pool shell replies", () => {
  async function armedCommand() {
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 1 });
    shellsOnline();
    await pool.ready;
    const command = pool.createCommand(commandOptions());
    await flush();
    const worker = FakeWorker.instances[0];
    if (!worker) throw new Error("fixture must create a shell");
    return { command, pool, worker };
  }

  it("ignores a reply for a command the shell is no longer running", async () => {
    const { command, worker } = await armedCommand();

    worker.reply({ commandId: 999, type: "ready" });
    worker.reply({ commandId: command.commandId, type: "ready" });

    await expect(command.ready).resolves.toBeUndefined();
  });

  it("frees the shell when the command reports done", async () => {
    const { command, pool, worker } = await armedCommand();
    commandReady(command.commandId);
    await command.ready;

    worker.reply({ commandId: command.commandId, type: "command-done" });
    await expect(command.slots[0]?.done).resolves.toBeUndefined();
    expect(pool.isReady(1)).toBe(true);
  });

  it("records a thread-scoped error against the slot and keeps the shell", async () => {
    const { command, worker } = await armedCommand();
    commandReady(command.commandId);
    await command.ready;
    const slot = command.slots[0] as ThreadPoolCommandSlot;

    worker.reply({ commandId: command.commandId, error: { message: "thread 3 died" }, tid: 3, type: "error" });

    expect(slot.failure?.message).toContain("thread 3 died");
    expect(slot.tid).toBe(3);
    expect(Atomics.load(slot.control, THREAD_SLOT_ERROR_INDEX)).toBe(1);
    expect(Atomics.load(slot.control, THREAD_SLOT_STATE_INDEX)).toBe(THREAD_SLOT_STATE_FAILED);
  });

  it("ends the command when an error arrives with no thread id", async () => {
    const { command, worker } = await armedCommand();
    const slot = command.slots[0] as ThreadPoolCommandSlot;

    worker.reply({ commandId: command.commandId, error: { message: "boom" }, type: "error" });

    await expect(command.ready).rejects.toThrow(/boom/);
    await expect(slot.done).resolves.toBeUndefined();
  });

  it("annotates a worker error with the slot and the worker url", async () => {
    const { command, worker } = await armedCommand();
    worker.reply({
      commandId: command.commandId,
      error: { message: "unreachable", name: "RuntimeError" },
      type: "error",
    });

    await expect(command.ready).rejects.toThrow(/browser wasi thread worker 0 failed/);
  });
});

describe("thread worker pool shell failures", () => {
  it("terminates a crashed shell, probes the load failure, and fails its command", async () => {
    vi.useFakeTimers();
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 1 });
    const worker = FakeWorker.instances[0];
    if (!worker) throw new Error("fixture must create a shell");

    worker.emit("error", { message: "SyntaxError", preventDefault: () => undefined });

    expect(worker.terminated).toBe(true);
    // The shell never came online, so the failure is a load failure worth probing.
    expect(probe.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(pool.ready).resolves.toBeUndefined();
  });

  it("does not probe a shell that had already come online", async () => {
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 1 });
    shellsOnline();
    await pool.ready;

    FakeWorker.instances[0]?.emit("error", { message: "later crash", preventDefault: () => undefined });
    expect(probe.calls).toEqual([]);
  });

  it("fails the shell when its message cannot be delivered", async () => {
    vi.useFakeTimers();
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 1 });
    shellsOnline();
    await pool.ready;
    const command = pool.createCommand(commandOptions());
    await vi.advanceTimersByTimeAsync(0);

    FakeWorker.instances[0]?.emit("messageerror", { preventDefault: () => undefined });

    await expect(command.ready).rejects.toThrow(/could not receive its message/);
  });

  it("fails a shell that never becomes ready within the timeout", async () => {
    vi.useFakeTimers();
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 0 });
    await pool.ready;
    const command = pool.createCommand(commandOptions({ poolSize: 1 }));

    await vi.advanceTimersByTimeAsync(60_000);

    await expect(command.ready).rejects.toThrow(/did not become ready within 5000ms/);
    expect(trace.some((line) => line.includes("thread pool shell ready timeout index=0"))).toBe(true);
  });

  it("ignores a shell whose terminate throws", async () => {
    vi.useFakeTimers();
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 1 });
    const worker = FakeWorker.instances[0];
    if (!worker) throw new Error("fixture must create a shell");
    worker.terminateError = new Error("already gone");

    expect(() => worker.emit("error", { preventDefault: () => undefined })).not.toThrow();
    await vi.advanceTimersByTimeAsync(60_000);
    await pool.ready;
  });

  it("ignores a second failure on an already-terminated shell", async () => {
    vi.useFakeTimers();
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 1 });
    const worker = FakeWorker.instances[0];
    if (!worker) throw new Error("fixture must create a shell");

    worker.emit("error", { preventDefault: () => undefined });
    worker.emit("error", { preventDefault: () => undefined });

    expect(probe.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await pool.ready;
  });

  it("replaces failed shells until the replacement budget runs out", async () => {
    vi.useFakeTimers();
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 0 });
    await pool.ready;

    const command = pool.createCommand(commandOptions({ poolSize: 1 }));
    // Every shell times out, so the pool replaces it until the budget is spent.
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(command.ready).rejects.toThrow(/did not become ready/);
    expect(trace.some((line) => line.includes("thread pool ensureSize giving up target=1"))).toBe(true);
    expect(trace.some((line) => line.includes("thread pool replacing worker=0"))).toBe(true);
    expect(FakeWorker.instances.length).toBeGreaterThan(1);
  });
});

describe("thread worker pool shutdown and dispose", () => {
  it("quiesces every live slot, signals shutdown and waits for done", async () => {
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 1 });
    shellsOnline();
    await pool.ready;
    const command = pool.createCommand(commandOptions());
    await flush();
    commandReady(command.commandId);
    await command.ready;
    const slot = command.slots[0] as ThreadPoolCommandSlot;

    const shutdown = command.shutdown();
    expect(Atomics.load(slot.control, THREAD_SLOT_STATE_INDEX)).toBe(THREAD_SLOT_STATE_SHUTDOWN);
    FakeWorker.instances[0]?.reply({ commandId: command.commandId, type: "command-done" });

    await expect(shutdown).resolves.toBeUndefined();
    expect(trace.some((line) => line.includes("thread pool command shutdown done id=1"))).toBe(true);
  });

  it("waits for a running slot to leave its running state before signalling shutdown", async () => {
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 1 });
    shellsOnline();
    await pool.ready;
    const command = pool.createCommand(commandOptions());
    await flush();
    commandReady(command.commandId);
    await command.ready;
    const slot = command.slots[0] as ThreadPoolCommandSlot;
    Atomics.store(slot.control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_RUNNING);

    // Only another thread can leave the running state, so Atomics.wait plays that part.
    vi.spyOn(Atomics, "wait").mockImplementation(((control: Int32Array) => {
      Atomics.store(control, THREAD_SLOT_STATE_INDEX, THREAD_SLOT_STATE_IDLE);
      return "ok";
    }) as unknown as typeof Atomics.wait);

    const shutdown = command.shutdown();
    FakeWorker.instances[0]?.reply({ commandId: command.commandId, type: "command-done" });
    await shutdown;

    expect(trace.some((line) => line.includes("thread pool command shutdown wait worker=0"))).toBe(true);
  });

  it("skips a slot whose shell has already moved on", async () => {
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 1 });
    shellsOnline();
    await pool.ready;
    const command = pool.createCommand(commandOptions());
    await flush();
    commandReady(command.commandId);
    await command.ready;

    FakeWorker.instances[0]?.reply({ commandId: command.commandId, type: "command-done" });
    await expect(command.shutdown()).resolves.toBeUndefined();
  });

  it("shuts every shell down and refuses further work", async () => {
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 2 });
    shellsOnline();
    await pool.ready;

    await pool.dispose();

    expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true);
    expect(FakeWorker.instances[0]?.posted.at(-1)).toEqual({ mode: "shutdown" });

    const command = pool.createCommand(commandOptions());
    await expect(command.ready).rejects.toThrow("browser wasi thread worker pool is disposed");
  });

  it("disposes even when a shell refuses its shutdown message", async () => {
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 1 });
    const worker = FakeWorker.instances[0];
    if (!worker) throw new Error("fixture must create a shell");
    shellsOnline();
    await pool.ready;
    worker.postMessageError = new Error("port closed");

    await expect(pool.dispose()).resolves.toBeUndefined();
    expect(worker.terminated).toBe(true);
  });
});

describe("thread worker pool saturation", () => {
  it("reports the busy shell once the retry deadline passes", async () => {
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 1 });
    shellsOnline();
    await pool.ready;
    const first = pool.createCommand(commandOptions());
    await flush();
    commandReady(first.commandId);
    await first.ready;

    // The single shell is busy; leap past the retry deadline rather than waiting 30s.
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      clock += 1;
      return clock === 1 ? 0 : 10 ** 9;
    });

    const second = pool.createCommand(commandOptions());
    await expect(second.ready).rejects.toThrow("browser wasi thread worker 0 is already busy");
  });

  it("retries while a shell is still busy and succeeds once it frees up", async () => {
    const pool = createBrowserWasiThreadWorkerPool({ initialSize: 1 });
    shellsOnline();
    await pool.ready;
    const first = pool.createCommand(commandOptions());
    await flush();
    commandReady(first.commandId);
    await first.ready;

    const second = pool.createCommand(commandOptions());
    await flush();
    // Free the shell mid-retry; the 25ms retry then claims it for the second command.
    FakeWorker.instances[0]?.reply({ commandId: first.commandId, type: "command-done" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    commandReady(second.commandId);

    await expect(second.ready).resolves.toBeUndefined();
  });
});

describe("throwWithThreadFailure", () => {
  it("rethrows the original error when the workers drain cleanly", async () => {
    const original = new Error("wasm trap");

    await expect(throwWithThreadFailure(original, { waitForWorkers: async () => undefined })).rejects.toBe(original);
  });

  it("joins the opaque trap with the worker-side cause and keeps the original stack", async () => {
    const original = new Error("unreachable");
    original.stack = "STACK-MARKER";

    await expect(
      throwWithThreadFailure(original, {
        waitForWorkers: async () => {
          throw new Error("wasi thread 3 failed");
        },
      }),
    ).rejects.toMatchObject({ message: "unreachable; wasi thread 3 failed", stack: "STACK-MARKER" });
  });

  it("stringifies non-Error values on both sides", async () => {
    await expect(
      throwWithThreadFailure("plain failure", {
        waitForWorkers: async () => {
          throw "worker string";
        },
      }),
    ).rejects.toThrow("plain failure; worker string");
  });
});
