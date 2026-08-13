import { describe, expect, it } from "vitest";
import { createRomWeaverCommand } from "../../src/wasm/rom-weaver-command.ts";
import { assertRunJsonSucceeded, joinGuestPath, withTempFixture, writeGuestFile } from "./test-helpers.mjs";

const encoder = new TextEncoder();

const u16 = (value) => new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
const u32 = (value) =>
  new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
const u64 = (value) => new Uint8Array([...u32(value), 0, 0, 0, 0]);

const concat = (...parts) => {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
};

const hashMember = (algorithm, hash) =>
  concat(
    encoder.encode("RWH1"),
    new Uint8Array([algorithm, 0, hash.length, 0]),
    u32(1),
    u32(0),
    u32(0),
    hash,
    u32(0),
    u32(0),
  );

const identifyPack = () => {
  const members = [
    ["crc32.bin", hashMember(0, new Uint8Array([0x36, 0x10, 0xa6, 0x86]))],
    [
      "md5.bin",
      hashMember(
        1,
        new Uint8Array([
          0x5d, 0x41, 0x40, 0x2a, 0xbc, 0x4b, 0x2a, 0x76, 0xb9, 0x71, 0x9d, 0x91, 0x10, 0x17, 0xc5, 0x92,
        ]),
      ),
    ],
    [
      "sha1.bin",
      hashMember(
        2,
        new Uint8Array([
          0xaa, 0xf4, 0xc6, 0x1d, 0xdc, 0xc5, 0xe8, 0xa2, 0xda, 0xbe, 0xde, 0x0f, 0x3b, 0x48, 0x2c, 0xd9, 0xae, 0xa9,
          0x43, 0x4d,
        ]),
      ),
    ],
    ["name-platforms.bin", concat(encoder.encode("RWHP"), u16(1), u16(6), u32(0), u16(0))],
    ["names.json", encoder.encode('["Hello World (WASM Test) [!]"]')],
    ["platforms.json", encoder.encode('["Test System"]')],
  ];
  const directory = members.map(([name, bytes]) =>
    concat(u16(name.length), u64(bytes.byteLength), encoder.encode(name)),
  );
  return concat(encoder.encode("RWFP1\0\0\0"), u32(members.length), ...directory, ...members.map(([, bytes]) => bytes));
};

describe("ROM identify WASM command", () => {
  it("matches a ROM through a staged database pack", async () => {
    await withTempFixture(
      async ({ dir, opfsHandle, sourcePath, worker }) => {
        const databasePath = joinGuestPath(dir, "test.pack");
        await writeGuestFile(opfsHandle, databasePath, identifyPack());

        const result = await worker.runJson(
          createRomWeaverCommand("identify", {
            database: [databasePath],
            input: sourcePath,
          }),
        );
        const terminal = assertRunJsonSucceeded(result, { command: "identify" });

        expect(terminal.details.identify.status).toBe("matched");
        expect(terminal.details.identify.matches).toEqual([
          expect.objectContaining({
            algorithm: "crc32",
            name: "Hello World (WASM Test) [!]",
            platform: "Test System",
            variant: "raw",
          }),
        ]);
      },
      {
        prefix: "rom-weaver-identify-",
        sourceContents: "hello",
      },
    );
  });
});
