import { afterEach, expect, it, vi } from "vitest";
import {
  deleteEmulatorSave,
  clearEmulatorSavePreview,
  setEmulatorSavePreview,
  registerEmulatorSaveBridge,
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

const players = [];
const createPlayer = async ({ opaque = false, gameId = sha1 } = {}) => {
  const frame = document.createElement("iframe");
  if (opaque) frame.setAttribute("sandbox", "allow-scripts");
  frame.srcdoc = `<script>
    window.addEventListener("message", (event) => {
      if (event.source !== parent) return;
      if (event.data.command === "send") parent.postMessage(event.data.message, "*");
      if (event.data.source === "rom-weaver-emulator") parent.postMessage({ reply: event.data }, "*");
    });
  </script>`;
  const loaded = new Promise((resolve) => frame.addEventListener("load", resolve, { once: true }));
  document.body.append(frame);
  await loaded;
  const replies = [];
  const onReply = (event) => {
    if (event.source === frame.contentWindow && event.data?.reply) replies.push(event.data.reply);
  };
  window.addEventListener("message", onReply);
  const unregister = registerEmulatorSaveBridge(frame, gameId);
  const player = {
    frame,
    replies,
    unregister,
    send: (kind, extra = {}) =>
      frame.contentWindow.postMessage(
        {
          command: "send",
          message: { source: "rom-weaver-emulator", gameId, gameName: gameId, kind, ...extra },
        },
        "*",
      ),
    dispose: () => {
      unregister();
      window.removeEventListener("message", onReply);
      frame.remove();
    },
  };
  players.push(player);
  return player;
};

afterEach(() => {
  for (const player of players.splice(0)) player.dispose();
  clearEmulatorSavePreview(sha1);
});

it("retains concurrent emulator bridge saves and their display metadata", async () => {
  await writeEmulatorSave({ ...original, updatedAt: 1 });
  const player = await createPlayer();
  player.send("save-state", { data: new Uint8Array([30, 31]), gameLabel: "Playing ROM.nes" });
  player.send("save-sram", { data: new Uint8Array([40, 41]), gameLabel: "Playing ROM.nes" });
  await expect.poll(readSave).toMatchObject({
    gameName: sha1,
    label: "Playing ROM.nes",
    state: new Uint8Array([30, 31]),
    sram: new Uint8Array([40, 41]),
  });
  player.send("request-load-state");
  player.send("request-load-sram");
  await expect.poll(() => player.replies.length).toBe(2);
  expect(player.replies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: "load-state", data: new Uint8Array([30, 31]) }),
      expect.objectContaining({ kind: "load-sram", data: new Uint8Array([40, 41]) }),
    ]),
  );
});

it("rejects other frames and games and revokes a stopped player's preview access", async () => {
  await writeEmulatorSave({ ...original, updatedAt: 1 });
  setEmulatorSavePreview(sha1, new Uint8Array([17, 42, 99]));
  const player = await createPlayer();
  const foreign = await createPlayer({ gameId: "b".repeat(40) });
  foreign.send("request-load-sram", { gameId: sha1 });
  foreign.send("save-state", { gameId: sha1, data: new Uint8Array([99]) });
  player.send("request-load-state", { gameId: "b".repeat(40) });
  player.send("request-load-sram");
  await expect.poll(() => player.replies.length).toBe(1);
  expect(player.replies[0].data).toEqual(new Uint8Array([17, 42, 99]));
  expect(foreign.replies).toEqual([]);
  expect(await readSave()).toMatchObject(original);
  player.unregister();
  player.send("request-load-sram");
  player.send("save-state", { data: new Uint8Array([99]) });
  const replacement = await createPlayer();
  replacement.send("request-load-sram");
  await expect.poll(() => replacement.replies.length).toBe(1);
  expect(player.replies).toHaveLength(1);
  expect(await readSave()).toMatchObject(original);
});

it("loads and saves through a registered opaque sandbox without trusting another opaque frame", async () => {
  await writeEmulatorSave({ ...original, updatedAt: 1 });
  const player = await createPlayer({ opaque: true });
  const foreign = await createPlayer({ opaque: true, gameId: "b".repeat(40) });
  foreign.send("request-load-sram", { gameId: sha1 });
  foreign.send("save-sram", { gameId: sha1, data: new Uint8Array([99]) });
  player.send("save-sram", { data: new Uint8Array([4, 5]) });
  await expect.poll(readSave).toMatchObject({ sram: new Uint8Array([4, 5]) });
  player.send("request-load-sram");
  await expect.poll(() => player.replies.length).toBe(1);
  expect(player.replies[0].data).toEqual(new Uint8Array([4, 5]));
  expect(foreign.replies).toEqual([]);
});
