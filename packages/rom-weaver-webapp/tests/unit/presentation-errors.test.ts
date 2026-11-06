import { describe, expect, it } from "vitest";
import { formatCodedErrorForDisplay, getDisplayedErrorCode, getErrorCode } from "../../src/presentation/errors.ts";

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

  const engineError = (message: string, engineCode: string, engineFields: Record<string, string>) =>
    codedError(message, "COMPRESSION_FAILED", { details: { engineCode, engineFields } });

  it("shows a plain no-ROM message without the internal path or filter flag", () => {
    const message = "validation failed: no extract entries from `/work/version.rar` matched --filter rom";
    const coded = engineError(message, "extract.no_matching_entries", {
      filter: "--filter rom",
      path: "/work/version.rar",
    });
    expect(formatCodedErrorForDisplay(coded)).toBe("No ROM found in version.rar.");
    expect(formatCodedErrorForDisplay(codedError("failed", "WORKER_FAILED", { cause: coded }))).toBe(
      "No ROM found in version.rar.",
    );
    // The text alone no longer classifies: only the engine code does.
    expect(formatCodedErrorForDisplay(codedError(message, "COMPRESSION_FAILED"))).toMatch(/^COMPRESSION_FAILED: /);
  });

  it.each(["/work/readme-only.zip", "/work/notes `v2`.zip"])(
    "offers browser recovery when all extract entries of %s are ignored",
    (path) => {
      const diagnostic = `validation failed: all extract entries from \`${path}\` were ignored by default filters; rerun with --no-ignore or pass --select <pattern>`;
      const fileName = path.split("/").pop();
      const expected = `No usable ROM found in ${fileName}. Choose an archive containing a ROM, or extract it and add the ROM file.`;
      const coded = engineError(diagnostic, "extract.all_entries_ignored", { path });
      expect(formatCodedErrorForDisplay(coded)).toBe(expected);
      expect(formatCodedErrorForDisplay(codedError("failed", "WORKER_FAILED", { cause: coded }))).toBe(expected);
    },
  );

  it("keeps messages that carry required runtime detail", () => {
    expect(formatCodedErrorForDisplay(codedError("Multi-file output needs an archive", "INVALID_INPUT"))).toBe(
      "INVALID_INPUT: Multi-file output needs an archive",
    );
    expect(formatCodedErrorForDisplay(codedError("Wasm OOM", "OUT_OF_MEMORY"))).toBe("OUT_OF_MEMORY: Wasm OOM");
  });

  it("decides memory exhaustion by code, not by the message text", () => {
    expect(formatCodedErrorForDisplay(codedError("Wasm OOM", "WORKER_FAILED"))).toBe(
      "WORKER_FAILED: The task stopped unexpectedly. Reload the page and try again. Details: Wasm OOM",
    );
    expect(formatCodedErrorForDisplay(codedError("bad alloc", "COMPRESSION_FAILED"))).toBe(
      "COMPRESSION_FAILED: Compression failed. Details: bad alloc",
    );
  });

  it("localizes a storage-full failure and keeps its detail", () => {
    expect(formatCodedErrorForDisplay(codedError("write failed", "STORAGE_FULL"))).toBe(
      "STORAGE_FULL: Couldn't save the result. Free up storage, or choose a folder the browser can write to. Details: write failed",
    );
  });

  it("reads the displayed code from a prefix only when it is a workflow code", () => {
    expect(getDisplayedErrorCode("STORAGE_FULL: full")).toBe("STORAGE_FULL");
    expect(getDisplayedErrorCode("full", "OUT_OF_MEMORY")).toBe("OUT_OF_MEMORY");
    expect(getDisplayedErrorCode("ERROR: no space left")).toBeUndefined();
    expect(getDisplayedErrorCode("no space left")).toBeUndefined();
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
