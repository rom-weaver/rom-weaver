import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmulatorSaveExport,
  configureEmulatorSaveStorage,
  deleteEmulatorSave,
  importEmulatorSave,
  importEmulatorSavePart,
  ensureEmulatorSaveBridge,
  listEmulatorSaves,
  parseSerializedEmulatorSave,
  serializeEmulatorSave,
  writeEmulatorSave,
  type EmulatorSaveRecord,
} from "../../src/storage/browser/emulator-saves.ts";

type FakeRequest = {
  error: Error | null;
  onerror: (() => void) | null;
  onsuccess: (() => void) | null;
  onupgradeneeded: (() => void) | null;
  result: unknown;
};

type FakeCursor = {
  continue: () => void;
  update: (value: unknown) => void;
  value: unknown;
};

type FakeCursorRequest = {
  error: Error | null;
  onerror: (() => void) | null;
  onsuccess: (() => void) | null;
  result: FakeCursor | null;
};

type FakeTransaction = {
  error: Error | null;
  onabort: (() => void) | null;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  objectStore: (name: string) => FakeObjectStore;
};

class FakeObjectStore {
  constructor(
    private readonly values: Map<string, unknown>,
    private readonly transaction: FakeTransaction,
  ) {}

  get(key: string): FakeRequest {
    return this.finish(() => this.values.get(key));
  }

  getAll(): FakeRequest {
    return this.finish(() => [...this.values.values()]);
  }

  put(value: unknown, key: string): FakeRequest {
    return this.finish(() => {
      this.values.set(key, value);
      return key;
    });
  }

  openCursor(): FakeCursorRequest {
    const entries = [...this.values.entries()];
    const request: FakeCursorRequest = { error: null, onerror: null, onsuccess: null, result: null };
    let index = 0;
    const step = () => {
      queueMicrotask(() => {
        const entry = entries[index];
        index += 1;
        if (!entry) {
          request.result = null;
          request.onsuccess?.();
          return;
        }
        const [key, value] = entry;
        request.result = {
          continue: step,
          update: (next: unknown) => this.values.set(key, next),
          value,
        };
        request.onsuccess?.();
      });
    };
    step();
    return request;
  }

  delete(key: string): FakeRequest {
    return this.finish(() => {
      this.values.delete(key);
      return undefined;
    });
  }

  private finish(result: () => unknown): FakeRequest {
    const request: FakeRequest = {
      error: null,
      onerror: null,
      onsuccess: null,
      onupgradeneeded: null,
      result: undefined,
    };
    queueMicrotask(() => {
      request.result = result();
      request.onsuccess?.();
      this.transaction.oncomplete?.();
    });
    return request;
  }
}

class FakeDatabase {
  readonly objectStoreNames = { contains: (name: string) => name === "games" };
  private readonly values = new Map<string, unknown>();

  createObjectStore() {
    return new FakeObjectStore(this.values, this.createTransaction("readwrite"));
  }

  seed(key: string, value: unknown) {
    this.values.set(key, value);
  }

  stored(key: string) {
    return this.values.get(key);
  }

  transaction() {
    return this.createTransaction("readonly");
  }

  private createTransaction(_mode: IDBTransactionMode): FakeTransaction {
    const transaction = {} as FakeTransaction;
    transaction.error = null;
    transaction.onabort = null;
    transaction.onerror = null;
    transaction.oncomplete = null;
    transaction.objectStore = () => new FakeObjectStore(this.values, transaction);
    return transaction;
  }

  close() {
    // The fake database has no resources to release.
  }
}

// `upgrade: false` stands in for a database already on the current version, so
// the open runs without the migration the upgrade would otherwise perform.
const createFakeIndexedDb = (database = new FakeDatabase(), { upgrade = true } = {}) => {
  const factory = {
    databases() {
      if (this !== factory) throw new Error("IDBFactory.databases requires its receiver.");
      return Promise.resolve([]);
    },
    open: () => {
      const request: FakeRequest & { transaction: FakeTransaction } = {
        error: null,
        onerror: null,
        onsuccess: null,
        onupgradeneeded: null,
        result: database,
        transaction: database.transaction(),
      };
      queueMicrotask(() => {
        if (upgrade) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  return factory as unknown as IDBFactory;
};

const record: EmulatorSaveRecord = {
  gameId: "rom-weaver-nes",
  gameName: "rom-weaver-nes",
  label: "Some Game (USA).nes",
  sram: new Uint8Array([4, 5, 6]),
  state: new Uint8Array([1, 2, 3]),
  updatedAt: 1,
};

const sha1 = "0123456789abcdef0123456789abcdef01234567";

beforeEach(() => {
  vi.stubGlobal("indexedDB", createFakeIndexedDb());
});

describe("emulator saves", () => {
  it("round-trips the export format and app-owned IndexedDB record", async () => {
    const serialized = serializeEmulatorSave(record);
    const parsed = parseSerializedEmulatorSave(serialized);
    expect(parsed.state).toEqual(record.state);
    expect(parsed.sram).toEqual(record.sram);

    await writeEmulatorSave(record);
    expect(await listEmulatorSaves()).toEqual([{ ...record, updatedAt: expect.any(Number) }]);

    const exported = createEmulatorSaveExport(record);
    const imported = await importEmulatorSave(exported.blob);
    expect(imported.gameId).toBe(record.gameId);
    expect(imported.state).toEqual(record.state);
    expect(imported.sram).toEqual(record.sram);
  });

  it("stores display metadata beside the derived key", async () => {
    await writeEmulatorSave(record);
    const [stored] = await listEmulatorSaves();
    expect(Object.keys(stored || {}).sort()).toEqual(["gameId", "gameName", "label", "sram", "state", "updatedAt"]);
    expect(JSON.parse(serializeEmulatorSave(record))).toHaveProperty("label", record.label);
  });

  it("keeps the ROM name a version 1 record carries", async () => {
    const database = new FakeDatabase();
    database.seed(record.gameId, { ...record, label: "Some Game (USA).nes" });
    vi.stubGlobal("indexedDB", createFakeIndexedDb(database));

    await listEmulatorSaves();
    await vi.waitFor(() => {
      expect(database.stored(record.gameId)).toMatchObject({ gameId: record.gameId });
      expect(database.stored(record.gameId)).toHaveProperty("label", "Some Game (USA).nes");
    });
  });

  it("keeps the ROM name without an upgrade", async () => {
    const database = new FakeDatabase();
    database.seed(record.gameId, { ...record, label: "Some Game (USA).nes" });
    vi.stubGlobal("indexedDB", createFakeIndexedDb(database, { upgrade: false }));

    await listEmulatorSaves();
    await vi.waitFor(() => {
      expect(database.stored(record.gameId)).toMatchObject({ gameId: record.gameId });
      expect(database.stored(record.gameId)).toHaveProperty("label", "Some Game (USA).nes");
    });
  });

  it("lists the most recently saved game first", async () => {
    const database = new FakeDatabase();
    // Seeded rather than written so the timestamps differ; `writeEmulatorSave`
    // stamps `Date.now()`, which ties within a single millisecond.
    database.seed("rom-weaver-a", { ...record, gameId: "rom-weaver-a", gameName: "rom-weaver-a", updatedAt: 10 });
    database.seed("rom-weaver-z", { ...record, gameId: "rom-weaver-z", gameName: "rom-weaver-z", updatedAt: 20 });
    vi.stubGlobal("indexedDB", createFakeIndexedDb(database, { upgrade: false }));

    const listed = await listEmulatorSaves();
    expect(listed.map((entry) => entry.gameId)).toEqual(["rom-weaver-z", "rom-weaver-a"]);
  });

  it("restores the ROM name from a version 1 export", async () => {
    const legacy = JSON.stringify({
      ...JSON.parse(serializeEmulatorSave(record)),
      label: "Some Game (USA).nes",
      version: 1,
    });
    const imported = await importEmulatorSave(new Blob([legacy]));
    expect(imported).toHaveProperty("label", "Some Game (USA).nes");
    expect(imported.state).toEqual(record.state);
  });

  it("limits imported display names", () => {
    const serialized = JSON.stringify({
      ...JSON.parse(serializeEmulatorSave(record)),
      label: "x".repeat(256),
    });
    expect(parseSerializedEmulatorSave(serialized).label).toHaveLength(255);
  });

  it("imports raw SRAM and save-state bytes with a normalized SHA-1", async () => {
    const importedSram = await importEmulatorSavePart({
      data: new Blob([new Uint8Array([7, 8, 9])]),
      part: "sram",
      sha1: `  ${sha1.toUpperCase()}  `,
    });
    expect(importedSram).toMatchObject({ gameId: sha1, gameName: sha1, label: "Imported save" });
    expect(importedSram.sram).toEqual(new Uint8Array([7, 8, 9]));

    const importedState = await importEmulatorSavePart({
      data: new Uint8Array([1, 2, 3]),
      part: "state",
      sha1,
    });
    expect(importedState.sram).toEqual(new Uint8Array([7, 8, 9]));
    expect(importedState.state).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects invalid direct-import SHA-1 and data", async () => {
    await expect(
      importEmulatorSavePart({ data: new Uint8Array([1]), part: "sram", sha1: "not-a-sha-1" }),
    ).rejects.toThrow("40-character SHA-1 checksum");
    await expect(importEmulatorSavePart({ data: new Uint8Array(), part: "state", sha1 })).rejects.toThrow(
      "uploaded emulator save is empty",
    );

    const arrayBuffer = vi.fn();
    const oversized = { arrayBuffer, size: 128 * 1024 * 1024 + 1 } as unknown as Blob;
    await expect(importEmulatorSavePart({ data: oversized, part: "state", sha1 })).rejects.toThrow(
      "uploaded emulator save is too large",
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("merges a direct import with existing save parts and metadata", async () => {
    const existing: EmulatorSaveRecord = {
      ...record,
      gameId: sha1,
      gameName: sha1,
      label: "Known ROM.nes",
    };
    await writeEmulatorSave(existing);

    const imported = await importEmulatorSavePart({
      data: new Uint8Array([10, 11]),
      part: "state",
      sha1: sha1.toUpperCase(),
    });

    expect(imported).toMatchObject({ gameId: sha1, gameName: sha1, label: existing.label });
    expect(imported.sram).toEqual(existing.sram);
    expect(imported.state).toEqual(new Uint8Array([10, 11]));
  });

  it("rejects malformed save files and deletes a whole game record", async () => {
    expect(() => parseSerializedEmulatorSave("{}")).toThrow("The selected file is not a rom-weaver EmulatorJS save.");

    await writeEmulatorSave(record);
    await deleteEmulatorSave(record.gameId);
    expect(await listEmulatorSaves()).toEqual([]);
  });

  it("answers emulator save requests with the persisted SRAM", async () => {
    const source = { postMessage: vi.fn() };
    const listeners: Array<(event: MessageEvent<unknown>) => void> = [];
    vi.stubGlobal("window", {
      addEventListener: (_type: string, listener: (event: MessageEvent<unknown>) => void) => {
        listeners.push(listener);
      },
    });
    await writeEmulatorSave(record);
    ensureEmulatorSaveBridge();

    listeners[0]?.({
      data: {
        gameId: record.gameId,
        kind: "request-load-sram",
        source: "rom-weaver-emulator",
      },
      source,
    } as unknown as MessageEvent<unknown>);

    await vi.waitFor(() => expect(source.postMessage).toHaveBeenCalled());
    expect(source.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        data: record.sram,
        gameId: record.gameId,
        kind: "load-sram",
        source: "rom-weaver-emulator",
      }),
      "*",
    );

    source.postMessage.mockClear();
    configureEmulatorSaveStorage(false);
    listeners[0]?.({
      data: {
        gameId: record.gameId,
        kind: "request-load-sram",
        source: "rom-weaver-emulator",
      },
      source,
    } as unknown as MessageEvent<unknown>);
    expect(source.postMessage).toHaveBeenCalledWith(expect.objectContaining({ data: null, kind: "load-sram" }), "*");
    configureEmulatorSaveStorage(true);
  });
});
