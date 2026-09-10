import { expect, test } from "vitest";
import { assertRunJsonSucceeded, readGuestFile, withTempFixture } from "./test-helpers.mjs";

const SIGNATURE = 0x08012025;

const writeU16 = (bytes, offset, value) => {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
};

const writeU32 = (bytes, offset, value) => {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
};

const sectionOffset = (slot, id) => slot * 0xe000 + ((id + 1) % 14) * 0x1000;

const checksum = (bytes, offset, size) => {
  let sum = 0;
  for (let index = 0; index < size; index += 4) {
    const word =
      (bytes[offset + index] |
        (bytes[offset + index + 1] << 8) |
        (bytes[offset + index + 2] << 16) |
        (bytes[offset + index + 3] << 24)) >>>
      0;
    sum = (sum + word) >>> 0;
  }
  return ((sum & 0xffff) + (sum >>> 16)) & 0xffff;
};

const emeraldFixture = () => {
  const bytes = new Uint8Array(0x20000);
  for (const [slot, counter] of [
    [0, 8],
    [1, 7],
  ]) {
    for (let id = 0; id < 14; id += 1) {
      const offset = sectionOffset(slot, id);
      writeU16(bytes, offset + 0xff4, id);
      writeU32(bytes, offset + 0xff8, SIGNATURE);
      writeU32(bytes, offset + 0xffc, counter);
    }
    const small = sectionOffset(slot, 0);
    bytes.set([0xcc, 0xbf, 0xbe, 0xff, 0xff, 0xff, 0xff], small);
    bytes.set([0x39, 0x30, 0x31, 0xd4], small + 10);
    bytes.set([32, 0, 14, 22, 3], small + 14);
    writeU32(bytes, small + 0xac, 0x12345678);
    writeU32(bytes, sectionOffset(slot, 1) + 0x490, (5_000 ^ 0x12345678) >>> 0);
    bytes[sectionOffset(slot, 4) + 0xef0] = 0x42;
    for (let id = 0; id < 14; id += 1) {
      const size = id === 0 ? 0xf2c : id === 4 ? 0xf08 : id === 13 ? 0x7d0 : 0xf80;
      const offset = sectionOffset(slot, id);
      writeU16(bytes, offset + 0xff6, checksum(bytes, offset, size));
    }
  }
  return bytes;
};

const alttpFixture = () => {
  const fileSize = 0x500;
  const bytes = new Uint8Array(0x2000);
  for (let slot = 0; slot < 3; slot += 1) {
    const offset = slot * fileSize;
    writeU16(bytes, offset + 0x3e5, 0x55aa);
    writeU16(bytes, offset + 0x360, 123);
    writeU16(bytes, offset + 0x362, 123);
    bytes[offset + 0x36c] = 24;
    bytes[offset + 0x36d] = 24;
    let checksum = 0x5a5a;
    for (let index = 0; index < 0x4fe; index += 2) {
      const word = bytes[offset + index] | (bytes[offset + index + 1] << 8);
      checksum = (checksum - word) & 0xffff;
    }
    writeU16(bytes, offset + 0x4fe, checksum);
    bytes.copyWithin(0xf00 + offset, offset, offset + fileSize);
  }
  return bytes;
};

test("the real WASM command path identifies and edits an Emerald save", async () => {
  const original = emeraldFixture();
  await withTempFixture(
    async ({ opfsHandle, sourcePath, worker }) => {
      const identify = await worker.runJson({
        args: { args: { input: sourcePath }, type: "identify" },
        type: "save",
      });
      const identifyEvent = assertRunJsonSucceeded(identify, { command: "save-identify" });
      expect(identifyEvent.details.save_editor.document.identity.id).toBe("pokemon-emerald");
      expect(identifyEvent.details.save_editor.document.integrity.state).toBe("valid");

      const preview = await worker.runJson({
        args: {
          args: {
            assignments: ["trainer.money=999999", "trainer.name=ASH"],
            dry_run: true,
            game: "pokemon-emerald",
            input: sourcePath,
          },
          type: "set",
        },
        type: "save",
      });
      const previewEvent = assertRunJsonSucceeded(preview, { command: "save-set" });
      expect(previewEvent.details.save_editor.result.preview.output_valid).toBe(true);

      const outputPath = "/work/emerald-edited.sav";
      const edit = await worker.runJson({
        args: {
          args: {
            assignments: ["trainer.money=999999", "trainer.name=ASH"],
            game: "pokemon-emerald",
            input: sourcePath,
            output: outputPath,
          },
          type: "set",
        },
        type: "save",
      });
      const editEvent = assertRunJsonSucceeded(edit, { command: "save-set" });
      expect(editEvent.details.save_editor.output).toBe(outputPath);
      expect(await Array.fromAsync(opfsHandle.keys())).toContain("emerald-edited.sav");
      const edited = await readGuestFile(opfsHandle, outputPath);
      expect(edited.byteLength).toBe(original.byteLength);
      expect(edited.slice(0xe000, 0x1c000)).toEqual(original.slice(0xe000, 0x1c000));

      const get = await worker.runJson({
        args: {
          args: { field: "trainer.money", game: "pokemon-emerald", input: outputPath },
          type: "get",
        },
        type: "save",
      });
      const getEvent = assertRunJsonSucceeded(get, { command: "save-get" });
      expect(getEvent.label).toBe("999999");
    },
    { sourceContents: original, sourceFileName: "emerald.sav" },
  );
});

test("the real WASM command path edits a Zelda SRAM file", async () => {
  const original = alttpFixture();
  await withTempFixture(
    async ({ opfsHandle, sourcePath, worker }) => {
      const identify = await worker.runJson({
        args: { args: { input: sourcePath }, type: "identify" },
        type: "save",
      });
      const identifyEvent = assertRunJsonSucceeded(identify, { command: "save-identify" });
      expect(identifyEvent.details.save_editor.document.identity.id).toBe("zelda-a-link-to-the-past");

      const outputPath = "/work/zelda-edited.srm";
      const edit = await worker.runJson({
        args: {
          args: {
            assignments: ["slot_2.resources.rupees=999"],
            input: sourcePath,
            output: outputPath,
          },
          type: "set",
        },
        type: "save",
      });
      assertRunJsonSucceeded(edit, { command: "save-set" });
      const edited = await readGuestFile(opfsHandle, outputPath);
      expect(edited.byteLength).toBe(original.byteLength);
      expect(edited.slice(0, 0x500)).toEqual(original.slice(0, 0x500));

      const get = await worker.runJson({
        args: {
          args: { field: "slot_2.resources.rupees", input: outputPath },
          type: "get",
        },
        type: "save",
      });
      const getEvent = assertRunJsonSucceeded(get, { command: "save-get" });
      expect(getEvent.label).toBe("999");
    },
    { sourceContents: original, sourceFileName: "zelda.srm" },
  );
});
