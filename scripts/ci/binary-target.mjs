// Identifies which platform an executable was built for from its file header alone, so a binary
// that CI built can be checked against the target the release expects without running it (the
// release job for a Windows or arm64 target may not be able to).

import { closeSync, openSync, readSync } from "node:fs";

const HEADER_BYTES = 64 * 1024;

const ELF_MACHINES = new Map([
  [3, "i686"],
  [62, "x86_64"],
  [183, "aarch64"],
]);
const MACHO_CPUS = new Map([
  [0x01000007, "x86_64"],
  [0x0100000c, "aarch64"],
]);
const PE_MACHINES = new Map([
  [0x014c, "i686"],
  [0x8664, "x86_64"],
  [0xaa64, "aarch64"],
]);

function describeElf(view, bytes) {
  const wide = bytes[4] === 2;
  const little = bytes[5] === 1;
  if (!little || (bytes[4] !== 1 && !wide)) return null;
  const arch = ELF_MACHINES.get(view.getUint16(18, true));
  const phoff = wide ? Number(view.getBigUint64(32, true)) : view.getUint32(28, true);
  const phentsize = view.getUint16(wide ? 54 : 42, true);
  const phnum = view.getUint16(wide ? 56 : 44, true);
  let interpreter = "";
  for (let index = 0; index < phnum; index += 1) {
    const entry = phoff + index * phentsize;
    if (entry + phentsize > bytes.length || view.getUint32(entry, true) !== 3) continue;
    const offset = wide ? Number(view.getBigUint64(entry + 8, true)) : view.getUint32(entry + 4, true);
    const size = wide ? Number(view.getBigUint64(entry + 32, true)) : view.getUint32(entry + 16, true);
    interpreter = Buffer.from(bytes.subarray(offset, offset + size)).toString("latin1").replace(/\0.*$/su, "");
  }
  return { format: "elf", arch, libc: interpreter.includes("ld-linux") ? "gnu" : "musl", bits: wide ? 64 : 32 };
}

/** Returns `{ format, arch, libc? }` for an ELF, Mach-O, or PE header, or `null` when unrecognized. */
export function describeBinary(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 52 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46)
    return describeElf(view, bytes);
  // 64-bit little-endian Mach-O (0xfeedfacf); the release targets are never universal or 32-bit.
  if (bytes.length >= 8 && view.getUint32(0, true) === 0xfeedfacf)
    return { format: "macho", arch: MACHO_CPUS.get(view.getUint32(4, true)) };
  if (bytes.length >= 0x40 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const header = view.getUint32(0x3c, true);
    if (header + 6 <= bytes.length && view.getUint32(header, true) === 0x00004550)
      return { format: "pe", arch: PE_MACHINES.get(view.getUint16(header + 4, true)) };
  }
  return null;
}

/** What `describeBinary` must report for a rustc target triple, or `null` for one this does not know. */
export function expectedBinary(triple) {
  const parts = triple.split("-");
  const arch = parts[0];
  if (!["x86_64", "aarch64", "i686"].includes(arch)) return null;
  if (parts.includes("linux") && (parts.includes("gnu") || parts.includes("musl")))
    return { format: "elf", arch, libc: parts.includes("gnu") ? "gnu" : "musl" };
  if (parts.includes("darwin")) return { format: "macho", arch };
  if (parts.includes("windows")) return { format: "pe", arch };
  return null;
}

export function readHeader(path) {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    return buffer.subarray(0, readSync(descriptor, buffer, 0, HEADER_BYTES, 0));
  } finally {
    closeSync(descriptor);
  }
}

/** Throws unless the executable at `path` was built for the rustc target `triple`. */
export function assertBinaryTarget(path, triple) {
  const expected = expectedBinary(triple);
  if (!expected) throw new Error(`unknown target ${triple}`);
  const actual = describeBinary(readHeader(path));
  if (!actual) throw new Error(`${path} is not a recognized ELF, Mach-O, or PE executable`);
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key])
      throw new Error(`${path} was built for ${key} ${actual[key] ?? "unknown"}, not ${expected[key]} (${triple})`);
  }
}
