import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  disposeNestedThreadWorkers: vi.fn(() => Promise.resolve()),
  disposeThreadRuntime: vi.fn(() => Promise.resolve()),
  primeThreadRuntime: vi.fn(() => Promise.resolve()),
  runWasiThread: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../src/wasm/browser-opfs-wasi-thread-runtime.ts", () => ({
  __disposeRomWeaverBrowserNestedThreadWorkers: mocks.disposeNestedThreadWorkers,
  __disposeRomWeaverBrowserThreadRuntime: mocks.disposeThreadRuntime,
  __primeRomWeaverBrowserThreadRuntime: mocks.primeThreadRuntime,
  __runRomWeaverBrowserWasiThread: mocks.runWasiThread,
}));

const STATE_INDEX = 0;
const TID_INDEX = 1;
const START_ARG_INDEX = 2;
const ERROR_INDEX = 3;
const STATE_IDLE = 0;
const STATE_REQUESTED = 1;
const STATE_STARTING = 2;
const STATE_FAILED = 5;
const STATE_SHUTDOWN = 6;

class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  closed = false;
  messages: unknown[] = [];
  name: string;

  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  postMessage(message: unknown) {
    this.messages.push(message);
  }
}

type WorkerScope = {
  addEventListener: (type: string, listener: (event: { data: unknown }) => void) => void;
  close: () => void;
  postMessage: (message: unknown) => void;
};

let posted: Array<Record<string, unknown>>;
let closed: number;
let listener: ((event: { data: unknown }) => void) | null;
/** Scripted values for the slot state word, consumed one per `Atomics.load` of index 0. */
let stateScript: number[];

const flush = async () => {
  for (let index = 0; index < 40; index += 1) await Promise.resolve();
};

const channelMessages = () => FakeBroadcastChannel.instances.flatMap((channel) => channel.messages);

const createControl = (options?: { shared?: boolean; length?: number; startArg?: number; tid?: number }) => {
  const length = options?.length ?? 4;
  const buffer = options?.shared === false ? new ArrayBuffer(length * 4) : new SharedArrayBuffer(length * 4);
  const control = new Int32Array(buffer);
  if (control.length > TID_INDEX) control[TID_INDEX] = options?.tid ?? 7;
  if (control.length > START_ARG_INDEX) control[START_ARG_INDEX] = options?.startArg ?? 99;
  return { buffer, control };
};

const loadWorker = async () => {
  vi.resetModules();
  posted = [];
  closed = 0;
  listener = null;
  const scope: WorkerScope = {
    addEventListener: (type, handler) => {
      if (type === "message") listener = handler;
    },
    close: () => {
      closed += 1;
    },
    postMessage: (message) => {
      posted.push(message as Record<string, unknown>);
    },
  };
  vi.stubGlobal("self", scope);
  await import("../../src/wasm/workers/browser-wasi-thread-worker.ts");
  if (!listener) throw new Error("the thread worker did not register a message listener");
  return listener;
};

const send = async (data: unknown) => {
  listener?.({ data });
  await flush();
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.disposeNestedThreadWorkers.mockResolvedValue(undefined);
  mocks.disposeThreadRuntime.mockResolvedValue(undefined);
  mocks.primeThreadRuntime.mockResolvedValue(undefined);
  mocks.runWasiThread.mockResolvedValue(undefined);
  FakeBroadcastChannel.instances = [];
  stateScript = [];
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  const realLoad = Atomics.load.bind(Atomics);
  vi.spyOn(Atomics, "load").mockImplementation((array, index) => {
    if (index === STATE_INDEX && stateScript.length > 0) return stateScript.shift() as number;
    return realLoad(array as Int32Array, index);
  });
  // The pool loop parks on Atomics.wait; the scripted state word stands in for
  // the spawner's notify so the test thread never blocks.
  vi.spyOn(Atomics, "wait").mockReturnValue("ok");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("message dispatch", () => {
  it("answers a pool-shell probe", async () => {
    await loadWorker();

    await send({ mode: "pool-shell" });

    expect(posted).toEqual([{ type: "shell-ready" }]);
  });

  it("rejects a mode it does not know", async () => {
    await loadWorker();

    await send({ mode: "nope" });
    await send({});

    expect(posted).toEqual([
      {
        error: expect.objectContaining({ message: "unsupported browser wasi thread worker mode: nope" }),
        tid: null,
        type: "error",
      },
      {
        error: expect.objectContaining({ message: "unsupported browser wasi thread worker mode: unknown" }),
        tid: null,
        type: "error",
      },
    ]);
  });

  it("treats a message with no data as an unknown mode", async () => {
    await loadWorker();

    await send(undefined);

    expect(posted[0]).toMatchObject({
      error: { message: "unsupported browser wasi thread worker mode: unknown" },
      type: "error",
    });
  });

  it("disposes the runtime and closes on shutdown", async () => {
    await loadWorker();

    await send({ mode: "shutdown" });

    expect(mocks.disposeThreadRuntime).toHaveBeenCalledTimes(1);
    expect(closed).toBe(1);
    expect(posted).toEqual([]);
  });

  it("closes even when disposing the runtime fails", async () => {
    mocks.disposeThreadRuntime.mockRejectedValue(new Error("dispose failed"));
    await loadWorker();

    await send({ mode: "shutdown" });

    expect(closed).toBe(1);
  });
});

describe("pool command", () => {
  it("primes the runtime, runs the requested thread, and reports done", async () => {
    const { buffer, control } = createControl({ startArg: 42, tid: 3 });
    stateScript = [STATE_IDLE, STATE_REQUESTED, STATE_REQUESTED, STATE_SHUTDOWN, STATE_SHUTDOWN];
    await loadWorker();

    await send({
      commandId: "cmd-1",
      controlBuffer: buffer,
      mode: "pool-command",
      runtime: { wasmUrl: "app.wasm" },
    });

    expect(mocks.primeThreadRuntime).toHaveBeenCalledWith({ wasmUrl: "app.wasm" }, undefined);
    expect(mocks.runWasiThread).toHaveBeenCalledTimes(1);
    expect(mocks.runWasiThread.mock.calls[0]?.[0]).toMatchObject({
      commandId: "cmd-1",
      startArg: 42,
      startControlBuffer: buffer,
      tid: 3,
    });
    expect(mocks.disposeNestedThreadWorkers).toHaveBeenCalledTimes(1);
    expect(control[STATE_INDEX]).toBe(STATE_IDLE);
    expect(control[ERROR_INDEX]).toBe(0);
    expect(posted).toEqual([
      { commandId: "cmd-1", type: "ready" },
      { commandId: "cmd-1", type: "command-done" },
    ]);
  });

  it("skips priming when the caller opted out", async () => {
    const { buffer } = createControl();
    stateScript = [STATE_SHUTDOWN, STATE_SHUTDOWN];
    await loadWorker();

    await send({ commandId: "cmd-2", controlBuffer: buffer, mode: "pool-command", prewarmRuntime: false });

    expect(mocks.primeThreadRuntime).not.toHaveBeenCalled();
    expect(posted).toEqual([
      { commandId: "cmd-2", type: "ready" },
      { commandId: "cmd-2", type: "command-done" },
    ]);
  });

  it("parks on a failed slot until the spawner hands it back", async () => {
    const { buffer } = createControl();
    stateScript = [STATE_IDLE, STATE_FAILED, STATE_FAILED, STATE_SHUTDOWN, STATE_SHUTDOWN];
    await loadWorker();

    await send({ commandId: "cmd-3", controlBuffer: buffer, mode: "pool-command" });

    expect(mocks.runWasiThread).not.toHaveBeenCalled();
    expect(posted.at(-1)).toMatchObject({ type: "command-done" });
  });

  it("ignores a slot state that is neither a request nor a terminal state", async () => {
    const { buffer } = createControl();
    stateScript = [STATE_STARTING, STATE_STARTING, STATE_SHUTDOWN, STATE_SHUTDOWN];
    await loadWorker();

    await send({ commandId: "cmd-4", controlBuffer: buffer, mode: "pool-command" });

    expect(mocks.runWasiThread).not.toHaveBeenCalled();
    expect(posted.at(-1)).toMatchObject({ type: "command-done" });
  });

  it("marks the slot failed and reports the thread error", async () => {
    const { buffer, control } = createControl({ tid: 5 });
    stateScript = [STATE_IDLE, STATE_REQUESTED, STATE_REQUESTED, STATE_SHUTDOWN, STATE_SHUTDOWN];
    mocks.runWasiThread.mockRejectedValue(new Error("thread trapped"));
    await loadWorker();

    await send({ commandId: "cmd-5", controlBuffer: buffer, mode: "pool-command" });

    expect(control[STATE_INDEX]).toBe(STATE_FAILED);
    expect(control[ERROR_INDEX]).toBe(1);
    expect(posted).toEqual([
      { commandId: "cmd-5", type: "ready" },
      {
        commandId: "cmd-5",
        error: expect.objectContaining({ message: "thread trapped", name: "Error" }),
        tid: 5,
        type: "error",
      },
      { commandId: "cmd-5", type: "command-done" },
    ]);
  });

  it("refuses a control buffer that is not shared or is too short", async () => {
    await loadWorker();

    await send({ commandId: "cmd-6", controlBuffer: createControl({ shared: false }).buffer, mode: "pool-command" });
    await send({ commandId: "cmd-7", controlBuffer: createControl({ length: 2 }).buffer, mode: "pool-command" });

    expect(posted).toEqual([
      {
        commandId: "cmd-6",
        error: expect.objectContaining({ message: "browser wasi thread pool worker missing shared control buffer" }),
        tid: null,
        type: "error",
      },
      {
        commandId: "cmd-7",
        error: expect.objectContaining({ message: "browser wasi thread pool worker missing shared control buffer" }),
        tid: null,
        type: "error",
      },
    ]);
  });

  it("rejects a second command while the first still owns the shell", async () => {
    const { buffer } = createControl();
    let releasePrime = () => undefined;
    mocks.primeThreadRuntime.mockReturnValue(
      new Promise<void>((resolve) => {
        releasePrime = () => resolve();
      }),
    );
    stateScript = [STATE_SHUTDOWN, STATE_SHUTDOWN];
    await loadWorker();

    await send({ commandId: "cmd-8", controlBuffer: buffer, mode: "pool-command" });
    await send({ commandId: "cmd-9", controlBuffer: buffer, mode: "pool-command" });

    expect(posted).toEqual([
      {
        commandId: "cmd-9",
        error: expect.objectContaining({
          message: "browser wasi thread worker received a command while busy",
        }),
        tid: null,
        type: "error",
      },
    ]);

    releasePrime();
    await flush();
    expect(posted.at(-1)).toMatchObject({ commandId: "cmd-8", type: "command-done" });
  });

  it("accepts a new command once the shell is free again", async () => {
    const { buffer } = createControl();
    stateScript = [STATE_SHUTDOWN, STATE_SHUTDOWN];
    await loadWorker();
    await send({ commandId: "cmd-a", controlBuffer: buffer, mode: "pool-command" });

    stateScript = [STATE_SHUTDOWN, STATE_SHUTDOWN];
    await send({ commandId: "cmd-b", controlBuffer: buffer, mode: "pool-command" });

    expect(posted.filter((message) => message.type === "command-done")).toHaveLength(2);
  });
});

describe("stream publishing", () => {
  const streamPayload = (extra?: Record<string, unknown>) => ({
    __streamBroadcastChannelName: "rom-weaver-stream",
    __streamRequestId: 12,
    commandId: "cmd-stream",
    mode: "pool-command",
    ...extra,
  });

  it("broadcasts the pool trace lines and the thread lifecycle", async () => {
    const { buffer } = createControl({ tid: 4 });
    stateScript = [STATE_IDLE, STATE_REQUESTED, STATE_REQUESTED, STATE_SHUTDOWN, STATE_SHUTDOWN];
    await loadWorker();

    await send(streamPayload({ controlBuffer: buffer }));

    const lines = channelMessages().filter(
      (message): message is { line: string; requestId: number; tid: number | null; type: string } =>
        typeof (message as { line?: unknown }).line === "string",
    );
    expect(lines.map((message) => message.line)).toEqual([
      "[wasi-thread-worker] pool command received command=cmd-stream",
      "[wasi-thread-worker] pool thread start tid=4 startArg=99",
      "[wasi-thread-worker] pool thread done tid=4",
    ]);
    expect(lines.every((message) => message.requestId === 12 && message.type === "traceNonJsonLine")).toBe(true);
    expect(lines[0]?.tid).toBeNull();
    expect(lines[1]?.tid).toBe(4);
    expect(FakeBroadcastChannel.instances.every((channel) => channel.closed)).toBe(true);
    expect(mocks.primeThreadRuntime.mock.calls[0]?.[1]).toBeTypeOf("function");
  });

  it("broadcasts a thread failure trace line", async () => {
    const { buffer } = createControl({ tid: 2 });
    stateScript = [STATE_IDLE, STATE_REQUESTED, STATE_REQUESTED, STATE_SHUTDOWN, STATE_SHUTDOWN];
    mocks.runWasiThread.mockRejectedValue(new Error("boom"));
    await loadWorker();

    await send(streamPayload({ controlBuffer: buffer }));

    expect(channelMessages()).toContainEqual({
      line: "[wasi-thread-worker] pool thread failed tid=2 Error:boom",
      requestId: 12,
      tid: 2,
      type: "traceNonJsonLine",
    });
  });

  it("routes stdout and stderr through the shared channel", async () => {
    const { buffer } = createControl({ tid: 1 });
    stateScript = [STATE_IDLE, STATE_REQUESTED, STATE_REQUESTED, STATE_SHUTDOWN, STATE_SHUTDOWN];
    mocks.runWasiThread.mockImplementation(
      (payload: { stderrLineHandler?: (line: string) => void; stdoutLineHandler?: (line: string) => void }) => {
        payload.stdoutLineHandler?.('{"status":"running"}');
        payload.stdoutLineHandler?.("plain stdout");
        payload.stderrLineHandler?.('{"level":"warn"}');
        payload.stderrLineHandler?.("plain stderr");
        payload.stdoutLineHandler?.("");
        return Promise.resolve();
      },
    );
    await loadWorker();

    await send(streamPayload({ controlBuffer: buffer }));

    expect(channelMessages()).toEqual(
      expect.arrayContaining([
        { event: { status: "running" }, requestId: 12, tid: 1, type: "event" },
        { line: "plain stdout", requestId: 12, tid: 1, type: "nonJsonLine" },
        { event: { level: "warn" }, requestId: 12, tid: 1, type: "traceEvent" },
        { line: "plain stderr", requestId: 12, tid: 1, type: "traceNonJsonLine" },
      ]),
    );
    expect(channelMessages().filter((message) => (message as { line?: string }).line === "")).toEqual([]);
  });

  it("publishes nothing without a channel name or an integer request id", async () => {
    const { buffer } = createControl();
    stateScript = [STATE_SHUTDOWN, STATE_SHUTDOWN];
    await loadWorker();

    await send({ ...streamPayload({ controlBuffer: buffer }), __streamBroadcastChannelName: "" });
    stateScript = [STATE_SHUTDOWN, STATE_SHUTDOWN];
    await send({ ...streamPayload({ controlBuffer: buffer }), __streamRequestId: 1.5 });

    expect(FakeBroadcastChannel.instances).toEqual([]);
  });

  it("publishes nothing when the runtime has no BroadcastChannel", async () => {
    const { buffer } = createControl();
    stateScript = [STATE_SHUTDOWN, STATE_SHUTDOWN];
    vi.stubGlobal("BroadcastChannel", undefined);
    await loadWorker();

    await send(streamPayload({ controlBuffer: buffer }));

    expect(posted.at(-1)).toMatchObject({ type: "command-done" });
  });

  it("traces a busy rejection on the caller's channel", async () => {
    const { buffer } = createControl();
    let releasePrime = () => undefined;
    mocks.primeThreadRuntime.mockReturnValue(
      new Promise<void>((resolve) => {
        releasePrime = () => resolve();
      }),
    );
    stateScript = [STATE_SHUTDOWN, STATE_SHUTDOWN];
    await loadWorker();

    await send(streamPayload({ controlBuffer: buffer }));
    await send(streamPayload({ commandId: "cmd-busy", controlBuffer: buffer }));

    expect(channelMessages()).toContainEqual({
      line: "[wasi-thread-worker] pool command rejected busy command=cmd-busy",
      requestId: 12,
      tid: null,
      type: "traceNonJsonLine",
    });

    releasePrime();
    await flush();
  });
});

describe("error serialization", () => {
  it("keeps the message, name, stack, and cause chain", async () => {
    const cause = new RangeError("root cause");
    const error = new Error("outer", { cause });
    mocks.runWasiThread.mockRejectedValue(error);
    const { buffer } = createControl();
    stateScript = [STATE_IDLE, STATE_REQUESTED, STATE_REQUESTED, STATE_SHUTDOWN, STATE_SHUTDOWN];
    await loadWorker();

    await send({ commandId: "cmd-e", controlBuffer: buffer, mode: "pool-command" });

    const failure = posted.find((message) => message.type === "error") as { error: Record<string, unknown> };
    expect(failure.error).toMatchObject({ message: "outer", name: "Error", stack: expect.any(String) });
    expect(failure.error.cause).toMatchObject({ message: "root cause", name: "RangeError" });
  });

  it("stringifies a throw that is not an object", async () => {
    mocks.runWasiThread.mockRejectedValue("plain string failure");
    const { buffer } = createControl();
    stateScript = [STATE_IDLE, STATE_REQUESTED, STATE_REQUESTED, STATE_SHUTDOWN, STATE_SHUTDOWN];
    await loadWorker();

    await send({ commandId: "cmd-f", controlBuffer: buffer, mode: "pool-command" });

    const failure = posted.find((message) => message.type === "error") as { error: Record<string, unknown> };
    expect(failure.error).toEqual({
      cause: undefined,
      message: "plain string failure",
      name: "Error",
      stack: undefined,
    });
  });

  it("falls back for an error-like object with the wrong field types", async () => {
    mocks.runWasiThread.mockRejectedValue({ message: 42, name: 7, stack: null });
    const { buffer } = createControl();
    stateScript = [STATE_IDLE, STATE_REQUESTED, STATE_REQUESTED, STATE_SHUTDOWN, STATE_SHUTDOWN];
    await loadWorker();

    await send({ commandId: "cmd-g", controlBuffer: buffer, mode: "pool-command" });

    const failure = posted.find((message) => message.type === "error") as { error: Record<string, unknown> };
    expect(failure.error).toEqual({
      cause: undefined,
      message: "[object Object]",
      name: "Error",
      stack: undefined,
    });
  });
});
