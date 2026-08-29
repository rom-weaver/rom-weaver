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

const identifyPack = () => {
  const hashes = concat(
    encoder.encode("RWH5"),
    new Uint8Array([1, 1, 5, 0, 7, 0x36, 0x10, 0xa6, 0x86]),
    new Uint8Array([
      0x5d, 0x41, 0x40, 0x2a, 0xbc, 0x4b, 0x2a, 0x76, 0xb9, 0x71, 0x9d, 0x91, 0x10, 0x17, 0xc5, 0x92, 0xaa, 0xf4, 0xc6,
      0x1d, 0xdc, 0xc5, 0xe8, 0xa2, 0xda, 0xbe, 0xde, 0x0f, 0x3b, 0x48, 0x2c, 0xd9, 0xae, 0xa9, 0x43, 0x4d,
    ]),
  );
  const name = encoder.encode("Hello World (WASM Test) [!]");
  const scope = encoder.encode("full_file");
  const members = [
    [
      "strings.bin",
      concat(encoder.encode("RWS5"), new Uint8Array([1, 2, name.length]), name, new Uint8Array([scope.length]), scope),
    ],
    ["hashes.bin", hashes],
    ["components.bin", concat(encoder.encode("RWC5"), new Uint8Array([1, 1, 0, 0, 0, 3]))],
    ["games.bin", concat(encoder.encode("RWG5"), new Uint8Array([1, 1, 0, 0, 1, 0, 0]))],
    ["owners.bin", concat(encoder.encode("RWO5"), new Uint8Array([1, 1, 1, 0]))],
    ["routes.bin", concat(encoder.encode("RWR5"), new Uint8Array([1, 1, 0]))],
    ["sets.bin", concat(encoder.encode("RWX5"), new Uint8Array([1, 1, 0, 1, 0]))],
    [
      "manifest.json",
      encoder.encode(
        '{"format":"rom-weaver-identify-system-pack-v5","platform":"Test System","source":"libretro","canonicalizationProfile":"full_file","canonicalizationVersion":1,"provenance":[]}',
      ),
    ],
  ];
  const directory = members.map(([name, bytes]) =>
    concat(u16(name.length), u64(bytes.byteLength), encoder.encode(name)),
  );
  return concat(encoder.encode("RWFP5\0\0\0"), u32(members.length), ...directory, ...members.map(([, bytes]) => bytes));
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
            algorithm: "components",
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

  it("attaches a title during browser ingest", async () => {
    await withTempFixture(
      async ({ dir, opfsHandle, sourcePath, worker }) => {
        const databasePath = joinGuestPath(dir, "test.pack");
        await writeGuestFile(opfsHandle, databasePath, identifyPack());

        const result = await worker.runJson(
          createRomWeaverCommand("ingest", {
            database: [databasePath],
            input: sourcePath,
            output: joinGuestPath(dir, "output"),
          }),
        );
        const terminal = assertRunJsonSucceeded(result, { command: "ingest" });

        expect(terminal.details.ingest.assets[0].identification).toEqual({
          matches: [
            expect.objectContaining({
              algorithm: "components",
              name: "Hello World (WASM Test) [!]",
              variant: "raw",
            }),
          ],
          status: "matched",
        });
      },
      {
        prefix: "rom-weaver-ingest-identify-",
        sourceContents: "hello",
      },
    );
  });
});
