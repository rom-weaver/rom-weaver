import { describe, expect, it } from "vitest";
import OutputCompressionManager from "../../src/lib/compression/output-compression-manager.ts";
import { discFormatToChdMode, getChdAutoCreateMode } from "../../src/lib/input/rom-specific-file-utils.ts";

describe("discFormatToChdMode", () => {
  it("maps the engine disc_format verdict to a CHD mode", () => {
    expect(discFormatToChdMode("DVD")).toBe("dvd");
    expect(discFormatToChdMode("CD")).toBe("cd");
    expect(discFormatToChdMode("GD-ROM")).toBe("cd");
    expect(discFormatToChdMode(undefined)).toBeUndefined();
    expect(discFormatToChdMode("")).toBeUndefined();
  });
});

describe("getChdAutoCreateMode", () => {
  it("matches the engine CD size boundary for unprobed ISO files", () => {
    expect(getChdAutoCreateMode({ fileName: "disc.iso", size: 2048 })).toBe("cd");
    expect(getChdAutoCreateMode({ fileName: "disc.iso", fileSize: 450_000 * 2048 })).toBe("cd");
    expect(getChdAutoCreateMode({ fileName: "disc.iso", size: 450_001 * 2048 })).toBe("dvd");
    expect(getChdAutoCreateMode({ fileName: "disc.iso", size: 2352 })).toBe("cd");
    expect(getChdAutoCreateMode({ fileName: "disc.iso", size: 0 })).toBe("dvd");
    expect(getChdAutoCreateMode({ fileName: "disc.iso", size: 2048, metadata: { format: "DVD" } })).toBe("dvd");
  });
  it("prefers the explicit metadata.mode verdict", () => {
    expect(getChdAutoCreateMode({ fileName: "disc.cue", metadata: { mode: "dvd" } })).toBe("dvd");
    expect(getChdAutoCreateMode({ fileName: "game.iso", metadata: { mode: "cd" } })).toBe("cd");
  });

  it("treats a cue path as a CD", () => {
    expect(getChdAutoCreateMode({ fileName: "game.iso", metadata: { cuePath: "game.cue" } })).toBe("cd");
  });

  it("uses the Rust metadata.format verdict over the filename", () => {
    // A `.iso` would otherwise fall to the regex and read as DVD; the engine verdict wins.
    expect(getChdAutoCreateMode({ fileName: "game.iso", metadata: { format: "CD" } })).toBe("cd");
    expect(getChdAutoCreateMode({ fileName: "game.iso", metadata: { format: "GD-ROM" } })).toBe("cd");
    expect(getChdAutoCreateMode({ fileName: "track01.bin", metadata: { format: "DVD" } })).toBe("dvd");
  });

  it.each([13, 4096, 32768, 2352, 2352 * 20])("keeps an unrecognized %i-byte BIN raw", (size) => {
    expect(getChdAutoCreateMode({ fileName: "game.bin", size, _u8array: new Uint8Array(size) })).toBe("raw");
  });

  it("recognizes a raw-sector CD by its sync header", () => {
    const bytes = new Uint8Array(2352);
    bytes.fill(255, 1, 11);
    expect(getChdAutoCreateMode({ fileName: "track.bin", size: bytes.length, _u8array: bytes })).toBe("cd");
  });

  it("recognizes cooked CD sectors by their ISO9660 descriptor", () => {
    const bytes = new Uint8Array(2048 * 20);
    bytes.set(new TextEncoder().encode("CD001"), 16 * 2048 + 1);
    expect(getChdAutoCreateMode({ fileName: "track.bin", size: bytes.length, _u8array: bytes })).toBe("cd");
  });

  it("preserves a GD-ROM sheet", () => {
    expect(getChdAutoCreateMode({ fileName: "disc.gdi" })).toBe("cd");
  });

  it("falls back to the filename only when no engine verdict exists", () => {
    expect(getChdAutoCreateMode({ fileName: "disc.cue" })).toBe("cd");
    expect(getChdAutoCreateMode({ fileName: "track01.bin" })).toBe("raw");
    expect(getChdAutoCreateMode({ fileName: "game.iso" })).toBe("dvd");
  });
});

describe("raw CHD codec defaults", () => {
  it("uses the generic codec settings while preserving explicit overrides", () => {
    const settings = { chdCreateCdCodecs: "cdlz,cdzl,cdfl", chdCreateDvdCodecs: "zstd:7" };
    expect(OutputCompressionManager.getChdCodecsForMode("raw", settings)).toBe("zstd:7");
    expect(OutputCompressionManager.getChdCodecsForMode("cd", settings)).toContain("cdlz");
    expect(OutputCompressionManager.getChdCodecsForMode("dvd", settings)).toBe("zstd:7");
  });
});
