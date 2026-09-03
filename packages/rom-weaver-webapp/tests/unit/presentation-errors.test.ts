import { describe, expect, it } from "vitest";
import { formatCodedErrorForDisplay, getErrorCode } from "../../src/presentation/errors.ts";

const codedError = (
  message: string,
  code: unknown,
  options: { cause?: unknown; details?: Record<string, unknown> } = {},
): Error => Object.assign(new Error(message), { code, ...options });

describe("presentation errors", () => {
  it("reads codes only from Error instances with string codes", () => {
    expect(getErrorCode(codedError("failed", "WORKER_FAILED"))).toBe("WORKER_FAILED");
    expect(getErrorCode(codedError("failed", 42))).toBe("");
    expect(getErrorCode({ code: "WORKER_FAILED" })).toBe("");
  });

  it("returns uncoded values without a code prefix", () => {
    expect(formatCodedErrorForDisplay(new Error("plain failure"))).toBe("plain failure");
    expect(formatCodedErrorForDisplay("plain failure")).toBe("plain failure");
  });

  it("localizes known codes and keeps the original detail", () => {
    expect(formatCodedErrorForDisplay(codedError("bad selection", "INVALID_INPUT"))).toBe(
      "INVALID_INPUT: The selected input is not valid. Details: bad selection",
    );
  });

  it("keeps messages that carry required runtime detail", () => {
    expect(formatCodedErrorForDisplay(codedError("Multi-file output needs an archive", "INVALID_INPUT"))).toBe(
      "INVALID_INPUT: Multi-file output needs an archive",
    );
    expect(formatCodedErrorForDisplay(codedError("Wasm OOM", "WORKER_FAILED"))).toBe("WORKER_FAILED: Wasm OOM");
    expect(formatCodedErrorForDisplay(codedError("bad alloc", "COMPRESSION_FAILED"))).toBe(
      "COMPRESSION_FAILED: bad alloc",
    );
  });

  it("uses a distinct cause before structured worker details", () => {
    const error = codedError("Worker execution failed.", "WORKER_FAILED", {
      cause: new Error("worker crashed"),
      details: { phase: "run", workerName: "patch-worker" },
    });
    expect(formatCodedErrorForDisplay(error)).toBe("WORKER_FAILED: Worker execution failed. Details: worker crashed");
  });

  it("formats finite script coordinates and request identifiers", () => {
    const error = codedError("Worker execution failed.", "WORKER_FAILED", {
      details: {
        columnNumber: 9,
        fileName: "runner.js",
        lineNumber: 14,
        phase: "start",
        requestId: "request-7",
        workerName: "runner",
      },
    });
    expect(formatCodedErrorForDisplay(error)).toBe(
      "WORKER_FAILED: Worker execution failed. Details: phase=start, worker=runner, script=runner.js, line=14, column=9, requestId=request-7",
    );
  });

  it("falls back to a worker URL and omits invalid coordinates", () => {
    const error = codedError("Worker execution failed.", "WORKER_FAILED", {
      details: {
        columnNumber: Number.NaN,
        lineNumber: Number.POSITIVE_INFINITY,
        workerScriptUrl: "/workers/runner.js",
      },
    });
    expect(formatCodedErrorForDisplay(error)).toBe(
      "WORKER_FAILED: Worker execution failed. Details: script=/workers/runner.js",
    );
  });

  it("keeps the raw message for unknown error codes", () => {
    expect(formatCodedErrorForDisplay(codedError("future failure", "FUTURE_ERROR"))).toBe(
      "FUTURE_ERROR: future failure",
    );
  });
});
