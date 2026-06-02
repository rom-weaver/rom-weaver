import { bench, describe } from 'vitest';
import {
  __createBrowserOpfsRandomAccessFileForTest,
} from '../src/rom-weaver-browser-opfs-api.ts';
import { createBenchOptions, MIB, readBooleanEnv, readPositiveIntEnv } from './browser-bench-shared.mjs';
import { createMockSyncAccessHandle } from './opfs-mock-sync-handle.mjs';

// CPU-overhead micro-bench for BrowserOpfsRandomAccessFile's read-cache/write bookkeeping. It runs
// against an in-memory mock handle (the real FileSystemSyncAccessHandle is worker-only), so it does
// NOT measure OPFS syscall latency — that is covered end-to-end by browser-worker-client.bench.mjs
// (checksum = read-heavy, extract = random reads, compress = write-heavy). The purpose here is to
// guard the cache-hit, cache-bypass, and write-invalidation code paths against CPU regressions when
// the cache geometry / invalidation strategy changes.

const FIXTURE_MIB = readPositiveIntEnv('ROM_WEAVER_WASM_BENCH_OPFS_IO_FIXTURE_MIB', 16);
const BENCH_OPTIONS = createBenchOptions();
const BENCH_LOG = readBooleanEnv('ROM_WEAVER_WASM_BENCH_OPFS_IO_LOG', false);

const READ_CACHE_BLOCK_BYTES = 1 * MIB;
const SMALL_READ_BYTES = 64 * 1024;
const LARGE_READ_BYTES = 512 * 1024;
const SMALL_WRITE_BYTES = 64 * 1024;
const LARGE_WRITE_BYTES = 4 * MIB;

let fixtureBytes = 0;
let readFile = null;
let writeFile = null;
const smallReadScratch = new Uint8Array(SMALL_READ_BYTES);
const largeReadScratch = new Uint8Array(LARGE_READ_BYTES);
const smallWritePayload = new Uint8Array(SMALL_WRITE_BYTES).fill(0xa5);
const largeWritePayload = new Uint8Array(LARGE_WRITE_BYTES).fill(0x5a);

// Deterministic offset stepping keeps successive iterations comparable without Math.random.
let smallReadCursor = 0;
let largeReadCursor = 0;
let writeCursor = 0;

function patternByte(offset) {
  return (offset * 31 + 7) & 0xff;
}

function benchLog(message, fields) {
  if (!BENCH_LOG) return;
  // Trace-style line so the cache micro-bench is debuggable when something regresses.
  console.info(`[opfs-io-bench] ${message}`, fields ?? {});
}

function ensureReady() {
  if (readFile && writeFile) return;
  fixtureBytes = FIXTURE_MIB * MIB;
  readFile = __createBrowserOpfsRandomAccessFileForTest(
    createMockSyncAccessHandle({ size: fixtureBytes, fill: patternByte }),
  );
  writeFile = __createBrowserOpfsRandomAccessFileForTest(
    createMockSyncAccessHandle({ size: fixtureBytes, fill: patternByte }),
  );
  benchLog('initialized', { fixtureBytes, readCacheBlockBytes: READ_CACHE_BLOCK_BYTES });
}

describe('rom-weaver-wasm OPFS read-cache CPU micro-benchmarks (mock handle)', () => {
  bench('read small <=256KiB within one block (cache-hit path)', () => {
    ensureReady();
    // Stay inside a single 1 MiB block so the read is cache-eligible and mostly hits.
    const blockBase = (smallReadCursor % 8) * READ_CACHE_BLOCK_BYTES;
    smallReadCursor += 1;
    readFile.readAt(blockBase + 4096, smallReadScratch);
  }, BENCH_OPTIONS);

  bench('read 512KiB request (>256KiB, bypasses cache)', () => {
    ensureReady();
    const offset = (largeReadCursor % 8) * READ_CACHE_BLOCK_BYTES;
    largeReadCursor += 1;
    readFile.readAt(offset, largeReadScratch);
  }, BENCH_OPTIONS);

  bench('write 64KiB then read same region (invalidation path)', () => {
    ensureReady();
    const offset = (writeCursor % 8) * READ_CACHE_BLOCK_BYTES;
    writeCursor += 1;
    writeFile.writeAt(offset, smallWritePayload);
    writeFile.readAt(offset, smallReadScratch);
  }, BENCH_OPTIONS);

  bench('write 4MiB block', () => {
    ensureReady();
    const offset = (writeCursor % 4) * LARGE_WRITE_BYTES;
    writeCursor += 1;
    writeFile.writeAt(offset, largeWritePayload);
  }, BENCH_OPTIONS);

  // The case targeted invalidation (2a) is meant to win: a warmed read block should survive a write
  // to an unrelated block. Today writeAt clears the whole cache, forcing a full block re-read here.
  bench('write elsewhere then re-read warmed region (cross-region invalidation)', () => {
    ensureReady();
    const readOffset = 0;
    const writeOffset = (writeCursor % 4 + 4) * READ_CACHE_BLOCK_BYTES;
    writeCursor += 1;
    writeFile.readAt(readOffset, smallReadScratch);
    writeFile.writeAt(writeOffset, smallWritePayload);
    writeFile.readAt(readOffset, smallReadScratch);
  }, BENCH_OPTIONS);
});
