import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";

const sectorBytes = 2352;
const blockBytes = 16 * sectorBytes;
const bcd = (value) => Math.floor(value / 10) * 16 + (value % 10);
const msf = (frames) =>
  Buffer.from([bcd(Math.floor(frames / 4500)), bcd(Math.floor(frames / 75) % 60), bcd(frames % 75)]);

// Callers MUST supply a legally built raw Mode 2 CD image; arbitrary sectors cannot establish boot compatibility.
// Layout: https://github.com/libretro/pcsx_rearmed/blob/master/libpcsxcore/cdriso.c (handlepbp).
export const packHomebrewPbp = (images) => {
  assert(images.length >= 1 && images.length <= 5);
  const discs = images.map((image) => {
    assert(image.length % sectorBytes === 0);
    assert(image.subarray(16 * sectorBytes + 25, 16 * sectorBytes + 30).equals(Buffer.from("CD001")));
    const header = Buffer.alloc(0x100000);
    header.write("PSISOIMG0000");
    header.write("_TEST_00001", 0x400);
    for (const [offset, point, time] of [
      [0, 0xa0, Buffer.from([1, 0, 0])],
      [10, 0xa1, Buffer.from([1, 0, 0])],
      [20, 0xa2, msf(image.length / sectorBytes + 150)],
    ]) {
      header[0x802 + offset] = point;
      time.copy(header, 0x807 + offset);
    }
    header[0x81e] = 0x41;
    header[0x820] = 1;
    msf(150).copy(header, 0x825);
    const blocks = [];
    let payloadOffset = 0;
    for (let offset = 0, index = 0; offset < image.length; offset += blockBytes, index += 1) {
      const block = Buffer.alloc(blockBytes);
      image.copy(block, 0, offset, offset + blockBytes);
      const compressed = deflateRawSync(block);
      header.writeUInt32LE(payloadOffset, 0x4000 + index * 32);
      header.writeUInt32LE(compressed.length, 0x4004 + index * 32);
      payloadOffset += compressed.length;
      blocks.push(compressed);
    }
    header.writeUInt32LE(payloadOffset, 0x4000 + blocks.length * 32);
    return Buffer.concat([header, ...blocks]);
  });
  let psar = discs[0];
  if (discs.length > 1) {
    const header = Buffer.alloc(0x8000);
    header.write("PSTITLEIMG000000");
    [0x2cc9c5bc, 0x33b5a90f, 0x06f6b4b3, 0xb25945ba].forEach((value, index) => {
      header.writeUInt32LE(value, 24 + index * 4);
    });
    let offset = header.length;
    discs.forEach((disc, index) => {
      header.writeUInt32LE(offset, 0x200 + index * 4);
      offset += disc.length;
    });
    psar = Buffer.concat([header, ...discs]);
  }
  const header = Buffer.alloc(40);
  header.writeUInt32LE(0x50425000);
  header.writeUInt32LE(0x10000, 4);
  for (let index = 0; index < 8; index += 1) header.writeUInt32LE(40, 8 + index * 4);
  return Buffer.concat([header, psar]);
};
