import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";
import { describe, expect, test } from "vitest";
import { dedupeTree } from "../../../../scripts/dedupe-tree.mjs";
import { encodeChunk, optimizePng, SIGNATURE } from "../../scripts/optimize-png.mjs";

/**
 * The asset optimizers rewrite committed binaries in place, so the invariant
 * that matters is that they are lossless. A regression here would silently ship
 * a corrupted icon - nothing else in the build would notice.
 */

/** Build an 8-bit RGBA PNG with every scanline filter set to none. */
const makePng = (width: number, height: number, pixel: (x: number, y: number) => number[]) => {
  const stride = width * 4;
  const filtered = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const channels = pixel(x, y);
      for (let c = 0; c < 4; c += 1) filtered[y * (stride + 1) + 1 + x * 4 + c] = channels[c];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    encodeChunk("IHDR", header),
    // Level 0 (stored) so there is real headroom for the optimizer to recover.
    encodeChunk("IDAT", zlib.deflateSync(filtered, { level: 0 })),
    encodeChunk("IEND", Buffer.alloc(0)),
  ]);
};

/** Decode straight through zlib, independent of the optimizer's own decoder. */
const readPixels = (png: Buffer) => {
  const parts: Buffer[] = [];
  let offset = 8;
  let header = Buffer.alloc(0);
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IDAT") parts.push(data);
    if (type === "IHDR") header = data;
    offset += 12 + length;
  }
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const stride = width * 4;
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const above = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const left = x >= 4 ? pixels[y * stride + x - 4] : 0;
      const corner = y > 0 && x >= 4 ? pixels[(y - 1) * stride + x - 4] : 0;
      let value = raw[y * (stride + 1) + 1 + x];
      if (filterType === 1) value += left;
      else if (filterType === 2) value += above;
      else if (filterType === 3) value += (left + above) >> 1;
      else if (filterType === 4) {
        const p = left + above - corner;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - above);
        const pc = Math.abs(p - corner);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? above : corner;
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }
  return pixels;
};

describe("optimizePng", () => {
  test("shrinks a naively encoded PNG without changing a pixel", () => {
    const source = makePng(64, 64, (x, y) => [x * 4, y * 4, (x ^ y) & 0xff, 255]);
    const optimized = optimizePng(source);

    expect(optimized.length).toBeLessThan(source.length);
    expect(readPixels(optimized)).toEqual(readPixels(source));
  });

  test("preserves pixels for a gradient that defeats RLE", () => {
    const source = makePng(32, 48, (x, y) => [(x * 7 + y * 3) & 0xff, (y * 11) & 0xff, 128, (x + y) & 0xff]);
    expect(readPixels(optimizePng(source))).toEqual(readPixels(source));
  });

  test("strips metadata chunks that do not affect rendering", () => {
    const source = makePng(16, 16, () => [1, 2, 3, 255]);
    const withText = Buffer.concat([
      source.subarray(0, source.length - 12),
      encodeChunk("tEXt", Buffer.from("Software\0test", "latin1")),
      source.subarray(source.length - 12),
    ]);
    expect(optimizePng(withText).includes(Buffer.from("tEXt"))).toBe(false);
  });

  test("returns non-PNG input untouched", () => {
    const notPng = Buffer.from("this is not a png at all");
    expect(optimizePng(notPng)).toBe(notPng);
  });
});

describe("dedupeTree", () => {
  test("collapses identical files onto one inode and leaves contents intact", () => {
    const root = mkdtempSync(join(tmpdir(), "dedupe-tree-"));
    try {
      mkdirSync(join(root, "a"));
      mkdirSync(join(root, "b"));
      writeFileSync(join(root, "a", "LICENSE"), "Apache License 2.0 text");
      writeFileSync(join(root, "b", "LICENSE"), "Apache License 2.0 text");
      writeFileSync(join(root, "b", "OTHER"), "MIT License text");

      const result = dedupeTree(root);

      expect(result.linked).toBe(1);
      expect(statSync(join(root, "a", "LICENSE")).ino).toBe(statSync(join(root, "b", "LICENSE")).ino);
      expect(statSync(join(root, "b", "OTHER")).ino).not.toBe(statSync(join(root, "a", "LICENSE")).ino);

      // Idempotent: a second pass finds everything already linked.
      expect(dedupeTree(root).linked).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
