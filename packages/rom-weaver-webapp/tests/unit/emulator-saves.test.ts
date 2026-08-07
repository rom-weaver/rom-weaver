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

const createFakeIndexedDb = () => {
  const database = new FakeDatabase();
  return {
    open: () => {
      const request: FakeRequest = {
        error: null,
        onerror: null,
        onsuccess: null,
        onupgradeneeded: null,
        result: database,
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  } as unknown as IDBFactory;
};

const record: EmulatorSaveRecord = {
  gameId: "rom-weaver-nes",
  gameName: "rom-weaver-nes",
  label: "game.nes",
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
