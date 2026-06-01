import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __createBrowserOpfsRandomAccessFileForTest,
  __createBrowserVirtualRandomAccessFileForTest,
  __createWasiRandomAccessFileInodeForTest,
} from '../src/rom-weaver-browser-opfs-api.mjs';
import { createMockSyncAccessHandle } from './opfs-mock-sync-handle.mjs';

// Targeted correctness coverage for BrowserOpfsRandomAccessFile's read cache and its invalidation.
// These assertions gate the read-cache tuning (large-read caching, range invalidation on write):
// a stale cache block returning pre-write bytes is silent data corruption, so every read-back is
// compared against the exact bytes that were written. The real FileSystemSyncAccessHandle is
// worker-only, so an in-memory mock backs the file here.

const MIB = 1024 * 1024;
const FILE_BYTES = 4 * MIB;
const BLOCK_BYTES = 1 * MIB;
const LARGE_VIRTUAL_READ_BYTES = 768 * 1024;

let file = null;
let fileReaderSyncReadCount = 0;
let fileReaderSyncInstalled = false;
let originalFileReaderSync = null;

function patternByte(offset) {
  return (offset * 31 + 7) & 0xff;
}

function patternBytes(offset, length) {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = patternByte(offset + index);
  return bytes;
}

function fillConstant(length, value) {
  return new Uint8Array(length).fill(value & 0xff);
}

beforeEach(() => {
  const syncHandle = createMockSyncAccessHandle({ size: FILE_BYTES, fill: patternByte });
  file = __createBrowserOpfsRandomAccessFileForTest(syncHandle);
});

afterEach(() => {
  if (!fileReaderSyncInstalled) return;
  if (originalFileReaderSync) {
    globalThis.FileReaderSync = originalFileReaderSync;
  } else {
    delete globalThis.FileReaderSync;
  }
  fileReaderSyncInstalled = false;
  originalFileReaderSync = null;
});

describe('BrowserOpfsRandomAccessFile read cache correctness', () => {
  it('returns exact bytes for a small (cache-eligible) read', () => {
    const offset = 3000;
    const dst = new Uint8Array(64 * 1024);
    const read = file.readAt(offset, dst);
    expect(read).toBe(dst.byteLength);
    expect(Array.from(dst)).toEqual(Array.from(patternBytes(offset, dst.byteLength)));
  });

  it('returns identical correct bytes on a repeated read (cache hit)', () => {
    const offset = 5 * 1024;
    const first = new Uint8Array(32 * 1024);
    const second = new Uint8Array(32 * 1024);
    file.readAt(offset, first);
    file.readAt(offset, second);
    expect(Array.from(second)).toEqual(Array.from(first));
    expect(Array.from(second)).toEqual(Array.from(patternBytes(offset, second.byteLength)));
  });

  it('returns exact bytes for a large (cache-bypassing) read', () => {
    const offset = BLOCK_BYTES + 1234;
    const dst = new Uint8Array(512 * 1024);
    const read = file.readAt(offset, dst);
    expect(read).toBe(dst.byteLength);
    expect(Array.from(dst)).toEqual(Array.from(patternBytes(offset, dst.byteLength)));
  });

  it('returns exact bytes for a read spanning multiple cache blocks', () => {
    const offset = BLOCK_BYTES - 4096;
    const dst = new Uint8Array(BLOCK_BYTES + 8192);
    const read = file.readAt(offset, dst);
    expect(read).toBe(dst.byteLength);
    expect(Array.from(dst)).toEqual(Array.from(patternBytes(offset, dst.byteLength)));
  });

  it('reflects a write into a region that was previously cached (no stale cache)', () => {
    const offset = 7 * 1024;
    const length = 16 * 1024;
    const warm = new Uint8Array(length);
    file.readAt(offset, warm);
    expect(Array.from(warm)).toEqual(Array.from(patternBytes(offset, length)));

    const replacement = fillConstant(length, 0xc7);
    file.writeAt(offset, replacement);

    const after = new Uint8Array(length);
    file.readAt(offset, after);
    expect(Array.from(after)).toEqual(Array.from(replacement));
  });

  it('keeps neighbouring cached bytes correct after an adjacent write', () => {
    const cachedOffset = 2 * 1024;
    const cachedLength = 8 * 1024;
    const warm = new Uint8Array(cachedLength);
    file.readAt(cachedOffset, warm);

    // Write a region far from the warmed read but inside the same file.
    const writeOffset = 600 * 1024;
    const replacement = fillConstant(4096, 0x39);
    file.writeAt(writeOffset, replacement);

    const reread = new Uint8Array(cachedLength);
    file.readAt(cachedOffset, reread);
    expect(Array.from(reread)).toEqual(Array.from(patternBytes(cachedOffset, cachedLength)));

    const written = new Uint8Array(replacement.byteLength);
    file.readAt(writeOffset, written);
    expect(Array.from(written)).toEqual(Array.from(replacement));
  });

  it('returns no bytes past a truncated end and correct bytes before it', () => {
    const warm = new Uint8Array(64 * 1024);
    file.readAt(0, warm);

    const newSize = 1024;
    file.truncate(newSize);
    expect(file.size()).toBe(newSize);

    const head = new Uint8Array(newSize);
    expect(file.readAt(0, head)).toBe(newSize);
    expect(Array.from(head)).toEqual(Array.from(patternBytes(0, newSize)));

    const past = new Uint8Array(4096);
    expect(file.readAt(newSize, past)).toBe(0);
  });

  it('tracks lazy allocation without physically growing the OPFS handle', () => {
    const syncHandle = createMockSyncAccessHandle({ size: 1024, fill: patternByte });
    const lazyFile = __createBrowserOpfsRandomAccessFileForTest(syncHandle);
    lazyFile.allocateAtLeast(4 * MIB);

    expect(lazyFile.size()).toBe(4 * MIB);
    expect(syncHandle.__snapshot().byteLength).toBe(1024);

    const sparse = new Uint8Array(4096);
    expect(lazyFile.readAt(2 * MIB, sparse)).toBe(sparse.byteLength);
    expect(Array.from(sparse)).toEqual(Array.from(new Uint8Array(sparse.byteLength)));
  });
});

class TestBlob extends Blob {
  constructor(bytes) {
    super([]);
    this.bytes = bytes;
  }

  get size() {
    return this.bytes.byteLength;
  }

  slice(start = 0, end = this.size) {
    return new TestBlob(this.bytes.subarray(start, end));
  }
}

class TestFileReaderSync {
  readAsArrayBuffer(blob) {
    fileReaderSyncReadCount += 1;
    return blob.bytes.buffer.slice(blob.bytes.byteOffset, blob.bytes.byteOffset + blob.bytes.byteLength);
  }
}

function installTestFileReaderSync() {
  originalFileReaderSync = globalThis.FileReaderSync;
  globalThis.FileReaderSync = TestFileReaderSync;
  fileReaderSyncReadCount = 0;
  fileReaderSyncInstalled = true;
}

describe('BrowserVirtualRandomAccessFile Blob read cache correctness', () => {
  it('returns exact bytes for direct Blob reads', () => {
    installTestFileReaderSync();
    const source = new TestBlob(patternBytes(0, FILE_BYTES));
    const virtualFile = __createBrowserVirtualRandomAccessFileForTest(source);
    const offset = 3000;
    const dst = new Uint8Array(64 * 1024);

    const read = virtualFile.readAt(offset, dst);

    expect(read).toBe(dst.byteLength);
    expect(Array.from(dst)).toEqual(Array.from(patternBytes(offset, dst.byteLength)));
  });

  it('serves repeated small Blob reads from the virtual read cache', () => {
    installTestFileReaderSync();
    const source = new TestBlob(patternBytes(0, FILE_BYTES));
    const virtualFile = __createBrowserVirtualRandomAccessFileForTest(source);
    const offset = 5 * 1024;
    const first = new Uint8Array(32 * 1024);
    const second = new Uint8Array(32 * 1024);

    virtualFile.readAt(offset, first);
    virtualFile.readAt(offset, second);

    expect(fileReaderSyncReadCount).toBe(1);
    expect(virtualFile.snapshotIoStats()).toMatchObject({
      blobCacheHitBytes: second.byteLength,
      blobCacheHits: 1,
      blobCacheMisses: 1,
      blobReadCalls: 1,
    });
    expect(Array.from(second)).toEqual(Array.from(first));
    expect(Array.from(second)).toEqual(Array.from(patternBytes(offset, second.byteLength)));
  });

  it('bypasses the virtual read cache for large Blob reads', () => {
    installTestFileReaderSync();
    const source = new TestBlob(patternBytes(0, FILE_BYTES));
    const virtualFile = __createBrowserVirtualRandomAccessFileForTest(source);
    const offset = BLOCK_BYTES + 1234;
    const first = new Uint8Array(LARGE_VIRTUAL_READ_BYTES);
    const second = new Uint8Array(LARGE_VIRTUAL_READ_BYTES);

    virtualFile.readAt(offset, first);
    virtualFile.readAt(offset, second);

    expect(fileReaderSyncReadCount).toBe(2);
    expect(virtualFile.snapshotIoStats()).toMatchObject({
      blobCacheHits: 0,
      blobCacheMisses: 0,
      blobReadCalls: 2,
    });
    expect(Array.from(second)).toEqual(Array.from(first));
    expect(Array.from(second)).toEqual(Array.from(patternBytes(offset, second.byteLength)));
  });
});

function createTestWasiBackingFile(options = {}) {
  const state = {
    closeCount: 0,
    closed: false,
    flushCount: 0,
    reopenCount: 0,
    writes: [],
  };
  return {
    supportsBufferedSequentialWrite: Boolean(options.supportsBufferedSequentialWrite),
    supportsDirectWasmRead: true,
    close() {
      state.closeCount += 1;
      state.closed = true;
    },
    flush() {
      state.flushCount += 1;
    },
    readAt(offset, target) {
      if (state.closed) return -1;
      const start = Number(offset);
      const length = Math.min(target.byteLength, Math.max(0, 16 - start));
      for (let index = 0; index < length; index += 1) target[index] = (start + index) & 0xff;
      return length;
    },
    reopen() {
      state.reopenCount += 1;
      state.closed = false;
    },
    size() {
      return 16;
    },
    snapshot() {
      return {
        ...state,
        writes: state.writes.map((write) => ({
          offset: write.offset,
          bytes: Array.from(write.bytes),
        })),
      };
    },
    truncate() {},
    writeAt(offset, source) {
      if (state.closed) return -1;
      state.writes.push({ offset: Number(offset), bytes: source.slice() });
      return source.byteLength;
    },
  };
}

function openTestInode(inode) {
  const result = inode.path_open(0, 0n, 0);
  expect(result.ret).toBe(0);
  expect(result.fd_obj).toBeTruthy();
  return result.fd_obj;
}

describe('WasiRandomAccessFileInode fd_close handling', () => {
  it('closes close-on-last-fd backing files only after the final fd closes', () => {
    const file = createTestWasiBackingFile();
    const inode = __createWasiRandomAccessFileInodeForTest(file, {
      closeOnLastFdClose: true,
      readonly: true,
    });
    const first = openTestInode(inode);
    const second = openTestInode(inode);

    expect(first.fd_close()).toBe(0);
    expect(file.snapshot().closeCount).toBe(0);

    expect(second.fd_close()).toBe(0);
    expect(file.snapshot().closeCount).toBe(1);

    expect(second.fd_close()).toBe(0);
    expect(file.snapshot().closeCount).toBe(1);
    expect(first.fd_read(1).ret).not.toBe(0);
  });

  it('reopens close-on-last-fd backing files for a later open', () => {
    const file = createTestWasiBackingFile();
    const inode = __createWasiRandomAccessFileInodeForTest(file, {
      closeOnLastFdClose: true,
      readonly: true,
    });
    const first = openTestInode(inode);
    expect(first.fd_close()).toBe(0);
    expect(file.snapshot()).toMatchObject({ closeCount: 1, closed: true });

    const second = openTestInode(inode);
    const read = second.fd_read(4);

    expect(read.ret).toBe(0);
    expect(Array.from(read.data)).toEqual([0, 1, 2, 3]);
    expect(file.snapshot()).toMatchObject({ closeCount: 1, closed: false });
  });

  it('leaves default backing files open after fd_close', () => {
    const file = createTestWasiBackingFile();
    const inode = __createWasiRandomAccessFileInodeForTest(file, { readonly: true });
    const fd = openTestInode(inode);

    expect(fd.fd_close()).toBe(0);

    expect(file.snapshot()).toMatchObject({ closeCount: 0, closed: false });
  });

  it('flushes buffered writes on fd_close without closing default backing files', () => {
    const file = createTestWasiBackingFile({ supportsBufferedSequentialWrite: true });
    const inode = __createWasiRandomAccessFileInodeForTest(file);
    const fd = openTestInode(inode);

    expect(fd.fd_write(new Uint8Array([3, 1, 4])).ret).toBe(0);
    expect(file.snapshot().writes).toEqual([]);
    expect(fd.fd_close()).toBe(0);

    expect(file.snapshot()).toMatchObject({
      closeCount: 0,
      writes: [{ bytes: [3, 1, 4], offset: 0 }],
    });
  });
});
