// Dependency-free, deterministic encoders used to build the apply-matrix fixtures. They are
// written from the public format specs (not from rom-weaver's Rust) so applying their output in
// the webapp is an independent oracle: the result must equal the target bytes exactly.
import { createHash } from "node:crypto";
import zlib from "node:zlib";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** Deterministic pseudo-random bytes (xorshift32) so fixtures are byte-stable across runs. */
export const prng = (length, seed = 0x9e3779b9) => {
  const out = new Uint8Array(length);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
};

export const concat = (...parts) => {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const ascii = (text) => new TextEncoder().encode(text);
const be = (value, width) => {
  const out = new Uint8Array(width);
  let v = BigInt(value);
  for (let i = width - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
};
const le32 = (value) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0, true);
  return out;
};

/** Runs where `target` differs from `source` (target past source end counts as different). */
const diffRuns = (source, target, { minGap = 0 } = {}) => {
  const runs = [];
  let i = 0;
  while (i < target.length) {
    if (i < source.length && source[i] === target[i]) {
      i++;
      continue;
    }
    let end = i + 1;
    for (;;) {
      while (end < target.length && (end >= source.length || source[end] !== target[end])) end++;
      let probe = end;
      while (probe < target.length && probe < source.length && source[probe] === target[probe] && probe - end <= minGap)
        probe++;
      if (probe < target.length && probe - end <= minGap && (probe >= source.length || source[probe] !== target[probe]))
        end = probe;
      else break;
    }
    runs.push([i, end]);
    i = end;
  }
  return runs;
};

const ipsRecords = (source, target, offsetWidth, eofOffsets) => {
  const records = [];
  for (const [start0, end] of diffRuns(source, target, { minGap: 2 })) {
    let start = start0;
    // Never emit an offset that spells the "EOF"/"EEOF" marker.
    if (eofOffsets.includes(start)) start -= 1;
    while (start < end) {
      const chunkEnd = Math.min(end, start + 0xffff);
      const data = target.subarray(start, chunkEnd);
      const allSame = data.length > 8 && data.every((byte) => byte === data[0]);
      if (allSame) records.push(concat(be(start, offsetWidth), be(0, 2), be(data.length, 2), Uint8Array.of(data[0])));
      else records.push(concat(be(start, offsetWidth), be(data.length, 2), data));
      start = chunkEnd;
    }
  }
  return records;
};

export const encodeIps = (source, target, { truncate = false } = {}) => {
  const body = ipsRecords(source, target, 3, [0x454f46]);
  const tail = truncate && target.length < source.length ? be(target.length, 3) : new Uint8Array();
  return concat(ascii("PATCH"), ...body, ascii("EOF"), tail);
};

export const encodeIps32 = (source, target) =>
  concat(ascii("IPS32"), ...ipsRecords(source, target, 4, [0x45454f46]), ascii("EEOF"));

export const encodeEbp = (source, target, meta = { patcher: "EBPatcher", author: "apply-matrix", title: "matrix" }) =>
  concat(ascii("PATCH"), ...ipsRecords(source, target, 3, [0x454f46]), ascii("EOF"), ascii(JSON.stringify(meta)));

const bpsNumber = (value) => {
  const out = [];
  let n = BigInt(value);
  for (;;) {
    const x = Number(n & 0x7fn);
    n >>= 7n;
    if (n === 0n) {
      out.push(0x80 | x);
      break;
    }
    out.push(x);
    n -= 1n;
  }
  return Uint8Array.from(out);
};

export const encodeBps = (source, target, metadata = "") => {
  const actions = [];
  let outPos = 0;
  let pendingLiteral = [];
  const flushLiteral = () => {
    if (!pendingLiteral.length) return;
    actions.push(bpsNumber(((pendingLiteral.length - 1) << 2) | 1), Uint8Array.from(pendingLiteral));
    pendingLiteral = [];
  };
  while (outPos < target.length) {
    if (outPos < source.length && source[outPos] === target[outPos]) {
      let end = outPos;
      while (end < target.length && end < source.length && source[end] === target[end]) end++;
      const length = end - outPos;
      if (length >= 4) {
        flushLiteral();
        actions.push(bpsNumber((length - 1) << 2)); // SourceRead
        outPos = end;
        continue;
      }
    }
    pendingLiteral.push(target[outPos]);
    outPos++;
  }
  flushLiteral();
  const head = concat(
    ascii("BPS1"),
    bpsNumber(source.length),
    bpsNumber(target.length),
    bpsNumber(ascii(metadata).length),
    ascii(metadata),
  );
  const withoutFooter = concat(head, ...actions, le32(crc32(source)), le32(crc32(target)));
  return concat(withoutFooter, le32(crc32(withoutFooter)));
};

export const encodeUps = (source, target) => {
  const parts = [ascii("UPS1"), bpsNumber(source.length), bpsNumber(target.length)];
  let pointer = 0;
  const limit = Math.max(source.length, target.length);
  let i = 0;
  const xorAt = (at) => (at < target.length ? target[at] : 0) ^ (at < source.length ? source[at] : 0);
  while (i < limit) {
    if (xorAt(i) === 0) {
      i++;
      continue;
    }
    const start = i;
    const xors = [];
    while (i < limit && xorAt(i) !== 0) xors.push(xorAt(i++));
    parts.push(bpsNumber(start - pointer), Uint8Array.from(xors), Uint8Array.of(0));
    pointer = i + 1;
    i += 1;
  }
  const withoutFooter = concat(...parts, le32(crc32(source)), le32(crc32(target)));
  return concat(withoutFooter, le32(crc32(withoutFooter)));
};

const vcdiffVarint = (value) => {
  const bytes = [value & 0x7f];
  let n = Math.floor(value / 128);
  while (n > 0) {
    bytes.unshift(0x80 | (n & 0x7f));
    n = Math.floor(n / 128);
  }
  return Uint8Array.from(bytes);
};

/** Single-window uncompressed VCDIFF (RFC 3284, default code table): ADD and COPY(SELF) only. */
export const encodeVcdiff = (source, target) => {
  const data = [];
  const inst = [];
  const addr = [];
  let pos = 0;
  let literal = [];
  const flush = () => {
    if (!literal.length) return;
    inst.push(Uint8Array.of(1), vcdiffVarint(literal.length)); // ADD, explicit size
    data.push(Uint8Array.from(literal));
    literal = [];
  };
  while (pos < target.length) {
    let end = pos;
    if (pos < source.length && source[pos] === target[pos]) {
      while (end < target.length && end < source.length && source[end] === target[end]) end++;
    }
    if (end - pos >= 8) {
      flush();
      inst.push(Uint8Array.of(19), vcdiffVarint(end - pos)); // COPY size follows, mode SELF
      addr.push(vcdiffVarint(pos));
      pos = end;
    } else {
      literal.push(target[pos++]);
    }
  }
  flush();
  const dataBytes = concat(...data);
  const instBytes = concat(...inst);
  const addrBytes = concat(...addr);
  const delta = concat(
    vcdiffVarint(target.length),
    Uint8Array.of(0),
    vcdiffVarint(dataBytes.length),
    vcdiffVarint(instBytes.length),
    vcdiffVarint(addrBytes.length),
    dataBytes,
    instBytes,
    addrBytes,
  );
  return concat(
    Uint8Array.of(0xd6, 0xc3, 0xc4, 0x00, 0x00),
    Uint8Array.of(0x01), // VCD_SOURCE
    vcdiffVarint(source.length),
    vcdiffVarint(0),
    vcdiffVarint(delta.length),
    delta,
  );
};

/** GDIFF v4 (W3C NOTE-gdiff): data append and copy commands, big-endian. */
export const encodeGdiff = (source, target) => {
  const out = [Uint8Array.of(0xd1, 0xff, 0xd1, 0xff, 4)];
  let pos = 0;
  let literal = [];
  const flush = () => {
    let at = 0;
    while (at < literal.length) {
      const n = Math.min(246, literal.length - at);
      out.push(Uint8Array.of(n), Uint8Array.from(literal.slice(at, at + n)));
      at += n;
    }
    literal = [];
  };
  while (pos < target.length) {
    let end = pos;
    if (pos < source.length && source[pos] === target[pos]) {
      while (end < target.length && end < source.length && source[end] === target[end]) end++;
    }
    if (end - pos >= 8) {
      flush();
      let at = pos;
      while (at < end) {
        const n = Math.min(0xffff, end - at);
        out.push(Uint8Array.of(250), be(at, 2), be(n, 2)); // copy ushort pos, ushort len
        at += n;
      }
      pos = end;
    } else {
      literal.push(target[pos++]);
    }
  }
  flush();
  out.push(Uint8Array.of(0));
  return concat(...out);
};

// ---- containers -----------------------------------------------------------------------------

const dosTime = 0x6000; // 12:00:00
const dosDate = 0x5821; // 2024-01-01

/** Minimal ZIP writer. entries: [{ name, data, store? }]. `utf8` sets the language-encoding flag. */
export const zip = (entries, { comment = "", utf8 = true } = {}) => {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = new TextEncoder().encode(entry.name);
    const raw = entry.data;
    const store = entry.store ?? raw.length < 32;
    const body = store ? raw : new Uint8Array(zlib.deflateRawSync(raw, { level: 9 }));
    const flags = utf8 ? 0x0800 : 0;
    const method = store ? 0 : 8;
    const local = concat(
      le32(0x04034b50),
      Uint8Array.of(20, 0, flags & 0xff, flags >> 8, method, 0),
      Uint8Array.of(dosTime & 0xff, dosTime >> 8, dosDate & 0xff, dosDate >> 8),
      le32(crc32(raw)),
      le32(body.length),
      le32(raw.length),
      Uint8Array.of(name.length & 0xff, name.length >> 8, 0, 0),
      name,
      body,
    );
    centrals.push(
      concat(
        le32(0x02014b50),
        Uint8Array.of(20, 0, 20, 0, flags & 0xff, flags >> 8, method, 0),
        Uint8Array.of(dosTime & 0xff, dosTime >> 8, dosDate & 0xff, dosDate >> 8),
        le32(crc32(raw)),
        le32(body.length),
        le32(raw.length),
        Uint8Array.of(name.length & 0xff, name.length >> 8, 0, 0, 0, 0, 0, 0, 0, 0),
        le32(0),
        le32(offset),
        name,
      ),
    );
    locals.push(local);
    offset += local.length;
  }
  const central = concat(...centrals);
  const note = ascii(comment);
  const end = concat(
    le32(0x06054b50),
    Uint8Array.of(0, 0, 0, 0),
    Uint8Array.of(entries.length & 0xff, entries.length >> 8, entries.length & 0xff, entries.length >> 8),
    le32(central.length),
    le32(offset),
    Uint8Array.of(note.length & 0xff, note.length >> 8),
    note,
  );
  return concat(...locals, central, end);
};

/** Minimal ustar writer. entries: [{ name, data }]. */
export const tar = (entries) => {
  const blocks = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    const put = (text, at, length) => header.set(ascii(text).subarray(0, length), at);
    put(entry.name, 0, 100);
    put("0000644\0", 100, 8);
    put("0000000\0", 108, 8);
    put("0000000\0", 116, 8);
    put(`${entry.data.length.toString(8).padStart(11, "0")}\0`, 124, 12);
    put("00000000000\0", 136, 12);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    put("ustar\0", 257, 6);
    put("00", 263, 2);
    const sum = header.reduce((total, byte) => total + byte, 0);
    put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    blocks.push(header, entry.data, new Uint8Array((512 - (entry.data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return concat(...blocks);
};

/** Deterministic gzip (zero mtime, optional FNAME). */
export const gzip = (bytes, name) => {
  const deflated = new Uint8Array(zlib.deflateRawSync(bytes, { level: 9 }));
  const fname = name ? concat(ascii(name), Uint8Array.of(0)) : new Uint8Array();
  return concat(
    Uint8Array.of(0x1f, 0x8b, 8, name ? 8 : 0, 0, 0, 0, 0, 0, 3),
    fname,
    deflated,
    le32(crc32(bytes)),
    le32(bytes.length),
  );
};

/** Four bytes to append to `prefix` so the whole buffer has CRC-32 `wanted` (CRC forging). */
export const forgeCrc32Tail = (prefix, wanted) => {
  const inverse = new Map();
  for (let i = 0; i < 256; i++) inverse.set(CRC_TABLE[i] >>> 24, i);
  const idx = [];
  let t = (wanted ^ 0xffffffff) >>> 0;
  for (let i = 0; i < 4; i++) {
    const index = inverse.get(t >>> 24);
    idx.unshift(index);
    t = ((t ^ CRC_TABLE[index]) << 8) >>> 0;
  }
  let register = 0xffffffff;
  for (const byte of prefix) register = CRC_TABLE[(register ^ byte) & 0xff] ^ (register >>> 8);
  const tail = [];
  for (const index of idx) {
    tail.push((index ^ register) & 0xff);
    register = CRC_TABLE[index] ^ (register >>> 8);
  }
  const out = Uint8Array.from(tail);
  if (crc32(concat(prefix, out)) !== wanted) throw new Error("crc forge failed");
  return out;
};

/** PPF 3.0 (encoding 2) with undo data: header, then [offset u64le][len u8][new bytes][undo bytes] records. */
export const encodePpf3 = (source, target, { undo = true, description = "apply-matrix" } = {}) => {
  const header = new Uint8Array(60);
  header.set(ascii("PPF30"), 0);
  header[5] = 2;
  header.set(ascii(description).subarray(0, 50), 6);
  header[56] = 0; // image type: BIN
  header[57] = 0; // no block check
  header[58] = undo ? 1 : 0;
  const records = [];
  for (const [start, end] of diffRuns(source, target)) {
    for (let at = start; at < end; at += 255) {
      const stop = Math.min(end, at + 255);
      const offset = new Uint8Array(8);
      new DataView(offset.buffer).setBigUint64(0, BigInt(at), true);
      records.push(offset, Uint8Array.of(stop - at), target.subarray(at, stop));
      if (undo) records.push(source.subarray(at, stop));
    }
  }
  return concat(header, ...records);
};
