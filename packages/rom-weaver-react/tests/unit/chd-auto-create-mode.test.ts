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
