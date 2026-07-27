import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";

const HEADER_SIZE = 16;
const PRG_SIZE = 16 * 1024;
const CHR_SIZE = 8 * 1024;
const CPU_BASE = 0x8000;
const MESSAGE_LENGTH = 14;

const invariant = (condition, message) => {
  if (!condition) throw new Error(message);
};

const FONT = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
};

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

const crc32 = (bytes) => {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

const checksum = (algorithm, bytes) => crypto.createHash(algorithm).update(bytes).digest("hex");
const checksums = (bytes) => ({
  crc32: crc32(bytes).toString(16).padStart(8, "0"),
  md5: checksum("md5", bytes),
  sha1: checksum("sha1", bytes),
});
const tileForCharacter = (character) => (character === " " ? 0 : character.charCodeAt(0) - 64);

const createChr = () => {
  const chr = Buffer.alloc(CHR_SIZE);
  for (const [character, rows] of Object.entries(FONT)) {
    const tileOffset = tileForCharacter(character) * 16;
    rows.forEach((row, index) => {
      chr[tileOffset + index] = Number.parseInt(row, 2) << 2;
    });
  }
  return chr;
};

const createPrg = (message) => {
  invariant(message.length === MESSAGE_LENGTH, `message must be ${MESSAGE_LENGTH} characters`);
  invariant(/^[ A-Z]+$/.test(message), "message must contain only spaces and uppercase ASCII letters");

  const bytes = [];
  const labels = new Map();
  const fixups = [];
  const emit = (...values) => bytes.push(...values);
  const label = (name) => labels.set(name, bytes.length);
  const absolute = (opcode, name) => {
    emit(opcode, 0, 0);
    fixups.push({ index: bytes.length - 2, kind: "absolute", name });
  };
  const relative = (opcode, name) => {
    emit(opcode, 0);
    fixups.push({ index: bytes.length - 1, kind: "relative", name });
  };
  const setPpuAddress = (high, low) => {
    emit(0xa9, high, 0x8d, 0x06, 0x20, 0xa9, low, 0x8d, 0x06, 0x20);
  };

  label("reset");
  emit(
    0x78, // SEI
    0xd8, // CLD
    0xa2,
    0x40, // LDX #$40
    0x8e,
    0x17,
    0x40, // STX $4017
    0xa2,
    0xff, // LDX #$ff
    0x9a, // TXS
    0xe8, // INX
    0x8e,
    0x00,
    0x20, // STX $2000
    0x8e,
    0x01,
    0x20, // STX $2001
    0x8e,
    0x10,
    0x40, // STX $4010
  );

  label("first-vblank");
  emit(0x2c, 0x02, 0x20); // BIT $2002
  relative(0x10, "first-vblank"); // BPL
  label("second-vblank");
  emit(0x2c, 0x02, 0x20); // BIT $2002
  relative(0x10, "second-vblank"); // BPL

  setPpuAddress(0x3f, 0x00);
  emit(0xa2, 0x00); // LDX #0
  label("write-palette");
  absolute(0xbd, "palette"); // LDA palette,X
  emit(0x8d, 0x07, 0x20, 0xe8, 0xe0, 0x20); // STA $2007; INX; CPX #32
  relative(0xd0, "write-palette"); // BNE

  setPpuAddress(0x20, 0x00);
  emit(0xa9, 0x00, 0xa2, 0x04, 0xa0, 0x00); // LDA #0; LDX #4; LDY #0
  label("clear-nametable");
  emit(0x8d, 0x07, 0x20, 0x88); // STA $2007; DEY
  relative(0xd0, "clear-nametable"); // BNE
  emit(0xca); // DEX
  relative(0xd0, "clear-nametable"); // BNE

  setPpuAddress(0x21, 0xc9);
  emit(0xa2, 0x00); // LDX #0
  label("write-message");
  absolute(0xbd, "message"); // LDA message,X
  emit(0x8d, 0x07, 0x20, 0xe8, 0xe0, MESSAGE_LENGTH); // STA $2007; INX; CPX #14
  relative(0xd0, "write-message"); // BNE

  emit(
    0xa9,
    0x00, // LDA #0
    0x8d,
    0x05,
    0x20, // STA $2005
    0x8d,
    0x05,
    0x20, // STA $2005
    0xa9,
    0x0a, // LDA #%00001010
    0x8d,
    0x01,
    0x20, // STA $2001
  );
  label("forever");
  absolute(0x4c, "forever"); // JMP forever

  label("nmi");
  emit(0x40); // RTI
  label("irq");
  emit(0x40); // RTI
  label("palette");
  emit(0x0f, 0x30, 0x21, 0x11, ...Array(28).fill(0x0f));
  label("message");
  const messageOffset = bytes.length;
  emit(...[...message].map(tileForCharacter));

  for (const { index, kind, name } of fixups) {
    const target = CPU_BASE + labels.get(name);
    if (kind === "absolute") {
      bytes[index] = target & 0xff;
      bytes[index + 1] = target >> 8;
      continue;
    }
    const delta = target - (CPU_BASE + index + 1);
    invariant(delta >= -128 && delta <= 127, `branch to ${name} is out of range`);
    bytes[index] = delta & 0xff;
  }

  const prg = Buffer.alloc(PRG_SIZE, 0xea);
  Buffer.from(bytes).copy(prg);
  prg.writeUInt16LE(CPU_BASE + labels.get("nmi"), 0x3ffa);
  prg.writeUInt16LE(CPU_BASE + labels.get("reset"), 0x3ffc);
  prg.writeUInt16LE(CPU_BASE + labels.get("irq"), 0x3ffe);
  return { messageOffset, prg };
};

const createRom = (message) => {
  const header = Buffer.from([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const { messageOffset, prg } = createPrg(message);
  return { messageOffset: HEADER_SIZE + messageOffset, rom: Buffer.concat([header, prg, createChr()]) };
};

const createIpsPatch = (original, modified) => {
  const firstDifference = original.findIndex((byte, index) => byte !== modified[index]);
  invariant(firstDifference !== -1, "original and modified ROMs must differ");
  let end = firstDifference + 1;
  while (end < original.length && original[end] !== modified[end]) end += 1;
  invariant(original.subarray(end).equals(modified.subarray(end)), "ROM changes must form one contiguous range");
  const record = Buffer.alloc(5);
  record.writeUIntBE(firstDifference, 0, 3);
  record.writeUInt16BE(end - firstDifference, 3);
  return Buffer.concat([Buffer.from("PATCH"), record, modified.subarray(firstDifference, end), Buffer.from("EOF")]);
};

const createZip = (entries) => {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, source] of entries) {
    const nameBytes = Buffer.from(name);
    const compressed = zlib.deflateRawSync(source, { level: 9 });
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc32(source), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(source.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    localParts.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc32(source), 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(source.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
};

const createFirstSampleAssets = () => {
  const original = createRom(" HELLO WORLD  ");
  const modified = createRom("MODIFIED WORLD");
  invariant(original.rom.length === HEADER_SIZE + PRG_SIZE + CHR_SIZE, "ROM has an unexpected size");
  invariant(original.messageOffset === modified.messageOffset, "message offsets must match");
  const changedOffsets = Array.from(original.rom.keys()).filter((index) => original.rom[index] !== modified.rom[index]);
  invariant(
    changedOffsets.length === MESSAGE_LENGTH &&
      changedOffsets.every((offset, index) => offset === original.messageOffset + index),
    "only the message bytes may differ",
  );

  const patch = createIpsPatch(original.rom, modified.rom);
  const manifest = Buffer.from(
    `${JSON.stringify(
      {
        version: 1,
        rom: {
          path: "hello-world.nes",
          checks: { checksums: checksums(original.rom), size: original.rom.length },
        },
        patches: [
          {
            name: "Hello to modified world",
            description: "Changes the message displayed by the NES ROM.",
            path: "first-weave.ips",
          },
        ],
        output: { name: "modified-world.nes", checks: { checksums: checksums(modified.rom) } },
      },
      null,
      2,
    )}\n`,
  );

  return {
    firstCreateZip: createZip([
      ["hello-world.nes", original.rom],
      ["modified-world.nes", modified.rom],
    ]),
    firstWeaveZip: createZip([
      ["rom-weaver-bundle.json", manifest],
      ["hello-world.nes", original.rom],
      ["first-weave.ips", patch],
    ]),
    modifiedRom: modified.rom,
    originalRom: original.rom,
    patch,
  };
};

const writeFirstSampleAssets = (outputDirectory = path.resolve("dist")) => {
  const assets = createFirstSampleAssets();
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const [name, source] of [
    ["first-create.zip", assets.firstCreateZip],
    ["first-weave.zip", assets.firstWeaveZip],
    ["hello-world.nes", assets.originalRom],
    ["modified-world.nes", assets.modifiedRom],
  ]) {
    fs.writeFileSync(path.join(outputDirectory, name), source);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFirstSampleAssets(path.resolve(process.argv[2] ?? "dist"));
}

export { createFirstSampleAssets, writeFirstSampleAssets };
