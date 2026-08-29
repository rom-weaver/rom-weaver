import { describe, expect, it } from "vitest";
import { createRomWeaverCommand } from "../../src/wasm/rom-weaver-command.ts";
import { assertRunJsonSucceeded, joinGuestPath, withTempFixture, writeGuestFile } from "./test-helpers.mjs";

const encoder = new TextEncoder();

const u16 = (value) => new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
const u32 = (value) =>
  new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
const u64 = (value) => new Uint8Array([...u32(value), 0, 0, 0, 0]);
const uvar = (value) => {
  const bytes = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return new Uint8Array(bytes);
};

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

const variableTable = (magic, count, ...records) =>
  concat(encoder.encode(magic), new Uint8Array([1]), uvar(count), ...records);

const identifyPack = () => {
  const strings = variableTable(
    "RWS4",
    4,
    uvar(27),
    encoder.encode("Hello World (WASM Test) [!]"),
    uvar(11),
    encoder.encode("Test System"),
    uvar(9),
    encoder.encode("full_file"),
    uvar(8),
    encoder.encode("game.bin"),
  );
  const hashes = variableTable(
    "RWH4",
    1,
    u32(0),
    u32(7),
    uvar(5),
    new Uint8Array([0, 1]),
    new Uint8Array([0x36, 0x10, 0xa6, 0x86]),
  );
  const components = variableTable("RWC4", 1, uvar(0), uvar(3), uvar(0), uvar(0), uvar(0), new Uint8Array([0, 3]));
  const games = variableTable(
    "RWG4",
    1,
    uvar(0),
    uvar(1),
    uvar(0),
    uvar(0),
    uvar(0),
    uvar(0),
    uvar(0),
    uvar(1),
    uvar(0),
    uvar(0),
    uvar(0),
    new Uint8Array([0, 7, 0]),
  );
  const members = [
    ["strings.bin", strings],
    ["hashes.bin", hashes],
    ["components.bin", components],
    ["games.bin", games],
    ["owners.bin", concat(encoder.encode("RWO4"), new Uint8Array([1]), uvar(1), uvar(1), uvar(0), uvar(1), uvar(0))],
    ["routes.bin", concat(encoder.encode("RWR4"), new Uint8Array([1]), uvar(1), uvar(0))],
    [
      "sets.bin",
      concat(
        encoder.encode("RWX4"),
        new Uint8Array([1]),
        uvar(1),
        uvar(0),
        uvar(1),
        uvar(0),
        uvar(0),
        uvar(0),
        uvar(0),
        uvar(0),
      ),
    ],
    [
      "manifest.json",
      encoder.encode(
        JSON.stringify({
          format: "rom-weaver-identify-system-pack-v4",
          platform: "Test System",
          source: "libretro",
          canonicalizationProfile: "libretro-clrmamepro-v1",
          canonicalizationVersion: 1,
          provenance: [],
          counts: { games: 1, components: 1, hashes: 1, routedKeys: 1, sharedComponents: 0 },
        }),
      ),
    ],
  ];
  const directory = members.map(([name, bytes]) =>
    concat(u16(name.length), u64(bytes.byteLength), encoder.encode(name)),
  );
  return concat(encoder.encode("RWFP4\0\0\0"), u32(members.length), ...directory, ...members.map(([, bytes]) => bytes));
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

  it("matches a checksum without a source file", async () => {
    await withTempFixture(
      async ({ dir, opfsHandle, worker }) => {
        const databasePath = joinGuestPath(dir, "test.pack");
        await writeGuestFile(opfsHandle, databasePath, identifyPack());

        const result = await worker.runJson(
          createRomWeaverCommand("identify", {
            database: [databasePath],
            hash: "3610a686",
          }),
        );
        const terminal = assertRunJsonSucceeded(result, { command: "identify" });

        expect(terminal.details.identify.status).toBe("matched");
        expect(terminal.details.identify.matches).toEqual([
          expect.objectContaining({
            algorithm: "crc32",
            name: "Hello World (WASM Test) [!]",
            platform: "Test System",
            variant: "manual",
          }),
        ]);
      },
      {
        prefix: "rom-weaver-identify-hash-",
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
