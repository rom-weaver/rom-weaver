import { buildPbp, buildPbpDiscBytes } from "../wasm/pbp-fixture.mjs";

const text = (value) => new TextEncoder().encode(value);
const u32 = (bytes, at, value, littleEndian = false) => new DataView(bytes.buffer).setUint32(at, value, littleEndian);

const gamecube = (size) => {
  const bytes = new Uint8Array(size);
  bytes.set(text("RWTEST"));
  u32(bytes, 0x1c, 0xc2339f3d);
  bytes.set(text("Synthetic patch input"), 0x20);
  return bytes;
};

export const csoFixture = () => {
  const payload = gamecube(32768);
  const blocks = payload.length / 2048;
  const start = 24 + (blocks + 1) * 4;
  const container = new Uint8Array(start + payload.length);
  container.set(text("CISO"));
  u32(container, 4, 24, true);
  new DataView(container.buffer).setBigUint64(8, BigInt(payload.length), true);
  u32(container, 16, 2048, true);
  container[20] = 1;
  for (let block = 0; block < blocks; block++) u32(container, 24 + block * 4, 0x80000000 + start + block * 2048, true);
  u32(container, 24 + blocks * 4, container.length, true);
  container.set(payload, start);
  return { container, payload, extension: "cso", payloadExtension: "iso" };
};

// NKit's declared disc size keeps these one-block fixtures small during extraction.
const nkitSize = (bytes, at, size) => {
  bytes.set(text("NKIT  v2"), at);
  const view = new DataView(bytes.buffer);
  view.setUint16(at + 8, 20);
  view.setUint16(at + 10, 1);
  view.setBigUint64(at + 12, BigInt(size));
};

const cisoFixture = () => {
  const payload = gamecube(2 * 1024 * 1024);
  const nkitAt = 0x8000 + payload.length;
  const container = new Uint8Array(nkitAt + 1024);
  container.set(text("CISO"));
  u32(container, 4, payload.length, true);
  container[8] = 1;
  container.set(payload, 0x8000);
  nkitSize(container, nkitAt, payload.length);
  return { container, payload, extension: "ciso", payloadExtension: "iso" };
};

const wbfsFixture = () => {
  const payload = gamecube(2 * 1024 * 1024);
  const container = new Uint8Array(payload.length * 2);
  container.set(text("WBFS"));
  u32(container, 4, container.length / 512);
  container[8] = 9;
  container[9] = 21;
  container[10] = 1;
  container[12] = 1;
  container.set(payload.subarray(0, 256), 512);
  new DataView(container.buffer).setUint16(512 + 256, 1);
  nkitSize(container, 0x10000, payload.length);
  container.set(payload, payload.length);
  return { container, payload, extension: "wbfs", payloadExtension: "iso" };
};

const tgcFixture = () => {
  const payload = gamecube(0x100000);
  u32(payload, 0x420, 0x6000);
  u32(payload, 0x424, 0x8000);
  u32(payload, 0x428, 12);
  u32(payload, 0x42c, 12);
  u32(payload, 0x8000, 0x01000000);
  u32(payload, 0x8008, 1);
  const container = new Uint8Array(0x110000);
  const header = [
    0xae0f38a2,
    0,
    0x8000,
    payload.length,
    0x108000,
    12,
    12,
    0x108020,
    0x100,
    container.length,
    0,
    0,
    0,
    payload.length,
  ];
  for (const [index, value] of header.entries()) u32(container, index * 4, value);
  container.set(payload, 0x8000);
  container.set(payload.subarray(0x8000, 0x800c), 0x108000);
  return { container, payload, extension: "tgc", payloadExtension: "iso" };
};

const pbpFixture = () => {
  const payload = buildPbpDiscBytes(32, 7);
  return {
    container: buildPbp([{ discId: "SLUS00001", iso: payload }]),
    payload,
    extension: "pbp",
    payloadExtension: "bin",
  };
};

export const patchContainerFixtures = () => [csoFixture(), pbpFixture(), cisoFixture(), wbfsFixture(), tgcFixture()];

export const xisoFixture = (partitionOffset = 0) => {
  const bytes = new Uint8Array(131072);
  const sector = 2048;
  bytes.set(text("MICROSOFT*XBOX*MEDIA"), 32 * sector);
  u32(bytes, 32 * sector + 20, 33, true);
  u32(bytes, 32 * sector + 24, 28, true);
  bytes.set(text("MICROSOFT*XBOX*MEDIA"), 33 * sector - 20);
  const root = 33 * sector;
  u32(bytes, root + 4, 34, true);
  u32(bytes, root + 8, 8, true);
  bytes[root + 12] = 0x80;
  bytes[root + 13] = 11;
  bytes.set(text("default.xbe"), root + 14);
  bytes.set(text("XBE-STUB"), 34 * sector);
  if (!partitionOffset) return bytes;
  const disc = new Uint8Array(partitionOffset + bytes.length);
  disc.set(text("SYNTHETIC VIDEO PARTITION"));
  disc.set(bytes, partitionOffset);
  return disc;
};

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

export const rawCrc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
};

// This independent BPS encoder MUST use the raw source, without workflow preparation.
export const rawBpsFixture = (source, offset) => {
  if (offset >= source.length)
    throw new Error(`rawBpsFixture: offset ${offset} is outside a ${source.length}-byte source`);
  const target = source.slice();
  target[offset] ^= 1;
  const patch = [...text("BPS1")];
  const number = (input) => {
    let value = input;
    while (true) {
      const byte = value & 127;
      value = Math.floor(value / 128);
      if (!value) {
        patch.push(byte | 128);
        return;
      }
      patch.push(byte);
      value--;
    }
  };
  number(source.length);
  number(target.length);
  number(0);
  if (offset) number((offset - 1) * 4);
  number(1);
  patch.push(target[offset]);
  const remaining = target.length - offset - 1;
  if (remaining) number((remaining - 1) * 4);
  const appendCrc = (crc) => {
    for (let shift = 0; shift < 32; shift += 8) patch.push((crc >>> shift) & 255);
  };
  appendCrc(rawCrc32(source));
  appendCrc(rawCrc32(target));
  appendCrc(rawCrc32(patch));
  return { patch: new Uint8Array(patch), target };
};
