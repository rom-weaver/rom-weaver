import * as wasiShim from "@bjorn3/browser_wasi_shim";
import { describe, expect, it, vi } from "vitest";

import {
  OPFS_SEQUENTIAL_DIRECT_WRITE_MIN_BYTES,
  OPFS_SEQUENTIAL_WRITE_BUFFER_BYTES,
} from "../../src/wasm/browser-opfs-constants.ts";
import { IdleFilePool } from "../../src/wasm/browser-opfs-idle-file-pool.ts";
import type { RandomAccessFileLike } from "../../src/wasm/browser-opfs-wasi-file-inode.ts";
import { WasiRandomAccessFileInode } from "../../src/wasm/browser-opfs-wasi-file-inode.ts";

const ERRNO_SUCCESS = wasiShim.wasi.ERRNO_SUCCESS;
const ERRNO_BADF = wasiShim.wasi.ERRNO_BADF;
const ERRNO_PERM = wasiShim.wasi.ERRNO_PERM;
const ERRNO_IO = wasiShim.wasi.ERRNO_IO;
const ERRNO_INVAL = wasiShim.wasi.ERRNO_INVAL;
const ERRNO_NOTSUP = wasiShim.wasi.ERRNO_NOTSUP;

type MemoryFileOptions = {
  bytes?: Uint8Array;
  readReturn?: (offset: number, dst: Uint8Array) => number;
  supportsBufferedSequentialWrite?: boolean;
  supportsDirectWasmRead?: boolean;
  writeReturn?: (offset: number, data: Uint8Array) => number;
};

/** In-memory RandomAccessFileLike; every adapter behavior under test is injectable. */
class MemoryFile implements RandomAccessFileLike {
  allocations: number[] = [];
  bytes: Uint8Array;
  closeCount = 0;
  flushCount = 0;
  reopenCount = 0;
  supportsBufferedSequentialWrite: boolean;
  supportsDirectWasmRead: boolean;
  truncations: number[] = [];
  writes: { data: Uint8Array; offset: number }[] = [];
  private readonly options: MemoryFileOptions;

  constructor(options: MemoryFileOptions = {}) {
    this.options = options;
    this.bytes = options.bytes ?? new Uint8Array(0);
    this.supportsBufferedSequentialWrite = options.supportsBufferedSequentialWrite ?? false;
    this.supportsDirectWasmRead = options.supportsDirectWasmRead ?? false;
  }

  readAt(offset: number | bigint, dst: Uint8Array): number {
    const start = Number(offset);
    if (this.options.readReturn) return this.options.readReturn(start, dst);
    const length = Math.max(0, Math.min(dst.byteLength, this.bytes.byteLength - start));
    if (length <= 0) return 0;
    dst.set(this.bytes.subarray(start, start + length));
    return length;
  }

  writeAt(offset: number | bigint, data: Uint8Array): number {
    const start = Number(offset);
    this.writes.push({ data: new Uint8Array(data), offset: start });
    if (this.options.writeReturn) return this.options.writeReturn(start, data);
    if (start + data.byteLength > this.bytes.byteLength) {
      const grown = new Uint8Array(start + data.byteLength);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes.set(data, start);
    return data.byteLength;
  }

  size(): number {
    return this.bytes.byteLength;
  }

  truncate(size: number): void {
    this.truncations.push(size);
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, Math.min(size, this.bytes.byteLength)));
    this.bytes = next;
  }

  flush(): void {
    this.flushCount += 1;
  }

  close(): void {
    this.closeCount += 1;
  }

  reopen(): void {
    this.reopenCount += 1;
  }
}

type OpenFile = {
  fd_allocate(offset: bigint, len: bigint): number;
  fd_close(): number;
  fd_fdstat_get(): { fdstat: unknown; ret: number };
  fd_filestat_get(): { filestat: unknown; ret: number };
  fd_filestat_set_size(size: bigint): number;
  fd_pread(size: number, offset: bigint): { data: Uint8Array; ret: number };
  fd_pread_into(target: Uint8Array, offset: bigint): { nread: number; ret: number };
  fd_pwrite(data: Uint8Array, offset: bigint): { nwritten: number; ret: number };
  fd_read(size: number): { data: Uint8Array; ret: number };
  fd_read_into(target: Uint8Array): { nread: number; ret: number };
  fd_seek(offset: bigint, whence: number): { offset: bigint; ret: number };
  fd_sync(): number;
  fd_tell(): { offset: bigint; ret: number };
  fd_write(data: Uint8Array): { nwritten: number; ret: number };
  flushPendingWrite(): number;
  pendingWriteBufferLength(): number;
  position: bigint;
};

function openFd(inode: WasiRandomAccessFileInode, oflags = 0, rights = 0n, fdFlags = 0): OpenFile {
  const { fd_obj, ret } = inode.path_open(oflags, rights, fdFlags);
  expect(ret).toBe(ERRNO_SUCCESS);
  if (!fd_obj) throw new Error("path_open must return an fd for this fixture");
  return fd_obj as unknown as OpenFile;
}

describe("WasiRandomAccessFileInode path_open", () => {
  it("refuses write rights on a readonly inode", () => {
    const inode = new WasiRandomAccessFileInode(new MemoryFile(), { readonly: true });

    expect(inode.path_open(0, wasiShim.wasi.RIGHTS_FD_WRITE, 0)).toEqual({ fd_obj: null, ret: ERRNO_PERM });
    expect(inode.path_open(wasiShim.wasi.OFLAGS_TRUNC, 0n, 0)).toEqual({ fd_obj: null, ret: ERRNO_PERM });
    expect(inode.openRefCount).toBe(0);
  });

  it("truncates on OFLAGS_TRUNC and counts the open", () => {
    const file = new MemoryFile({ bytes: new Uint8Array([1, 2, 3]) });
    const inode = new WasiRandomAccessFileInode(file);

    const fd = openFd(inode, wasiShim.wasi.OFLAGS_TRUNC);
    expect(file.truncations).toEqual([0]);
    expect(inode.openRefCount).toBe(1);
    expect(fd.fd_tell()).toEqual({ offset: 0n, ret: ERRNO_SUCCESS });
  });

  it("seeks to the end when opened with FDFLAGS_APPEND", () => {
    const file = new MemoryFile({ bytes: new Uint8Array(10) });
    const inode = new WasiRandomAccessFileInode(file);

    const fd = openFd(inode, 0, 0n, wasiShim.wasi.FDFLAGS_APPEND);
    expect(fd.fd_tell()).toEqual({ offset: 10n, ret: ERRNO_SUCCESS });
  });

  it("reports a regular-file stat sized from the adapter", () => {
    const inode = new WasiRandomAccessFileInode(new MemoryFile({ bytes: new Uint8Array(7) }));

    expect(inode.size).toBe(7n);
    const stat = inode.stat();
    expect(stat.filetype).toBe(wasiShim.wasi.FILETYPE_REGULAR_FILE);
    expect(stat.size).toBe(7n);
  });
});

describe("WasiRandomAccessFileInode handle lifecycle", () => {
  it("closes the backing file when the last fd of a closeOnLastFdClose inode closes", () => {
    const file = new MemoryFile();
    const inode = new WasiRandomAccessFileInode(file, { closeOnLastFdClose: true });

    const first = openFd(inode);
    const second = openFd(inode);
    expect(inode.openRefCount).toBe(2);

    expect(first.fd_close()).toBe(ERRNO_SUCCESS);
    expect(file.closeCount).toBe(0);
    expect(second.fd_close()).toBe(ERRNO_SUCCESS);
    expect(file.closeCount).toBe(1);
  });

  it("reopens a closed file on the next open", () => {
    const file = new MemoryFile();
    const inode = new WasiRandomAccessFileInode(file, { closeOnLastFdClose: true });

    openFd(inode).fd_close();
    expect(file.closeCount).toBe(1);

    openFd(inode);
    expect(file.reopenCount).toBe(1);
  });

  it("parks the file in the idle pool instead of closing it", () => {
    const pool = new IdleFilePool({ capacity: 1 });
    const file = new MemoryFile();
    const inode = new WasiRandomAccessFileInode(file, { closeOnLastFdClose: true, idlePool: pool });

    openFd(inode).fd_close();
    expect(file.closeCount).toBe(0);

    // A second entry evicts the first, which closes it.
    const other = new WasiRandomAccessFileInode(new MemoryFile(), { closeOnLastFdClose: true, idlePool: pool });
    openFd(other).fd_close();
    expect(file.closeCount).toBe(1);
  });

  it("reports EIO when the backing close throws", () => {
    const file = new MemoryFile();
    vi.spyOn(file, "close").mockImplementation(() => {
      throw new Error("handle already gone");
    });
    const inode = new WasiRandomAccessFileInode(file, { closeOnLastFdClose: true });

    expect(openFd(inode).fd_close()).toBe(ERRNO_IO);
  });

  it("keeps closeIdleFile idempotent and a no-op without a close hook", () => {
    const file = new MemoryFile();
    const inode = new WasiRandomAccessFileInode(file, { closeOnLastFdClose: true });

    inode.closeIdleFile();
    inode.closeIdleFile();
    expect(file.closeCount).toBe(1);

    const closeless = new WasiRandomAccessFileInode({
      flush: () => undefined,
      readAt: () => 0,
      size: () => 0,
      truncate: () => undefined,
      writeAt: () => 0,
    });
    expect(() => {
      closeless.closeIdleFile();
    }).not.toThrow();
  });

  it("opens and re-parks a pooled file just to read its size", () => {
    const pool = new IdleFilePool({ capacity: 4 });
    const file = new MemoryFile({ bytes: new Uint8Array(5) });
    const inode = new WasiRandomAccessFileInode(file, { closeOnLastFdClose: true, idlePool: pool });

    expect(inode.size).toBe(5n);
    expect(inode.openRefCount).toBe(0);

    const unpooled = new WasiRandomAccessFileInode(new MemoryFile({ bytes: new Uint8Array(3) }), {
      closeOnLastFdClose: true,
    });
    expect(unpooled.size).toBe(3n);
  });

  it("never lets releaseOpenFile drive the ref count negative", () => {
    const inode = new WasiRandomAccessFileInode(new MemoryFile());

    expect(inode.releaseOpenFile()).toBe(ERRNO_SUCCESS);
    expect(inode.openRefCount).toBe(0);
  });
});

describe("OpenWasiRandomAccessFile reads", () => {
  it("advances the position on fd_read and leaves it alone on fd_pread", () => {
    const inode = new WasiRandomAccessFileInode(new MemoryFile({ bytes: new Uint8Array([1, 2, 3, 4, 5]) }));
    const fd = openFd(inode);

    expect(fd.fd_read(2)).toEqual({ data: new Uint8Array([1, 2]), ret: ERRNO_SUCCESS });
    expect(fd.fd_tell().offset).toBe(2n);
    expect(fd.fd_pread(2, 3n)).toEqual({ data: new Uint8Array([4, 5]), ret: ERRNO_SUCCESS });
    expect(fd.fd_tell().offset).toBe(2n);
  });

  it("maps a negative adapter result to that errno and traces it once", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const inode = new WasiRandomAccessFileInode(new MemoryFile({ readReturn: () => -ERRNO_IO }));
    const fd = openFd(inode);

    expect(fd.fd_read(4)).toEqual({ data: new Uint8Array(0), ret: ERRNO_IO });
    expect(fd.fd_pread(4, 0n)).toEqual({ data: new Uint8Array(0), ret: ERRNO_IO });
    expect(debug).toHaveBeenCalledTimes(2);
    expect(debug.mock.calls[0]?.[0]).toContain("fd_read readAt returned error-like value");
    debug.mockRestore();
  });

  it("falls back to EIO for a non-finite or out-of-range adapter result", () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const nan = new WasiRandomAccessFileInode(new MemoryFile({ readReturn: () => Number.NaN }));
    expect(openFd(nan).fd_read(4).ret).toBe(ERRNO_IO);

    const huge = new WasiRandomAccessFileInode(new MemoryFile({ readReturn: () => -0x1_0000 }));
    expect(openFd(huge).fd_read(4).ret).toBe(ERRNO_IO);
    vi.restoreAllMocks();
  });

  it("clamps an over-long adapter read to the destination length", () => {
    const inode = new WasiRandomAccessFileInode(new MemoryFile({ readReturn: () => 99 }));
    const fd = openFd(inode);

    expect(fd.fd_read(4).data).toHaveLength(4);
    expect(fd.fd_tell().offset).toBe(4n);
  });

  it("serves direct wasm reads only from adapters that support them", () => {
    const unsupported = new WasiRandomAccessFileInode(new MemoryFile({ bytes: new Uint8Array([9]) }));
    const unsupportedFd = openFd(unsupported);
    expect(unsupportedFd.fd_read_into(new Uint8Array(1))).toEqual({ nread: 0, ret: ERRNO_NOTSUP });
    expect(unsupportedFd.fd_pread_into(new Uint8Array(1), 0n)).toEqual({ nread: 0, ret: ERRNO_NOTSUP });

    const supported = new WasiRandomAccessFileInode(
      new MemoryFile({ bytes: new Uint8Array([1, 2, 3]), supportsDirectWasmRead: true }),
    );
    const fd = openFd(supported);
    const target = new Uint8Array(2);
    expect(fd.fd_read_into(target)).toEqual({ nread: 2, ret: ERRNO_SUCCESS });
    expect(target).toEqual(new Uint8Array([1, 2]));
    expect(fd.fd_tell().offset).toBe(2n);

    const pTarget = new Uint8Array(1);
    expect(fd.fd_pread_into(pTarget, 2n)).toEqual({ nread: 1, ret: ERRNO_SUCCESS });
    expect(pTarget).toEqual(new Uint8Array([3]));
    expect(fd.fd_tell().offset).toBe(2n);
  });

  it("propagates a read error through the direct wasm read paths", () => {
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const inode = new WasiRandomAccessFileInode(
      new MemoryFile({ readReturn: () => -ERRNO_IO, supportsDirectWasmRead: true }),
    );
    const fd = openFd(inode);

    expect(fd.fd_read_into(new Uint8Array(2))).toEqual({ nread: 0, ret: ERRNO_IO });
    expect(fd.fd_pread_into(new Uint8Array(2), 0n)).toEqual({ nread: 0, ret: ERRNO_IO });
    vi.restoreAllMocks();
  });
});

describe("OpenWasiRandomAccessFile seek, stat and sync", () => {
  it("resolves every whence and rejects an unknown one", () => {
    const inode = new WasiRandomAccessFileInode(new MemoryFile({ bytes: new Uint8Array(10) }));
    const fd = openFd(inode);

    expect(fd.fd_seek(4n, wasiShim.wasi.WHENCE_SET)).toEqual({ offset: 4n, ret: ERRNO_SUCCESS });
    expect(fd.fd_seek(2n, wasiShim.wasi.WHENCE_CUR)).toEqual({ offset: 6n, ret: ERRNO_SUCCESS });
    expect(fd.fd_seek(-2n, wasiShim.wasi.WHENCE_END)).toEqual({ offset: 8n, ret: ERRNO_SUCCESS });
    expect(fd.fd_seek(0n, 99)).toEqual({ offset: 0n, ret: ERRNO_INVAL });
    expect(fd.fd_seek(-100n, wasiShim.wasi.WHENCE_SET)).toEqual({ offset: 0n, ret: ERRNO_INVAL });
    expect(fd.fd_tell().offset).toBe(8n);
  });

  it("reports a regular-file fdstat and filestat", () => {
    const inode = new WasiRandomAccessFileInode(new MemoryFile({ bytes: new Uint8Array(3) }));
    const fd = openFd(inode);

    expect(fd.fd_fdstat_get().ret).toBe(ERRNO_SUCCESS);
    const { filestat, ret } = fd.fd_filestat_get();
    expect(ret).toBe(ERRNO_SUCCESS);
    expect((filestat as wasiShim.wasi.Filestat).size).toBe(3n);
  });

  it("truncates through fd_filestat_set_size and refuses on a readonly inode", () => {
    const file = new MemoryFile({ bytes: new Uint8Array(8) });
    const inode = new WasiRandomAccessFileInode(file);
    expect(openFd(inode).fd_filestat_set_size(2n)).toBe(ERRNO_SUCCESS);
    expect(file.truncations).toEqual([2]);

    const readonly = new WasiRandomAccessFileInode(new MemoryFile(), { readonly: true });
    expect(openFd(readonly).fd_filestat_set_size(2n)).toBe(ERRNO_BADF);
  });

  it("grows the file through fd_allocate, preferring allocateAtLeast", () => {
    const truncating = new MemoryFile({ bytes: new Uint8Array(4) });
    const truncatingFd = openFd(new WasiRandomAccessFileInode(truncating));
    expect(truncatingFd.fd_allocate(2n, 6n)).toBe(ERRNO_SUCCESS);
    expect(truncating.truncations).toEqual([8]);

    const allocating = new MemoryFile({ bytes: new Uint8Array(4) });
    const withAllocate: RandomAccessFileLike = Object.assign(allocating, {
      allocateAtLeast: (size: number) => allocating.allocations.push(size),
    });
    const allocatingFd = openFd(new WasiRandomAccessFileInode(withAllocate));
    expect(allocatingFd.fd_allocate(0n, 16n)).toBe(ERRNO_SUCCESS);
    expect(allocating.allocations).toEqual([16]);
    expect(allocating.truncations).toEqual([]);
  });

  it("skips the allocation when the file is already large enough", () => {
    const file = new MemoryFile({ bytes: new Uint8Array(64) });
    expect(openFd(new WasiRandomAccessFileInode(file)).fd_allocate(0n, 8n)).toBe(ERRNO_SUCCESS);
    expect(file.truncations).toEqual([]);
  });

  it("flushes the adapter on fd_sync", () => {
    const file = new MemoryFile();
    expect(openFd(new WasiRandomAccessFileInode(file)).fd_sync()).toBe(ERRNO_SUCCESS);
    expect(file.flushCount).toBe(1);
  });
});

describe("OpenWasiRandomAccessFile writes", () => {
  it("writes straight through when the adapter does not buffer", () => {
    const file = new MemoryFile();
    const fd = openFd(new WasiRandomAccessFileInode(file));

    expect(fd.fd_write(new Uint8Array([1, 2, 3]))).toEqual({ nwritten: 3, ret: ERRNO_SUCCESS });
    expect(fd.fd_tell().offset).toBe(3n);
    expect(fd.fd_pwrite(new Uint8Array([9]), 0n)).toEqual({ nwritten: 1, ret: ERRNO_SUCCESS });
    expect(fd.fd_tell().offset).toBe(3n);
    expect(file.bytes).toEqual(new Uint8Array([9, 2, 3]));
  });

  it("refuses writes on a readonly inode and accepts an empty write", () => {
    const readonly = new WasiRandomAccessFileInode(new MemoryFile(), { readonly: true });
    const readonlyFd = openFd(readonly);
    expect(readonlyFd.fd_write(new Uint8Array([1]))).toEqual({ nwritten: 0, ret: ERRNO_BADF });
    expect(readonlyFd.fd_pwrite(new Uint8Array([1]), 0n)).toEqual({ nwritten: 0, ret: ERRNO_BADF });

    const writable = openFd(new WasiRandomAccessFileInode(new MemoryFile()));
    expect(writable.fd_write(new Uint8Array(0))).toEqual({ nwritten: 0, ret: ERRNO_SUCCESS });
  });

  it("coalesces small sequential writes and only hits the adapter on flush", () => {
    const file = new MemoryFile({ supportsBufferedSequentialWrite: true });
    const fd = openFd(new WasiRandomAccessFileInode(file));

    expect(fd.fd_write(new Uint8Array([1, 2]))).toEqual({ nwritten: 2, ret: ERRNO_SUCCESS });
    expect(fd.fd_write(new Uint8Array([3]))).toEqual({ nwritten: 1, ret: ERRNO_SUCCESS });
    expect(file.writes).toHaveLength(0);
    expect(fd.pendingWriteBufferLength()).toBe(3);

    expect(fd.flushPendingWrite()).toBe(ERRNO_SUCCESS);
    expect(file.writes).toEqual([{ data: new Uint8Array([1, 2, 3]), offset: 0 }]);
    expect(fd.pendingWriteBufferLength()).toBe(0);
  });

  it("flushes the coalesced run before a read, a seek or a positional write", () => {
    const file = new MemoryFile({ supportsBufferedSequentialWrite: true });
    const fd = openFd(new WasiRandomAccessFileInode(file));

    fd.fd_write(new Uint8Array([7, 8]));
    expect(fd.fd_read(1).ret).toBe(ERRNO_SUCCESS);
    expect(file.writes).toHaveLength(1);

    fd.fd_seek(0n, wasiShim.wasi.WHENCE_SET);
    fd.fd_write(new Uint8Array([1]));
    expect(fd.fd_pwrite(new Uint8Array([2]), 8n).ret).toBe(ERRNO_SUCCESS);
    expect(file.writes).toHaveLength(3);
  });

  it("flushes the pending run when a seek breaks it", () => {
    const file = new MemoryFile({ supportsBufferedSequentialWrite: true });
    const fd = openFd(new WasiRandomAccessFileInode(file));

    fd.fd_write(new Uint8Array([1, 2, 3]));
    fd.position = 100n;
    expect(fd.fd_write(new Uint8Array([4]))).toEqual({ nwritten: 1, ret: ERRNO_SUCCESS });
    expect(file.writes[0]).toEqual({ data: new Uint8Array([1, 2, 3]), offset: 0 });
    expect(fd.flushPendingWrite()).toBe(ERRNO_SUCCESS);
    expect(file.writes[1]).toEqual({ data: new Uint8Array([4]), offset: 100 });
  });

  it("bypasses the buffer for a write large enough to earn its own syscall", () => {
    const file = new MemoryFile({ supportsBufferedSequentialWrite: true });
    const fd = openFd(new WasiRandomAccessFileInode(file));
    const big = new Uint8Array(OPFS_SEQUENTIAL_DIRECT_WRITE_MIN_BYTES);

    expect(fd.fd_write(big)).toEqual({ nwritten: big.byteLength, ret: ERRNO_SUCCESS });
    expect(file.writes).toHaveLength(1);
    expect(fd.pendingWriteBufferLength()).toBe(0);
  });

  it("stops after a short direct write", () => {
    const file = new MemoryFile({
      supportsBufferedSequentialWrite: true,
      writeReturn: () => 16,
    });
    const fd = openFd(new WasiRandomAccessFileInode(file));

    const big = new Uint8Array(OPFS_SEQUENTIAL_DIRECT_WRITE_MIN_BYTES);
    expect(fd.fd_write(big)).toEqual({ nwritten: 16, ret: ERRNO_SUCCESS });
  });

  it("flushes automatically once the coalescing buffer fills", () => {
    const file = new MemoryFile({ supportsBufferedSequentialWrite: true });
    const fd = openFd(new WasiRandomAccessFileInode(file));

    // Two chunks under the direct-write floor that together overflow the buffer.
    const chunk = new Uint8Array(OPFS_SEQUENTIAL_DIRECT_WRITE_MIN_BYTES - 1);
    let written = 0;
    while (written < OPFS_SEQUENTIAL_WRITE_BUFFER_BYTES + chunk.byteLength) {
      written += fd.fd_write(chunk).nwritten;
    }

    expect(file.writes.length).toBeGreaterThan(0);
    expect(file.writes[0]?.data.byteLength).toBe(OPFS_SEQUENTIAL_WRITE_BUFFER_BYTES);
  });

  it("keeps the unwritten tail and reports EIO on a short buffered flush", () => {
    const file = new MemoryFile({ supportsBufferedSequentialWrite: true, writeReturn: () => 1 });
    const fd = openFd(new WasiRandomAccessFileInode(file));

    fd.fd_write(new Uint8Array([1, 2, 3]));
    expect(fd.flushPendingWrite()).toBe(ERRNO_IO);
    expect(fd.pendingWriteBufferLength()).toBe(2);
  });

  it("reports EIO without dropping bytes when the flush writes nothing", () => {
    const file = new MemoryFile({ supportsBufferedSequentialWrite: true, writeReturn: () => 0 });
    const fd = openFd(new WasiRandomAccessFileInode(file));

    fd.fd_write(new Uint8Array([1, 2, 3]));
    expect(fd.flushPendingWrite()).toBe(ERRNO_IO);
    expect(fd.pendingWriteBufferLength()).toBe(3);
  });

  it("surfaces a failed flush from every operation that must flush first", () => {
    const file = new MemoryFile({ supportsBufferedSequentialWrite: true, writeReturn: () => 0 });
    const fd = openFd(new WasiRandomAccessFileInode(file));
    fd.fd_write(new Uint8Array([1, 2, 3]));

    expect(fd.fd_read(1)).toEqual({ data: new Uint8Array(0), ret: ERRNO_IO });
    expect(fd.fd_pread(1, 0n)).toEqual({ data: new Uint8Array(0), ret: ERRNO_IO });
    expect(fd.fd_read_into(new Uint8Array(1))).toEqual({ nread: 0, ret: ERRNO_IO });
    expect(fd.fd_pread_into(new Uint8Array(1), 0n)).toEqual({ nread: 0, ret: ERRNO_IO });
    expect(fd.fd_seek(0n, wasiShim.wasi.WHENCE_SET).ret).toBe(ERRNO_IO);
    expect(fd.fd_sync()).toBe(ERRNO_IO);
    expect(fd.fd_allocate(0n, 64n)).toBe(ERRNO_IO);
    expect(fd.fd_filestat_get()).toEqual({ filestat: null, ret: ERRNO_IO });
    expect(fd.fd_filestat_set_size(1n)).toBe(ERRNO_IO);
    expect(fd.fd_pwrite(new Uint8Array([1]), 0n)).toEqual({ nwritten: 0, ret: ERRNO_IO });
    expect(fd.fd_close()).toBe(ERRNO_IO);
  });
});

describe("OpenWasiRandomAccessFile after close", () => {
  it("answers EBADF on every operation once closed", () => {
    const inode = new WasiRandomAccessFileInode(new MemoryFile({ supportsDirectWasmRead: true }));
    const fd = openFd(inode);
    expect(fd.fd_close()).toBe(ERRNO_SUCCESS);

    expect(fd.fd_close()).toBe(ERRNO_SUCCESS);
    expect(fd.fd_allocate(0n, 1n)).toBe(ERRNO_BADF);
    expect(fd.fd_fdstat_get()).toEqual({ fdstat: null, ret: ERRNO_BADF });
    expect(fd.fd_filestat_get()).toEqual({ filestat: null, ret: ERRNO_BADF });
    expect(fd.fd_filestat_set_size(0n)).toBe(ERRNO_BADF);
    expect(fd.fd_read(1)).toEqual({ data: new Uint8Array(0), ret: ERRNO_BADF });
    expect(fd.fd_pread(1, 0n)).toEqual({ data: new Uint8Array(0), ret: ERRNO_BADF });
    expect(fd.fd_read_into(new Uint8Array(1))).toEqual({ nread: 0, ret: ERRNO_BADF });
    expect(fd.fd_pread_into(new Uint8Array(1), 0n)).toEqual({ nread: 0, ret: ERRNO_BADF });
    expect(fd.fd_seek(0n, wasiShim.wasi.WHENCE_SET).ret).toBe(ERRNO_BADF);
    expect(fd.fd_tell().ret).toBe(ERRNO_BADF);
    expect(fd.fd_write(new Uint8Array([1]))).toEqual({ nwritten: 0, ret: ERRNO_BADF });
    expect(fd.fd_pwrite(new Uint8Array([1]), 0n)).toEqual({ nwritten: 0, ret: ERRNO_BADF });
    expect(fd.fd_sync()).toBe(ERRNO_BADF);
    expect(fd.flushPendingWrite()).toBe(ERRNO_BADF);
    expect(fd.pendingWriteBufferLength()).toBe(0);
  });
});
