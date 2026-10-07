import { afterEach, expect, it, vi } from "vitest";
import {
  deleteEmulatorSave,
  ensureEmulatorSaveBridge,
  importEmulatorSavePart,
  listEmulatorSaves,
  writeEmulatorSave,
} from "../../src/storage/browser/emulator-saves.ts";

const sha1 = "0123456789abcdef0123456789abcdef01234567";
const original = {
  gameId: sha1,
  gameName: sha1,
  label: "Known ROM.nes",
  state: new Uint8Array([1]),
  sram: new Uint8Array([2]),
};
const readSave = async () => (await listEmulatorSaves()).find((record) => record.gameId === sha1);
const readSaveById = async (gameId) => (await listEmulatorSaves()).find((record) => record.gameId === gameId);

afterEach(async () => {
  vi.restoreAllMocks();
  await deleteEmulatorSave(sha1);
  for (const record of await listEmulatorSaves()) {
    if (record.gameId.startsWith(`${sha1}.chd`)) await deleteEmulatorSave(record.gameId);
  }
});

it("migrates CHD aliases atomically while concurrent imports retain both new save parts", async () => {
  await writeEmulatorSave({ ...original, gameId: `${sha1}.chd`, gameName: `${sha1}.chd`, updatedAt: 1 });
  await Promise.all([
    importEmulatorSavePart({ data: new Uint8Array([10, 11]), part: "state", sha1 }),
    importEmulatorSavePart({ data: new Uint8Array([20, 21]), part: "sram", sha1 }),
  ]);
  expect(await readSave()).toMatchObject({
    gameId: sha1,
    gameName: sha1,
    label: original.label,
    state: new Uint8Array([10, 11]),
    sram: new Uint8Array([20, 21]),
  });
  expect(await readSaveById(`${sha1}.chd`)).toBeUndefined();
});

it("preserves conflicting legacy CHD bytes without resurrecting a deleted canonical save", async () => {
  await writeEmulatorSave({ ...original, gameId: `${sha1}.chd`, gameName: `${sha1}.chd`, updatedAt: 1 });
  await writeEmulatorSave({ ...original, state: new Uint8Array([3]), updatedAt: 2 });
  expect(await readSave()).toMatchObject({ state: new Uint8Array([3]) });
  expect(await readSaveById(`${sha1}.chd-conflict`)).toMatchObject({
    gameName: `${sha1}.chd`,
    state: original.state,
    sram: original.sram,
  });
  await deleteEmulatorSave(sha1);
  expect(await readSave()).toBeUndefined();
});

it("atomically merges concurrent state and SRAM imports in real IndexedDB", async () => {
  await writeEmulatorSave({ ...original, updatedAt: 1 });
  await Promise.all([
    importEmulatorSavePart({ data: new Uint8Array([10, 11]), part: "state", sha1 }),
    importEmulatorSavePart({ data: new Uint8Array([20, 21]), part: "sram", sha1 }),
  ]);
  expect(await readSave()).toMatchObject({
    gameName: original.gameName,
    label: original.label,
    state: new Uint8Array([10, 11]),
    sram: new Uint8Array([20, 21]),
  });
});

it("rejects an aborted save transaction and retains both previously saved parts", async () => {
  await writeEmulatorSave({ ...original, updatedAt: 1 });
  const put = Reflect.get(IDBObjectStore.prototype, "put");
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(function (value, key) {
    const request = put.call(this, value, key);
    this.transaction.abort();
    return request;
  });
  await expect(importEmulatorSavePart({ data: new Uint8Array([10, 11]), part: "state", sha1 })).rejects.toThrow();
  expect(await readSave()).toMatchObject(original);
});

it("retains concurrent emulator bridge saves and their display metadata", async () => {
  await writeEmulatorSave({ ...original, updatedAt: 1 });
  ensureEmulatorSaveBridge();
  for (const [kind, data] of [
    ["save-state", new Uint8Array([30, 31])],
    ["save-sram", new Uint8Array([40, 41])],
  ]) {
    window.postMessage(
      {
        source: "rom-weaver-emulator",
        gameId: sha1,
        gameName: sha1,
        gameLabel: "Playing ROM.nes",
        kind,
        data,
      },
      "*",
    );
  }
  await expect.poll(readSave).toMatchObject({
    gameName: sha1,
    label: "Playing ROM.nes",
    state: new Uint8Array([30, 31]),
    sram: new Uint8Array([40, 41]),
  });
});
