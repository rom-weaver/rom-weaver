import { describe, expect, it } from "vitest";
import {
  formatDownloadCompressionRatio,
  formatElapsedTiming,
  getLogicalRomInputCount,
  getMultiInputOutputError,
  getRequestedOutputName,
  isWorkflowDisposedError,
  resolveLocalStateUpdate,
  resolvePendingDownloadFileName,
  toError,
} from "../../src/public/react/patcher-form-session-utils.ts";
import type { RomInputRowState } from "../../src/public/react/patcher-ui-state.ts";

const row = (overrides: Partial<RomInputRowState>): RomInputRowState => ({ groupId: "", ...overrides }) as never;

describe("getRequestedOutputName", () => {
  it("trims and collapses blank names to undefined", () => {
    expect(getRequestedOutputName("  rom.zip ")).toBe("rom.zip");
    expect(getRequestedOutputName("   ")).toBeUndefined();
  });
});

describe("resolvePendingDownloadFileName", () => {
  it("keeps a requested name that already has an extension", () => {
    expect(resolvePendingDownloadFileName({ requestedOutputName: "rom.zip", resultOutputName: "x.7z" })).toBe(
      "rom.zip",
    );
  });

  it("borrows the result extension when the requested name has none", () => {
    expect(resolvePendingDownloadFileName({ requestedOutputName: "rom", resultOutputName: "x.7z" })).toBe("rom.7z");
  });

  it("falls back through result, automatic, fallback, then 'output'", () => {
    expect(resolvePendingDownloadFileName({ resultOutputName: "x.7z" })).toBe("x.7z");
    expect(resolvePendingDownloadFileName({ automaticOutputName: "auto.zip" })).toBe("auto.zip");
    expect(resolvePendingDownloadFileName({ fallbackOutputName: "fb.zip" })).toBe("fb.zip");
    expect(resolvePendingDownloadFileName({})).toBe("output");
  });
});

describe("getLogicalRomInputCount", () => {
  it("counts each group once plus every ungrouped row", () => {
    const rows = [row({ groupId: "disc" }), row({ groupId: "disc" }), row({ groupId: "" }), row({ groupId: "  " })];
    expect(getLogicalRomInputCount(rows)).toBe(3);
  });
});

describe("getMultiInputOutputError", () => {
  it("is empty for single logical inputs or archive formats", () => {
    expect(getMultiInputOutputError("none", 1)).toBe("");
    expect(getMultiInputOutputError("zip", 2)).toBe("");
    expect(getMultiInputOutputError("7z", 2)).toBe("");
  });

  it("explains the 'none' and non-archive cases for multi-input output", () => {
    expect(getMultiInputOutputError("none", 2)).toContain("cannot be used for multi-file output");
    expect(getMultiInputOutputError("chd", 2)).toContain("'chd' cannot be used for multi-file output");
  });
});

describe("formatElapsedTiming", () => {
  it("renders finite non-negative durations and suppresses the rest", () => {
    expect(formatElapsedTiming(0)).not.toBe("");
    expect(formatElapsedTiming(-1)).toBe("");
    expect(formatElapsedTiming(null)).toBe("");
    expect(formatElapsedTiming(Number.NaN)).toBe("");
  });
});

describe("formatDownloadCompressionRatio", () => {
  it("suppresses the ratio for inputs under the noise threshold", () => {
    expect(formatDownloadCompressionRatio(13, 7)).toBe("");
  });

  it("renders a percentage once the input is large enough", () => {
    expect(formatDownloadCompressionRatio(200 * 1024, 100 * 1024)).toContain("50");
  });
});

describe("misc helpers", () => {
  it("resolveLocalStateUpdate accepts values and updater functions", () => {
    expect(resolveLocalStateUpdate(1, 2)).toBe(2);
    expect(resolveLocalStateUpdate(1, (current) => current + 4)).toBe(5);
  });

  it("toError wraps non-errors", () => {
    const wrapped = toError("nope");
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe("nope");
    const original = new Error("keep");
    expect(toError(original)).toBe(original);
  });

  it("isWorkflowDisposedError matches the disposed code only", () => {
    expect(isWorkflowDisposedError(Object.assign(new Error("x"), { code: "WORKFLOW_DISPOSED" }))).toBe(true);
    expect(isWorkflowDisposedError(new Error("x"))).toBe(false);
  });
});
