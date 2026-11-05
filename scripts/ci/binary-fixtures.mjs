const MACHINES = { i686: 3, x86_64: 62, aarch64: 183 };

// Minimal executable headers for tests; a real binary is not needed to check what a header says.

// A minimal ELF image: header, then one PT_INTERP program header and its string when `interpreter` is given.
export function elf({ arch, wide = true, interpreter = "" }) {
  const header = wide ? 64 : 52;
  const phentsize = wide ? 56 : 32;
  const phnum = interpreter ? 1 : 0;
  const bytes = Buffer.alloc(header + phentsize * phnum + (interpreter ? interpreter.length + 1 : 0));
  bytes.write("\x7fELF", 0, "latin1");
  bytes[4] = wide ? 2 : 1;
  bytes[5] = 1;
  bytes.writeUInt16LE(MACHINES[arch], 18);
  if (wide) {
    bytes.writeBigUInt64LE(BigInt(header), 32);
    bytes.writeUInt16LE(phentsize, 54);
    bytes.writeUInt16LE(phnum, 56);
  } else {
    bytes.writeUInt32LE(header, 28);
    bytes.writeUInt16LE(phentsize, 42);
    bytes.writeUInt16LE(phnum, 44);
  }
  if (interpreter) {
    const entry = header;
    const offset = header + phentsize;
    bytes.writeUInt32LE(3, entry);
    if (wide) {
      bytes.writeBigUInt64LE(BigInt(offset), entry + 8);
      bytes.writeBigUInt64LE(BigInt(interpreter.length + 1), entry + 32);
    } else {
      bytes.writeUInt32LE(offset, entry + 4);
      bytes.writeUInt32LE(interpreter.length + 1, entry + 16);
    }
    bytes.write(interpreter, offset, "latin1");
  }
  return bytes;
}

export function macho(cpu) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(cpu, 4);
  return bytes;
}

export function pe(machine) {
  const bytes = Buffer.alloc(0x100);
  bytes.write("MZ", 0, "latin1");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x00004550, 0x80);
  bytes.writeUInt16LE(machine, 0x84);
  return bytes;
}
