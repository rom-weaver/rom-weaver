import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEmulatorSaveExport,
  deleteEmulatorSave,
  importEmulatorSave,
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
  return {
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
  } as unknown as IDBFactory;
};

const record: EmulatorSaveRecord = {
  gameId: "rom-weaver-nes",
  gameName: "rom-weaver-nes",
  sram: new Uint8Array([4, 5, 6]),
  state: new Uint8Array([1, 2, 3]),
  updatedAt: 1,
};

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

  it("stores only save data and its derived key", async () => {
    await writeEmulatorSave(record);
    const [stored] = await listEmulatorSaves();
    expect(Object.keys(stored || {}).sort()).toEqual(["gameId", "gameName", "sram", "state", "updatedAt"]);
    expect(JSON.parse(serializeEmulatorSave(record))).not.toHaveProperty("label");
  });

  it("drops the ROM name a version 1 record carries", async () => {
    const database = new FakeDatabase();
    database.seed(record.gameId, { ...record, label: "Some Game (USA).nes" });
    vi.stubGlobal("indexedDB", createFakeIndexedDb(database));

    await listEmulatorSaves();
    await vi.waitFor(() => {
      expect(database.stored(record.gameId)).toMatchObject({ gameId: record.gameId });
      expect(database.stored(record.gameId)).not.toHaveProperty("label");
    });
  });

  it("drops the ROM name a record kept when the upgrade could not rewrite it", async () => {
    const database = new FakeDatabase();
    database.seed(record.gameId, { ...record, label: "Some Game (USA).nes" });
    vi.stubGlobal("indexedDB", createFakeIndexedDb(database, { upgrade: false }));

    await listEmulatorSaves();
    await vi.waitFor(() => {
      expect(database.stored(record.gameId)).toMatchObject({ gameId: record.gameId });
      expect(database.stored(record.gameId)).not.toHaveProperty("label");
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

  it("drops the ROM name a version 1 export file carries", async () => {
    const legacy = JSON.stringify({
      ...JSON.parse(serializeEmulatorSave(record)),
      label: "Some Game (USA).nes",
      version: 1,
    });
    const imported = await importEmulatorSave(new Blob([legacy]));
    expect(imported).not.toHaveProperty("label");
    expect(imported.state).toEqual(record.state);
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
  });
});
