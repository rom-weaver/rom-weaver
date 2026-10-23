import { describe, expect, it } from "vitest";
import {
  formatDownloadCompressionRatio,
  formatElapsedTiming,
  getRequestedOutputName,
  isWorkflowDisposedError,
  resolveLocalStateUpdate,
  resolvePendingDownloadFileName,
  toError,
} from "../../src/public/react/patcher-form-session-utils.ts";

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

  it("appends the result extension after a dotted version", () => {
    expect(resolvePendingDownloadFileName({ requestedOutputName: "Hack v1.2", resultOutputName: "x.zip" })).toBe(
      "Hack v1.2.zip",
    );
  });

  it("borrows the result extension when the requested name has none", () => {
    expect(resolvePendingDownloadFileName({ requestedOutputName: "rom", resultOutputName: "x.7z" })).toBe("rom.7z");
  });

  it("treats a version segment as part of the requested stem", () => {
    expect(
      resolvePendingDownloadFileName({ requestedOutputName: "Practice 3.5.1", resultOutputName: "Practice 3.5.1.nes" }),
    ).toBe("Practice 3.5.1.nes");
    expect(resolvePendingDownloadFileName({ requestedOutputName: "Typed.sfc", resultOutputName: "x.nes" })).toBe(
      "Typed.sfc",
    );
  });

  it("borrows the literal result extension after a hash character", () => {
    expect(
      resolvePendingDownloadFileName({ requestedOutputName: "Hack.v2#2", resultOutputName: "Hack.v2#2.nes" }),
    ).toBe("Hack.v2#2.nes");
    expect(
      resolvePendingDownloadFileName({ requestedOutputName: "Kaizo Mario #2", resultOutputName: "Kaizo Mario #2.nes" }),
    ).toBe("Kaizo Mario #2.nes");
  });

  it("falls back through result, automatic, fallback, then 'output'", () => {
    expect(resolvePendingDownloadFileName({ resultOutputName: "x.7z" })).toBe("x.7z");
    expect(resolvePendingDownloadFileName({ automaticOutputName: "auto.zip" })).toBe("auto.zip");
    expect(resolvePendingDownloadFileName({ fallbackOutputName: "fb.zip" })).toBe("fb.zip");
    expect(resolvePendingDownloadFileName({})).toBe("output");
  });

  it("prefers the automatic name over a stale result name, keeping the result extension", () => {
    const base = { automaticOutputName: "game [change]", preferAutomaticName: true };
    expect(resolvePendingDownloadFileName({ ...base, resultOutputName: "valid-name.bin" })).toBe("game [change].bin");
    expect(resolvePendingDownloadFileName({ ...base, resultOutputName: "valid-name.zip" })).toBe("game [change].zip");
  });

  it("uses the automatic name when the requested name has only reserved characters", () => {
    expect(
      resolvePendingDownloadFileName({
        automaticOutputName: "game [change]",
        preferAutomaticName: true,
        requestedOutputName: ":::",
        resultOutputName: "valid-name.bin",
      }),
    ).toBe("game [change].bin");
  });

  it("keeps a recognized extension in the automatic stem before the result extension", () => {
    expect(
      resolvePendingDownloadFileName({
        automaticOutputName: "Game.gba",
        preferAutomaticName: true,
        resultOutputName: "custom.bin",
      }),
    ).toBe("Game.gba.bin");
  });

  it("does not duplicate the extension and falls back to the result name without an automatic name", () => {
    expect(
      resolvePendingDownloadFileName({
        automaticOutputName: "game [change].bin",
        preferAutomaticName: true,
        resultOutputName: "game [change].bin",
      }),
    ).toBe("game [change].bin");
    expect(resolvePendingDownloadFileName({ preferAutomaticName: true, resultOutputName: "x.7z" })).toBe("x.7z");
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
