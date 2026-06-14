import {
  VIRTUAL_FILE_CONTROL_BYTES_READ_INDEX,
  VIRTUAL_FILE_CONTROL_LENGTH_INDEX,
  VIRTUAL_FILE_CONTROL_OFFSET_HIGH_INDEX,
  VIRTUAL_FILE_CONTROL_OFFSET_LOW_INDEX,
  VIRTUAL_FILE_CONTROL_STATE_INDEX,
  VIRTUAL_FILE_CONTROL_STATUS_INDEX,
  VIRTUAL_FILE_CONTROL_WORD_COUNT,
  VIRTUAL_FILE_STATE_CONSUMER_LOCKED,
  VIRTUAL_FILE_STATE_DONE,
  VIRTUAL_FILE_STATE_IDLE,
  VIRTUAL_FILE_STATE_REQUESTED,
  VIRTUAL_FILE_STATUS_OK,
} from "./browser-virtual-file-protocol.ts";
import { formatErrorForTrace } from "./workers/worker-trace-format.ts";

const RANDOM_ACCESS_READ_CACHE_BLOCK_BYTES = 1024 * 1024;
const RANDOM_ACCESS_READ_CACHE_BLOCK_COUNT = 4;
const RANDOM_ACCESS_READ_CACHE_MAX_REQUEST_BYTES = 256 * 1024;
const VIRTUAL_BLOB_READ_CACHE_BLOCK_BYTES = 2 * 1024 * 1024;
const VIRTUAL_BLOB_READ_CACHE_BLOCK_COUNT = 8;
const VIRTUAL_BLOB_READ_CACHE_MAX_REQUEST_BYTES = 512 * 1024;
const ATOMICS_WAIT_SLICE_MS = 100;
const ATOMICS_WAIT_TIMEOUT_MS = 8000;
const VIRTUAL_FILE_PROXY_TRACE_READ_LIMIT = 12;
const VIRTUAL_FILE_PROXY_READ_TIMEOUT_MS = 12_000;
const VIRTUAL_FILE_PROXY_SLOT_ACQUIRE_TIMEOUT_MS = ATOMICS_WAIT_TIMEOUT_MS;

type TraceLine = (line: string) => void;
type AtomicsWaitResult = "changed" | "timed-out";

type FileReaderSyncLike = {
  readAsArrayBuffer(blob: Blob): ArrayBuffer;
};

declare const FileReaderSync: {
  new (): FileReaderSyncLike;
};

type SyncAccessHandleLike = {
  close(): void;
  flush(): void;
  getSize(): number;
  read(buffer: Uint8Array, options?: { at?: number }): number;
  truncate(size: number): void;
  write(buffer: Uint8Array, options?: { at?: number }): number;
};

type BrowserOpfsRandomAccessFileOptions = {
  scratchName?: string | null;
};

type BrowserVirtualRandomAccessFileOptions = {
  trace?: TraceLine | null;
};

type ReadCacheBlock = {
  bytes: Uint8Array;
  lastUsed: number;
  length: number;
  start: number;
};

type RandomAccessFileIoStats = ReturnType<typeof createRandomAccessFileIoStats>;

// Which ioStats counters a read cache bumps. The OPFS-backed and virtual-Blob-backed adapters keep
// separate counter families (opfsCache*/blobCache*) so the trace can attribute reads to the right
// backend; the cache logic is otherwise identical.
type ReadCacheStatKeys = {
  fillBytes: keyof RandomAccessFileIoStats;
  hitBytes: keyof RandomAccessFileIoStats;
  hits: keyof RandomAccessFileIoStats;
  misses: keyof RandomAccessFileIoStats;
};

type ReadCacheOptions = {
  blockBytes: number;
  blockCount: number;
  // Reads the backing store into `buf` starting at `blockStart`, returning bytes actually read. The
  // adapter owns this so the cache stays oblivious to OPFS vs Blob/proxy I/O.
  fill: (blockStart: number, buf: Uint8Array) => number;
  reusableBlockErrorMessage: string;
  statKeys: ReadCacheStatKeys;
  stats: RandomAccessFileIoStats;
};

// Fixed-capacity, block-aligned LRU read cache shared by BrowserOpfsRandomAccessFile and
// BrowserVirtualRandomAccessFile. Behavior (block size/count, LRU eviction, hit/miss accounting, and
// the fill-on-miss path) is exactly what each adapter open-coded before — only the backing read and
// the bumped ioStats counters differ, both injected via options. This is a hot path: keep it identical.
class LruReadCache {
  private readonly blockBytes: number;
  private readonly blockCount: number;
  private readonly blocks: ReadCacheBlock[];
  private readonly fill: (blockStart: number, buf: Uint8Array) => number;
  private readonly reusableBlockErrorMessage: string;
  private readonly statKeys: ReadCacheStatKeys;
  private readonly stats: RandomAccessFileIoStats;
  private tick: number;

  constructor(options: ReadCacheOptions) {
    this.blockBytes = options.blockBytes;
    this.blockCount = options.blockCount;
    this.fill = options.fill;
    this.reusableBlockErrorMessage = options.reusableBlockErrorMessage;
    this.statKeys = options.statKeys;
    this.stats = options.stats;
    this.blocks = [];
    this.tick = 0;
  }

  fitsWithinBlock(offset: number, byteLength: number): boolean {
    return readFitsWithinCacheBlock(offset, byteLength, this.blockBytes);
  }

  read(offset: number, dst: Uint8Array): number | null {
    const cached = this.findBlock(offset);
    if (cached) {
      const bytesRead = this.copyBlock(cached, offset, dst);
      this.stats[this.statKeys.hits] += 1;
      this.stats[this.statKeys.hitBytes] += bytesRead;
      return bytesRead;
    }

    const blockStart = Math.floor(offset / this.blockBytes) * this.blockBytes;
    const block = this.acquireBlock();
    this.stats[this.statKeys.misses] += 1;
    const bytesRead = this.fill(blockStart, block.bytes);
    if (bytesRead <= 0) return bytesRead;
    this.stats[this.statKeys.fillBytes] += bytesRead;
    block.start = blockStart;
    block.length = Math.min(bytesRead, block.bytes.byteLength);
    block.lastUsed = ++this.tick;
    return this.copyBlock(block, offset, dst);
  }

  findBlock(offset: number): ReadCacheBlock | null {
    for (const block of this.blocks) {
      if (offset >= block.start && offset < block.start + block.length) {
        block.lastUsed = ++this.tick;
        return block;
      }
    }
    return null;
  }

  acquireBlock(): ReadCacheBlock {
    if (this.blocks.length < this.blockCount) {
      const block = {
        bytes: new Uint8Array(this.blockBytes),
        lastUsed: 0,
        length: 0,
        start: 0,
      };
      this.blocks.push(block);
      return block;
    }
    let oldest = this.blocks[0];
    if (!oldest) throw new Error(this.reusableBlockErrorMessage);
    for (const block of this.blocks) {
      if (block.lastUsed < oldest.lastUsed) oldest = block;
    }
    return oldest;
  }

  copyBlock(block: ReadCacheBlock, offset: number, dst: Uint8Array): number {
    const relativeOffset = offset - block.start;
    if (relativeOffset < 0 || relativeOffset >= block.length) return 0;
    const available = block.length - relativeOffset;
    const length = Math.min(dst.byteLength, available);
    if (length <= 0) return 0;
    dst.set(block.bytes.subarray(relativeOffset, relativeOffset + length));
    return length;
  }

  clear(): void {
    this.blocks.length = 0;
  }

  // Empties any cache block whose [start, start+length) overlaps [start, end). A block is reset to
  // empty (length 0) rather than removed so its backing buffer can be reused by acquireBlock.
  invalidateRange(start: number, end: number): void {
    if (this.blocks.length === 0) return;
    for (const block of this.blocks) {
      if (block.length <= 0) continue;
      const blockEnd = block.start + block.length;
      if (start < blockEnd && end > block.start) {
        block.start = 0;
        block.length = 0;
        block.lastUsed = 0;
      }
    }
  }
}

type VirtualFileProxySlot = {
  controlBuffer: SharedArrayBuffer;
  dataBuffer: SharedArrayBuffer;
};

type VirtualFileProxy = {
  id: string;
  size: number;
  slots: VirtualFileProxySlot[];
};

type VirtualFileProxySlotView = {
  control: Int32Array<SharedArrayBuffer>;
  data: Uint8Array<SharedArrayBuffer>;
};

class BrowserOpfsRandomAccessFile {
  closed: boolean;
  dirty: boolean;
  ioStats: RandomAccessFileIoStats;
  logicalSize: number | null;
  readCache: LruReadCache;
  scratchName: string | null;
  supportsBufferedSequentialWrite: boolean;
  supportsDirectWasmRead: boolean;
  syncHandle: SyncAccessHandleLike;

  constructor(syncHandle: SyncAccessHandleLike, options: BrowserOpfsRandomAccessFileOptions = {}) {
    this.syncHandle = syncHandle;
    this.scratchName = options.scratchName ?? null;
    this.dirty = false;
    this.supportsDirectWasmRead = true;
    this.supportsBufferedSequentialWrite = true;
    this.ioStats = createRandomAccessFileIoStats();
    this.readCache = new LruReadCache({
      blockBytes: RANDOM_ACCESS_READ_CACHE_BLOCK_BYTES,
      blockCount: RANDOM_ACCESS_READ_CACHE_BLOCK_COUNT,
      fill: (blockStart, buf) =>
        this.readSyncAccessHandleAt(blockStart, buf, Math.min(buf.byteLength, this.size() - blockStart)),
      reusableBlockErrorMessage: "OPFS read cache has no reusable blocks",
      statKeys: {
        fillBytes: "opfsCacheFillBytes",
        hitBytes: "opfsCacheHitBytes",
        hits: "opfsCacheHits",
        misses: "opfsCacheMisses",
      },
      stats: this.ioStats,
    });
    this.logicalSize = null;
    this.closed = false;
  }

  readAt(offset: unknown, dst: Uint8Array): number {
    if (dst.byteLength <= 0) return 0;
    const start = Number(offset);
    if (!Number.isFinite(start) || start < 0) return 0;
    if (
      dst.byteLength <= RANDOM_ACCESS_READ_CACHE_MAX_REQUEST_BYTES &&
      this.readCache.fitsWithinBlock(start, dst.byteLength)
    ) {
      const cachedRead = this.readCache.read(start, dst);
      if (cachedRead !== null) return cachedRead;
    }
    return this.readSyncAccessHandleAt(start, dst);
  }

  writeAt(offset: unknown, src: Uint8Array): number {
    const start = Number(offset);
    const callStartMs = monotonicNowMs();
    const written = this.syncHandle.write(src, { at: start });
    this.ioStats.opfsWriteCalls += 1;
    this.ioStats.opfsWriteMs += monotonicNowMs() - callStartMs;
    this.ioStats.opfsWriteBytes += Math.max(0, Math.min(Number(written) || 0, src.byteLength));
    if (written > 0) {
      this.dirty = true;
      this.logicalSize = Math.max(this.logicalSize ?? 0, start + written);
      // Only drop cache blocks that overlap the bytes just written, so an interleaved
      // read/modify/write workload keeps unrelated cached blocks instead of refetching them all.
      this.readCache.invalidateRange(start, start + written);
    }
    return written;
  }

  size(): number {
    return Math.max(this.syncHandle.getSize(), this.logicalSize ?? 0);
  }

  allocateAtLeast(size: unknown): void {
    const normalizedSize = Math.max(0, Number(size) || 0);
    if (normalizedSize <= this.size()) return;
    this.logicalSize = normalizedSize;
  }

  truncate(size: unknown): void {
    const normalizedSize = Number(size);
    if (this.syncHandle.getSize() === normalizedSize && this.logicalSize === normalizedSize) return;
    // A shrink drops cached bytes at/after the new end; a grow only zero-fills past the old end.
    // Either way, invalidating [newSize, infinity) is sufficient and leaves earlier cached bytes valid.
    this.readCache.invalidateRange(normalizedSize, Number.POSITIVE_INFINITY);
    this.syncHandle.truncate(normalizedSize);
    this.logicalSize = normalizedSize;
    this.dirty = true;
  }

  readSyncAccessHandleAt(offset: number, dst: Uint8Array, requestedLength = dst.byteLength): number {
    const logicalSize = this.size();
    const length = Math.max(0, Math.min(requestedLength, dst.byteLength, logicalSize - offset));
    if (length <= 0) return 0;
    const physicalSize = this.syncHandle.getSize();
    const physicalLength = offset < physicalSize ? Math.min(length, physicalSize - offset) : 0;
    const callStartMs = monotonicNowMs();
    const bytesRead =
      physicalLength > 0 ? readSyncAccessHandleFully(this.syncHandle, dst.subarray(0, physicalLength), offset) : 0;
    const totalRead = bytesRead < length ? length : bytesRead;
    if (bytesRead < length) dst.fill(0, bytesRead, length);
    this.ioStats.opfsReadCalls += 1;
    this.ioStats.opfsReadMs += monotonicNowMs() - callStartMs;
    this.ioStats.opfsReadBytes += Math.max(0, Math.min(Number(totalRead) || 0, dst.byteLength));
    return totalRead;
  }

  flush(): void {
    if (!this.dirty) return;
    if (this.scratchName) {
      this.dirty = false;
      return;
    }
    const callStartMs = monotonicNowMs();
    this.syncHandle.flush();
    this.ioStats.opfsFlushCalls += 1;
    this.ioStats.opfsFlushMs += monotonicNowMs() - callStartMs;
    this.dirty = false;
  }

  close(): void {
    if (this.closed) return;
    try {
      this.readCache.clear();
      this.syncHandle.close();
    } finally {
      this.closed = true;
      this.dirty = false;
    }
  }

  snapshotIoStats(): RandomAccessFileIoStats {
    return { ...this.ioStats };
  }
}

class BrowserMemoryRandomAccessFile {
  bytes: Uint8Array;
  closed: boolean;
  length: number;
  supportsDirectWasmRead: boolean;

  constructor(initialCapacity: unknown = 0) {
    this.bytes = new Uint8Array(Math.max(0, Number(initialCapacity) || 0));
    this.length = 0;
    this.supportsDirectWasmRead = true;
    this.closed = false;
  }

  readAt(offset: unknown, dst: Uint8Array): number {
    if (this.closed) return 0;
    const start = Number(offset);
    if (!Number.isFinite(start) || start < 0 || start >= this.length) return 0;
    const length = Math.min(dst.byteLength, this.length - start);
    if (length <= 0) return 0;
    dst.set(this.bytes.subarray(start, start + length));
    return length;
  }

  writeAt(offset: unknown, src: Uint8Array): number {
    if (this.closed) return 0;
    const start = Number(offset);
    if (!Number.isFinite(start) || start < 0) return 0;
    const end = start + src.byteLength;
    this.ensureCapacity(end);
    this.bytes.set(src, start);
    this.length = Math.max(this.length, end);
    return src.byteLength;
  }

  size(): number {
    return this.length;
  }

  truncate(size: unknown): void {
    const nextSize = Math.max(0, Number(size) || 0);
    this.ensureCapacity(nextSize);
    if (nextSize > this.length) this.bytes.fill(0, this.length, nextSize);
    this.length = nextSize;
  }

  flush(): void {
    // no-op: in-memory adapter has nothing to flush
  }

  close(): void {
    this.closed = true;
  }

  ensureCapacity(size: number): void {
    if (size <= this.bytes.byteLength) return;
    let nextCapacity = Math.max(1024, this.bytes.byteLength);
    while (nextCapacity < size) nextCapacity *= 2;
    const next = new Uint8Array(nextCapacity);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
  }
}

class BrowserVirtualRandomAccessFile {
  closed: boolean;
  ioStats: RandomAccessFileIoStats;
  proxy: VirtualFileProxy | null;
  proxyFailed: boolean;
  readCache: LruReadCache;
  readCount: number;
  reader: FileReaderSyncLike | null;
  slots: VirtualFileProxySlotView[];
  source: unknown;
  supportsDirectWasmRead: boolean;
  trace: TraceLine | null;

  constructor(source: unknown, options: BrowserVirtualRandomAccessFileOptions = {}) {
    this.source = source;
    this.proxy = isVirtualFileProxy(source) ? source : null;
    this.reader = isBlobLike(source) ? new FileReaderSync() : null;
    this.slots = this.proxy ? normalizeVirtualFileProxySlots(this.proxy) : [];
    this.trace = typeof options.trace === "function" ? options.trace : null;
    this.readCount = 0;
    this.ioStats = createRandomAccessFileIoStats();
    this.readCache = new LruReadCache({
      blockBytes: VIRTUAL_BLOB_READ_CACHE_BLOCK_BYTES,
      blockCount: VIRTUAL_BLOB_READ_CACHE_BLOCK_COUNT,
      fill: (blockStart, buf) => this.readBlobAt(blockStart, buf, Math.min(buf.byteLength, this.size() - blockStart)),
      reusableBlockErrorMessage: "virtual read cache has no reusable blocks",
      statKeys: {
        fillBytes: "blobCacheFillBytes",
        hitBytes: "blobCacheHitBytes",
        hits: "blobCacheHits",
        misses: "blobCacheMisses",
      },
      stats: this.ioStats,
    });
    this.supportsDirectWasmRead = true;
    this.closed = false;
    // Set once a proxy read times out: the producer may still own a slot, so the proxy stops
    // recycling slots and fails fast instead of risking a stale-data read on a reused slot.
    this.proxyFailed = false;
  }

  readAt(offset: unknown, dst: Uint8Array): number {
    if (this.closed) return 0;
    this.readCount += 1;
    const readIndex = this.readCount;
    const start = Number(offset);
    if (!Number.isFinite(start) || start < 0 || start >= this.size()) return 0;
    const length = Math.min(dst.byteLength, this.size() - start);
    if (length <= 0) return 0;
    if (this.proxy) return this.readProxyAt(start, dst, length, readIndex);
    if (this.source instanceof Uint8Array) {
      dst.set(this.source.subarray(start, start + length));
      return length;
    }
    if (this.source instanceof ArrayBuffer) {
      dst.set(new Uint8Array(this.source, start, length));
      return length;
    }
    if (
      dst.byteLength <= VIRTUAL_BLOB_READ_CACHE_MAX_REQUEST_BYTES &&
      this.readCache.fitsWithinBlock(start, dst.byteLength)
    ) {
      const cachedRead = this.readCache.read(start, dst);
      if (cachedRead !== null) return cachedRead;
    }
    return this.readBlobAt(start, dst, length);
  }

  readBlobAt(offset: number, dst: Uint8Array, requestedLength = dst.byteLength): number {
    const length = Math.max(0, Math.min(requestedLength, dst.byteLength, this.size() - offset));
    if (length <= 0) return 0;
    if (!(this.reader && isBlobLike(this.source))) return 0;
    const callStartMs = monotonicNowMs();
    const bytes = new Uint8Array(this.reader.readAsArrayBuffer(this.source.slice(offset, offset + length)));
    this.ioStats.blobReadCalls += 1;
    this.ioStats.blobReadMs += monotonicNowMs() - callStartMs;
    this.ioStats.blobReadBytes += bytes.byteLength;
    dst.set(bytes);
    return bytes.byteLength;
  }

  readProxyAt(offset: number, dst: Uint8Array, requestedLength: number, readIndex: number): number {
    const proxy = this.proxy;
    if (!proxy) return 0;
    const shouldTrace = this.shouldTraceRead(readIndex);
    if (shouldTrace) {
      this.trace?.(`[browser-opfs] virtual proxy slot acquire start id=${proxy.id} read=${readIndex}`);
    }
    let slot: VirtualFileProxySlotView | null = null;
    let abandonedSlot = false;
    try {
      slot = this.acquireProxySlot();
      if (shouldTrace) {
        this.trace?.(`[browser-opfs] virtual proxy slot acquired id=${proxy.id} read=${readIndex}`);
      }
      const length = Math.min(requestedLength, slot.data.byteLength);
      if (length <= 0) return 0;
      if (shouldTrace) {
        this.trace?.(
          `[browser-opfs] virtual proxy read request id=${proxy.id} read=${readIndex} offset=${offset} length=${length}`,
        );
      }
      const low = offset >>> 0;
      const high = Math.floor(offset / 2 ** 32) >>> 0;
      Atomics.store(slot.control, VIRTUAL_FILE_CONTROL_OFFSET_LOW_INDEX, low);
      Atomics.store(slot.control, VIRTUAL_FILE_CONTROL_OFFSET_HIGH_INDEX, high);
      Atomics.store(slot.control, VIRTUAL_FILE_CONTROL_LENGTH_INDEX, length);
      Atomics.store(slot.control, VIRTUAL_FILE_CONTROL_BYTES_READ_INDEX, 0);
      Atomics.store(slot.control, VIRTUAL_FILE_CONTROL_STATUS_INDEX, VIRTUAL_FILE_STATUS_OK);
      Atomics.store(slot.control, VIRTUAL_FILE_CONTROL_STATE_INDEX, VIRTUAL_FILE_STATE_REQUESTED);
      Atomics.notify(slot.control, VIRTUAL_FILE_CONTROL_STATE_INDEX, 1);
      const deadline = createWaitDeadline(VIRTUAL_FILE_PROXY_READ_TIMEOUT_MS);
      while (true) {
        const state = Atomics.load(slot.control, VIRTUAL_FILE_CONTROL_STATE_INDEX);
        if (state === VIRTUAL_FILE_STATE_DONE) break;
        const result = waitForAtomicsStateChange(slot.control, VIRTUAL_FILE_CONTROL_STATE_INDEX, state, { deadline });
        if (result === "timed-out") {
          // The producer may still own this slot (mid read). Poison the proxy and do not recycle
          // the slot below, so a stale producer completion can never satisfy a later request.
          abandonedSlot = true;
          this.proxyFailed = true;
          throw new Error(`virtual file read timed out for ${proxy.id}`);
        }
      }
      if (Atomics.load(slot.control, VIRTUAL_FILE_CONTROL_STATUS_INDEX) !== VIRTUAL_FILE_STATUS_OK) {
        throw new Error(`virtual file read failed for ${proxy.id}`);
      }
      const bytesRead = Math.max(
        0,
        Math.min(Atomics.load(slot.control, VIRTUAL_FILE_CONTROL_BYTES_READ_INDEX), length),
      );
      if (bytesRead > 0) dst.set(slot.data.subarray(0, bytesRead));
      if (shouldTrace) {
        this.trace?.(`[browser-opfs] virtual proxy read done id=${proxy.id} read=${readIndex} bytes=${bytesRead}`);
      }
      return bytesRead;
    } catch (error) {
      this.trace?.(
        `[browser-opfs] virtual proxy read failed id=${proxy.id} read=${readIndex} ${formatErrorForTrace(error)}`,
      );
      throw error;
    } finally {
      if (slot && !abandonedSlot) this.releaseProxySlot(slot);
    }
  }

  shouldTraceRead(readIndex: number): boolean {
    return readIndex <= VIRTUAL_FILE_PROXY_TRACE_READ_LIMIT || readIndex % 128 === 0;
  }

  acquireProxySlot(): VirtualFileProxySlotView {
    if (this.proxyFailed) {
      throw new Error(`virtual file proxy is no longer usable for ${this.proxy?.id ?? "unknown"}`);
    }
    const deadline = createWaitDeadline(VIRTUAL_FILE_PROXY_SLOT_ACQUIRE_TIMEOUT_MS);
    while (true) {
      for (const slot of this.slots) {
        const state = Atomics.load(slot.control, VIRTUAL_FILE_CONTROL_STATE_INDEX);
        if (state === VIRTUAL_FILE_STATE_DONE) {
          this.reclaimStaleDoneProxySlot(slot);
          continue;
        }
        if (
          Atomics.compareExchange(
            slot.control,
            VIRTUAL_FILE_CONTROL_STATE_INDEX,
            VIRTUAL_FILE_STATE_IDLE,
            VIRTUAL_FILE_STATE_CONSUMER_LOCKED,
          ) === VIRTUAL_FILE_STATE_IDLE
        ) {
          return slot;
        }
      }
      const first = this.slots[0];
      if (!first) throw new Error(`virtual file proxy has no read slots for ${this.proxy?.id ?? "unknown"}`);
      const state = Atomics.load(first.control, VIRTUAL_FILE_CONTROL_STATE_INDEX);
      if (state === VIRTUAL_FILE_STATE_DONE) {
        this.reclaimStaleDoneProxySlot(first);
        continue;
      }
      const waitResult = waitForAtomicsStateChange(first.control, VIRTUAL_FILE_CONTROL_STATE_INDEX, state, {
        deadline,
      });
      if (waitResult === "timed-out") {
        this.proxyFailed = true;
        throw new Error(`virtual file read slot acquisition timed out for ${this.proxy?.id ?? "unknown"}`);
      }
    }
  }

  reclaimStaleDoneProxySlot(slot: VirtualFileProxySlotView): void {
    if (
      Atomics.compareExchange(
        slot.control,
        VIRTUAL_FILE_CONTROL_STATE_INDEX,
        VIRTUAL_FILE_STATE_DONE,
        VIRTUAL_FILE_STATE_IDLE,
      ) === VIRTUAL_FILE_STATE_DONE
    ) {
      Atomics.notify(slot.control, VIRTUAL_FILE_CONTROL_STATE_INDEX, 1);
    }
  }

  releaseProxySlot(slot: VirtualFileProxySlotView): void {
    Atomics.store(slot.control, VIRTUAL_FILE_CONTROL_STATE_INDEX, VIRTUAL_FILE_STATE_IDLE);
    Atomics.notify(slot.control, VIRTUAL_FILE_CONTROL_STATE_INDEX, 1);
  }

  writeAt(): number {
    return 0;
  }

  size(): number {
    if (this.proxy) return Number(this.proxy.size || 0);
    if (this.source instanceof Uint8Array || this.source instanceof ArrayBuffer) {
      return this.source.byteLength;
    }
    return isBlobLike(this.source) ? Number(this.source.size || 0) : 0;
  }

  truncate(): void {
    // no-op: virtual read-only files cannot be resized
  }

  flush(): void {
    // no-op: virtual read-only files have nothing to flush
  }

  close(): void {
    if (this.closed) return;
    this.readCache.clear();
    this.reader = null;
    this.closed = true;
  }

  reopen(): void {
    if (!this.reader && isBlobLike(this.source)) this.reader = new FileReaderSync();
    this.closed = false;
  }

  snapshotIoStats(): RandomAccessFileIoStats {
    return { ...this.ioStats };
  }
}

function createRandomAccessFileIoStats() {
  return {
    blobCacheFillBytes: 0,
    blobCacheHitBytes: 0,
    blobCacheHits: 0,
    blobCacheMisses: 0,
    blobReadBytes: 0,
    blobReadCalls: 0,
    blobReadMs: 0,
    opfsCacheFillBytes: 0,
    opfsCacheHitBytes: 0,
    opfsCacheHits: 0,
    opfsCacheMisses: 0,
    opfsFlushCalls: 0,
    opfsFlushMs: 0,
    opfsReadBytes: 0,
    opfsReadCalls: 0,
    opfsReadMs: 0,
    opfsWriteBytes: 0,
    opfsWriteCalls: 0,
    opfsWriteMs: 0,
  };
}

function addRandomAccessFileIoStats(
  target: RandomAccessFileIoStats,
  source: Partial<Record<keyof RandomAccessFileIoStats, unknown>> | null | undefined,
) {
  if (!source || typeof source !== "object") return;
  for (const key of Object.keys(target) as Array<keyof RandomAccessFileIoStats>) {
    target[key] += Number(source[key]) || 0;
  }
}

function randomAccessFileIoStatsHaveData(stats: RandomAccessFileIoStats): boolean {
  return Object.values(stats).some((value) => value > 0);
}

function isVirtualFileProxy(value: unknown): value is VirtualFileProxy {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<VirtualFileProxy>;
  return Boolean(
    typeof record.id === "string" &&
      Array.isArray(record.slots) &&
      Number.isFinite(Number(record.size)) &&
      Number(record.size) >= 0,
  );
}

function normalizeVirtualFileProxySlots(proxy: VirtualFileProxy): VirtualFileProxySlotView[] {
  const slots: VirtualFileProxySlotView[] = [];
  for (const slot of proxy.slots) {
    if (!(isSharedArrayBufferLike(slot?.controlBuffer) && isSharedArrayBufferLike(slot?.dataBuffer))) continue;
    const control = new Int32Array(slot.controlBuffer);
    if (control.length < VIRTUAL_FILE_CONTROL_WORD_COUNT) continue;
    slots.push({
      control,
      data: new Uint8Array(slot.dataBuffer),
    });
  }
  if (slots.length === 0) {
    throw new TypeError(`virtual file proxy has no usable shared read slots: ${proxy.id}`);
  }
  return slots;
}

function isSharedArrayBufferLike(value: unknown): value is SharedArrayBuffer {
  return Boolean(
    typeof SharedArrayBuffer === "function" &&
      value &&
      typeof value === "object" &&
      Object.prototype.toString.call(value) === "[object SharedArrayBuffer]",
  );
}

function isBlobLike(value: unknown): value is Blob {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<Blob>;
  return Boolean(typeof record.slice === "function" && "size" in record);
}

function readFitsWithinCacheBlock(
  offset: number,
  byteLength: number,
  blockBytes = RANDOM_ACCESS_READ_CACHE_BLOCK_BYTES,
): boolean {
  const blockStart = Math.floor(offset / blockBytes) * blockBytes;
  return offset + byteLength <= blockStart + blockBytes;
}

function readSyncAccessHandleFully(syncHandle: SyncAccessHandleLike, dst: Uint8Array, offset: number): number {
  let totalRead = 0;
  while (totalRead < dst.byteLength) {
    const chunk = dst.subarray(totalRead);
    const bytesRead = syncHandle.read(chunk, { at: offset + totalRead });
    if (!(bytesRead > 0)) break;
    totalRead += Math.min(bytesRead, chunk.byteLength);
  }
  return totalRead;
}

function monotonicNowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function createWaitDeadline(timeoutMs: unknown): number {
  const normalized = Math.max(0, Number(timeoutMs) || 0);
  return normalized > 0 ? monotonicNowMs() + normalized : Number.POSITIVE_INFINITY;
}

function waitForAtomicsStateChange(
  control: Int32Array<SharedArrayBuffer>,
  index: number,
  expectedState: number,
  options: { deadline?: number; timeoutMs?: number } = {},
): AtomicsWaitResult {
  const deadline =
    typeof options.deadline === "number"
      ? options.deadline
      : createWaitDeadline(options.timeoutMs ?? ATOMICS_WAIT_TIMEOUT_MS);
  while (Atomics.load(control, index) === expectedState) {
    const remainingMs = deadline - monotonicNowMs();
    if (remainingMs <= 0) return "timed-out";
    const waitMs = Math.min(ATOMICS_WAIT_SLICE_MS, remainingMs);
    const result = Atomics.wait(control, index, expectedState, waitMs);
    if (result === "not-equal") return "changed";
    if (result === "timed-out" && monotonicNowMs() >= deadline) return "timed-out";
  }
  return "changed";
}

// Test-only: lets benches/tests drive the OPFS random-access read/write path (read cache +
// sync access handle) directly without standing up a full WASI mount. Unused in production.
function __createBrowserOpfsRandomAccessFileForTest(
  syncHandle: SyncAccessHandleLike,
  options: BrowserOpfsRandomAccessFileOptions = {},
) {
  return new BrowserOpfsRandomAccessFile(syncHandle, options);
}

// Test-only: lets benches/tests drive the virtual Blob/proxy read path directly.
function __createBrowserVirtualRandomAccessFileForTest(
  source: unknown,
  options: BrowserVirtualRandomAccessFileOptions = {},
) {
  return new BrowserVirtualRandomAccessFile(source, options);
}

export {
  __createBrowserOpfsRandomAccessFileForTest,
  __createBrowserVirtualRandomAccessFileForTest,
  addRandomAccessFileIoStats,
  BrowserMemoryRandomAccessFile,
  BrowserOpfsRandomAccessFile,
  BrowserVirtualRandomAccessFile,
  createRandomAccessFileIoStats,
  isBlobLike,
  isVirtualFileProxy,
  randomAccessFileIoStatsHaveData,
};
