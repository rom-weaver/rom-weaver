import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserWorkerTransport, RomWeaverWorkerClientCore } from "../../src/wasm/workers/worker-client-core.ts";
import {
  SELECT_REQUEST_CANCEL_COUNT,
  SELECT_REQUEST_COUNT_INDEX,
  SELECT_REQUEST_HEADER_LENGTH,
  SELECT_REQUEST_READY,
  SELECT_REQUEST_READY_INDEX,
} from "../../src/wasm/workers/worker-protocol.ts";

type Listener = (event: Event) => void;

class FakeWorker {
  readonly listeners = new Map<string, Set<Listener>>();
  readonly posted: unknown[] = [];
  terminated = false;
  postError: Error | null = null;

  addEventListener(type: string, listener: Listener) {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  postMessage(message: unknown) {
    if (this.postError) throw this.postError;
    this.posted.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  emit(type: string, value: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(value as Event);
  }
}

function makeTransport() {
  const listeners = {
    error: undefined as Listener | undefined,
    exit: undefined as ((code: unknown) => void) | undefined,
    message: undefined as Listener | undefined,
    messageError: undefined as Listener | undefined,
  };
  const transport = {
    offError: vi.fn((target: Worker, listener: Listener) => {
      (target as unknown as FakeWorker).removeEventListener("error", listener);
      if (listeners.error === listener) listeners.error = undefined;
    }),
    offExit: vi.fn((target: Worker, listener: (code: unknown) => void) => {
      (target as unknown as FakeWorker).removeEventListener("exit", listener as Listener);
      if (listeners.exit === listener) listeners.exit = undefined;
    }),
    offMessage: vi.fn((target: Worker, listener: Listener) => {
      (target as unknown as FakeWorker).removeEventListener("message", listener);
      if (listeners.message === listener) listeners.message = undefined;
    }),
    offMessageError: vi.fn((target: Worker, listener: Listener) => {
      (target as unknown as FakeWorker).removeEventListener("messageerror", listener);
      if (listeners.messageError === listener) listeners.messageError = undefined;
    }),
    onError: vi.fn((target: Worker, listener: Listener) => {
      (target as unknown as FakeWorker).addEventListener("error", listener);
      listeners.error = listener;
    }),
    onExit: vi.fn((target: Worker, listener: (code: unknown) => void) => {
      (target as unknown as FakeWorker).addEventListener("exit", listener as Listener);
      listeners.exit = listener;
    }),
    onMessage: vi.fn((target: Worker, listener: Listener) => {
      (target as unknown as FakeWorker).addEventListener("message", listener);
      listeners.message = listener;
    }),
    onMessageError: vi.fn((target: Worker, listener: Listener) => {
      (target as unknown as FakeWorker).addEventListener("messageerror", listener);
      listeners.messageError = listener;
    }),
    postMessage: vi.fn((target: Worker, message: unknown) => target.postMessage(message)),
    readMessage: vi.fn((event: unknown) => (event as MessageEvent).data),
    terminate: vi.fn((target: Worker) => target.terminate()),
    toError: vi.fn((event: unknown) => new Error(`worker: ${(event as { message?: string }).message ?? "error"}`)),
    toExitError: vi.fn((code: unknown) => new Error(`exit ${String(code)}`)),
    toMessageError: vi.fn(
      (event: unknown) => new Error(`message: ${(event as { message?: string }).message ?? "error"}`),
    ),
  };
  return { listeners, transport };
}

const response = (data: unknown) => ({ data }) as MessageEvent;
const runRequest = { command: { type: "probe", args: { input: "/work/game.bin" } } } as never;

let worker: FakeWorker;
let transport: ReturnType<typeof makeTransport>["transport"];
let core: RomWeaverWorkerClientCore;

beforeEach(() => {
  worker = new FakeWorker();
  ({ transport } = makeTransport());
  core = new RomWeaverWorkerClientCore(worker as unknown as Worker, transport);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RomWeaverWorkerClientCore requests", () => {
  it("attaches listeners, sends run options, and resolves a result", async () => {
    const events: unknown[] = [];
    const lines: string[] = [];
    const traces: unknown[] = [];
    const traceLines: string[] = [];
    const promise = core.runJson(runRequest, {
      onEvent: (event) => events.push(event),
      onNonJsonLine: (line) => lines.push(line),
      onTraceEvent: (event) => traces.push(event),
      onTraceNonJsonLine: (line) => traceLines.push(line),
      virtualFiles: [{ path: "/work/game.bin" }],
    });

    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]).toMatchObject({ requestId: 1, type: "runJson" });
    const posted = worker.posted[0] as { options: Record<string, unknown> };
    expect(posted.options).toHaveProperty("__streamBroadcastChannelName");
    worker.emit("message", response({ requestId: 1, type: "event", event: { status: "running" } }));
    worker.emit("message", response({ requestId: 1, type: "nonJsonLine", line: "noise" }));
    worker.emit("message", response({ requestId: 1, type: "traceEvent", event: { span: "x" } }));
    worker.emit("message", response({ requestId: 1, type: "traceNonJsonLine", line: "trace" }));
    worker.emit(
      "message",
      response({ requestId: 1, type: "result", operation: "runJson", result: { ok: true, exitCode: 0 } }),
    );

    await expect(promise).resolves.toEqual({ ok: true, exitCode: 0 });
    expect(events).toEqual([{ status: "running" }]);
    expect(lines).toEqual(["noise"]);
    expect(traces).toEqual([{ span: "x" }]);
    expect(traceLines.some((line) => line.includes("send requestId=1"))).toBe(true);
  });

  it("resolves ready and disposed responses and ignores malformed messages", async () => {
    const ready = core.runJson(runRequest);
    worker.emit("message", response(null));
    worker.emit("message", response({ requestId: 1, type: "unknown" }));
    worker.emit(
      "message",
      response({ requestId: 1, type: "ready", mode: "browser-opfs", threaded: 1, wasmUrl: undefined }),
    );
    await expect(ready).resolves.toEqual({ mode: "browser-opfs", threaded: true, wasmUrl: null });

    const disposed = core.dispose();
    worker.emit("message", response({ requestId: 2, type: "disposed" }));
    await expect(disposed).resolves.toEqual({ disposed: true });
  });

  it("rejects a postMessage failure and rejects future work after shutdown", async () => {
    worker.postError = new Error("post failed");
    await expect(core.runJson(runRequest)).rejects.toMatchObject({ message: "post failed", kind: "worker" });

    core._shutdown("closed");
    await expect(core.runJson(runRequest)).rejects.toMatchObject({ message: "worker client has been terminated" });
    expect(transport.offMessage).toHaveBeenCalledTimes(1);
    expect(transport.offError).toHaveBeenCalledTimes(1);
  });

  it("routes targeted and unscoped errors to pending requests", async () => {
    const first = core.runJson(runRequest);
    worker.emit(
      "message",
      response({
        requestId: 1,
        type: "error",
        error: { name: "ValidationError", message: "validation failed: bad input", kind: "validation" },
      }),
    );
    await expect(first).rejects.toMatchObject({
      name: "ValidationError",
      message: "validation failed: bad input",
      kind: "validation",
    });

    const second = core.runJson(runRequest);
    const third = core.runJson(runRequest);
    worker.emit(
      "message",
      response({ requestId: null, type: "error", error: { message: "worker stopped", kind: "worker" } }),
    );
    await expect(Promise.all([second, third])).rejects.toMatchObject({ message: "worker stopped", kind: "worker" });
  });

  it("rejects pending requests for worker errors, message errors, and exits", async () => {
    const errorRequest = core.runJson(runRequest);
    worker.emit("error", { message: "crashed" });
    await expect(errorRequest).rejects.toMatchObject({ message: "worker: crashed" });

    const messageRequest = core.runJson(runRequest);
    worker.emit("messageerror", { message: "bad clone" });
    await expect(messageRequest).rejects.toMatchObject({ message: "message: bad clone" });

    const exitRequest = core.runJson(runRequest);
    worker.emit("exit", 17);
    await expect(exitRequest).rejects.toMatchObject({ message: "exit 17" });

    const noExitRequest = core.runJson(runRequest);
    transport.toExitError.mockReturnValueOnce(undefined);
    worker.emit("exit", 18);
    expect(transport.toExitError).toHaveBeenCalledWith(18);
    worker.emit("message", response({ requestId: 4, type: "result", operation: "runJson", result: { ok: true } }));
    await expect(noExitRequest).resolves.toEqual({ ok: true });
  });
});

describe("selection requests", () => {
  it("cancels when no handler exists and writes valid bounded indices", async () => {
    const pending = core.runJson(runRequest);
    const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 5);
    worker.emit("message", response({ requestId: 1, type: "selectRequest", request: "{}", control }));
    const view = new Int32Array(control);
    expect(Atomics.load(view, SELECT_REQUEST_COUNT_INDEX)).toBe(SELECT_REQUEST_CANCEL_COUNT);
    expect(Atomics.load(view, SELECT_REQUEST_READY_INDEX)).toBe(SELECT_REQUEST_READY);
    worker.emit("message", response({ requestId: 1, type: "result", operation: "runJson", result: { ok: true } }));
    await expect(pending).resolves.toEqual({ ok: true });

    const chosen: string[] = [];
    core.setSelectionHandler((request) => {
      chosen.push(request);
      return [-1, 2, 4, 6, 8];
    });
    const next = core.runJson(runRequest);
    const nextControl = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4);
    worker.emit("message", response({ requestId: 2, type: "selectRequest", request: "pick", control: nextControl }));
    await vi.waitFor(() => expect(chosen).toEqual(["pick"]));
    const nextView = new Int32Array(nextControl);
    expect(chosen).toEqual(["pick"]);
    expect(nextView.slice(SELECT_REQUEST_HEADER_LENGTH)).toEqual(new Int32Array([2, 4]));
    expect(nextView[SELECT_REQUEST_COUNT_INDEX]).toBe(2);
    worker.emit("message", response({ requestId: 2, type: "result", operation: "runJson", result: { ok: true } }));
    await expect(next).resolves.toEqual({ ok: true });
  });

  it("cancels when the selection handler rejects or returns a non-array", async () => {
    core.setSelectionHandler(() => Promise.reject(new Error("dialog closed")));
    const rejected = core.runJson(runRequest);
    const rejectedControl = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
    worker.emit(
      "message",
      response({ requestId: 1, type: "selectRequest", request: "pick", control: rejectedControl }),
    );
    await vi.waitFor(() =>
      expect(new Int32Array(rejectedControl)[SELECT_REQUEST_COUNT_INDEX]).toBe(SELECT_REQUEST_CANCEL_COUNT),
    );
    expect(new Int32Array(rejectedControl)[SELECT_REQUEST_COUNT_INDEX]).toBe(SELECT_REQUEST_CANCEL_COUNT);
    worker.emit("message", response({ requestId: 1, type: "result", operation: "runJson", result: { ok: true } }));
    await expect(rejected).resolves.toEqual({ ok: true });

    core.setSelectionHandler(() => "nope" as never);
    const nonArray = core.runJson(runRequest);
    const nonArrayControl = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
    worker.emit(
      "message",
      response({ requestId: 2, type: "selectRequest", request: "pick", control: nonArrayControl }),
    );
    await vi.waitFor(() =>
      expect(new Int32Array(nonArrayControl)[SELECT_REQUEST_COUNT_INDEX]).toBe(SELECT_REQUEST_CANCEL_COUNT),
    );
    expect(new Int32Array(nonArrayControl)[SELECT_REQUEST_COUNT_INDEX]).toBe(SELECT_REQUEST_CANCEL_COUNT);
    worker.emit("message", response({ requestId: 2, type: "result", operation: "runJson", result: { ok: true } }));
    await expect(nonArray).resolves.toEqual({ ok: true });
  });

  it("wakes open selections during shutdown", async () => {
    core.setSelectionHandler(() => new Promise<number[]>(() => undefined));
    const pending = core.runJson(runRequest);
    const control = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
    worker.emit("message", response({ requestId: 1, type: "selectRequest", request: "pick", control }));
    core._shutdown();
    expect(new Int32Array(control)[SELECT_REQUEST_COUNT_INDEX]).toBe(SELECT_REQUEST_CANCEL_COUNT);
    await expect(pending).rejects.toMatchObject({ message: "worker terminated" });
  });
});

describe("browser worker transport", () => {
  it("uses the Worker event API and formats errors", () => {
    const target = new FakeWorker();
    const browserTransport = createBrowserWorkerTransport();
    const listener = vi.fn();
    browserTransport.onMessage(target as unknown as Worker, listener);
    target.emit("message", response({ ok: true }));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ data: { ok: true } }));
    browserTransport.offMessage(target as unknown as Worker, listener);
    expect(target.listeners.get("message")?.size).toBe(0);

    expect(browserTransport.toError({ error: new Error("inner") })).toMatchObject({ message: "inner" });
    expect(browserTransport.toError({ message: " boom ", filename: "worker.ts", lineno: 7, colno: 3 })).toMatchObject({
      message: "boom at worker.ts:7:3",
    });
    expect(browserTransport.toError({})).toMatchObject({ message: "worker error" });
    expect(browserTransport.toMessageError({ message: " bad " })).toMatchObject({ message: "bad" });
    expect(browserTransport.toMessageError({})).toMatchObject({ message: "worker messageerror" });

    browserTransport.postMessage(target as unknown as Worker, { ping: true });
    browserTransport.terminate(target as unknown as Worker);
    expect(target.posted).toEqual([{ ping: true }]);
    expect(target.terminated).toBe(true);
  });
});
