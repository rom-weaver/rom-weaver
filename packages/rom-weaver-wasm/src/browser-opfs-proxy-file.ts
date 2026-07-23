// RandomAccessFileLike adapter backed by the OPFS async proxy.
//
// Marshals file operations to the sole handle-owning proxy, allowing spawned
// WASM threads to access OPFS without violating WebKit's one-handle rule.
//
// Lazily opens handles and caches one read block. Proxy version stamps invalidate
// the cache after any thread writes or truncates.

import type { OpfsProxyClient } from "./browser-opfs-proxy-client.ts";
import { OpfsProxyError } from "./browser-opfs-proxy-client.ts";
import type { RandomAccessFileLike } from "./browser-opfs-wasi-file-inode.ts";

/** Read-cache block tuned above the SAB slot size to reduce Safari Blob calls.
 * Locally sequential decode reads reuse the prefetch; cost is per-handle JS heap. */
const PROXY_READ_CACHE_BLOCK_BYTES = 4 * 1024 * 1024;
/** Requests larger than this are streamed directly rather than cached. */
const PROXY_READ_CACHE_MAX_REQUEST_BYTES = 256 * 1024;
/**
 * Coalesces small sequential decoder writes into 4 MiB proxy writes. Any
 * non-contiguous write or read/metadata operation flushes first for coherence.
 */
const PROXY_WRITE_BUFFER_BYTES = 4 * 1024 * 1024;

export interface BrowserProxyRandomAccessFileOptions {
  /** Create the file if it does not exist (output files). */
  create?: boolean;
  /** The file is writable (selects the proxy's sync-access mode). */
  writable?: boolean;
  /** WASI oflags to forward to the proxy open. */
  oflags?: number;
}

export class BrowserProxyRandomAccessFile implements RandomAccessFileLike {
  readonly supportsDirectWasmRead = true;
  scratchName: string | null = null;
  private readonly client: OpfsProxyClient;
  private readonly guestPath: string;
  private readonly create: boolean;
  private readonly writable: boolean;
  private readonly oflags: number;
  private handleId: number | null = null;
  private closed = false;
  // Single-block read cache, validated by the proxy's per-handle version stamp.
  private cacheBuf: Uint8Array | null = null;
  private cacheStart = -1;
  private cacheLen = 0;
  private cacheVersion = -1;
  // Sequential write-back buffer: coalesces contiguous writes before hitting the proxy.
  private wbuf: Uint8Array | null = null;
  private wbufStart = 0;
  private wbufLen = 0;

  constructor(client: OpfsProxyClient, guestPath: string, options: BrowserProxyRandomAccessFileOptions = {}) {
    this.client = client;
    this.guestPath = guestPath;
    this.create = Boolean(options.create);
    this.writable = Boolean(options.writable);
    this.oflags = options.oflags ?? 0;
  }

  private ensureOpen(): number {
    if (this.closed) throw new OpfsProxyError(`proxy file already closed: ${this.guestPath}`, 8 /* EBADF */);
    if (this.handleId === null) {
      this.handleId = this.client.open(this.guestPath, {
        create: this.create,
        oflags: this.oflags,
        writable: this.writable,
      });
    }
    return this.handleId;
  }

  readAt(offset: number | bigint, dst: Uint8Array): number {
    if (dst.byteLength <= 0) return 0;
    const handleId = this.ensureOpen();
    // Reads must see bytes still sitting in the write-back buffer (and the read cache validates against
    // the proxy version stamp, which only bumps once the write actually lands), so commit first.
    this.flushWriteBuffer();
    const start = Number(offset);
    if (dst.byteLength > PROXY_READ_CACHE_MAX_REQUEST_BYTES) {
      // Large read: stream directly; don't pollute the small-block cache.
      return this.client.readInto(handleId, start, dst);
    }
    const version = this.client.handleVersion(handleId);
    if (version !== this.cacheVersion) {
      this.cacheStart = -1;
      this.cacheLen = 0;
      this.cacheVersion = version;
    }
    if (this.cacheBuf && start >= this.cacheStart && start + dst.byteLength <= this.cacheStart + this.cacheLen) {
      dst.set(this.cacheBuf.subarray(start - this.cacheStart, start - this.cacheStart + dst.byteLength));
      return dst.byteLength;
    }
    if (!this.cacheBuf) this.cacheBuf = new Uint8Array(PROXY_READ_CACHE_BLOCK_BYTES);
    const blockStart = Math.floor(start / PROXY_READ_CACHE_BLOCK_BYTES) * PROXY_READ_CACHE_BLOCK_BYTES;
    const filled = this.client.readInto(handleId, blockStart, this.cacheBuf);
    this.cacheStart = blockStart;
    this.cacheLen = filled;
    this.cacheVersion = version;
    const available = blockStart + filled - start;
    if (available <= 0) return 0;
    const fromCache = Math.min(available, dst.byteLength);
    dst.set(this.cacheBuf.subarray(start - blockStart, start - blockStart + fromCache));
    if (fromCache >= dst.byteLength) return fromCache;
    // The request runs past the end of this 1-block cache. Returning the partial count here is a short
    // read mid-file; positional readers that do not retry (e.g. the CHD scoped reader's read_exact_at)
    // then fail with "read error". Fill the remainder directly so readAt always satisfies the full
    // request up to EOF. (`rest` is 0 only at true EOF, which is a correct short read.)
    const rest = this.client.readInto(handleId, start + fromCache, dst.subarray(fromCache));
    return fromCache + rest;
  }

  writeAt(offset: number | bigint, data: Uint8Array): number {
    if (data.byteLength <= 0) return 0;
    const handleId = this.ensureOpen();
    const start = Number(offset);
    // Writes at least the buffer's size gain nothing from coalescing: commit any pending bytes and
    // stream straight through (client.write still chunks over the slot buffer).
    if (data.byteLength >= PROXY_WRITE_BUFFER_BYTES) {
      this.flushWriteBuffer();
      return this.client.write(handleId, start, data);
    }
    if (!this.wbuf) this.wbuf = new Uint8Array(PROXY_WRITE_BUFFER_BYTES);
    const contiguous = this.wbufLen > 0 && start === this.wbufStart + this.wbufLen;
    if (!contiguous || this.wbufLen + data.byteLength > this.wbuf.byteLength) {
      this.flushWriteBuffer();
      this.wbufStart = start;
    }
    this.wbuf.set(data, this.wbufLen);
    this.wbufLen += data.byteLength;
    return data.byteLength;
  }

  size(): number {
    this.flushWriteBuffer();
    return this.client.size(this.ensureOpen());
  }

  truncate(size: number): void {
    this.flushWriteBuffer();
    this.client.truncate(this.ensureOpen(), Number(size));
  }

  flush(): void {
    if (this.handleId === null || this.closed) return;
    this.flushWriteBuffer();
    this.client.flush(this.handleId);
  }

  close(): void {
    if (this.handleId === null || this.closed) {
      this.closed = true;
      return;
    }
    this.flushWriteBuffer();
    this.client.close(this.handleId);
    this.handleId = null;
    this.closed = true;
  }

  /** Commit any buffered sequential writes to the proxy in one (slot-chunked) call. */
  private flushWriteBuffer(): void {
    if (this.wbufLen === 0 || !this.wbuf || this.handleId === null) return;
    const pending = this.wbufLen;
    this.wbufLen = 0;
    const written = this.client.write(this.handleId, this.wbufStart, this.wbuf.subarray(0, pending));
    if (written !== pending) {
      throw new OpfsProxyError(
        `proxy short write flushing ${this.guestPath}: wrote ${written} of ${pending}`,
        29 /* EIO */,
      );
    }
  }
}
