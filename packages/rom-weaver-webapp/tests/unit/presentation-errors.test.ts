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
      "INVALID_INPUT: rom-weaver couldn't use the files you added. Details: bad selection",
    );
  });

  it("shows a plain no-ROM message without the internal path or filter flag", () => {
    const message = "validation failed: no extract entries from `/work/version.rar` matched --filter rom";
    const formatted = formatCodedErrorForDisplay(codedError(message, "COMPRESSION_FAILED"));
    expect(formatted).toBe("No ROM found in version.rar.");
    expect(formatCodedErrorForDisplay(codedError("failed", "WORKER_FAILED", { cause: new Error(message) }))).toBe(
      "No ROM found in version.rar.",
    );
  });

  it.each(["extract entries", "extracted patch create original candidates", "extracted ingest input candidates"])(
    "offers browser recovery when all %s are ignored",
    (entries) => {
      const diagnostic = `validation failed: all ${entries} from \`/work/readme-only.zip\` were ignored by default filters; rerun with --no-ignore or pass --select <pattern>`;
      const expected =
        "No usable ROM found in readme-only.zip. Choose an archive containing a ROM, or extract it and add the ROM file.";
      expect(formatCodedErrorForDisplay(diagnostic)).toBe(expected);
      expect(formatCodedErrorForDisplay(codedError(diagnostic, "COMPRESSION_FAILED"))).toBe(expected);
      expect(formatCodedErrorForDisplay(codedError("failed", "WORKER_FAILED", { cause: new Error(diagnostic) }))).toBe(
        expected,
      );
    },
  );

  it("offers browser recovery when the ignored archive name contains a backtick", () => {
    const diagnostic =
      "validation failed: all extract entries from `/work/notes `v2`.zip` were ignored by default filters; rerun with --no-ignore or pass --select <pattern>";
    expect(formatCodedErrorForDisplay(diagnostic)).toBe(
      "No usable ROM found in notes `v2`.zip. Choose an archive containing a ROM, or extract it and add the ROM file.",
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
    const error = codedError("The task stopped unexpectedly. Reload the page and try again.", "WORKER_FAILED", {
      cause: new Error("worker crashed"),
      details: { phase: "run", workerName: "patch-worker" },
    });
    expect(formatCodedErrorForDisplay(error)).toBe(
      "WORKER_FAILED: The task stopped unexpectedly. Reload the page and try again. Details: worker crashed",
    );
  });

  it("formats finite script coordinates and request identifiers", () => {
    const error = codedError("The task stopped unexpectedly. Reload the page and try again.", "WORKER_FAILED", {
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
      "WORKER_FAILED: The task stopped unexpectedly. Reload the page and try again. Details: phase=start, worker=runner, script=runner.js, line=14, column=9, requestId=request-7",
    );
  });

  it("falls back to a worker URL and omits invalid coordinates", () => {
    const error = codedError("The task stopped unexpectedly. Reload the page and try again.", "WORKER_FAILED", {
      details: {
        columnNumber: Number.NaN,
        lineNumber: Number.POSITIVE_INFINITY,
        workerScriptUrl: "/workers/runner.js",
      },
    });
    expect(formatCodedErrorForDisplay(error)).toBe(
      "WORKER_FAILED: The task stopped unexpectedly. Reload the page and try again. Details: script=/workers/runner.js",
    );
  });

  it("keeps the raw message for unknown error codes", () => {
    expect(formatCodedErrorForDisplay(codedError("future failure", "FUTURE_ERROR"))).toBe(
      "FUTURE_ERROR: future failure",
    );
  });
});
