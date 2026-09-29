import { describe, expect, it } from "vitest";
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

  it("falls back to the filename only when no engine verdict exists", () => {
    expect(getChdAutoCreateMode({ fileName: "disc.cue" })).toBe("cd");
    expect(getChdAutoCreateMode({ fileName: "track01.bin" })).toBe("cd");
    expect(getChdAutoCreateMode({ fileName: "game.iso" })).toBe("dvd");
  });
});
