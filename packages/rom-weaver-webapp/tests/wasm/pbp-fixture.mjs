// Synthetic PS1 PBP builder for wasm tests, following the layout of `build_test_pbp_fixture` in
// crates/rom-weaver-cli/tests/cli_smoke/shared.rs. Unlike that builder, which deflates some blocks,
// every disc block here is stored raw (an index length equal to the block size means "not
// deflated"), so no compressor is needed and no real game image is ever committed.

const PBP_SECTOR_BYTES = 0x930;
const BLOCK_BYTES = PBP_SECTOR_BYTES * 16;
const INDEX_OFFSET = 0x4000;
const ISO_OFFSET = 0x100000;
const PBP_PSAR_OFFSET = 0x100;

const writeU32 = (bytes, offset, value) => new DataView(bytes.buffer).setUint32(offset, value, true);
const bcd = (value) => ((Math.floor(value / 10) << 4) | (value % 10)) & 0xff;

export function buildPbpDiscBytes(sectorCount, seed) {
  const bytes = new Uint8Array(sectorCount * PBP_SECTOR_BYTES);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (seed + (index % 239)) & 0xff;
  writeU32(bytes, BLOCK_BYTES + 104, sectorCount);
  return bytes;
}

function buildDiscPsar(discId, iso) {
  const sectorCount = iso.length / PBP_SECTOR_BYTES;
  const blockCount = Math.ceil(iso.length / BLOCK_BYTES);
  const padded = new Uint8Array(blockCount * BLOCK_BYTES);
  padded.set(iso);
  const psar = new Uint8Array(ISO_OFFSET + padded.length);
  psar.set(new TextEncoder().encode("PSISOIMG0000"));
  writeU32(psar, 12, psar.length);
  psar.set(new TextEncoder().encode(`_${discId.slice(0, 4)}_${discId.slice(4)}`), 0x400);
  const leadout = 150 + sectorCount;
  psar[0x800 + 2] = 0xa0;
  psar[0x800 + 7] = bcd(1);
  psar[0x80a + 2] = 0xa1;
  psar[0x80a + 7] = bcd(1);
  psar[0x814 + 2] = 0xa2;
  psar[0x814 + 7] = bcd(Math.floor(leadout / (60 * 75)));
  psar[0x814 + 8] = bcd(Math.floor(leadout / 75) % 60);
  psar[0x814 + 9] = bcd(leadout % 75);
  psar[0x81e] = 0x41;
  psar[0x81e + 2] = bcd(1);
  psar[0x81e + 3] = bcd(0);
  psar[0x81e + 4] = bcd(2);
  psar[0x81e + 5] = bcd(0);
  for (let block = 0; block < blockCount; block += 1) {
    const entry = INDEX_OFFSET + block * 0x20;
    writeU32(psar, entry, block * BLOCK_BYTES);
    writeU32(psar, entry + 4, BLOCK_BYTES);
  }
  psar.set(padded, ISO_OFFSET);
  return psar;
}

/** Build a PBP holding one PSISOIMG disc, or a PSTITLEIMG bundle when given several. */
export function buildPbp(discs) {
  const payloads = discs.map(({ discId, iso }) => buildDiscPsar(discId, iso));
  let psar;
  if (payloads.length === 1) {
    [psar] = payloads;
  } else {
    const header = new Uint8Array(0x200 + 5 * 4);
    header.set(new TextEncoder().encode("PSTITLEIMG000000"));
    writeU32(header, 0x10 + 8, 0x2cc9c5bc);
    writeU32(header, 0x10 + 12, 0x33b5a90f);
    writeU32(header, 0x10 + 16, 0x06f6b4b3);
    writeU32(header, 0x10 + 20, 0xb25945ba);
    const parts = [header];
    let cursor = 0x800;
    let length = header.length;
    payloads.forEach((payload, index) => {
      writeU32(header, 0x200 + index * 4, cursor);
      const gap = new Uint8Array(cursor - length);
      parts.push(gap, payload);
      length = cursor + payload.length;
      cursor = length;
    });
    psar = new Uint8Array(length);
    let at = 0;
    for (const part of parts) {
      psar.set(part, at);
      at += part.length;
    }
  }
  const pbp = new Uint8Array(PBP_PSAR_OFFSET + psar.length);
  pbp.set([0x00, 0x50, 0x42, 0x50]);
  writeU32(pbp, 4, 0x00010000);
  for (let section = 0; section < 8; section += 1) writeU32(pbp, 8 + section * 4, PBP_PSAR_OFFSET);
  pbp.set(psar, PBP_PSAR_OFFSET);
  return pbp;
}
