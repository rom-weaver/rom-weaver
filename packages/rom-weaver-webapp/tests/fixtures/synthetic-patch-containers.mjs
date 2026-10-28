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

export const xisoFixture = () => {
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
  return bytes;
};
