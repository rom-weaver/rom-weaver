import { describe, expect, it } from "vitest";
import OutputCompressionManager from "../../src/lib/compression/output-compression-manager.ts";
import {
  chdCodecModeFromCreateMode,
  discFormatToChdMode,
  getChdAutoCreateMode,
} from "../../src/lib/input/rom-specific-file-utils.ts";

describe("discFormatToChdMode", () => {
  it("maps the engine disc_format verdict to a CHD mode", () => {
    expect(discFormatToChdMode("DVD")).toBe("dvd");
    expect(discFormatToChdMode("CD")).toBe("cd");
    expect(discFormatToChdMode("GD-ROM")).toBe("cd");
    expect(discFormatToChdMode(undefined)).toBeUndefined();
    expect(discFormatToChdMode("")).toBeUndefined();
  });
});

// Byte-level inference (hard-disk headers, UDF, CD sync/ISO9660 descriptors, size rules) lives in Rust
// (`ChdContainerHandler::infer_auto_create_mode_label`, tested in crates/rom-weaver-containers); the webapp
// only consumes the verdict the engine reports as `metadata.chdCreateMode`.
describe("getChdAutoCreateMode", () => {
  it("prefers the explicit metadata.mode verdict", () => {
    expect(getChdAutoCreateMode({ fileName: "disc.cue", metadata: { mode: "dvd" } })).toBe("dvd");
    expect(getChdAutoCreateMode({ fileName: "game.iso", metadata: { mode: "cd" } })).toBe("cd");
  });

  it("treats a cue path or sheet as a CD", () => {
    expect(getChdAutoCreateMode({ fileName: "game.iso", metadata: { cuePath: "game.cue" } })).toBe("cd");
    expect(getChdAutoCreateMode({ fileName: "disc.gdi" })).toBe("cd");
    expect(getChdAutoCreateMode({ fileName: "disc.cue" })).toBe("cd");
  });

  it("uses the Rust metadata.format verdict for an identified non-loose image", () => {
    expect(getChdAutoCreateMode({ fileName: "game.iso", metadata: { format: "CD" } })).toBe("cd");
    expect(getChdAutoCreateMode({ fileName: "game.iso", metadata: { format: "GD-ROM" } })).toBe("cd");
    expect(getChdAutoCreateMode({ fileName: "game.iso", metadata: { format: "DVD" } })).toBe("dvd");
  });

  it("lets the Rust byte verdict override advisory identity for loose images, like native auto", () => {
    expect(getChdAutoCreateMode({ fileName: "game.bin", metadata: { format: "CD", chdCreateMode: "raw" } })).toBe(
      "raw",
    );
    expect(getChdAutoCreateMode({ fileName: "track.bin", metadata: { format: "DVD", chdCreateMode: "cd" } })).toBe(
      "cd",
    );
    expect(getChdAutoCreateMode({ fileName: "hybrid", metadata: { format: "CD", chdCreateMode: "hd" } })).toBe("hd");
  });

  it("reports the Rust byte verdict for an unidentified .iso", () => {
    expect(getChdAutoCreateMode({ fileName: "game.iso", metadata: { chdCreateMode: "dvd" } })).toBe("dvd");
    expect(getChdAutoCreateMode({ fileName: "game.iso", metadata: { chdCreateMode: "cd" } })).toBe("cd");
  });

  it("keeps a loose image raw when the engine reported no verdict", () => {
    expect(getChdAutoCreateMode({ fileName: "track01.bin" })).toBe("raw");
    expect(getChdAutoCreateMode({ fileName: "track01.bin", metadata: { format: "CD" } })).toBe("cd");
  });
});

describe("chdCodecModeFromCreateMode", () => {
  it("maps DVD and hard-disk verdicts to the DVD codec hint", () => {
    expect(chdCodecModeFromCreateMode("dvd")).toBe("dvd");
    expect(chdCodecModeFromCreateMode("hd")).toBe("dvd");
    expect(chdCodecModeFromCreateMode("cd")).toBeUndefined();
    expect(chdCodecModeFromCreateMode("raw")).toBeUndefined();
    expect(chdCodecModeFromCreateMode(undefined)).toBeUndefined();
  });
});

describe("raw CHD codec defaults", () => {
  it("uses the generic codec settings while preserving explicit overrides", () => {
    const settings = { chdCreateCdCodecs: "cdlz,cdzl,cdfl", chdCreateDvdCodecs: "zstd:7" };
    expect(OutputCompressionManager.getChdCodecsForMode("raw", settings)).toBe("zstd:7");
    expect(OutputCompressionManager.getChdCodecsForMode("hd", settings)).toBe("zstd:7");
    expect(OutputCompressionManager.getChdCodecsForMode("cd", settings)).toContain("cdlz");
    expect(OutputCompressionManager.getChdCodecsForMode("dvd", settings)).toBe("zstd:7");
  });
});
