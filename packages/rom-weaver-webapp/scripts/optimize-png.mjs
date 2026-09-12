#!/usr/bin/env node
/**
 * Re-encode PNG scanlines with different filters and deflate strategies.
 * The output retains image samples, palette, and transparency, but discards
 * other metadata, including color profiles and animation chunks.
 *
 * `--verify` compares IHDR and unfiltered scanlines. It does not verify color
 * management, palette interpretation, or animation.
 *
 *   node scripts/optimize-png.mjs [--verify] <file-or-directory...>
 *
 * Directories are searched recursively for `.png`.
 *
 * Only 8-bit non-interlaced PNGs are handled; anything else is returned as-is,
 * because that is all the icon pipeline produces and a partial implementation
 * that silently mangled the rest would be worse than a no-op.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

export const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// PNG colour type -> bytes per pixel at 8-bit depth.
const BYTES_PER_PIXEL = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
// Keep the header, palette, and transparency; stripping other chunks can change
// color-managed rendering: https://www.w3.org/TR/png-3/#6Colour-values
const RENDERING_CHUNKS = new Set(["IHDR", "PLTE", "tRNS"]);
const FILTER_TYPES = [0, 1, 2, 3, 4];
const ADAPTIVE = "adaptive";
const DEFLATE_STRATEGIES = [zlib.constants.Z_DEFAULT_STRATEGY, zlib.constants.Z_FILTERED, zlib.constants.Z_RLE];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buffer) => {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

/** Split a PNG into its chunk list. Returns null if the signature is wrong. */
const readChunks = (buffer) => {
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) return null;
  const chunks = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    chunks.push({ data: buffer.subarray(offset + 8, offset + 8 + length), type });
    offset += 12 + length;
  }
  return chunks;
};

/** Frame a PNG chunk: big-endian length, type, payload, CRC32 of type+payload. */
export const encodeChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
};

/** Reverse per-scanline filtering, yielding raw pixel rows. */
const unfilter = (filtered, height, bpp, stride) => {
  const pixels = Buffer.alloc(height * stride);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    const filterType = filtered[offset];
    offset += 1;
    const line = filtered.subarray(offset, offset + stride);
    offset += stride;
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prior ? prior[x] : 0;
      const c = prior && x >= bpp ? prior[x - bpp] : 0;
      let value = line[x];
      if (filterType === 1) value += a;
      else if (filterType === 2) value += b;
      else if (filterType === 3) value += (a + b) >> 1;
      else if (filterType === 4) value += paeth(a, b, c);
      row[x] = value & 0xff;
    }
  }
  return pixels;
};

const filterRow = (filterType, row, prior, bpp, stride, destination) => {
  for (let x = 0; x < stride; x += 1) {
    const a = x >= bpp ? row[x - bpp] : 0;
    const b = prior ? prior[x] : 0;
    const c = prior && x >= bpp ? prior[x - bpp] : 0;
    const value = row[x];
    let out;
    if (filterType === 0) out = value;
    else if (filterType === 1) out = value - a;
    else if (filterType === 2) out = value - b;
    else if (filterType === 3) out = value - ((a + b) >> 1);
    else out = value - paeth(a, b, c);
    destination[x] = out & 0xff;
  }
};

/** Minimum-sum-of-absolute-differences: libpng's adaptive filter heuristic. */
const absoluteSum = (buffer) => {
  let total = 0;
  for (const value of buffer) total += value < 128 ? value : 256 - value;
  return total;
};

/** Re-apply one filter strategy across every scanline. */
const refilter = (pixels, height, bpp, stride, strategy) => {
  const out = Buffer.alloc(height * (stride + 1));
  const candidate = Buffer.alloc(stride);
  const best = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    const lineStart = y * (stride + 1);
    if (strategy !== ADAPTIVE) {
      filterRow(strategy, row, prior, bpp, stride, candidate);
      candidate.copy(out, lineStart + 1);
      out[lineStart] = strategy;
      continue;
    }
    let bestScore = Number.POSITIVE_INFINITY;
    let bestType = 0;
    for (const filterType of FILTER_TYPES) {
      filterRow(filterType, row, prior, bpp, stride, candidate);
      const score = absoluteSum(candidate);
      if (score < bestScore) {
        bestScore = score;
        bestType = filterType;
        candidate.copy(best);
      }
    }
    best.copy(out, lineStart + 1);
    out[lineStart] = bestType;
  }
  return out;
};

/** Decode to unfiltered pixel rows plus the IHDR, for equality checks. */
const decode = (buffer) => {
  const chunks = readChunks(buffer);
  if (chunks === null) return null;
  const header = chunks.find((chunk) => chunk.type === "IHDR");
  if (header === undefined) return null;
  const width = header.data.readUInt32BE(0);
  const height = header.data.readUInt32BE(4);
  const bitDepth = header.data[8];
  const colorType = header.data[9];
  const interlace = header.data[12];
  const bpp = BYTES_PER_PIXEL[colorType];
  if (bitDepth !== 8 || interlace !== 0 || bpp === undefined) return null;
  const stride = width * bpp;
  const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data));
  return {
    bpp,
    chunks,
    header: header.data,
    height,
    pixels: unfilter(zlib.inflateSync(idat), height, bpp, stride),
    stride,
  };
};

/**
 * Decode a PNG to a tightly packed RGBA buffer, opaque where the source had no
 * alpha channel. Callers MUST pass an 8-bit, non-interlaced RGB or RGBA PNG.
 */
export const decodeRgba = (buffer) => {
  const image = decode(buffer);
  if (image === null) throw new Error("decodeRgba: unsupported PNG (needs 8-bit, non-interlaced)");
  const width = image.stride / image.bpp;
  if (image.bpp === 4) return { data: new Uint8ClampedArray(image.pixels), height: image.height, width };
  if (image.bpp !== 3) throw new Error(`decodeRgba: unsupported channel count ${image.bpp}`);
  const data = new Uint8ClampedArray(width * image.height * 4);
  for (let pixel = 0; pixel < width * image.height; pixel += 1) {
    data[pixel * 4] = image.pixels[pixel * 3];
    data[pixel * 4 + 1] = image.pixels[pixel * 3 + 1];
    data[pixel * 4 + 2] = image.pixels[pixel * 3 + 2];
    data[pixel * 4 + 3] = 0xff;
  }
  return { data, height: image.height, width };
};

/**
 * Return a smaller PNG with the same scanline samples, or the original input
 * when its format is unsupported or no smaller encoding is found.
 */
export const optimizePng = (buffer) => {
  const image = decode(buffer);
  if (image === null) return buffer;

  let smallest = null;
  for (const strategy of [...FILTER_TYPES, ADAPTIVE]) {
    const filtered = refilter(image.pixels, image.height, image.bpp, image.stride, strategy);
    for (const strategy_ of DEFLATE_STRATEGIES) {
      const deflated = zlib.deflateSync(filtered, { level: 9, memLevel: 9, strategy: strategy_ });
      if (smallest === null || deflated.length < smallest.length) smallest = deflated;
    }
  }

  const parts = [SIGNATURE];
  for (const chunk of image.chunks) {
    if (RENDERING_CHUNKS.has(chunk.type)) parts.push(encodeChunk(chunk.type, chunk.data));
  }
  parts.push(encodeChunk("IDAT", smallest), encodeChunk("IEND", Buffer.alloc(0)));
  const optimized = Buffer.concat(parts);
  return optimized.length < buffer.length ? optimized : buffer;
};

/** Compare IHDR and unfiltered scanlines; ancillary chunks and palettes are not compared. */
export const assertSamePixels = (source, optimized, label) => {
  const before = decode(source);
  const after = decode(optimized);
  if (before === null || after === null) {
    throw new Error(`${label}: could not decode both sides for verification`);
  }
  if (!before.header.equals(after.header)) {
    throw new Error(`${label}: IHDR changed during optimization`);
  }
  if (!before.pixels.equals(after.pixels)) {
    throw new Error(`${label}: pixels changed during optimization`);
  }
};

/** Expand directory arguments into the `.png` files beneath them. */
const collectPngs = (target) => {
  if (!fs.statSync(target).isDirectory()) return [target];
  const found = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const entryPath = path.join(target, entry.name);
    if (entry.isDirectory()) found.push(...collectPngs(entryPath));
    else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".png") found.push(entryPath);
  }
  return found;
};

const main = () => {
  const args = process.argv.slice(2);
  const verify = args.includes("--verify");
  const targets = args.filter((arg) => arg !== "--verify");
  if (targets.length === 0) {
    process.stderr.write("usage: optimize-png.mjs [--verify] <file-or-directory...>\n");
    process.exit(2);
  }
  const files = targets.flatMap(collectPngs).sort((left, right) => Number(left > right) - Number(left < right));
  let saved = 0;
  for (const file of files) {
    const source = fs.readFileSync(file);
    const optimized = optimizePng(source);
    if (verify) assertSamePixels(source, optimized, path.basename(file));
    if (optimized.length >= source.length) {
      process.stdout.write(`  ${path.basename(file)}: already optimal\n`);
      continue;
    }
    fs.writeFileSync(file, optimized);
    saved += source.length - optimized.length;
    const percent = ((1 - optimized.length / source.length) * 100).toFixed(1);
    process.stdout.write(`  ${path.basename(file)}: ${source.length} -> ${optimized.length} (-${percent}%)\n`);
  }
  process.stdout.write(`Saved ${saved} bytes across ${files.length} file(s).\n`);
};

if (process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`) main();
