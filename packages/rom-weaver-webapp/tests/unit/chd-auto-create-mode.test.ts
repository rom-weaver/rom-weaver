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

  it.each(["mbr", "gpt", "fat", "ntfs", "exfat"])("prefers valid %s headers over CD evidence", (kind) => {
    const bytes = new Uint8Array(204800);
    const view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode("CD001"), 32769);
    bytes.set([0x55, 0xaa], 510);
    if (kind === "mbr") {
      bytes[450] = 0x83;
      view.setUint32(454, 1, true);
      view.setUint32(458, 399, true);
    } else if (kind === "gpt") {
      bytes.set(new TextEncoder().encode("EFI PART"), 512);
      view.setUint32(524, 92, true);
      for (const [offset, value] of [
        [536, 1],
        [544, 399],
        [552, 34],
        [560, 398],
        [584, 2],
      ])
        view.setBigUint64(offset, BigInt(value), true);
      view.setUint32(592, 1, true);
      view.setUint32(596, 128, true);
    } else if (kind === "fat") {
      view.setUint16(11, 512, true);
      bytes[13] = 1;
      view.setUint16(14, 1, true);
      bytes[16] = 2;
      view.setUint16(19, 400, true);
      view.setUint16(22, 1, true);
    } else if (kind === "ntfs") {
      bytes.set(new TextEncoder().encode("NTFS    "), 3);
      view.setUint16(11, 512, true);
      bytes[13] = 1;
      view.setBigUint64(40, 400n, true);
      view.setBigUint64(48, 1n, true);
    } else {
      bytes.set(new TextEncoder().encode("EXFAT   "), 3);
      view.setBigUint64(72, 400n, true);
      view.setUint32(80, 1, true);
      view.setUint32(84, 1, true);
      view.setUint32(88, 2, true);
      view.setUint32(92, 1, true);
      bytes[108] = 9;
    }
    const source = { fileName: "hybrid.bin", size: bytes.length, _u8array: bytes };
    expect(getChdAutoCreateMode(source)).toBe("raw");
    expect(getChdAutoCreateMode({ ...source, metadata: { format: "CD" } })).toBe("raw");
    expect(getChdAutoCreateMode({ ...source, fileName: "hybrid", metadata: { format: "DVD" } })).toBe("raw");
    expect(getChdAutoCreateMode({ ...source, metadata: { mode: "cd" } })).toBe("cd");
    expect(getChdAutoCreateMode({ ...source, fileName: "hybrid.iso" })).toBe("cd");
    const invalidFields: Record<string, [number, number, 8 | 16 | 32 | 64][]> = {
      mbr: [
        [446, 1, 8],
        [450, 0, 8],
        [454, 0, 32],
        [454, 400, 32],
        [458, 0, 32],
        [458, 400, 32],
      ],
      gpt: [
        [524, 91, 32],
        [524, 513, 32],
        [536, 0, 64],
        [544, 400, 64],
        [552, 399, 64],
        [560, 400, 64],
        [584, 400, 64],
        [592, 0, 32],
        [596, 127, 32],
        [596, 129, 32],
      ],
      fat: [
        [11, 256, 16],
        [13, 0, 8],
        [13, 3, 8],
        [14, 0, 16],
        [16, 3, 8],
        [19, 401, 16],
        [22, 0, 16],
      ],
      ntfs: [
        [3, 0, 8],
        [11, 256, 16],
        [13, 0, 8],
        [13, 3, 8],
        [40, 401, 64],
        [48, 0, 64],
      ],
      exfat: [
        [3, 0, 8],
        [11, 1, 8],
        [72, 401, 64],
        [80, 0, 32],
        [84, 400, 32],
        [88, 400, 32],
        [92, 0, 32],
        [108, 8, 8],
        [108, 13, 8],
        [109, 26, 8],
      ],
    };
    const valid = bytes.slice();
    for (const [offset, value, width] of invalidFields[kind]) {
      if (width === 8) bytes[offset] = value;
      if (width === 16) view.setUint16(offset, value, true);
      if (width === 32) view.setUint32(offset, value, true);
      if (width === 64) view.setBigUint64(offset, BigInt(value), true);
      expect(getChdAutoCreateMode(source), `${kind} invalid field at ${offset}`).toBe("cd");
      expect(getChdAutoCreateMode({ ...source, metadata: { format: "CD" } })).toBe("cd");
      bytes.set(valid);
    }
    if (kind !== "gpt") {
      bytes[510] = 0;
      expect(getChdAutoCreateMode(source)).toBe("cd");
    }
  });

  it("checks hard-disk headers before raw CD sync on a bounded readable source", () => {
    const bytes = new Uint8Array(16 * 2352 + 22);
    bytes.fill(255, 1, 11);
    bytes.set([0x55, 0xaa], 510);
    bytes[450] = 0xee;
    const view = new DataView(bytes.buffer);
    view.setUint32(454, 1, true);
    view.setUint32(458, 0xffffffff, true);
    const reads: number[] = [];
    const source = {
      fileName: "hybrid",
      size: 512 * 2352,
      readIntoAt: (buffer: Uint8Array, _bufferOffset = 0, length = buffer.length, offset = 0) => {
        reads.push(length);
        buffer.set(bytes.subarray(offset, offset + length));
        return length;
      },
    };
    expect(getChdAutoCreateMode(source)).toBe("raw");
    expect(reads).toEqual([1024]);
    bytes[450] = 0x83;
    expect(getChdAutoCreateMode(source)).toBe("cd");
  });

  it("keeps a cooked BIN CD descriptor above the ISO size limit", () => {
    const bytes = new Uint8Array(32774);
    bytes.set(new TextEncoder().encode("CD001"), 32769);
    expect(getChdAutoCreateMode({ fileName: "disc.bin", size: 450001 * 2048, _u8array: bytes })).toBe("cd");
  });

  it("does not treat a boot signature alone as hard-disk evidence", () => {
    const bytes = new Uint8Array(204800);
    bytes.set([0x55, 0xaa], 510);
    bytes.set(new TextEncoder().encode("CD001"), 32769);
    expect(getChdAutoCreateMode({ fileName: "hybrid.bin", size: bytes.length, _u8array: bytes })).toBe("cd");
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
