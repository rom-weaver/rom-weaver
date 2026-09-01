import { afterEach, describe, expect, it, vi } from "vitest";
import { getWorkerErrorMessage, postCloneSafeWorkerMessage } from "../../src/workers/shared/worker-message-utils.ts";

const createScope = (postMessage: (message: unknown, transfer?: unknown) => void) => ({ postMessage });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getWorkerErrorMessage", () => {
  it("returns a string error unchanged", () => {
    expect(getWorkerErrorMessage("boom")).toBe("boom");
  });

  it("prefers an Error stack over its message", () => {
    const error = new Error("failed");
    error.stack = "Error: failed\n    at worker";
    expect(getWorkerErrorMessage(error)).toBe("Error: failed\n    at worker");
  });

  it("falls back to the Error message when the stack is empty", () => {
    const error = new Error("failed");
    error.stack = "";
    expect(getWorkerErrorMessage(error)).toBe("failed");
  });

  it("reads message then stack off an error-like object", () => {
    expect(getWorkerErrorMessage({ message: "plain message" })).toBe("plain message");
    expect(getWorkerErrorMessage({ message: 42, stack: "stack only" })).toBe("stack only");
  });

  it("describes an ErrnoError by its errno", () => {
    expect(getWorkerErrorMessage({ errno: 2, name: "ErrnoError" })).toBe(
      "Worker filesystem file not found while preparing disc output.",
    );
    expect(getWorkerErrorMessage({ errno: "13", name: "ErrnoError" })).toBe(
      "Worker filesystem error 13 while preparing disc output.",
    );
  });

  it("serializes an object that is neither error-like nor an ErrnoError", () => {
    expect(getWorkerErrorMessage({ code: 7, name: "ErrnoError" })).toBe('{"code":7,"name":"ErrnoError"}');
    expect(getWorkerErrorMessage({ detail: "unstructured" })).toBe('{"detail":"unstructured"}');
  });

  it("falls back to String() when the object cannot be serialized", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(getWorkerErrorMessage(circular)).toBe("[object Object]");
  });

  it("reports a generic crash for falsy throws", () => {
    expect(getWorkerErrorMessage(null)).toBe("Worker crashed");
    expect(getWorkerErrorMessage(undefined)).toBe("Worker crashed");
    expect(getWorkerErrorMessage(0)).toBe("Worker crashed");
  });

  it("stringifies a truthy primitive throw", () => {
    expect(getWorkerErrorMessage(404)).toBe("404");
    expect(getWorkerErrorMessage(true)).toBe("true");
  });
});

describe("postCloneSafeWorkerMessage", () => {
  it("stamps a timestamp on an object message that has none", () => {
    vi.spyOn(performance, "now").mockReturnValue(1234);
    const postMessage = vi.fn();

    postCloneSafeWorkerMessage(createScope(postMessage), { type: "progress" });

    expect(postMessage).toHaveBeenCalledWith({ timestamp: 1234, type: "progress" }, undefined);
  });

  it("keeps an existing timestamp", () => {
    vi.spyOn(performance, "now").mockReturnValue(1234);
    const postMessage = vi.fn();

    postCloneSafeWorkerMessage(createScope(postMessage), { timestamp: 7, type: "progress" });

    expect(postMessage).toHaveBeenCalledWith({ timestamp: 7, type: "progress" }, undefined);
  });

  it("passes a non-object message through and forwards the transfer list", () => {
    const postMessage = vi.fn();
    const transfer = [new ArrayBuffer(4)];

    postCloneSafeWorkerMessage(createScope(postMessage), "ping", transfer);

    expect(postMessage).toHaveBeenCalledWith("ping", transfer);
  });

  it("retries without the uncloneable handle fields", () => {
    const postMessage = vi.fn((message: unknown) => {
      if (message && typeof message === "object" && "fileHandle" in message) throw new DOMException("uncloneable");
    });
    const message = { fileHandle: { kind: "file" }, patchedRomFileHandle: { kind: "file" }, type: "done" };

    postCloneSafeWorkerMessage(createScope(postMessage), message);

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[1]?.[0]).toEqual({ timestamp: expect.any(Number), type: "done" });
    // The retry must not strip the caller's own object.
    expect(message.fileHandle).toEqual({ kind: "file" });
  });

  it("strips a nested outputRef handle without mutating the caller's outputRef", () => {
    let attempts = 0;
    const postMessage = vi.fn(() => {
      attempts += 1;
      if (attempts === 1) throw new DOMException("uncloneable");
    });
    const outputRef = { fileHandle: { kind: "file" }, path: "out.bin" };

    postCloneSafeWorkerMessage(createScope(postMessage), { outputRef, type: "done" });

    expect(postMessage.mock.calls[1]?.[0]).toEqual({
      outputRef: { path: "out.bin" },
      timestamp: expect.any(Number),
      type: "done",
    });
    expect(outputRef.fileHandle).toEqual({ kind: "file" });
  });

  it("rethrows when there is no uncloneable field to remove", () => {
    const failure = new DOMException("uncloneable");
    const postMessage = vi.fn(() => {
      throw failure;
    });

    expect(() => postCloneSafeWorkerMessage(createScope(postMessage), { type: "done" })).toThrow(failure);
    expect(() => postCloneSafeWorkerMessage(createScope(postMessage), "ping")).toThrow(failure);
  });
});
