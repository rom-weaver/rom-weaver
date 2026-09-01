import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createRunnerWorkerMessageQueue } from "../../src/wasm/workers/runner-worker-core.ts";
import {
  SELECT_REQUEST_COUNT_INDEX,
  SELECT_REQUEST_HEADER_LENGTH,
  SELECT_REQUEST_READY,
  SELECT_REQUEST_READY_INDEX,
} from "../../src/wasm/workers/worker-protocol.ts";

type WorkerMessage = Record<string, unknown> & { type: string };
type RunJsonOptions = Record<string, unknown> & {
  hostSelect?: (request: string) => number[];
  onEvent?: (event: unknown) => void;
  onNonJsonLine?: (line: string) => void;
  onTraceEvent?: (event: unknown) => void;
  onTraceNonJsonLine?: (line: string) => void;
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let posted: WorkerMessage[];
let runJson: ReturnType<typeof vi.fn>;
let dispose: ReturnType<typeof vi.fn>;
let initRunner: ReturnType<typeof vi.fn>;
let runnerOverride: unknown;

function makeQueue() {
  return createRunnerWorkerMessageQueue({
    initRunner: initRunner as never,
    postMessage: (message) => posted.push(message as unknown as WorkerMessage),
  });
}

function messagesOfType(type: string) {
  return posted.filter((message) => message.type === type);
}

function traceLines() {
  return messagesOfType("traceNonJsonLine").map((message) => String(message.line));
}

beforeEach(() => {
  posted = [];
  runJson = vi.fn(async () => ({ events: [], exitCode: 0, nonJsonLines: [], ok: true }));
  dispose = vi.fn(async () => undefined);
  runnerOverride = null;
  initRunner = vi.fn(async () => ({
    mode: "browser-opfs",
    runner: runnerOverride ?? { dispose, runJson, threaded: true, wasmUrl: "/app.wasm" },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function initialized() {
  const queue = makeQueue();
  queue.enqueue({ options: {}, requestId: 1, type: "init" } as never);
  await settle();
  posted.length = 0;
  return queue;
}

describe("runner worker init", () => {
  it("builds the runner and answers with its mode and threading flags", async () => {
    const queue = makeQueue();
    queue.enqueue({ mode: "browser-opfs", options: { wasmUrl: "/app.wasm" }, requestId: 7, type: "init" } as never);
    await settle();

    expect(initRunner).toHaveBeenCalledWith({ mode: "browser-opfs", options: { wasmUrl: "/app.wasm" } });
    expect(messagesOfType("ready")[0]).toEqual({
      mode: "browser-opfs",
      requestId: 7,
      threaded: true,
      type: "ready",
      wasmUrl: "/app.wasm",
    });
    void queue;
  });

  it("passes an empty options object and no mode when the request omits them", async () => {
    const queue = makeQueue();
    queue.enqueue({ mode: 5, requestId: 1, type: "init" } as never);
    await settle();

    expect(initRunner).toHaveBeenCalledWith({ mode: undefined, options: {} });
    void queue;
  });

  it("reports a runner with no wasm url as null", async () => {
    runnerOverride = { dispose, runJson, threaded: false, wasmUrl: null };
    const queue = makeQueue();
    queue.enqueue({ options: {}, requestId: 1, type: "init" } as never);
    await settle();

    expect(messagesOfType("ready")[0]).toMatchObject({ threaded: false, wasmUrl: null });
    void queue;
  });

  it("traces the queue lifecycle around every message", async () => {
    const queue = makeQueue();
    queue.enqueue({ options: {}, requestId: 3, type: "init" } as never);
    await settle();

    expect(traceLines()).toEqual([
      "[runner-worker] message enqueued requestId=3 type=init queued=1 active=none",
      "[runner-worker] message handling requestId=3 type=init queued=0",
      "[runner-worker] message handled requestId=3 type=init",
    ]);
    void queue;
  });

  it("posts no trace lines for a message without a request id", async () => {
    const queue = makeQueue();
    queue.enqueue({ options: {}, type: "init" } as never);
    await settle();

    expect(traceLines()).toEqual([]);
    expect(messagesOfType("ready")[0]).toMatchObject({ requestId: null });
    void queue;
  });
});

describe("runner worker runJson", () => {
  it("refuses to run before init", async () => {
    const queue = makeQueue();
    queue.enqueue({ request: { args: {}, type: "probe" }, requestId: 2, type: "runJson" } as never);
    await settle();

    expect(messagesOfType("error")[0]).toMatchObject({
      error: { message: "worker is not initialized. Send an init message first." },
      requestId: 2,
    });
    void queue;
  });

  it("forwards the request and posts the runner result", async () => {
    const queue = await initialized();
    const result = { events: [{ status: "succeeded" }], exitCode: 0, ok: true };
    runJson.mockResolvedValueOnce(result);

    queue.enqueue({
      options: { virtualFiles: [] },
      request: { command: { args: {}, type: "probe" }, output: {} },
      requestId: 4,
      type: "runJson",
    } as never);
    await settle();

    expect(runJson).toHaveBeenCalledTimes(1);
    expect(messagesOfType("result")[0]).toEqual({
      operation: "runJson",
      requestId: 4,
      result,
      type: "result",
    });
    expect(traceLines().some((line) => line.includes("runJson received command="))).toBe(true);
  });

  it("relays guest events, lines and trace output back to the client", async () => {
    const queue = await initialized();
    runJson.mockImplementationOnce(async (_request: unknown, options: RunJsonOptions) => {
      options.onEvent?.({ status: "running" });
      options.onNonJsonLine?.("plain stdout");
      options.onTraceEvent?.({ trace: true });
      options.onTraceNonJsonLine?.("trace line");
      return { events: [], exitCode: 0, ok: true };
    });

    queue.enqueue({ request: { args: {}, type: "probe" }, requestId: 5, type: "runJson" } as never);
    await settle();

    expect(messagesOfType("event")[0]).toEqual({ event: { status: "running" }, requestId: 5, type: "event" });
    expect(messagesOfType("nonJsonLine")[0]).toEqual({ line: "plain stdout", requestId: 5, type: "nonJsonLine" });
    expect(messagesOfType("traceEvent")[0]).toEqual({ event: { trace: true }, requestId: 5, type: "traceEvent" });
    expect(traceLines()).toContain("trace line");
  });

  it("traces the runner call through the caller's own trace sink", async () => {
    const queue = await initialized();
    const traced: string[] = [];
    runJson.mockImplementationOnce(async () => ({ events: [], exitCode: 0, ok: true, traceEvents: [] }));

    queue.enqueue({
      options: { onTraceNonJsonLine: (line: string) => traced.push(line) },
      request: { args: {}, type: "probe" },
      requestId: 6,
      type: "runJson",
    } as never);
    await settle();

    // The queue replaces the caller's sink with its own postMessage bridge.
    expect(traced).toEqual([]);
    expect(traceLines().some((line) => line.includes("runJson invoking runner command="))).toBe(true);
    expect(traceLines().some((line) => line.includes("runJson runner returned ok=true exitCode=0"))).toBe(true);
  });

  it("summarizes the stream routing and virtual files it was handed", async () => {
    const queue = await initialized();
    queue.enqueue({
      options: {
        __streamBroadcastChannelName: "rw-stream",
        virtualFiles: [
          { path: "/work/a.iso", source: { size: 12 } },
          { path: "/work/b.iso", useProxyHandle: true },
        ],
      },
      request: { command: { args: {}, type: "compress" }, output: {} },
      requestId: 8,
      type: "runJson",
    } as never);
    await settle();

    const received = traceLines().find((line) => line.includes("runJson received"));
    expect(received).toContain("stream=true");
    expect(received).toContain("virtualFiles=count=2,proxy=1,direct=1,bytes=12");
  });

  it("reports a runner throw as a worker error with the request context", async () => {
    const queue = await initialized();
    runJson.mockRejectedValueOnce(new Error("guest trapped"));

    queue.enqueue({
      request: { command: { args: {}, type: "compress" }, output: {} },
      requestId: 9,
      type: "runJson",
    } as never);
    await settle();

    const error = messagesOfType("error")[0]?.error as Record<string, unknown>;
    expect(error).toMatchObject({
      context: { command: "compress", stage: "worker.runJson" },
      message: "guest trapped",
      name: "Error",
    });
    expect(traceLines().some((line) => line.includes("runJson threw Error:guest trapped"))).toBe(true);
  });
});

describe("runner worker hostSelect", () => {
  function answerSelection(count: number, indices: number[]) {
    return vi.spyOn(Atomics, "wait").mockImplementation(((control: Int32Array) => {
      Atomics.store(control, SELECT_REQUEST_COUNT_INDEX, count);
      indices.forEach((value, slot) => {
        Atomics.store(control, SELECT_REQUEST_HEADER_LENGTH + slot, value);
      });
      Atomics.store(control, SELECT_REQUEST_READY_INDEX, SELECT_REQUEST_READY);
      return "ok";
    }) as unknown as typeof Atomics.wait);
  }

  const selectRequest = JSON.stringify({ candidates: ["a", "b", "c"], heading: "Pick", mode: "multi" });

  it("posts a select request and returns the indices the host chose", async () => {
    const queue = await initialized();
    answerSelection(2, [2, 0]);
    let selected: number[] = [];
    runJson.mockImplementationOnce(async (_request: unknown, options: RunJsonOptions) => {
      selected = options.hostSelect?.(selectRequest) ?? [];
      return { events: [], exitCode: 0, ok: true };
    });

    queue.enqueue({ request: { args: {}, type: "extract" }, requestId: 11, type: "runJson" } as never);
    await settle();

    expect(selected).toEqual([2, 0]);
    const request = messagesOfType("selectRequest")[0];
    expect(request).toMatchObject({ request: selectRequest, requestId: 11 });
    expect((request?.control as SharedArrayBuffer | undefined)?.byteLength).toBe(
      (SELECT_REQUEST_HEADER_LENGTH + 3) * Int32Array.BYTES_PER_ELEMENT,
    );
    expect(
      traceLines().some((line) =>
        line.includes('hostSelect prompting user to pick entries mode=multi heading="Pick" candidates=3'),
      ),
    ).toBe(true);
    expect(traceLines().some((line) => line.includes("hostSelect woke with 2 selected index(es) [2,0]"))).toBe(true);
  });

  it("treats a non-positive count as a cancel", async () => {
    const queue = await initialized();
    answerSelection(-1, []);
    let selected: number[] = [1];
    runJson.mockImplementationOnce(async (_request: unknown, options: RunJsonOptions) => {
      selected = options.hostSelect?.(selectRequest) ?? [];
      return { events: [], exitCode: 0, ok: true };
    });

    queue.enqueue({ request: { args: {}, type: "extract" }, requestId: 12, type: "runJson" } as never);
    await settle();

    expect(selected).toEqual([]);
    expect(traceLines().some((line) => line.includes("hostSelect woke cancelled (count<=0)"))).toBe(true);
  });

  it("clamps the reply to the candidate count and tolerates an unparsable request", async () => {
    const queue = await initialized();
    answerSelection(9, [4, 5, 6]);
    let clamped: number[] = [];
    let unparsable: number[] = [];
    runJson.mockImplementationOnce(async (_request: unknown, options: RunJsonOptions) => {
      clamped = options.hostSelect?.(selectRequest) ?? [];
      unparsable = options.hostSelect?.("not json") ?? [];
      return { events: [], exitCode: 0, ok: true };
    });

    queue.enqueue({ request: { args: {}, type: "extract" }, requestId: 13, type: "runJson" } as never);
    await settle();

    expect(clamped).toEqual([4, 5, 6]);
    // Zero candidates leaves only the header, so no index can be read back.
    expect(unparsable).toEqual([]);
    const controls = messagesOfType("selectRequest").map(
      (message) => (message.control as SharedArrayBuffer).byteLength,
    );
    expect(controls).toEqual([
      (SELECT_REQUEST_HEADER_LENGTH + 3) * Int32Array.BYTES_PER_ELEMENT,
      SELECT_REQUEST_HEADER_LENGTH * Int32Array.BYTES_PER_ELEMENT,
    ]);
  });
});

describe("runner worker dispose and unknown messages", () => {
  it("disposes the runner and clears it", async () => {
    const queue = await initialized();
    queue.enqueue({ requestId: 20, type: "dispose" } as never);
    await settle();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(messagesOfType("disposed")[0]).toEqual({ requestId: 20, type: "disposed" });

    queue.enqueue({ request: { args: {}, type: "probe" }, requestId: 21, type: "runJson" } as never);
    await settle();
    expect(messagesOfType("error")[0]).toMatchObject({
      error: { message: "worker is not initialized. Send an init message first." },
    });
  });

  it("disposes cleanly when no runner was ever built", async () => {
    const queue = makeQueue();
    queue.enqueue({ requestId: 22, type: "dispose" } as never);
    await settle();

    expect(messagesOfType("disposed")[0]).toEqual({ requestId: 22, type: "disposed" });
  });

  it("rejects an unknown message type with its stage context", async () => {
    const queue = makeQueue();
    queue.enqueue({ requestId: 23, type: "nope" } as never);
    await settle();

    expect(messagesOfType("error")[0]?.error).toMatchObject({
      context: { stage: "worker.nope" },
      message: "unknown worker message type: nope",
    });
  });

  it("rejects a non-object message and still labels the queue entry", async () => {
    const queue = makeQueue();
    queue.enqueue("not-a-message" as never);
    await settle();

    expect(traceLines()).toEqual([]);
    expect(messagesOfType("error")[0]).toMatchObject({
      error: { message: "worker message must be an object", name: "TypeError" },
      requestId: null,
    });
  });

  it("handles queued messages one at a time, in order", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | null = null;
    initRunner = vi.fn(async () => {
      order.push("init-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("init-end");
      return { mode: "browser-opfs", runner: { dispose, runJson, threaded: false, wasmUrl: null } };
    });

    const queue = makeQueue();
    queue.enqueue({ options: {}, requestId: 1, type: "init" } as never);
    queue.enqueue({ requestId: 2, type: "dispose" } as never);
    await settle();

    expect(order).toEqual(["init-start"]);
    expect(messagesOfType("disposed")).toHaveLength(0);
    // Both enqueues land before the first handler starts, so the depth is 2.
    expect(traceLines()).toContain("[runner-worker] message enqueued requestId=2 type=dispose queued=2 active=none");

    releaseFirst?.();
    await settle();
    expect(order).toEqual(["init-start", "init-end"]);
    expect(messagesOfType("disposed")).toHaveLength(1);
  });
});

describe("runner worker error serialization", () => {
  async function errorFor(thrown: unknown) {
    const queue = await initialized();
    runJson.mockRejectedValueOnce(thrown);
    queue.enqueue({ request: { args: {}, type: "probe" }, requestId: 30, type: "runJson" } as never);
    await settle();
    return messagesOfType("error")[0]?.error as Record<string, unknown>;
  }

  it("keeps the name, message and stack of a thrown Error", async () => {
    const thrown = new RangeError("out of range");
    const error = await errorFor(thrown);

    expect(error).toMatchObject({ message: "out of range", name: "RangeError" });
    expect(typeof error.stack).toBe("string");
  });

  it("serializes a thrown string, null and undefined", async () => {
    expect(await errorFor("bare failure")).toMatchObject({ message: "bare failure", name: "Error" });
    expect(await errorFor(null)).toMatchObject({ message: "null" });
    expect(await errorFor(undefined)).toMatchObject({ message: "undefined" });
  });

  it("falls back to JSON for a thrown plain object", async () => {
    expect(await errorFor({ detail: "oops" })).toMatchObject({ message: '{"detail":"oops"}' });
    expect(await errorFor({})).toMatchObject({ message: "[object Object]" });
  });

  it("serializes an Error cause and a string cause, dropping anything else", async () => {
    const withErrorCause = await errorFor(new Error("outer", { cause: new TypeError("inner") }));
    expect(withErrorCause.cause).toMatchObject({ message: "inner", name: "TypeError" });

    const withStringCause = await errorFor(Object.assign(new Error("outer"), { cause: "just text" }));
    expect(withStringCause.cause).toBe("just text");

    const withOtherCause = await errorFor(Object.assign(new Error("outer"), { cause: 42 }));
    expect(withOtherCause).not.toHaveProperty("cause");
  });

  it("prefers the error's own context over the request's", async () => {
    const thrown = Object.assign(new Error("bad format"), {
      context: { command: "identify", family: "archive", format: "zip", stage: "probe" },
    });
    const queue = await initialized();
    runJson.mockRejectedValueOnce(thrown);
    queue.enqueue({
      request: { command: { args: {}, type: "compress" }, output: {} },
      requestId: 31,
      type: "runJson",
    } as never);
    await settle();

    expect((messagesOfType("error")[0]?.error as Record<string, unknown> | undefined)?.context).toEqual({
      command: "identify",
      family: "archive",
      format: "zip",
      stage: "probe",
    });
  });

  it("omits the context entirely when nothing identifies the failure", async () => {
    const queue = makeQueue();
    queue.enqueue(42 as never);
    await settle();

    expect(messagesOfType("error")[0]?.error).not.toHaveProperty("context");
  });
});
