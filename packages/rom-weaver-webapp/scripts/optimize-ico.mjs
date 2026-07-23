#!/usr/bin/env node
/**
 * Repack an .ico so each image is stored as a PNG instead of a raw BMP.
 *
 * An ICONDIRENTRY may hold either, and every browser has read the PNG form
 * since IE11. The committed favicon stored all four sizes (16/32/48/64) as
 * uncompressed 32bpp BMP, which is why a favicon cost 32 KB - the 64x64 entry
 * alone was 16 KB of literal BGRA.
 *
 * Pixels are preserved exactly: the BMP is decoded, re-emitted as an RGBA PNG,
 * and `optimizePng` picks the smallest lossless encoding. Entries already in
 * PNG form are re-optimized in place. Alpha comes from the 32bpp BGRA data, so
 * the 1bpp AND mask that follows it is redundant and is dropped.
 *
 *   node scripts/optimize-ico.mjs <file.ico...>
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

import { encodeChunk, optimizePng, SIGNATURE } from "./optimize-png.mjs";

const ICONDIR_SIZE = 6;
const ICONDIRENTRY_SIZE = 16;
const BITMAPINFOHEADER_SIZE = 40;

/** Wrap RGBA rows in a minimal PNG (colour type 6, no filtering). */
const encodeRgbaPng = (rgba, width, height) => {
  const stride = width * 4;
  const filtered = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    rgba.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour + alpha
  return Buffer.concat([
    SIGNATURE,
    encodeChunk("IHDR", header),
    encodeChunk("IDAT", zlib.deflateSync(filtered, { level: 9 })),
    encodeChunk("IEND", Buffer.alloc(0)),
  ]);
};

/**
 * Decode a 32bpp BMP-in-ICO payload to top-down RGBA. Returns null for colour
 * depths this tool does not handle, so those entries are left untouched.
 */
const decodeBmpEntry = (data) => {
  const headerSize = data.readUInt32LE(0);
  if (headerSize !== BITMAPINFOHEADER_SIZE) return null;
  const width = data.readInt32LE(4);
  // An ICO stores XOR bitmap + AND mask stacked, so biHeight is doubled.
  const height = Math.trunc(data.readInt32LE(8) / 2);
  const bitCount = data.readUInt16LE(14);
  if (bitCount !== 32 || width <= 0 || height <= 0) return null;

  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    // BMP rows run bottom-up.
    const source = BITMAPINFOHEADER_SIZE + (height - 1 - y) * width * 4;
    for (let x = 0; x < width; x += 1) {
      const from = source + x * 4;
      const to = (y * width + x) * 4;
      rgba[to] = data[from + 2];
      rgba[to + 1] = data[from + 1];
      rgba[to + 2] = data[from];
      rgba[to + 3] = data[from + 3];
    }
  }
  return { height, rgba, width };
};

const repackIco = (buffer) => {
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error("not an icon file (bad ICONDIR reserved/type)");
  }
  const count = buffer.readUInt16LE(4);
  const images = [];
  for (let i = 0; i < count; i += 1) {
    const entry = buffer.subarray(ICONDIR_SIZE + i * ICONDIRENTRY_SIZE);
    const size = entry.readUInt32LE(8);
    const offset = entry.readUInt32LE(12);
    const data = buffer.subarray(offset, offset + size);

    if (data.subarray(0, 8).equals(SIGNATURE)) {
      images.push({ data: optimizePng(data), entry: Buffer.from(entry.subarray(0, ICONDIRENTRY_SIZE)) });
      continue;
    }
    const decoded = decodeBmpEntry(data);
    if (decoded === null) {
      images.push({ data, entry: Buffer.from(entry.subarray(0, ICONDIRENTRY_SIZE)) });
      continue;
    }
    const png = optimizePng(encodeRgbaPng(decoded.rgba, decoded.width, decoded.height));
    const header = Buffer.from(entry.subarray(0, ICONDIRENTRY_SIZE));
    images.push({ data: png.length < data.length ? png : data, entry: header });
  }

  const directory = Buffer.alloc(ICONDIR_SIZE + count * ICONDIRENTRY_SIZE);
  buffer.copy(directory, 0, 0, ICONDIR_SIZE);
  let offset = directory.length;
  const payloads = [];
  for (const [index, image] of images.entries()) {
    image.entry.writeUInt32LE(image.data.length, 8);
    image.entry.writeUInt32LE(offset, 12);
    image.entry.copy(directory, ICONDIR_SIZE + index * ICONDIRENTRY_SIZE);
    payloads.push(image.data);
    offset += image.data.length;
  }
  return Buffer.concat([directory, ...payloads]);
};

const main = () => {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    process.stderr.write("usage: optimize-ico.mjs <file.ico...>\n");
    process.exit(2);
  }
  for (const file of files) {
    const source = fs.readFileSync(file);
    const repacked = repackIco(source);
    if (repacked.length >= source.length) {
      process.stdout.write(`  ${path.basename(file)}: already optimal\n`);
      continue;
    }
    fs.writeFileSync(file, repacked);
    const percent = ((1 - repacked.length / source.length) * 100).toFixed(1);
    process.stdout.write(`  ${path.basename(file)}: ${source.length} -> ${repacked.length} (-${percent}%)\n`);
  }
};

main();
