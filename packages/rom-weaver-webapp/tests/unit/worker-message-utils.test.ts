import { afterEach, describe, expect, it, vi } from "vitest";
import { postCloneSafeWorkerMessage } from "../../src/workers/shared/worker-message-utils.ts";

const createScope = (postMessage: (message: unknown, transfer?: unknown) => void) => ({ postMessage });

afterEach(() => {
  vi.restoreAllMocks();
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
