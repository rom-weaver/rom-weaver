import { createLogger } from "../../lib/logging.ts";
import { createIdbObjectStore } from "./idb-object-store.ts";
import { requestKeptRomFile } from "./kept-rom-files.ts";
import { registerBrowserTransientOpfsPath, waitForBrowserOpfsBootCleanup } from "./browser-opfs-cleanup.ts";

const DATABASE_NAME = "rom-weaver-kept-roms";
const STORE_NAME = "roms";
const LOCK_NAME = "rom-weaver-kept-roms";
const logger = createLogger("kept-roms");
const SHA1 = /^[a-f0-9]{40}$/;
const STORAGE_NAME = /^[a-f0-9]{40}-[a-f0-9-]{36}\.rom$/;

type KeptRomRecord = {
  version: 1;
  gameId: string;
  fileName: string;
  size: number;
  storageName: string;
  updatedAt: number;
};

type KeptRom = {
  gameId: string;
  fileName: string;
  size: number;
  status: "ready" | "removed" | "unreadable";
};

type KeptRomPlayback = { file: File; dispose: () => Promise<void> };

const { open: openDatabase, transaction } = createIdbObjectStore(DATABASE_NAME, STORE_NAME, {
  blocked: "Kept ROM storage is upgrading. Close other rom-weaver tabs and try again.",
  unavailable: "Kept ROM storage is unavailable.",
  failed: "Kept ROM index update failed.",
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const isReadableRecord = (value: unknown): value is KeptRomRecord =>
  isRecord(value) &&
  value.version === 1 &&
  typeof value.gameId === "string" &&
  SHA1.test(value.gameId) &&
  typeof value.fileName === "string" &&
  value.fileName.length > 0 &&
  value.fileName.length <= 255 &&
  typeof value.size === "number" &&
  Number.isSafeInteger(value.size) &&
  value.size >= 0 &&
  typeof value.storageName === "string" &&
  STORAGE_NAME.test(value.storageName) &&
  value.storageName.startsWith(`${value.gameId}-`) &&
  typeof value.updatedAt === "number";

const withLock = <T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!globalThis.navigator?.locks) return Promise.reject(new Error("Kept ROM storage requires browser Web Locks."));
  return navigator.locks.request(LOCK_NAME, { signal }, action);
};

const readRecords = async (): Promise<Map<string, unknown>> => {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const keys = store.getAllKeys();
      const values = store.getAll();
      tx.oncomplete = () => resolve(new Map(keys.result.map((key, index) => [String(key), values.result[index]])));
      tx.onerror = tx.onabort = () => reject(tx.error || new Error("Could not read kept ROMs."));
    });
  } finally {
    database.close();
  }
};

const reconcile = async (): Promise<KeptRom[]> => {
  const records = await readRecords();
  const { names = [] } = await requestKeptRomFile({ action: "list" });
  const present = new Set(names);
  const referenced = new Set<string>();
  let unknownVersion = false;
  const roms: KeptRom[] = [];
  for (const [gameId, value] of records) {
    if (isRecord(value) && typeof value.storageName === "string") referenced.add(value.storageName);
    if (!isReadableRecord(value) || value.gameId !== gameId) {
      unknownVersion = true;
      roms.push({
        gameId,
        fileName: isRecord(value) && typeof value.fileName === "string" ? value.fileName : gameId,
        size: 0,
        status: "unreadable",
      });
      continue;
    }
    roms.push({
      gameId,
      fileName: value.fileName,
      size: value.size,
      status: present.has(value.storageName) ? "ready" : "removed",
    });
  }
  // Future records MAY reference files differently; an older app MUST preserve them.
  if (!unknownVersion) {
    for (const name of names) {
      if (!referenced.has(name)) await requestKeptRomFile({ action: "remove", name });
    }
  }
  return roms;
};

const listKeptRoms = (): Promise<KeptRom[]> => withLock(reconcile);

const keepTestRom = (gameId: string, file: File): Promise<void> =>
  withLock(async () => {
    if (!SHA1.test(gameId)) throw new Error("Keeping a ROM requires its save SHA-1.");
    const previous: unknown = await transaction("readonly", (store) => store.get(gameId));
    if (previous !== undefined && !isReadableRecord(previous))
      throw new Error("This kept ROM record can't be read by this app version.");
    const storageName = `${gameId}-${crypto.randomUUID()}.rom`;
    try {
      await requestKeptRomFile({ action: "write", name: storageName, blob: file });
      const record: KeptRomRecord = {
        version: 1,
        gameId,
        fileName: file.name.slice(0, 255),
        size: file.size,
        storageName,
        updatedAt: Date.now(),
      };
      await transaction("readwrite", (store) => store.put(record, gameId));
    } catch (error) {
      await requestKeptRomFile({ action: "remove", name: storageName }).catch((cleanupError: unknown) => {
        logger.debug("Incomplete kept ROM will be cleaned on boot", { storageName, error: String(cleanupError) });
      });
      throw error;
    }
    if (isReadableRecord(previous)) {
      await requestKeptRomFile({ action: "remove", name: previous.storageName }).catch((error: unknown) => {
        logger.debug("Replaced kept ROM will be cleaned on boot", { error: String(error) });
      });
    }
  });

const readKeptRom = async (gameId: string, signal?: AbortSignal): Promise<KeptRomPlayback> => {
  signal?.throwIfAborted();
  await waitForBrowserOpfsBootCleanup();
  return withLock(async () => {
    signal?.throwIfAborted();
    const record: unknown = await transaction("readonly", (store) => store.get(gameId));
    if (!isReadableRecord(record) || record.gameId !== gameId) throw new Error("This kept ROM can't be read.");
    const snapshotId = crypto.randomUUID();
    const releaseOwnership = registerBrowserTransientOpfsPath(
      `/work/runtime-output/emulator/kept-roms/${snapshotId}.rom`,
    );
    const dispose = async () => {
      await requestKeptRomFile({ action: "release", snapshotId });
      releaseOwnership();
    };
    try {
      // Playback MUST own scratch bytes so deleting a kept ROM cannot invalidate its active Blob.
      const { blob } = await requestKeptRomFile({ action: "read", name: record.storageName, snapshotId }, signal);
      if (!blob || blob.size !== record.size) throw new Error("This kept ROM was removed or changed by the browser.");
      return { file: new File([blob], record.fileName), dispose };
    } catch (error) {
      await dispose().catch((cleanupError: unknown) =>
        logger.debug("ROM playback cleanup deferred", { error: String(cleanupError) }),
      );
      throw error;
    }
  }, signal);
};

const deleteKeptRom = (gameId: string): Promise<void> =>
  withLock(async () => {
    const record: unknown = await transaction("readonly", (store) => store.get(gameId));
    if (
      isRecord(record) &&
      typeof record.storageName === "string" &&
      STORAGE_NAME.test(record.storageName) &&
      record.storageName.startsWith(`${gameId}-`)
    ) {
      await requestKeptRomFile({ action: "remove", name: record.storageName });
    }
    await transaction("readwrite", (store) => store.delete(gameId));
  });

export { deleteKeptRom, keepTestRom, listKeptRoms, readKeptRom };
export type { KeptRom, KeptRomPlayback };
