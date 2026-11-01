// Deterministic generators for the Create / Trim / Compress / Extract groups. Small inputs are built
// in memory; anything over ~1 MiB or slow to build is cached under $RW_EXH_CACHE (never committed) and
// reused when present.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { prng } from "../../fixtures/apply-matrix/encoders.mjs";

export const EXH_CACHE =
  process.env.RW_EXH_CACHE || path.join(os.homedir(), ".cache/agents/apply-matrix-fixtures/exh-web");
export const FIXTURE_ROOT =
  process.env.RW_MATRIX_FIXTURES || path.join(os.homedir(), ".cache/agents/apply-matrix-fixtures");

export const crc32Hex = (bytes) => zlib.crc32(bytes).toString(16).padStart(8, "0");

/** Build once, reuse from disk afterwards. */
export function cached(name, build) {
  const file = path.join(EXH_CACHE, name);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const bytes = Buffer.from(build());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return bytes;
}

const mutate = (source, edits) => {
  const out = Buffer.from(source);
  for (const [at, value] of edits) if (at < out.length) out[at] = value;
  return out;
};

/** Original/modified pairs for Create. `expectOffered` lists nothing: the UI decides what it offers. */
export function createPairs() {
  const base = Buffer.from(prng(8192, 0xabc123));
  const big = () => Buffer.from(prng(4 << 20, 0x5eed));
  return [
    {
      name: "same",
      original: () => base,
      modified: () =>
        mutate(base, [
          [10, 1],
          [4000, 9],
          [8000, 7],
        ]),
    },
    {
      name: "grow",
      original: () => base,
      modified: () => Buffer.concat([mutate(base, [[200, 0xee]]), Buffer.from(prng(1500, 77))]),
    },
    { name: "shrink", original: () => base, modified: () => mutate(base, [[5, 5]]).subarray(0, 6000) },
    { name: "identical", original: () => base, modified: () => Buffer.from(base) },
    { name: "one-byte", original: () => Buffer.from([0x41]), modified: () => Buffer.from([0x42]) },
    { name: "tail-only", original: () => base, modified: () => mutate(base, [[8191, 0x99]]) },
    { name: "head-only", original: () => base, modified: () => mutate(base, [[0, 0x99]]) },
    {
      name: "dense",
      original: () => base,
      modified: () => Buffer.from(prng(8192, 0xdead)),
    },
    {
      name: "empty-to-data",
      original: () => Buffer.alloc(0),
      modified: () => Buffer.from(prng(3000, 31)),
    },
    {
      name: "big-4mib",
      cache: true,
      original: () => cached("create-big-original.bin", big),
      modified: () =>
        cached("create-big-modified.bin", () =>
          mutate(big(), [
            [1, 1],
            [100_000, 2],
            [2_000_000, 3],
            [4_194_000, 4],
          ]),
        ),
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Trim fixtures
// ---------------------------------------------------------------------------------------------
const le32 = (bytes, offset, value) => bytes.writeUInt32LE(value >>> 0, offset);
const nds16 = (bytes) => {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      const carry = crc & 1;
      crc >>>= 1;
      if (carry) crc ^= 0xa001;
    }
  }
  return crc & 0xffff;
};

/** NDS/DSi test ROM. unit 0 = DS, 2 = DSi-enhanced; cert adds the 0x88-byte download-play certificate. */
export function buildNds({
  unit = 0,
  ntr = 0x3000,
  ntrTwl = 0x3000,
  size = 0x5000,
  cert = false,
  title = "RW-TRIM",
} = {}) {
  const headerBytes = 0x1000;
  const rom = Buffer.alloc(size);
  const header = rom.subarray(0, headerBytes);
  header.write(title, 0, "ascii");
  header[0x12] = unit;
  le32(header, 0x80, ntr);
  le32(header, 0x84, headerBytes);
  le32(header, 0x210, ntrTwl);
  for (let index = 0; index < 156; index++) header[0x0c0 + index] = (index * 37 + 11) % 251;
  header.writeUInt16LE(nds16(header.subarray(0x0c0, 0x0c0 + 156)), 0x15c);
  header.writeUInt16LE(nds16(header.subarray(0, 0x15e)), 0x15e);
  for (let index = headerBytes; index < size; index++) rom[index] = (index * 13 + 5) % 251;
  if (cert) {
    rom[ntr] = 0x61;
    rom[ntr + 1] = 0x63;
    rom.fill(0xa5, ntr + 2, ntr + 0x88);
  }
  return rom;
}

/** GBA-like ROM: random payload then 0xFF (or 0x00) padding up to `total`. */
export function buildGba({ used = 0x6000, total = 0x10000, pad = 0xff } = {}) {
  const rom = Buffer.alloc(total, pad);
  const payload = prng(used, 0x6ba);
  // Make sure the last payload byte is not itself padding.
  payload[used - 1] = pad === 0xff ? 0x12 : 0x34;
  Buffer.from(payload).copy(rom, 0);
  rom.write("RWGBATEST", 0xa0, "ascii");
  return rom;
}

/** Minimal 3DS NCSD cartridge image: one NCCH partition, trailing 0xFF padding to `total`. */
export function build3ds({ media = 0x80, partition = 0x40, total = 0x20000, pad = 0xff } = {}) {
  // sizes are in 0x200-byte media units; partition starts at unit 1
  const rom = Buffer.alloc(total, pad);
  const header = Buffer.alloc(0x200);
  header.write("NCSD", 0x100, "ascii");
  header.writeUInt32LE(media, 0x104);
  header.writeUInt32LE(1, 0x120);
  header.writeUInt32LE(partition, 0x124);
  header[0x18e] = 0;
  header.copy(rom, 0);
  const ncch = Buffer.alloc(0x200);
  ncch.write("NCCH", 0x100, "ascii");
  ncch.writeUInt32LE(partition, 0x104);
  ncch.copy(rom, 0x200);
  Buffer.from(prng(partition * 0x200 - 0x200, 0x3d5)).copy(rom, 0x400);
  rom[0x200 + partition * 0x200 - 1] = 0x55; // last used byte must not look like padding
  return rom;
}

export function trimFixtures() {
  return [
    { id: "nds-ds", ext: "nds", bytes: () => buildNds({ ntr: 0x3000, size: 0x5000 }), trimmedSize: 0x3000 },
    {
      id: "nds-download-play",
      ext: "nds",
      bytes: () => buildNds({ cert: true, ntr: 0x3000, ntrTwl: 0x3000, size: 0x5000 }),
      trimmedSize: 0x3000 + 0x88,
    },
    {
      id: "dsi",
      ext: "dsi",
      bytes: () => buildNds({ ntr: 0x2800, ntrTwl: 0x3a00, size: 0x7000, unit: 2 }),
      trimmedSize: 0x3a00,
    },
    { id: "srl", ext: "srl", bytes: () => buildNds({ ntr: 0x3000, size: 0x6000 }), trimmedSize: 0x3000 },
    {
      id: "nds-already-trimmed",
      ext: "nds",
      bytes: () => buildNds({ ntr: 0x3000, size: 0x3000 }),
      trimmedSize: 0x3000,
    },
    { id: "gba-ff", ext: "gba", bytes: () => buildGba({ pad: 0xff }), trimmedSize: 0x6000 },
    { id: "gba-00", ext: "gba", bytes: () => buildGba({ pad: 0x00 }), trimmedSize: 0x6000 },
    { id: "gba-no-padding", ext: "gba", bytes: () => Buffer.from(prng(0x4000, 9)), trimmedSize: null },
    {
      id: "3ds-ncsd",
      ext: "3ds",
      bytes: () => build3ds({ media: 0x80, partition: 0x40, total: 0x20000 }),
      trimmedSize: 0x200 + 0x40 * 0x200,
    },
  ];
}
