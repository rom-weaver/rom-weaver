import { afterEach, expect, it, vi } from "vitest";
import {
  deleteKeptRom,
  keepTestRom,
  listKeptRoms,
  readKeptRom as readKeptRomSource,
} from "../../src/storage/browser/kept-roms.ts";
import { requestKeptRomFile } from "../../src/storage/browser/kept-rom-files.ts";
import {
  startBrowserOpfsBootCleanup,
  resetBrowserTransientOpfs,
} from "../../src/storage/browser/browser-opfs-cleanup.ts";

const playbackSources = [];
const readKeptRom = async (gameId) => {
  const source = await readKeptRomSource(gameId);
  playbackSources.push(source);
  return source.file;
};

const gameId = "0123456789abcdef0123456789abcdef01234567";
const name = `${gameId}-11111111-1111-1111-1111-111111111111.rom`;

const putRecord = async (value) => {
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open("rom-weaver-kept-roms", 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    await new Promise((resolve, reject) => {
      const tx = database.transaction("roms", "readwrite");
      tx.objectStore("roms").put(value, gameId);
      tx.oncomplete = resolve;
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } finally {
    database.close();
  }
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(playbackSources.splice(0).map((source) => source.dispose()));
  await deleteKeptRom(gameId);
  await requestKeptRomFile({ action: "remove", name });
  await listKeptRoms();
});

it("keeps the original archive bytes under its playable save SHA-1 across fresh module reads", async () => {
  const bytes = new Uint8Array([80, 75, 3, 4, 0, 255]);
  const file = new File([bytes], "v1.2 #2; Pokémon.zip");
  await keepTestRom(gameId, file);
  expect(await listKeptRoms()).toContainEqual({ gameId, fileName: file.name, size: bytes.length, status: "ready" });
  const stored = await readKeptRom(gameId);
  expect(stored.name).toBe(file.name);
  expect(new Uint8Array(await stored.arrayBuffer())).toEqual(bytes);
});

it("keeps ROMs through boot and reset scratch sweeps", async () => {
  await keepTestRom(gameId, new File(["ROM"], "game.nes"));
  await startBrowserOpfsBootCleanup();
  await resetBrowserTransientOpfs();
  expect(await (await readKeptRom(gameId)).text()).toBe("ROM");
});

it("serializes two replacements without leaving unindexed files", async () => {
  await Promise.all([
    keepTestRom(gameId, new File(["first"], "game.zip")),
    keepTestRom(gameId, new File(["second"], "game.zip")),
  ]);
  expect(await (await readKeptRom(gameId)).text()).toBe("second");
  const files = await requestKeptRomFile({ action: "list" });
  expect(files.names).toHaveLength(1);
});

it("retains the previous complete ROM when the new index transaction aborts", async () => {
  await keepTestRom(gameId, new File(["original"], "game.nes"));
  const put = Object.getOwnPropertyDescriptor(IDBObjectStore.prototype, "put")?.value;
  if (!put) throw new Error("IndexedDB put is unavailable");
  const spy = vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (...args) {
    const result = put.apply(this, args);
    if (this.name === "roms") this.transaction.abort();
    return result;
  });
  await expect(keepTestRom(gameId, new File(["replacement"], "game.nes"))).rejects.toThrow();
  spy.mockRestore();
  expect(await (await readKeptRom(gameId)).text()).toBe("original");
  expect((await requestKeptRomFile({ action: "list" })).names).toHaveLength(1);
});

it("cleans interrupted unindexed files and reports missing indexed files", async () => {
  await requestKeptRomFile({ action: "write", name, blob: new Blob(["partial"]) });
  expect(await listKeptRoms()).toEqual([]);
  expect((await requestKeptRomFile({ action: "list" })).names).toEqual([]);
  await keepTestRom(gameId, new File(["ROM"], "game.nes"));
  const files = await requestKeptRomFile({ action: "list" });
  await requestKeptRomFile({ action: "remove", name: files.names[0] });
  expect(await listKeptRoms()).toContainEqual({ gameId, fileName: "game.nes", size: 3, status: "removed" });
  await expect(readKeptRom(gameId)).rejects.toThrow();
});

it("lists future versions as unreadable and preserves their files", async () => {
  await listKeptRoms();
  await requestKeptRomFile({ action: "write", name, blob: new Blob(["future"]) });
  await putRecord({ version: 999, fileName: "future.nes", gameId, storageName: name });
  expect(await listKeptRoms()).toContainEqual({ gameId, fileName: "future.nes", size: 0, status: "unreadable" });
  expect((await requestKeptRomFile({ action: "list" })).names).toEqual([name]);
  await expect(keepTestRom(gameId, new File(["new"], "game.nes"))).rejects.toThrow("can't be read");
});

it("rejects traversal and keeps chunk-boundary bytes complete", async () => {
  await expect(requestKeptRomFile({ action: "remove", name: "../work/output" })).rejects.toThrow("Invalid kept ROM");
  const bytes = new Uint8Array(4 * 1024 * 1024 + 1);
  bytes[0] = 1;
  bytes[bytes.length - 1] = 255;
  await keepTestRom(gameId, new File([bytes], "large.nes"));
  expect(new Uint8Array(await (await readKeptRom(gameId)).arrayBuffer())).toEqual(bytes);
});

it("keeps the active playback readable when its kept original is deleted", async () => {
  await keepTestRom(gameId, new File(["ROM"], "game.nes"));
  const source = await readKeptRomSource(gameId);
  playbackSources.push(source);
  await deleteKeptRom(gameId);
  expect(await source.file.text()).toBe("ROM");
  expect(await listKeptRoms()).toEqual([]);
});

it("cancels a queued replay without changing the kept original", async () => {
  await keepTestRom(gameId, new File(["ROM"], "game.nes"));
  let unlock;
  let acquired;
  const gate = new Promise((resolve) => {
    unlock = resolve;
  });
  const locked = new Promise((resolve) => {
    acquired = resolve;
  });
  const holder = navigator.locks.request("rom-weaver-kept-roms", async () => {
    acquired();
    await gate;
  });
  await locked;
  try {
    const controller = new AbortController();
    const cancelled = readKeptRomSource(gameId, controller.signal).catch((error) => error);
    await expect
      .poll(async () => (await navigator.locks.query()).pending.some((lock) => lock.name === "rom-weaver-kept-roms"))
      .toBe(true);
    controller.abort();
    expect((await cancelled).name).toBe("AbortError");
  } finally {
    unlock();
    await holder;
  }
  expect(await (await readKeptRom(gameId)).text()).toBe("ROM");
});
