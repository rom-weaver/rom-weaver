import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addRandomAccessFileIoStats,
  BrowserVirtualRandomAccessFile,
  createRandomAccessFileIoStats,
  isBlobLike,
  randomAccessFileIoStatsHaveData,
} from "../../src/wasm/browser-opfs-io-adapters.ts";

const MIB = 1024 * 1024;
/** Mirrors VIRTUAL_BLOB_READ_CACHE_BLOCK_BYTES / _BLOCK_COUNT / _MAX_REQUEST_BYTES in the adapter. */
const CACHE_BLOCK_BYTES = 2 * MIB;
const CACHE_BLOCK_COUNT = 8;
const CACHE_MAX_REQUEST_BYTES = 512 * 1024;

type FakeBlob = { size: number; slice: (start: number, end: number) => { end: number; start: number } };

let sliceCalls: { end: number; start: number }[];

/**
 * Stands in for a worker's FileReaderSync over a synthetic Blob. Node's Blob only reads
 * asynchronously, so the fake blob hands back its range and the reader synthesises the bytes:
 * `byte(i) = i & 0xff`, which lets any offset be checked without holding the whole payload.
 */
class FakeFileReaderSync {
  readAsArrayBuffer(range: { end: number; start: number }): ArrayBuffer {
    const bytes = new Uint8Array(Math.max(0, range.end - range.start));
    for (let index = 0; index < bytes.byteLength; index += 1) bytes[index] = (range.start + index) & 0xff;
    return bytes.buffer;
  }
}

function fakeBlob(size: number): FakeBlob {
  return {
    size,
    slice(start: number, end: number) {
      sliceCalls.push({ end, start });
      return { end, start };
    },
  };
}

const expectedByte = (offset: number) => offset & 0xff;

// Blob files share the worker's cache budget, so each test closes what it opened, as restoreVirtualFiles does at run end.
let openedBlobFiles: BrowserVirtualRandomAccessFile[];

function openBlobFile(size: number): BrowserVirtualRandomAccessFile {
  const file = new BrowserVirtualRandomAccessFile(fakeBlob(size));
  openedBlobFiles.push(file);
  return file;
}

beforeEach(() => {
  sliceCalls = [];
  openedBlobFiles = [];
  vi.stubGlobal("FileReaderSync", FakeFileReaderSync);
});

afterEach(() => {
  for (const file of openedBlobFiles) file.close();
  vi.unstubAllGlobals();
});

describe("random access io stats", () => {
  it("starts every counter at zero and reports no data", () => {
    const stats = createRandomAccessFileIoStats();

    expect(Object.values(stats).every((value) => value === 0)).toBe(true);
    expect(randomAccessFileIoStatsHaveData(stats)).toBe(false);

    stats.opfsReadCalls = 1;
    expect(randomAccessFileIoStatsHaveData(stats)).toBe(true);
  });

  it("adds a snapshot key by key, coercing junk to zero", () => {
    const target = createRandomAccessFileIoStats();

    addRandomAccessFileIoStats(target, { blobReadBytes: 10, opfsReadCalls: 2 });
    addRandomAccessFileIoStats(target, { blobReadBytes: 5, opfsReadCalls: "3" });
    addRandomAccessFileIoStats(target, { blobReadBytes: Number.NaN, opfsWriteCalls: null });

    expect(target.blobReadBytes).toBe(15);
    expect(target.opfsReadCalls).toBe(5);
    expect(target.opfsWriteCalls).toBe(0);
  });

  it("ignores a missing or non-object snapshot and any unknown key", () => {
    const target = createRandomAccessFileIoStats();

    addRandomAccessFileIoStats(target, null);
    addRandomAccessFileIoStats(target, undefined);
    addRandomAccessFileIoStats(target, "nope" as never);
    addRandomAccessFileIoStats(target, { notACounter: 99 } as never);

    expect(randomAccessFileIoStatsHaveData(target)).toBe(false);
  });
});

describe("isBlobLike", () => {
  it("accepts anything with a slice method and a size, and nothing else", () => {
    expect(isBlobLike({ size: 4, slice: () => undefined })).toBe(true);
    expect(isBlobLike(new Blob([new Uint8Array(1)]))).toBe(true);
    expect(isBlobLike({ slice: () => undefined })).toBe(false);
    expect(isBlobLike({ size: 4 })).toBe(false);
    expect(isBlobLike(null)).toBe(false);
    expect(isBlobLike(42)).toBe(false);
    expect(isBlobLike(new Uint8Array(4))).toBe(false);
  });
});

describe("BrowserVirtualRandomAccessFile over in-memory sources", () => {
  it("serves a Uint8Array source directly, with no reader", () => {
    const file = new BrowserVirtualRandomAccessFile(new Uint8Array([1, 2, 3, 4]));

    expect(file.reader).toBeNull();
    expect(file.size()).toBe(4);
    const dst = new Uint8Array(2);
    expect(file.readAt(1, dst)).toBe(2);
    expect(dst).toEqual(new Uint8Array([2, 3]));
  });

  it("serves an ArrayBuffer source directly", () => {
    const source = new Uint8Array([9, 8, 7]).buffer;
    const file = new BrowserVirtualRandomAccessFile(source);

    expect(file.size()).toBe(3);
    const dst = new Uint8Array(3);
    expect(file.readAt(0, dst)).toBe(3);
    expect(dst).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("clamps a read to what remains and refuses one that starts out of range", () => {
    const file = new BrowserVirtualRandomAccessFile(new Uint8Array([1, 2, 3]));

    expect(file.readAt(2, new Uint8Array(8))).toBe(1);
    expect(file.readAt(3, new Uint8Array(1))).toBe(0);
    expect(file.readAt(-1, new Uint8Array(1))).toBe(0);
    expect(file.readAt(Number.NaN, new Uint8Array(1))).toBe(0);
    expect(file.readAt(0, new Uint8Array(0))).toBe(0);
  });

  it("is read-only and has nothing to flush or resize", () => {
    const file = new BrowserVirtualRandomAccessFile(new Uint8Array([1]));

    expect(file.writeAt()).toBe(0);
    expect(() => {
      file.truncate();
      file.flush();
    }).not.toThrow();
  });

  it("reports zero size for a source it cannot read", () => {
    expect(new BrowserVirtualRandomAccessFile(null).size()).toBe(0);
    expect(new BrowserVirtualRandomAccessFile({ size: undefined, slice: () => undefined }).size()).toBe(0);
  });

  it("stops serving reads once closed and resumes after reopen", () => {
    const file = new BrowserVirtualRandomAccessFile(new Uint8Array([1, 2, 3]));

    file.close();
    expect(file.closed).toBe(true);
    expect(file.readAt(0, new Uint8Array(1))).toBe(0);

    // Closing twice must stay a no-op.
    file.close();
    file.reopen();
    expect(file.closed).toBe(false);
    expect(file.readAt(0, new Uint8Array(1))).toBe(1);
  });

  it("hands back a detached copy of its counters", () => {
    const file = new BrowserVirtualRandomAccessFile(new Uint8Array([1]));
    const snapshot = file.snapshotIoStats();

    file.ioStats.blobReadCalls = 5;
    expect(snapshot.blobReadCalls).toBe(0);
    expect(file.snapshotIoStats().blobReadCalls).toBe(5);
  });
});

describe("BrowserVirtualRandomAccessFile over a Blob source", () => {
  it("reads through the reader and records the blob io counters", () => {
    const file = openBlobFile(1024);
    const dst = new Uint8Array(16);

    expect(file.readAt(32, dst)).toBe(16);
    expect(dst[0]).toBe(expectedByte(32));
    expect(file.ioStats.blobReadCalls).toBe(1);
    // The miss fills a whole cache block, clamped to the blob's length.
    expect(file.ioStats.blobReadBytes).toBe(1024);
    expect(file.ioStats.blobCacheMisses).toBe(1);
    expect(file.ioStats.blobCacheHits).toBe(0);
  });

  it("serves a second read of the same block from the cache", () => {
    const file = openBlobFile(4 * MIB);
    const first = new Uint8Array(64);
    const second = new Uint8Array(64);

    file.readAt(0, first);
    sliceCalls.length = 0;
    expect(file.readAt(128, second)).toBe(64);

    expect(sliceCalls).toEqual([]);
    expect(file.ioStats.blobCacheHits).toBe(1);
    expect(file.ioStats.blobCacheHitBytes).toBe(64);
    expect(file.ioStats.blobCacheFillBytes).toBe(CACHE_BLOCK_BYTES);
    expect(second[0]).toBe(expectedByte(128));
  });

  it("streams a request larger than the cache request cap straight through", () => {
    const file = openBlobFile(4 * MIB);
    const dst = new Uint8Array(CACHE_MAX_REQUEST_BYTES + 1);

    expect(file.readAt(0, dst)).toBe(dst.byteLength);
    expect(sliceCalls).toEqual([{ end: dst.byteLength, start: 0 }]);
    expect(file.ioStats.blobCacheMisses).toBe(0);
    expect(file.ioStats.blobReadCalls).toBe(1);
  });

  it("streams a request that straddles two cache blocks", () => {
    const file = openBlobFile(4 * MIB);
    const dst = new Uint8Array(64);

    expect(file.readAt(CACHE_BLOCK_BYTES - 32, dst)).toBe(64);
    expect(sliceCalls).toEqual([{ end: CACHE_BLOCK_BYTES + 32, start: CACHE_BLOCK_BYTES - 32 }]);
    expect(file.ioStats.blobCacheMisses).toBe(0);
    expect(dst[0]).toBe(expectedByte(CACHE_BLOCK_BYTES - 32));
  });

  it("evicts the least recently used block once the cache is full", () => {
    const file = openBlobFile((CACHE_BLOCK_COUNT + 2) * CACHE_BLOCK_BYTES);
    const dst = new Uint8Array(16);

    for (let block = 0; block <= CACHE_BLOCK_COUNT; block += 1) {
      file.readAt(block * CACHE_BLOCK_BYTES, dst);
    }
    expect(file.ioStats.blobCacheMisses).toBe(CACHE_BLOCK_COUNT + 1);

    // Block 0 was the least recently used, so it is gone and must be refilled.
    file.readAt(0, dst);
    expect(file.ioStats.blobCacheMisses).toBe(CACHE_BLOCK_COUNT + 2);
    expect(file.ioStats.blobCacheHits).toBe(0);

    // The most recent block is still resident.
    file.readAt(CACHE_BLOCK_COUNT * CACHE_BLOCK_BYTES + 8, dst);
    expect(file.ioStats.blobCacheHits).toBe(1);
  });

  it("returns nothing past the end of the blob", () => {
    const file = openBlobFile(128);

    expect(file.readAt(200, new Uint8Array(16))).toBe(0);
    expect(file.readBlobAt(0, new Uint8Array(0))).toBe(0);
    expect(file.readBlobAt(128, new Uint8Array(16))).toBe(0);
  });

  it("reads nothing once the reader is released, until reopen restores it", () => {
    const file = openBlobFile(1024);
    file.readAt(0, new Uint8Array(16));

    file.close();
    expect(file.reader).toBeNull();
    // A direct blob read with no reader yields nothing even though the file reports its size.
    expect(file.readBlobAt(0, new Uint8Array(16))).toBe(0);

    file.reopen();
    expect(file.reader).not.toBeNull();
    expect(file.readAt(0, new Uint8Array(16))).toBe(16);
  });

  it("drops its cached blocks on close so a reopened file re-reads the blob", () => {
    const file = openBlobFile(4 * MIB);
    file.readAt(0, new Uint8Array(16));
    expect(file.ioStats.blobCacheMisses).toBe(1);

    file.close();
    file.reopen();
    file.readAt(0, new Uint8Array(16));
    expect(file.ioStats.blobCacheMisses).toBe(2);
  });

  it("keeps no reader for a non-blob source, so a direct blob read is a no-op", () => {
    const file = new BrowserVirtualRandomAccessFile(new Uint8Array(64));

    expect(file.readBlobAt(0, new Uint8Array(16))).toBe(0);
  });
});

describe("BrowserVirtualRandomAccessFile read-cache invalidation", () => {
  it("empties only the blocks that overlap the invalidated range", () => {
    const file = openBlobFile(4 * MIB);
    const dst = new Uint8Array(16);
    file.readAt(0, dst);
    file.readAt(CACHE_BLOCK_BYTES, dst);
    expect(file.ioStats.blobCacheMisses).toBe(2);

    file.readCache.invalidateRange(0, 8);

    file.readAt(0, dst);
    expect(file.ioStats.blobCacheMisses).toBe(3);
    file.readAt(CACHE_BLOCK_BYTES, dst);
    expect(file.ioStats.blobCacheHits).toBe(1);
  });

  it("does nothing for an empty cache or an already-empty block", () => {
    const file = openBlobFile(4 * MIB);

    expect(() => {
      file.readCache.invalidateRange(0, 1024);
    }).not.toThrow();

    file.readAt(0, new Uint8Array(16));
    file.readCache.invalidateRange(0, 1024);
    expect(() => {
      file.readCache.invalidateRange(0, 1024);
    }).not.toThrow();
    expect(file.ioStats.blobCacheHits).toBe(0);
  });
});

describe("BrowserVirtualRandomAccessFile timing fallback", () => {
  it("times blob reads with Date.now when performance is unavailable", () => {
    const original = globalThis.performance;
    Reflect.deleteProperty(globalThis, "performance");
    try {
      const file = openBlobFile(1024);
      expect(file.readAt(0, new Uint8Array(16))).toBe(16);
      expect(file.ioStats.blobReadCalls).toBe(1);
      expect(file.ioStats.blobReadMs).toBeGreaterThanOrEqual(0);
    } finally {
      Object.defineProperty(globalThis, "performance", { configurable: true, value: original, writable: true });
    }
  });
});

describe("BrowserVirtualRandomAccessFile Blob read cache", () => {
  it("sizes the cache block to a small file and serves an oversized request from it", () => {
    const file = openBlobFile(1000);
    const dst = new Uint8Array(1024 * 1024);

    expect(file.readAt(0, dst)).toBe(1000);
    expect(file.readAt(0, dst)).toBe(1000);
    expect(dst[999]).toBe(expectedByte(999));
    expect(sliceCalls).toEqual([{ end: 1000, start: 0 }]);
    expect(file.snapshotIoStats().blobReadBytes).toBe(1000);
  });

  it("drops cached blocks on close so a closed file retains nothing", () => {
    const file = openBlobFile(1000);
    file.readAt(0, new Uint8Array(16));
    file.close();
    file.reopen();
    file.readAt(0, new Uint8Array(16));

    expect(sliceCalls).toHaveLength(2);
  });

  it("bounds a worker's cached bytes at twice the budget and returns them on close", async () => {
    // The budget is module state, so start from a fresh module that no earlier test has filled.
    vi.resetModules();
    const { BrowserVirtualRandomAccessFile: FreshFile } = await import("../../src/wasm/browser-opfs-io-adapters.ts");
    const readBlocks = (file: InstanceType<typeof FreshFile>, blocks: number[]) => {
      for (const block of blocks) file.readAt(block * CACHE_BLOCK_BYTES, new Uint8Array(16));
    };
    const full = new FreshFile(fakeBlob(32 * MIB));
    readBlocks(full, [0, 1, 2, 3, 4, 5, 6, 7]);
    // Past the budget each adapter's first block still fits in the headroom up to twice the budget.
    const firsts = Array.from({ length: 8 }, () => new FreshFile(fakeBlob(32 * MIB)));
    for (const file of firsts) readBlocks(file, [0]);

    sliceCalls = [];
    readBlocks(firsts[0] as InstanceType<typeof FreshFile>, [0]);
    expect(sliceCalls).toHaveLength(0);
    // The headroom is spent, so the next adapter holds no block and every read goes to the Blob.
    const starved = new FreshFile(fakeBlob(32 * MIB));
    readBlocks(starved, [0, 0]);
    expect(sliceCalls).toHaveLength(2);

    full.close();
    for (const file of firsts) file.close();
    starved.close();
    sliceCalls = [];
    const afterRelease = new FreshFile(fakeBlob(32 * MIB));
    readBlocks(afterRelease, [0, 1, 0]);
    expect(sliceCalls).toHaveLength(2);
    afterRelease.close();
  });
});
