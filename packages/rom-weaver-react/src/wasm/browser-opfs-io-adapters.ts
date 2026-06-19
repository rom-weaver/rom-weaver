const RANDOM_ACCESS_READ_CACHE_BLOCK_BYTES = 1024 * 1024;
const VIRTUAL_BLOB_READ_CACHE_BLOCK_BYTES = 2 * 1024 * 1024;
const VIRTUAL_BLOB_READ_CACHE_BLOCK_COUNT = 8;
const VIRTUAL_BLOB_READ_CACHE_MAX_REQUEST_BYTES = 512 * 1024;

type FileReaderSyncLike = {
  readAsArrayBuffer(blob: Blob): ArrayBuffer;
};

declare const FileReaderSync: {
  new (): FileReaderSyncLike;
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

// Fixed-capacity, block-aligned LRU read cache used by BrowserVirtualRandomAccessFile. Behavior (block
// size/count, LRU eviction, hit/miss accounting, and the fill-on-miss path) is generic — only the
// backing read and the bumped ioStats counters differ, both injected via options. This is a hot path.
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

class BrowserVirtualRandomAccessFile {
  closed: boolean;
  ioStats: RandomAccessFileIoStats;
  readCache: LruReadCache;
  reader: FileReaderSyncLike | null;
  source: unknown;
  supportsDirectWasmRead: boolean;

  constructor(source: unknown) {
    this.source = source;
    this.reader = isBlobLike(source) ? new FileReaderSync() : null;
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
  }

  readAt(offset: unknown, dst: Uint8Array): number {
    if (this.closed) return 0;
    const start = Number(offset);
    if (!Number.isFinite(start) || start < 0 || start >= this.size()) return 0;
    const length = Math.min(dst.byteLength, this.size() - start);
    if (length <= 0) return 0;
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

  writeAt(): number {
    return 0;
  }

  size(): number {
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

function monotonicNowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export {
  addRandomAccessFileIoStats,
  BrowserVirtualRandomAccessFile,
  createRandomAccessFileIoStats,
  isBlobLike,
  randomAccessFileIoStatsHaveData,
};
