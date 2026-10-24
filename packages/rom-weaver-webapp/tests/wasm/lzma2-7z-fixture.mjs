import { crc32 } from "./stored-zip-fixture.mjs";

// 7z's variable-length NUMBER: leading one bits in the first byte count the little-endian bytes
// that follow, and the first byte's remaining bits hold the value's top bits.
const pushNumber = (out, value) => {
  let first = 0;
  let mask = 0x80;
  let extra = 0;
  while (extra < 8 && value >= 2 ** (7 * (extra + 1))) {
    first |= mask;
    mask >>= 1;
    extra += 1;
  }
  if (extra < 8) first |= Math.floor(value / 2 ** (8 * extra));
  out.push(first);
  for (let index = 0; index < extra; index += 1) out.push(Math.floor(value / 2 ** (8 * index)) & 0xff);
};

const pushLe = (out, value, byteLength) => {
  for (let index = 0; index < byteLength; index += 1) out.push(Math.floor(value / 2 ** (8 * index)) & 0xff);
};

/**
 * Builds a 7z archive with one solid block (folder) per file, each an LZMA2 stream declaring
 * dictionary property `dictionaryProp` (40 declares 4 GiB - 1) whatever its size. The streams use
 * LZMA2's uncompressed chunks, so no encoder is involved and any declared dictionary is valid.
 */
export function buildLzma2FoldersSevenZip(files, dictionaryProp) {
  const packed = [];
  const packSizes = [];
  for (const { data } of files) {
    const start = packed.length;
    for (let offset = 0; offset < data.length; offset += 1 << 16) {
      const chunk = data.subarray(offset, offset + (1 << 16));
      // Control 1 starts an uncompressed chunk and resets the dictionary; 2 continues it.
      packed.push(offset === 0 ? 0x01 : 0x02, (chunk.length - 1) >> 8, (chunk.length - 1) & 0xff);
      for (const byte of chunk) packed.push(byte);
    }
    packed.push(0x00);
    packSizes.push(packed.length - start);
  }

  // Header, MainStreamsInfo, PackInfo at offset 0 with one stream per folder.
  const header = [0x01, 0x04, 0x06];
  pushNumber(header, 0);
  pushNumber(header, files.length);
  header.push(0x09);
  for (const size of packSizes) pushNumber(header, size);
  header.push(0x00);
  // UnPackInfo: inline folders of one coder each - flags 0x21 (1-byte id, has properties),
  // id 0x21 (LZMA2), one property byte - then each folder's unpacked size.
  header.push(0x07, 0x0b);
  pushNumber(header, files.length);
  header.push(0x00);
  for (const _ of files) header.push(0x01, 0x21, 0x21, 0x01, dictionaryProp);
  header.push(0x0c);
  for (const { data } of files) pushNumber(header, data.length);
  header.push(0x00);
  // SubStreamsInfo: one file per folder (the default) with every CRC defined.
  header.push(0x08, 0x0a, 0x01);
  for (const { data } of files) pushLe(header, crc32(data), 4);
  header.push(0x00, 0x00);
  // FilesInfo: inline UTF-16LE names, NUL-terminated.
  header.push(0x05);
  pushNumber(header, files.length);
  const names = [0x00];
  for (const { name } of files) {
    for (let index = 0; index < name.length; index += 1) pushLe(names, name.charCodeAt(index), 2);
    names.push(0, 0);
  }
  header.push(0x11);
  pushNumber(header, names.length);
  header.push(...names, 0x00, 0x00);

  const startHeader = [];
  pushLe(startHeader, packed.length, 8);
  pushLe(startHeader, header.length, 8);
  pushLe(startHeader, crc32(header), 4);
  const signature = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04];
  pushLe(signature, crc32(startHeader), 4);
  return Uint8Array.from([...signature, ...startHeader, ...packed, ...header]);
}
