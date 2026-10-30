// Independent (non-rom-weaver) patch encoders used to author apply-matrix fixtures.
// They deliberately do not share code with the product so a bug in the product's
// own encoder cannot hide a matching bug in its decoder.
import { crc32 } from "node:zlib";

const u8 = (...values) => Uint8Array.from(values);
export const concat = (...parts) => {
  const flat = parts.flatMap((part) => (typeof part === "number" ? [Uint8Array.of(part)] : [part]));
  const out = new Uint8Array(flat.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of flat) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
export const ascii = (text) => Uint8Array.from(text, (char) => char.charCodeAt(0));
const le = (value, bytes) => {
  const out = new Uint8Array(bytes);
  let rest = BigInt(value);
  for (let index = 0; index < bytes; index++) {
    out[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
};
const be = (value, bytes) => le(value, bytes).reverse();
export const crc32Of = (bytes) => crc32(bytes) >>> 0;

/** Runs of changed bytes between source and target (target may be longer or shorter). */
export const changedRuns = (source, target, { maxRun = 0xffff, gap = 0 } = {}) => {
  const runs = [];
  let index = 0;
  while (index < target.length) {
    if (index < source.length && source[index] === target[index]) {
      index++;
      continue;
    }
    const start = index;
    let lastDiff = index;
    while (index < target.length && index - start < maxRun) {
      const differs = index >= source.length || source[index] !== target[index];
      if (differs) lastDiff = index;
      else if (index - lastDiff > gap) break;
      index++;
    }
    runs.push([start, target.subarray(start, lastDiff + 1)]);
    index = lastDiff + 1;
  }
  return runs;
};

export const encodeIps = (source, target, { rle = [], truncate = true } = {}) => {
  const parts = [ascii("PATCH")];
  const covered = new Set();
  for (const [offset, length, value] of rle) {
    parts.push(be(offset, 3), be(0, 2), be(length, 2), u8(value));
    for (let at = offset; at < offset + length; at++) covered.add(at);
  }
  for (const [offset, data] of changedRuns(source, target)) {
    if (covered.has(offset)) continue;
    parts.push(be(offset, 3), be(data.length, 2), data);
  }
  parts.push(ascii("EOF"));
  if (truncate && target.length < source.length) parts.push(be(target.length, 3));
  return concat(...parts);
};

export const encodeIps32 = (source, target) => {
  const parts = [ascii("IPS32")];
  for (const [offset, data] of changedRuns(source, target)) parts.push(be(offset, 4), be(data.length, 2), data);
  parts.push(ascii("EEOF"));
  return concat(...parts);
};

const beatVarint = (value) => {
  const out = [];
  let rest = BigInt(value);
  for (;;) {
    const low = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest === 0n) {
      out.push(0x80 | low);
      return Uint8Array.from(out);
    }
    out.push(low);
    rest -= 1n;
  }
};

/** BPS using SourceRead for equal runs and TargetRead for changed bytes; optional TargetCopy RLE. */
export const encodeBps = (source, target, { metadata = "", useTargetCopy = false } = {}) => {
  const meta = ascii(metadata);
  const body = [ascii("BPS1"), beatVarint(source.length), beatVarint(target.length), beatVarint(meta.length), meta];
  let index = 0;
  let targetCopyBase = 0; // relative offset cursor for TargetCopy
  while (index < target.length) {
    if (index < source.length && source[index] === target[index]) {
      let end = index;
      while (end < target.length && end < source.length && source[end] === target[end]) end++;
      body.push(beatVarint(((end - index - 1) << 2) | 0));
      index = end;
      continue;
    }
    let end = index;
    while (end < target.length && !(end < source.length && source[end] === target[end])) end++;
    if (useTargetCopy && end - index >= 3 && target.subarray(index, end).every((value) => value === target[index])) {
      // one literal byte, then an overlapping TargetCopy that repeats it
      body.push(beatVarint((0 << 2) | 1), u8(target[index]));
      const copyLength = end - index - 1;
      if (copyLength > 0) {
        // TargetCopy offsets are relative to the previous TargetCopy cursor (starts at 0)
        const absolute = index;
        const delta = absolute - targetCopyBase;
        body.push(beatVarint(((copyLength - 1) << 2) | 3), beatVarint((Math.abs(delta) << 1) | (delta < 0 ? 1 : 0)));
        targetCopyBase = absolute + copyLength;
      }
    } else {
      body.push(beatVarint(((end - index - 1) << 2) | 1), target.subarray(index, end));
    }
    index = end;
  }
  const withoutCrc = concat(...body, le(crc32Of(source), 4), le(crc32Of(target), 4));
  return concat(withoutCrc, le(crc32Of(withoutCrc), 4));
};

export const encodeUps = (source, target) => {
  const body = [ascii("UPS1"), beatVarint(source.length), beatVarint(target.length)];
  const xor = (at) => (at < target.length ? target[at] ^ (at < source.length ? source[at] : 0) : 0);
  let index = 0;
  let last = 0;
  while (index < target.length) {
    if (xor(index) === 0) {
      index++;
      continue;
    }
    body.push(beatVarint(index - last));
    while (index < target.length && xor(index) !== 0) body.push(u8(xor(index++)));
    body.push(u8(0));
    index++;
    last = index;
  }
  const withoutCrc = concat(...body, le(crc32Of(source), 4), le(crc32Of(target), 4));
  return concat(withoutCrc, le(crc32Of(withoutCrc), 4));
};

const padded = (text, length) => {
  const out = new Uint8Array(length).fill(0x20);
  out.set(ascii(text).subarray(0, length));
  return out;
};

export const encodePpf1 = (source, target, description = "apply-matrix") => {
  const parts = [ascii("PPF10"), u8(0), padded(description, 50)];
  for (const [offset, data] of changedRuns(source, target, { maxRun: 255 })) parts.push(le(offset, 4), u8(data.length), data);
  return concat(...parts);
};

export const encodePpf2 = (source, target, description = "apply-matrix") => {
  const parts = [ascii("PPF20"), u8(1), padded(description, 50), le(source.length, 4)];
  const block = new Uint8Array(1024);
  block.set(source.subarray(0x9320, 0x9320 + 1024));
  parts.push(block);
  for (const [offset, data] of changedRuns(source, target, { maxRun: 255 })) parts.push(le(offset, 4), u8(data.length), data);
  return concat(...parts);
};

export const encodePpf3 = (source, target, { blockCheck = false, undo = false, imageType = 0, description = "apply-matrix" } = {}) => {
  const parts = [
    ascii("PPF30"),
    u8(2),
    padded(description, 50),
    u8(imageType),
    u8(blockCheck ? 1 : 0),
    u8(undo ? 1 : 0),
    u8(0),
  ];
  if (blockCheck) {
    const block = new Uint8Array(1024);
    block.set(source.subarray(0x9320, 0x9320 + 1024));
    parts.push(block);
  }
  for (const [offset, data] of changedRuns(source, target, { maxRun: 255 })) {
    parts.push(le(offset, 8), u8(data.length), data);
    if (undo) parts.push(source.subarray(offset, offset + data.length));
  }
  return concat(...parts);
};

/**
 * APS (N64) patch: header type 1 carries the 17-byte N64 block (format byte, 3-byte cart id
 * from ROM offset 0x3C, 8-byte CRC field from ROM offset 0x10, 5 bytes padding), then the output
 * size and simple/RLE records. `rle` is a list of [offset, length(<=255), value].
 */
export const encodeApsN64 = (source, target, { description = "apply-matrix", rle = [] } = {}) => {
  const parts = [
    ascii("APS10"),
    u8(1),
    u8(0),
    padded(description, 50),
    u8(1),
    source.subarray(0x3c, 0x3f),
    source.subarray(0x10, 0x18),
    new Uint8Array(5),
    le(target.length, 4),
  ];
  const covered = new Set();
  for (const [offset, length, value] of rle) {
    parts.push(le(offset, 4), u8(0), u8(value), u8(length));
    for (let at = offset; at < offset + length; at++) covered.add(at);
  }
  for (const [offset, data] of changedRuns(source, target, { maxRun: 255 })) {
    if (covered.has(offset)) continue;
    parts.push(le(offset, 4), u8(data.length), data);
  }
  return concat(...parts);
};

/** GDIFF (w3.org NOTE-gdiff) using data + copy commands. */
export const encodeGdiff = (source, target) => {
  const parts = [u8(0xd1, 0xff, 0xd1, 0xff, 0x04)];
  const data = (bytes) => {
    for (let at = 0; at < bytes.length; at += 65535) {
      const chunk = bytes.subarray(at, Math.min(bytes.length, at + 65535));
      if (chunk.length <= 246) parts.push(u8(chunk.length), chunk);
      else parts.push(u8(247), be(chunk.length, 2), chunk);
    }
  };
  const copy = (position, length) => parts.push(u8(254), be(position, 4), be(length, 4)); // int pos, int len
  let index = 0;
  while (index < target.length) {
    if (index < source.length && source[index] === target[index]) {
      let end = index;
      while (end < target.length && end < source.length && source[end] === target[end]) end++;
      copy(index, end - index);
      index = end;
    } else {
      let end = index;
      while (end < target.length && !(end < source.length && source[end] === target[end])) end++;
      data(target.subarray(index, end));
      index = end;
    }
  }
  parts.push(u8(0));
  return concat(...parts);
};

const vcdiffInt = (value) => {
  const out = [value & 0x7f];
  let rest = Math.floor(value / 128);
  while (rest > 0) {
    out.unshift(0x80 | (rest & 0x7f));
    rest = Math.floor(rest / 128);
  }
  return Uint8Array.from(out);
};
const adler32 = (bytes) => {
  let a = 1;
  let b = 0;
  for (const value of bytes) {
    a = (a + value) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
};

/**
 * Plain RFC 3284 VCDIFF with the default code table: ADD (opcode 1 + size), COPY mode 0
 * (opcode 19 + size, SELF address), RUN (opcode 0). No secondary compression.
 * `adler` adds the xdelta3 VCD_ADLER32 extension.
 */
export const encodeVcdiff = (source, target, { adler = false, runs = true } = {}) => {
  const add = [];
  const inst = [];
  const addr = [];
  let index = 0;
  const emitAdd = (bytes) => {
    inst.push(u8(1), vcdiffInt(bytes.length));
    add.push(bytes);
  };
  while (index < target.length) {
    if (index < source.length && source[index] === target[index]) {
      let end = index;
      while (end < target.length && end < source.length && source[end] === target[end]) end++;
      inst.push(u8(19), vcdiffInt(end - index));
      addr.push(vcdiffInt(index));
      index = end;
      continue;
    }
    let end = index;
    while (end < target.length && !(end < source.length && source[end] === target[end])) end++;
    const chunk = target.subarray(index, end);
    if (runs && chunk.length >= 8 && chunk.every((value) => value === chunk[0])) {
      inst.push(u8(0), vcdiffInt(chunk.length));
      add.push(u8(chunk[0]));
    } else emitAdd(chunk);
    index = end;
  }
  const addBytes = concat(...add);
  const instBytes = concat(...inst);
  const addrBytes = concat(...addr);
  const checksum = adler ? be(adler32(target), 4) : new Uint8Array(0);
  const delta = concat(
    vcdiffInt(target.length),
    u8(0),
    vcdiffInt(addBytes.length),
    vcdiffInt(instBytes.length),
    vcdiffInt(addrBytes.length),
    checksum,
    addBytes,
    instBytes,
    addrBytes,
  );
  return concat(
    u8(0xd6, 0xc3, 0xc4, 0x00, 0x00),
    u8(adler ? 0x05 : 0x01),
    vcdiffInt(source.length),
    vcdiffInt(0),
    vcdiffInt(delta.length),
    delta,
  );
};
