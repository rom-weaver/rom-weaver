import { expect, test } from "vitest";
import { assertRunJsonSucceeded, readGuestFile, withTempFixture, writeGuestFile } from "./test-helpers.mjs";

const SIGNATURE = 0x08012025;
const TEST_SCHEMA_PACK = {
  games: [
    {
      checksums: [{ algorithm: "sum8", length: 63, offset: 63, start: 0, target: 255 }],
      fields: [{ id: "player.coins", label: "Coins", offset: 4, type: "u16_le" }],
      generation: {
        fill: 0,
        patches: [
          { bytes: [82, 87], offset: 0 },
          { bytes: [77], offset: 20 },
        ],
      },
      id: "test-schema-game",
      mirrors: [],
      name: "Test schema game",
      platform: "custom",
      save_size: 64,
      signatures: [{ bytes: [82, 87], offset: 0 }],
    },
  ],
  schema_version: 1,
};

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

const pokemonGen1Fixture = () => {
  const bytes = new Uint8Array(0x8000);
  bytes.set([0x80, 0x81, 0x82, 0x50], 0x2598);
  bytes.set([0x86, 0x80, 0x93, 0x50], 0x25f6);
  bytes.set([0x01, 0x23, 0x45], 0x25f3);
  bytes.set([0x06, 0x78], 0x2850);
  bytes[0x2601] = 3;
  bytes[0x25ca] = 0xff;
  bytes[0x27e7] = 0xff;
  bytes[0x7000] = 0xa5;
  let sum = 0;
  for (let offset = 0x2598; offset < 0x3523; offset += 1) sum = (sum + bytes[offset]) & 0xff;
  bytes[0x3523] = ~sum & 0xff;
  return bytes;
};

test("the real WASM command path creates and edits a save from a local schema pack", async () => {
  await withTempFixture(async ({ opfsHandle, worker }) => {
    const schemaPath = "/work/test-schema.json";
    await writeGuestFile(opfsHandle, schemaPath, new TextEncoder().encode(JSON.stringify(TEST_SCHEMA_PACK)));
    const createdPath = "/work/schema-created.sav";
    const create = await worker.runJson({
      args: {
        args: {
          assignments: ["player.coins=65535"],
          game: "test-schema-game",
          output: createdPath,
          schema: schemaPath,
        },
        type: "create",
      },
      type: "save",
    });
    assertRunJsonSucceeded(create, { command: "save-create" });
    const created = await readGuestFile(opfsHandle, createdPath);
    expect(created.byteLength).toBe(64);
    expect(Array.from(created.slice(0, 6))).toEqual([82, 87, 0, 0, 255, 255]);
    expect(created.reduce((sum, byte) => (sum + byte) & 0xff, 0)).toBe(255);

    const editedPath = "/work/schema-edited.sav";
    const edit = await worker.runJson({
      args: {
        args: {
          assignments: ["player.coins=0"],
          game: "test-schema-game",
          input: createdPath,
          output: editedPath,
          schema: schemaPath,
        },
        type: "set",
      },
      type: "save",
    });
    assertRunJsonSucceeded(edit, { command: "save-set" });
    const edited = await readGuestFile(opfsHandle, editedPath);
    expect(Array.from(edited.slice(4, 6))).toEqual([0, 0]);
    expect(edited[20]).toBe(77);
    expect(edited.reduce((sum, byte) => (sum + byte) & 0xff, 0)).toBe(255);
  });
});

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

test("the real WASM command path identifies and edits an English Red save", async () => {
  const original = pokemonGen1Fixture();
  await withTempFixture(
    async ({ opfsHandle, sourcePath, worker }) => {
      const identify = await worker.runJson({
        args: { args: { game: "pokemon-red", input: sourcePath }, type: "identify" },
        type: "save",
      });
      const identifyEvent = assertRunJsonSucceeded(identify, { command: "save-identify" });
      expect(identifyEvent.details.save_editor.document.identity.id).toBe("pokemon-red");

      const outputPath = "/work/red-edited.sav";
      const edit = await worker.runJson({
        args: {
          args: {
            assignments: ["trainer.money=999999", "progress.badge_8=true"],
            game: "pokemon-red",
            input: sourcePath,
            output: outputPath,
          },
          type: "set",
        },
        type: "save",
      });
      assertRunJsonSucceeded(edit, { command: "save-set" });
      const edited = await readGuestFile(opfsHandle, outputPath);
      expect(edited[0x7000]).toBe(0xa5);
      let sum = 0;
      for (let offset = 0x2598; offset < 0x3523; offset += 1) sum = (sum + edited[offset]) & 0xff;
      expect(edited[0x3523]).toBe(~sum & 0xff);
      const get = await worker.runJson({
        args: {
          args: { field: "trainer.money", game: "pokemon-red", input: outputPath },
          type: "get",
        },
        type: "save",
      });
      const getEvent = assertRunJsonSucceeded(get, { command: "save-get" });
      expect(getEvent.label).toBe("999999");
    },
    { sourceContents: original, sourceFileName: "red.sav" },
  );
});

test("the real WASM command path creates and edits a fresh Zelda save", async () => {
  await withTempFixture(async ({ opfsHandle, worker }) => {
    const outputPath = "/work/operations/save-editor-test/zelda-created.srm";
    const created = await worker.runJson({
      args: {
        args: { game: "zelda-a-link-to-the-past", output: outputPath },
        type: "create",
      },
      type: "save",
    });
    const createdEvent = assertRunJsonSucceeded(created, { command: "save-create" });
    expect(createdEvent.details.save_editor.result.document.identity.id).toBe("zelda-a-link-to-the-past");
    expect((await readGuestFile(opfsHandle, outputPath)).byteLength).toBe(0x2000);

    const editedPath = "/work/zelda-created-edited.srm";
    const edited = await worker.runJson({
      args: {
        args: {
          assignments: ["slot_1.resources.rupees=999"],
          game: "zelda-a-link-to-the-past",
          output: editedPath,
        },
        type: "create",
      },
      type: "save",
    });
    assertRunJsonSucceeded(edited, { command: "save-create" });
    const dryPath = "/work/zelda-dry-run.srm";
    const preview = await worker.runJson({
      args: {
        args: {
          assignments: ["slot_1.resources.rupees=999"],
          dry_run: true,
          game: "zelda-a-link-to-the-past",
          output: dryPath,
        },
        type: "create",
      },
      type: "save",
    });
    const previewEvent = assertRunJsonSucceeded(preview, { command: "save-create" });
    expect(previewEvent.stage).toBe("preview");
    expect(Array.from(await opfsHandle.keys())).not.toContain("zelda-dry-run.srm");
  });
});

test("the real WASM command path creates and edits Super Mario World SRAM", async () => {
  await withTempFixture(async ({ opfsHandle, worker }) => {
    const sourcePath = "/work/mario-created.srm";
    const created = await worker.runJson({
      args: { args: { game: "super-mario-world", output: sourcePath }, type: "create" },
      type: "save",
    });
    const event = assertRunJsonSucceeded(created, { command: "save-create" });
    expect(event.details.save_editor.result.document.identity.id).toBe("super-mario-world");
    const source = new Uint8Array(await readGuestFile(opfsHandle, sourcePath));
    expect(source.byteLength).toBe(2048);
    const outputPath = "/work/mario-edited.srm";
    const edited = await worker.runJson({
      args: {
        args: {
          assignments: ["slot_1.progress.exits_completed=96", "slot_1.events.event_000=true"],
          input: sourcePath,
          output: outputPath,
        },
        type: "set",
      },
      type: "save",
    });
    assertRunJsonSucceeded(edited, { command: "save-set" });
    const output = new Uint8Array(await readGuestFile(opfsHandle, outputPath));
    expect(output[140]).toBe(96);
    expect(output[96]).toBe(0x80);
    expect(output.slice(0, 143)).toEqual(output.slice(429, 572));
    expect(new Uint8Array(await readGuestFile(opfsHandle, sourcePath))).toEqual(source);
  });
});
