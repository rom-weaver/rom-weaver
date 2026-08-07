import { createLogger } from "../../lib/logging.ts";

/**
 * EmulatorJS 4.2.3 storage findings:
 *
 * - `data/src/storage.js` implements `EJS_STORAGE` with one object store per
 *   database. Browser save states use database `EmulatorJS-states`, store
 *   `states`, and keys such as `<getBaseFileName()>.state`; `?EJS_KEYS!` is a
 *   bookkeeping array. The state value is the raw `Uint8Array`.
 * - `GameManager.mountFileSystems()` mounts Emscripten IDBFS at
 *   `/data/saves` with `autoPersist: true`. Emscripten stores that mount in
 *   `EM_FS_<window.location.pathname>`, version 20, object store `FILE_DATA`.
 *   `saveSaveFiles()` asks the core to write SRAM, emits `saveSaveFiles`, and
 *   is called on exit. The optional `save-save-interval` setting calls it on a
 *   timer; SRAM is not saved once per frame by this JavaScript layer.
 * - `EJS_disableLocalStorage` only gates EmulatorJS settings in
 *   `saveSettings`, `preGetSetting`, `getCoreSettings`, and `loadSettings`. It
 *   does not disable the IndexedDB state store or IDBFS. EmulatorJS local
 *   storage keys are `ejs-settings` and `ejs-<gameId>-<core>-<gameName>-settings`,
 *   which cannot collide with the app's `rom-weaver-*` keys.
 * - `EJS_gameID` participates in settings and netplay identity, but state keys
 *   use `getBaseFileName()`, which prefers `EJS_gameName`. We therefore pass a
 *   checksum- or filename/size-derived game name and numeric game ID.
 * - `EJS_onSaveState` receives `{ screenshot, format, state }`, and
 *   `EJS_onLoadState` receives no arguments. `EJS_onSaveSave` receives
 *   `{ screenshot, format, save }`, and `EJS_onLoadSave` receives no arguments.
 *   Registering these callbacks intercepts EmulatorJS's default picker and
 *   browser-state handling, so this bridge stores and loads the bytes itself.
 * - `EJS_emulator.pause()` and `.play()` are public methods. The document
 *   bridge uses visibility-specific commands and only resumes an emulator it
 *   paused itself.
 */

const logger = createLogger("emulator-saves");
const DATABASE_NAME = "rom-weaver-emulator-saves";
const DATABASE_VERSION = 1;
const STORE_NAME = "games";
const MESSAGE_SOURCE = "rom-weaver-emulator";
const SAVE_FORMAT = "rom-weaver-emulator-save";
const SAVE_FORMAT_VERSION = 1;
const MAX_IMPORT_BYTES = 128 * 1024 * 1024;

type EmulatorSaveRecord = {
  gameId: string;
  gameName: string;
  label: string;
  state?: Uint8Array;
  sram?: Uint8Array;
  updatedAt: number;
};

type EmulatorSaveUpdate = {
  data: Uint8Array;
  gameId: string;
  gameName: string;
  label?: string;
};

type SerializedEmulatorSave = {
  format: typeof SAVE_FORMAT;
  version: typeof SAVE_FORMAT_VERSION;
  gameId: string;
  gameName: string;
  label: string;
  state?: string;
  sram?: string;
};

type EmulatorSaveMessage = {
  source: typeof MESSAGE_SOURCE;
  kind: "ready" | "request-load-sram" | "request-load-state" | "save-sram" | "save-state";
  gameId: string;
  gameName?: string;
  gameLabel?: string;
  data?: ArrayBuffer | ArrayBufferView | null;
};

const listeners = new Set<() => void>();
let bridgeInstalled = false;

const storageUnavailable = () => new Error("Emulator save storage is unavailable in this browser.");

const assertStorage = (): IDBFactory => {
  if (typeof indexedDB === "undefined") throw storageUnavailable();
  return indexedDB;
};

const requestError = (request: IDBRequest): Error =>
  request.error instanceof Error ? request.error : new Error("Emulator save storage request failed.");

const openDatabase = (): Promise<IDBDatabase> => {
  const factory = assertStorage();
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DATABASE_NAME, DATABASE_VERSION);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onerror = () => reject(requestError(request));
    request.onsuccess = () => resolve(request.result);
  });
};

const deleteBuiltinRecords = async (gameName: string): Promise<void> => {
  const factory = assertStorage();
  const databaseNames = new Set<string>(["EmulatorJS-states"]);
  const databases = (factory as IDBFactory & { databases?: () => Promise<IDBDatabaseInfo[]> }).databases;
  if (databases) {
    for (const database of await databases()) {
      if (database.name?.startsWith("EM_FS_")) databaseNames.add(database.name);
    }
  }
  const currentPath = typeof location === "undefined" ? "/" : location.pathname;
  databaseNames.add(`EM_FS_${currentPath}`);
  await Promise.all(
    [...databaseNames].map(
      (databaseName) =>
        new Promise<void>((resolve, reject) => {
          const request = factory.open(databaseName);
          request.onerror = () => reject(requestError(request));
          request.onupgradeneeded = () => undefined;
          request.onsuccess = () => {
            const database = request.result;
            const storeName = databaseName === "EmulatorJS-states" ? "states" : "FILE_DATA";
            if (!database.objectStoreNames.contains(storeName)) {
              database.close();
              resolve();
              return;
            }
            const transaction = database.transaction(storeName, "readwrite");
            const store = transaction.objectStore(storeName);
            const keysRequest = store.getAllKeys();
            keysRequest.onerror = () => reject(requestError(keysRequest));
            keysRequest.onsuccess = () => {
              const keys = keysRequest.result.filter((key) => {
                if (databaseName === "EmulatorJS-states") return key === `${gameName}.state`;
                return typeof key === "string" && key.includes(gameName);
              });
              for (const key of keys) store.delete(key);
              if (databaseName === "EmulatorJS-states") {
                const bookkeepingRequest = store.get("?EJS_KEYS!");
                bookkeepingRequest.onsuccess = () => {
                  if (!Array.isArray(bookkeepingRequest.result)) return;
                  store.put(
                    bookkeepingRequest.result.filter((key) => !keys.includes(key)),
                    "?EJS_KEYS!",
                  );
                };
              }
            };
            transaction.onerror = () => reject(transaction.error || new Error("Emulator save cleanup failed."));
            transaction.oncomplete = () => {
              database.close();
              resolve();
            };
          };
        }),
    ),
  );
};

const runTransaction = async <T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> => {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      if (request) {
        request.onerror = () => reject(requestError(request));
        request.onsuccess = () => undefined;
      }
    } catch (error) {
      database.close();
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    transaction.onerror = () => reject(transaction.error || new Error("Emulator save transaction failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Emulator save transaction was aborted."));
    transaction.oncomplete = () => {
      database.close();
      resolve(undefined);
    };
  });
};

const readTransaction = async <T>(operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> => {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    let request: IDBRequest<T>;
    try {
      transaction = database.transaction(STORE_NAME, "readonly");
      request = operation(transaction.objectStore(STORE_NAME));
    } catch (error) {
      database.close();
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    request.onerror = () => reject(requestError(request));
    request.onsuccess = () => resolve(request.result);
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error || new Error("Emulator save transaction failed."));
    transaction.onabort = () => reject(transaction.error || new Error("Emulator save transaction was aborted."));
  });
};

const copyBytes = (value: ArrayBuffer | ArrayBufferView | null | undefined): Uint8Array | undefined => {
  if (value === null || value === undefined) return undefined;
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return undefined;
};

const copyRecord = (record: EmulatorSaveRecord): EmulatorSaveRecord => ({
  gameId: record.gameId,
  gameName: record.gameName,
  label: record.label,
  ...(record.state ? { state: copyBytes(record.state) } : {}),
  ...(record.sram ? { sram: copyBytes(record.sram) } : {}),
  updatedAt: record.updatedAt,
});

const normalizeRecord = (value: unknown): EmulatorSaveRecord | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<EmulatorSaveRecord>;
  if (typeof record.gameId !== "string" || !record.gameId || typeof record.gameName !== "string") return undefined;
  const state = copyBytes(record.state);
  const sram = copyBytes(record.sram);
  if (!(state || sram)) return undefined;
  return {
    gameId: record.gameId,
    gameName: record.gameName,
    label: typeof record.label === "string" && record.label ? record.label : record.gameName,
    ...(state ? { state } : {}),
    ...(sram ? { sram } : {}),
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
  };
};

const readEmulatorSave = async (gameId: string): Promise<EmulatorSaveRecord | undefined> => {
  const result = await readTransaction<unknown>((store) => store.get(gameId));
  const record = normalizeRecord(result);
  return record ? copyRecord(record) : undefined;
};

const writeRecord = async (record: EmulatorSaveRecord): Promise<void> => {
  await runTransaction("readwrite", (store) => store.put(copyRecord(record), record.gameId));
};

const updatePart = async (kind: "sram" | "state", update: EmulatorSaveUpdate): Promise<void> => {
  const previous = await readEmulatorSave(update.gameId);
  const next: EmulatorSaveRecord = {
    gameId: update.gameId,
    gameName: update.gameName,
    label: update.label || previous?.label || update.gameName,
    ...(previous?.state ? { state: previous.state } : {}),
    ...(previous?.sram ? { sram: previous.sram } : {}),
    [kind]: copyBytes(update.data),
    updatedAt: Date.now(),
  };
  await writeRecord(next);
  notifyListeners();
};

const listEmulatorSaves = async (): Promise<EmulatorSaveRecord[]> => {
  const result = await readTransaction<unknown[]>((store) => store.getAll());
  return (result || [])
    .map(normalizeRecord)
    .filter((record): record is EmulatorSaveRecord => !!record)
    .map(copyRecord)
    .sort((left, right) => left.label.localeCompare(right.label) || left.gameId.localeCompare(right.gameId));
};

const deleteEmulatorSave = async (gameId: string): Promise<void> => {
  const previous = await readEmulatorSave(gameId);
  await runTransaction("readwrite", (store) => store.delete(gameId));
  if (previous) {
    await deleteBuiltinRecords(previous.gameName).catch((error) => {
      logger.warn("EmulatorJS built-in save cleanup failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }
  notifyListeners();
};

const saveEmulatorState = (update: EmulatorSaveUpdate) => updatePart("state", update);
const saveEmulatorSram = (update: EmulatorSaveUpdate) => updatePart("sram", update);

const notifyListeners = () => {
  for (const listener of listeners) listener();
};

const subscribeEmulatorSaves = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const base64ToBytes = (value: unknown, label: string): Uint8Array => {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`Invalid ${label} data in the EmulatorJS save file.`);
  }
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch (error) {
    throw new Error(`Invalid ${label} data in the EmulatorJS save file.`, { cause: error });
  }
};

const serializeEmulatorSave = (record: EmulatorSaveRecord): string => {
  const value: SerializedEmulatorSave = {
    format: SAVE_FORMAT,
    version: SAVE_FORMAT_VERSION,
    gameId: record.gameId,
    gameName: record.gameName,
    label: record.label,
    ...(record.state ? { state: bytesToBase64(record.state) } : {}),
    ...(record.sram ? { sram: bytesToBase64(record.sram) } : {}),
  };
  return JSON.stringify(value);
};

const parseSerializedEmulatorSave = (serialized: string): EmulatorSaveRecord => {
  let value: Partial<SerializedEmulatorSave>;
  try {
    value = JSON.parse(serialized) as Partial<SerializedEmulatorSave>;
  } catch (error) {
    throw new Error("The selected file is not valid JSON.", { cause: error });
  }
  if (
    value.format !== SAVE_FORMAT ||
    value.version !== SAVE_FORMAT_VERSION ||
    typeof value.gameId !== "string" ||
    !value.gameId ||
    typeof value.gameName !== "string" ||
    typeof value.label !== "string"
  ) {
    throw new Error("The selected file is not a rom-weaver EmulatorJS save.");
  }
  const state = value.state === undefined ? undefined : base64ToBytes(value.state, "save-state");
  const sram = value.sram === undefined ? undefined : base64ToBytes(value.sram, "SRAM");
  if (!(state || sram)) throw new Error("The EmulatorJS save file contains no save-state or SRAM data.");
  return {
    gameId: value.gameId,
    gameName: value.gameName,
    label: value.label || value.gameName,
    ...(state ? { state } : {}),
    ...(sram ? { sram } : {}),
    updatedAt: Date.now(),
  };
};

const createEmulatorSaveExport = (record: EmulatorSaveRecord): { blob: Blob; fileName: string } => {
  const safeName = (record.label || record.gameId).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return {
    blob: new Blob([serializeEmulatorSave(record)], { type: "application/json" }),
    fileName: `${safeName || "emulator-save"}.rw-emulator-save.json`,
  };
};

const parseEmulatorSaveFile = async (file: Blob): Promise<EmulatorSaveRecord> => {
  if (file.size > MAX_IMPORT_BYTES) throw new Error("The EmulatorJS save file is too large.");
  return parseSerializedEmulatorSave(await file.text());
};

const writeEmulatorSave = async (record: EmulatorSaveRecord): Promise<void> => {
  const normalized = normalizeRecord(record);
  if (!normalized) throw new Error("The EmulatorJS save record is incomplete.");
  await writeRecord({ ...normalized, updatedAt: Date.now() });
  notifyListeners();
};

const importEmulatorSave = async (file: Blob): Promise<EmulatorSaveRecord> => {
  const record = await parseEmulatorSaveFile(file);
  await writeEmulatorSave(record);
  return record;
};

const isSaveMessage = (value: unknown): value is EmulatorSaveMessage => {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<EmulatorSaveMessage>;
  return message.source === MESSAGE_SOURCE && typeof message.kind === "string" && typeof message.gameId === "string";
};

const postToSource = (source: MessageEventSource | null, message: unknown) => {
  if (!source || typeof source.postMessage !== "function") return;
  (source as unknown as { postMessage: (value: unknown, targetOrigin: string) => void }).postMessage(message, "*");
};

const handleSaveMessage = async (event: MessageEvent<unknown>) => {
  if (!isSaveMessage(event.data)) return;
  const message = event.data;
  const label = message.gameLabel || message.gameName || message.gameId;
  if (message.kind === "save-state" || message.kind === "save-sram") {
    const data = copyBytes(message.data);
    if (!data) return;
    const update = { data, gameId: message.gameId, gameName: message.gameName || message.gameId, label };
    if (message.kind === "save-state") await saveEmulatorState(update);
    else await saveEmulatorSram(update);
    return;
  }
  if (message.kind !== "request-load-state" && message.kind !== "request-load-sram") return;
  const record = await readEmulatorSave(message.gameId);
  const data = message.kind === "request-load-state" ? record?.state : record?.sram;
  postToSource(event.source, {
    data: data ? copyBytes(data) : null,
    gameId: message.gameId,
    kind: message.kind === "request-load-state" ? "load-state" : "load-sram",
    source: MESSAGE_SOURCE,
  });
};

const ensureEmulatorSaveBridge = () => {
  if (bridgeInstalled || typeof window === "undefined") return;
  bridgeInstalled = true;
  window.addEventListener("message", (event) => {
    void handleSaveMessage(event).catch((error) => {
      logger.warn("EmulatorJS save bridge message failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });
};

export type { EmulatorSaveRecord };
export {
  createEmulatorSaveExport,
  deleteEmulatorSave,
  ensureEmulatorSaveBridge,
  importEmulatorSave,
  listEmulatorSaves,
  parseSerializedEmulatorSave,
  readEmulatorSave,
  serializeEmulatorSave,
  subscribeEmulatorSaves,
  writeEmulatorSave,
};
