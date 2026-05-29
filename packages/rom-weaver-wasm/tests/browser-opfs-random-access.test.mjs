import { beforeEach, describe, expect, it } from 'vitest';
import {
  __createBrowserOpfsRandomAccessFileForTest,
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

let file = null;

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
});
