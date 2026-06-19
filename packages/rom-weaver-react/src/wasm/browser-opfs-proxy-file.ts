// RandomAccessFileLike adapter backed by the OPFS async proxy.
//
// Instead of owning a FileSystemSyncAccessHandle (BrowserOpfsRandomAccessFile), this adapter marshals
// every read/write/size/truncate/flush to the proxy worker via an OpfsProxyClient. It is the consumer
// seam that lets any WASM thread operate on a real OPFS file the proxy opened — no per-thread handle,
// so it sidesteps the "spawned thread cannot path_open OPFS (os error 44)" wall and WebKit's
// one-handle-per-file rule (the proxy holds the single handle; this adapter just references it by id).
//
// The handle is opened lazily on first use (open is a proxy round-trip; deferring it means files that
// are listed but never touched cost nothing). A single-block consumer-side read cache amortises the
// per-read SAB round-trip for bursty small/sequential reads, and is validated against the proxy's
// per-handle version stamp: any write/truncate (from THIS thread or another) bumps the stamp, so the
// next read drops the stale block — cross-thread coherence without explicit invalidation messages.

import type { OpfsProxyClient } from "./browser-opfs-proxy-client.ts";
import { OpfsProxyError } from "./browser-opfs-proxy-client.ts";
import type { RandomAccessFileLike } from "./browser-opfs-wasi-file-inode.ts";

/** Block size for the consumer read cache; large reads above this bypass the cache and stream. */
const PROXY_READ_CACHE_BLOCK_BYTES = 1024 * 1024;
/** Requests larger than this are streamed directly rather than cached. */
const PROXY_READ_CACHE_MAX_REQUEST_BYTES = 256 * 1024;

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
    // Cache hit: the whole request lies within the cached block.
    if (this.cacheBuf && start >= this.cacheStart && start + dst.byteLength <= this.cacheStart + this.cacheLen) {
      dst.set(this.cacheBuf.subarray(start - this.cacheStart, start - this.cacheStart + dst.byteLength));
      return dst.byteLength;
    }
    // Miss: refill one aligned block, then copy out.
    if (!this.cacheBuf) this.cacheBuf = new Uint8Array(PROXY_READ_CACHE_BLOCK_BYTES);
    const blockStart = Math.floor(start / PROXY_READ_CACHE_BLOCK_BYTES) * PROXY_READ_CACHE_BLOCK_BYTES;
    const filled = this.client.readInto(handleId, blockStart, this.cacheBuf);
    this.cacheStart = blockStart;
    this.cacheLen = filled;
    this.cacheVersion = version;
    const available = blockStart + filled - start;
    if (available <= 0) return 0;
    const copyLen = Math.min(available, dst.byteLength);
    dst.set(this.cacheBuf.subarray(start - blockStart, start - blockStart + copyLen));
    return copyLen;
  }

  writeAt(offset: number | bigint, data: Uint8Array): number {
    return this.client.write(this.ensureOpen(), Number(offset), data);
  }

  size(): number {
    return this.client.size(this.ensureOpen());
  }

  truncate(size: number): void {
    this.client.truncate(this.ensureOpen(), Number(size));
  }

  flush(): void {
    if (this.handleId === null || this.closed) return;
    this.client.flush(this.handleId);
  }

  close(): void {
    if (this.handleId === null || this.closed) {
      this.closed = true;
      return;
    }
    this.client.close(this.handleId);
    this.handleId = null;
    this.closed = true;
  }
}
