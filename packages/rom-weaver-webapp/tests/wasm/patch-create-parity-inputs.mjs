// Deterministic inputs shared by patch-create-parity.test.mjs and the native-CLI
// generator that produced fixtures/patch-create-parity/expected.json
// (`node scripts/generate-patch-create-parity.mjs <rom-weaver-binary>`).
const encoder = new TextEncoder();

const DLDI_MAGIC = [0xed, 0xa5, 0x8d, 0xbf, 0x20, 0x43, 0x68, 0x69, 0x73, 0x68, 0x6d, 0x00];
const APS_GBA_BLOCK_SIZE = 0x1_0000;

function writeI32(bytes, offset, value) {
  new DataView(bytes.buffer).setInt32(offset, value | 0, true);
}

// Mirrors build_dldi_driver in crates/rom-weaver-cli/tests/cli_smoke/patch.rs.
function buildDldiDriver(driverLog2, baseAddress, friendlyName) {
  const size = 1 << driverLog2;
  const bytes = new Uint8Array(size);
  bytes.set(DLDI_MAGIC, 0x00);
  bytes[0x0c] = 1;
  bytes[0x0d] = driverLog2;
  bytes[0x0e] = 0x01 | 0x02 | 0x04 | 0x08;
  bytes[0x0f] = driverLog2;
  bytes.set(encoder.encode(friendlyName).subarray(0, 0x40 - 0x10 - 1), 0x10);
  writeI32(bytes, 0x40, baseAddress);
  writeI32(bytes, 0x44, baseAddress + size);
  writeI32(bytes, 0x48, baseAddress + 0xa0);
  writeI32(bytes, 0x4c, baseAddress + 0xa8);
  writeI32(bytes, 0x50, baseAddress + 0xa8);
  writeI32(bytes, 0x54, baseAddress + 0xb0);
  writeI32(bytes, 0x58, baseAddress + 0xb0);
  writeI32(bytes, 0x5c, baseAddress + 0xc0);
  writeI32(bytes, 0x68, baseAddress + 0x80);
  writeI32(bytes, 0x70, baseAddress + 0x88);
  writeI32(bytes, 0x74, baseAddress + 0x8c);
  writeI32(bytes, 0x7c, baseAddress + 0x90);
  writeI32(bytes, 0x84, baseAddress + 0xd0);
  writeI32(bytes, 0x8c, baseAddress + 0xd8);
  writeI32(bytes, 0xa0, baseAddress + 0x80);
  writeI32(bytes, 0xa8, baseAddress + 0x84);
  bytes.fill(0x7f, 0xb0, 0xc0);
  return bytes;
}

function buildNdsWithDldiSlot(slotOffset, allocatedLog2, baseAddress, friendlyName) {
  const slotSize = 1 << allocatedLog2;
  const file = new Uint8Array(slotOffset + slotSize + 0x80).fill(0xcd);
  file.set(buildDldiDriver(allocatedLog2, baseAddress, friendlyName), slotOffset);
  return file;
}

function apsgbaPair() {
  const source = new Uint8Array(APS_GBA_BLOCK_SIZE);
  for (let index = 0; index < source.length; index += 1) {
    source[index] = (index * 17 + (index >> 5)) & 0xff;
  }
  const target = source.slice();
  target[0x0123] ^= 0x3f;
  target[0x8000] = 0x5a;
  return { modified: target, original: source };
}

const textPair = (original, modified) => ({
  modified: encoder.encode(modified),
  original: encoder.encode(original),
});

/** Per-format inputs; `dldiSeed` is applied to `original` (via patch apply) to build `modified`. */
export const PATCH_CREATE_PARITY_CASES = {
  apsgba: apsgbaPair(),
  dldi: {
    dldiSeed: buildDldiDriver(8, 0xbf80_0000 | 0, "Roundtrip driver"),
    original: buildNdsWithDldiSlot(0x300, 12, 0x0200_0000, "Default driver"),
  },
  dps: textPair("hello old world", "hello new world + dps"),
  gdiff: textPair("abcdefghij", "abXYcdefgh!!"),
  ips32: textPair("abcdefgh", "a1XYZf!!!"),
  pat: textPair("hello old world", "HELlo old worlD"),
  solid: textPair("abcdefghij", "abCDfgh"),
};

export const PATCH_CREATE_PARITY_FORMATS = Object.keys(PATCH_CREATE_PARITY_CASES);
