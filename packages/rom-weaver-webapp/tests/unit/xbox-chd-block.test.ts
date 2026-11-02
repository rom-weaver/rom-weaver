import { describe, expect, it } from "vitest";
import OutputCompressionManager from "../../src/lib/compression/output-compression-manager.ts";
import { resolveAutomaticCompressionFormat } from "../../src/lib/compression/container-format-registry.ts";
import { isXboxSource, XBOX_PLATFORM } from "../../src/lib/compression/disc-image-policy.ts";
import { TRIM_SUPPORTED_FILES } from "../../src/public/react/trim-supported-files.ts";
import { describeTrimRun, getTrimRunKind } from "../../src/public/react/trim-run-summary.ts";
import { ROM_WEAVER_TRIM_INPUT_EXTENSIONS } from "../../src/wasm/generated/rom-weaver-format-metadata.ts";

const discSource = (fileName: string, metadata: Record<string, string> = {}) => ({
  fileName,
  metadata,
  size: 2048 * 4,
});

describe("Xbox XISO never gets CHD", () => {
  it("recognises an XISO by the engine platform or its name", () => {
    expect(isXboxSource(XBOX_PLATFORM)).toBe(true);
    expect(isXboxSource("microsoft xbox")).toBe(true);
    expect(isXboxSource(undefined, "game.xiso")).toBe(true);
    expect(isXboxSource(undefined, "Game.XISO.ISO")).toBe(true);
    expect(isXboxSource("Sony PlayStation 2", "game.iso")).toBe(false);
    expect(isXboxSource(undefined, "game.iso")).toBe(false);
  });

  it("keeps CHD supported for ordinary discs, but not for an XISO, whatever else the metadata says", () => {
    const dvd = discSource("game.iso", { format: "DVD", recommendedFormat: "chd" });
    expect(OutputCompressionManager.supportsOutputCompression(dvd, "chd")).toBe(true);
    for (const source of [
      discSource("game.iso", { format: "DVD", platform: XBOX_PLATFORM, recommendedFormat: "chd" }),
      discSource("game.xiso.iso", { format: "DVD", recommendedFormat: "chd" }),
      discSource("game.iso", { mode: "dvd", platform: XBOX_PLATFORM }),
    ]) {
      expect(OutputCompressionManager.supportsOutputCompression(source, "chd")).toBe(false);
      expect(OutputCompressionManager.supportsOutputCompression(source, "zip")).toBe(true);
      expect(OutputCompressionManager.supportsOutputCompression(source, "7z")).toBe(true);
    }
  });

  it("never resolves automatic output compression to CHD for an XISO", () => {
    const dvd = discSource("game.iso", { format: "DVD", recommendedFormat: "chd" });
    expect(OutputCompressionManager.resolveOutputCompression(dvd, { compressionFormat: "auto" })).toBe("chd");
    const xbox = discSource("game.iso", { format: "DVD", platform: XBOX_PLATFORM, recommendedFormat: "chd" });
    expect(OutputCompressionManager.resolveOutputCompression(xbox, { compressionFormat: "auto" })).not.toBe("chd");
  });

  it("falls back from CHD in the extension-based automatic format", () => {
    const input = { fallback: "zip", hasDiscEvidence: true, sourceFileName: "game.cue", sourceSize: 2048 * 4 } as const;
    expect(resolveAutomaticCompressionFormat(input)).toBe("chd");
    expect(resolveAutomaticCompressionFormat({ ...input, sourcePlatform: XBOX_PLATFORM })).toBe("zip");
  });
});

describe("Trim copy", () => {
  it("lists only extensions the generated trim table accepts, grouped by platform", () => {
    const generated: readonly string[] = ROM_WEAVER_TRIM_INPUT_EXTENSIONS;
    const platforms = TRIM_SUPPORTED_FILES.filter((group) => group.label !== "Archives & containers");
    expect(platforms.map((group) => group.label)).toEqual([
      "Nintendo DS/DSi",
      "Game Boy Advance",
      "Nintendo 3DS",
      "Xbox XISO",
    ]);
    for (const group of platforms) {
      for (const extension of group.extensions) expect(generated, `${group.label} .${extension}`).toContain(extension);
    }
    expect(TRIM_SUPPORTED_FILES.at(-1)?.label).toBe("Archives & containers");
  });

  it("names the run kind and its sentence per input", () => {
    const base = { fileName: "game.nds", mode: "trim", restoreAvailable: false, xiso: false } as const;
    expect(getTrimRunKind(base)).toBe("pending");
    expect(describeTrimRun(base)).toBe("");
    expect(getTrimRunKind({ ...base, restoreAvailable: true })).toBe("cartridge");
    expect(describeTrimRun({ ...base, restoreAvailable: true })).toContain("12-byte revert marker");
    expect(getTrimRunKind({ ...base, xiso: true, trimSupported: true })).toBe("xiso");
    expect(describeTrimRun({ ...base, xiso: true })).toContain("can't be restored");
    expect(getTrimRunKind({ ...base, mode: "restore", restoreAvailable: true })).toBe("restore");
    expect(describeTrimRun({ ...base, mode: "restore", restoreAvailable: true })).toContain("0xFF");
    expect(getTrimRunKind({ ...base, trimSupported: false })).toBe("unsupported");
    expect(describeTrimRun({ ...base, fileName: "a.txt", trimSupported: false })).toMatch(
      /Nintendo DS\/DSi, Game Boy Advance, Nintendo 3DS, and Xbox XISO.*a\.txt.*Compress/,
    );
  });
});
