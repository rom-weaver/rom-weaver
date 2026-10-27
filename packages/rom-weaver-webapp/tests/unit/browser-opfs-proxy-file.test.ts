import * as wasiShim from "@bjorn3/browser_wasi_shim";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  browserProxyAdapterBufferBytes,
  BrowserProxyRandomAccessFile,
} from "../../src/wasm/browser-opfs-proxy-file.ts";
import { IdleFilePool } from "../../src/wasm/browser-opfs-idle-file-pool.ts";
import { WasiRandomAccessFileInode } from "../../src/wasm/browser-opfs-wasi-file-inode.ts";
import type { OpfsProxyClient } from "../../src/wasm/browser-opfs-proxy-client.ts";
import { OpfsProxyError } from "../../src/wasm/browser-opfs-proxy-client.ts";

const MIB = 1024 * 1024;
/** Mirrors PROXY_READ_CACHE_BLOCK_BYTES / _MAX_REQUEST_BYTES / PROXY_WRITE_BUFFER_BYTES. */
const READ_CACHE_BLOCK_BYTES = 4 * MIB;
const READ_CACHE_MAX_REQUEST_BYTES = 256 * 1024;
const WRITE_BUFFER_BYTES = 4 * MIB;

type FakeProxy = {
  bytesFor: (path: string) => Uint8Array;
  calls: string[];
  client: OpfsProxyClient;
  closed: number[];
  flushed: number[];
  openOptions: Record<string, unknown>[];
  reads: { length: number; offset: number }[];
  setBytes: (path: string, bytes: Uint8Array) => void;
  setVersion: (value: number) => void;
  setWriteResult: (fn: ((length: number) => number) | null) => void;
  truncations: { handleId: number; size: number }[];
  writes: { data: Uint8Array; offset: number }[];
};

function makeProxy(options: { openError?: Error } = {}): FakeProxy {
  const files = new Map<string, Uint8Array>();
  const handles = new Map<number, string>();
  let nextHandle = 1;
  let writeResult: ((length: number) => number) | null = null;
  let version = 1;
  const state = {
    bytesFor: (path: string) => files.get(path) ?? new Uint8Array(0),
    calls: [] as string[],
    closed: [] as number[],
    flushed: [] as number[],
    openOptions: [] as Record<string, unknown>[],
    reads: [] as { length: number; offset: number }[],
    setBytes: (path: string, bytes: Uint8Array) => files.set(path, bytes),
    setVersion: (value: number) => {
      version = value;
    },
    setWriteResult: (fn: ((length: number) => number) | null) => {
      writeResult = fn;
    },
    truncations: [] as { handleId: number; size: number }[],
    writes: [] as { data: Uint8Array; offset: number }[],
  };
  const client = {
    close: (handleId: number) => {
      state.calls.push("close");
      state.closed.push(handleId);
      handles.delete(handleId);
    },
    flush: (handleId: number) => {
      state.calls.push("flush");
      state.flushed.push(handleId);
    },
    handleVersion: () => version,
    open: (path: string, openOptions: Record<string, unknown>) => {
      state.calls.push("open");
      state.openOptions.push(openOptions);
      if (options.openError) throw options.openError;
      if (!files.has(path)) files.set(path, new Uint8Array(0));
      const id = nextHandle;
      nextHandle += 1;
      handles.set(id, path);
      return id;
    },
    readInto: (handleId: number, offset: number, dst: Uint8Array) => {
      state.calls.push("readInto");
      state.reads.push({ length: dst.byteLength, offset });
      const bytes = files.get(handles.get(handleId) ?? "") ?? new Uint8Array(0);
      const length = Math.max(0, Math.min(dst.byteLength, bytes.byteLength - offset));
      if (length <= 0) return 0;
      dst.set(bytes.subarray(offset, offset + length));
      return length;
    },
    size: (handleId: number) => {
      state.calls.push("size");
      return (files.get(handles.get(handleId) ?? "") ?? new Uint8Array(0)).byteLength;
    },
    truncate: (handleId: number, size: number) => {
      state.calls.push("truncate");
      state.truncations.push({ handleId, size });
      const path = handles.get(handleId) ?? "";
      const next = new Uint8Array(size);
      next.set((files.get(path) ?? new Uint8Array(0)).subarray(0, size));
      files.set(path, next);
    },
    write: (handleId: number, offset: number, data: Uint8Array) => {
      state.calls.push("write");
      state.writes.push({ data: new Uint8Array(data), offset });
      const path = handles.get(handleId) ?? "";
      const current = files.get(path) ?? new Uint8Array(0);
      const length = Math.max(current.byteLength, offset + data.byteLength);
      const next = new Uint8Array(length);
      next.set(current);
      next.set(data, offset);
      files.set(path, next);
      return writeResult ? writeResult(data.byteLength) : data.byteLength;
    },
  };
  return { ...state, client: client as unknown as OpfsProxyClient };
}

const patterned = (length: number, seed = 0) => {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index + seed) & 0xff;
  return bytes;
};

let proxy: FakeProxy;

beforeEach(() => {
  proxy = makeProxy();
});

describe("WASI close with proxy write buffering", () => {
  it.each([false, true])("publishes buffered writes without proxy fsync with idle pooling=%s", (pooled) => {
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/out.bin", { create: true, writable: true });
    const pool = new IdleFilePool();
    const inode = new WasiRandomAccessFileInode(file, {
      closeOnLastFdClose: pooled,
      idlePool: pooled ? pool : undefined,
    });
    const writer = inode.path_open(0, wasiShim.wasi.RIGHTS_FD_WRITE, 0).fd_obj;
    const reader = inode.path_open(0, wasiShim.wasi.RIGHTS_FD_READ, 0).fd_obj;
    if (!(writer && reader)) throw new Error("fixture descriptors must open");
    const bytes = new Uint8Array([1, 2, 3, 4]);
    try {
      expect(writer.fd_write(bytes)).toEqual({ nwritten: bytes.length, ret: wasiShim.wasi.ERRNO_SUCCESS });
      expect(proxy.writes).toEqual([]);
      expect(writer.fd_close()).toBe(wasiShim.wasi.ERRNO_SUCCESS);
      expect(proxy.bytesFor("/work/out.bin")).toEqual(bytes);
      expect(proxy.flushed).toEqual([]);
      const callsAfterWrite = [...proxy.calls];
      expect(reader.fd_close()).toBe(wasiShim.wasi.ERRNO_SUCCESS);
      expect(proxy.calls).toEqual(callsAfterWrite);
      expect(proxy.flushed).toEqual([]);
      expect(proxy.closed).toEqual([]);
      if (pooled) expect(pool.size).toBe(1);
    } finally {
      file.close();
    }
  });

  it.each([false, true])("publishes writes before returning with idle pooling=%s", (pooled) => {
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/out.bin", { create: true, writable: true });
    const pool = new IdleFilePool();
    const inode = new WasiRandomAccessFileInode(file, {
      closeOnLastFdClose: pooled,
      idlePool: pooled ? pool : undefined,
    });
    const first = inode.path_open(0, 0n, 0).fd_obj;
    const second = inode.path_open(0, 0n, 0).fd_obj;
    if (!(first && second)) throw new Error("fixture descriptors must open");
    try {
      expect(first.fd_write(new Uint8Array([1, 2]))).toEqual({ nwritten: 2, ret: wasiShim.wasi.ERRNO_SUCCESS });
      expect(first.fd_close()).toBe(wasiShim.wasi.ERRNO_SUCCESS);
      expect(proxy.bytesFor("/work/out.bin")).toEqual(new Uint8Array([1, 2]));
      expect(second.fd_pwrite(new Uint8Array([3, 4]), 2n)).toEqual({ nwritten: 2, ret: wasiShim.wasi.ERRNO_SUCCESS });
      expect(second.fd_close()).toBe(wasiShim.wasi.ERRNO_SUCCESS);
      expect(proxy.bytesFor("/work/out.bin")).toEqual(new Uint8Array([1, 2, 3, 4]));
      expect(proxy.closed).toEqual([]);
      if (pooled) expect(pool.size).toBe(1);
    } finally {
      file.close();
    }
  });

  it("still requests durable storage on explicit fd_sync", () => {
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/out.bin", { create: true, writable: true });
    const inode = new WasiRandomAccessFileInode(file);
    const fd = inode.path_open(0, wasiShim.wasi.RIGHTS_FD_WRITE, 0).fd_obj;
    if (!fd) throw new Error("fixture descriptor must open");
    const bytes = new Uint8Array([1, 2, 3]);
    try {
      expect(fd.fd_write(bytes)).toEqual({ nwritten: bytes.length, ret: wasiShim.wasi.ERRNO_SUCCESS });
      expect(proxy.writes).toEqual([]);
      expect(fd.fd_sync()).toBe(wasiShim.wasi.ERRNO_SUCCESS);
      expect(proxy.bytesFor("/work/out.bin")).toEqual(bytes);
      expect(proxy.calls.slice(-2)).toEqual(["write", "flush"]);
      expect(proxy.flushed).toEqual([1]);
      expect(fd.fd_close()).toBe(wasiShim.wasi.ERRNO_SUCCESS);
      expect(proxy.flushed).toEqual([1]);
    } finally {
      file.close();
    }
  });

  it("surfaces proxy errors at close and retains pending bytes for retry", () => {
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/out.bin", { create: true, writable: true });
    const inode = new WasiRandomAccessFileInode(file);
    const fd = inode.path_open(0, 0n, 0).fd_obj;
    if (!fd) throw new Error("fixture descriptor must open");
    try {
      fd.fd_write(new Uint8Array([1, 2, 3]));
      proxy.setWriteResult(() => {
        throw new OpfsProxyError("write failed", 29);
      });
      expect(() => fd.fd_close()).toThrow("write failed");
      expect(inode.openRefCount).toBe(1);
      proxy.setWriteResult(null);
      expect(fd.fd_close()).toBe(wasiShim.wasi.ERRNO_SUCCESS);
      expect(proxy.bytesFor("/work/out.bin")).toEqual(new Uint8Array([1, 2, 3]));
      expect(inode.openRefCount).toBe(0);
    } finally {
      proxy.setWriteResult(null);
      file.close();
    }
  });
});

describe("BrowserProxyRandomAccessFile handle lifecycle", () => {
  it("retains buffered bytes after a failed flush", () => {
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/out.bin", { create: true, writable: true });
    file.writeAt(0, new Uint8Array([1, 2, 3]));
    proxy.setWriteResult(() => {
      throw new OpfsProxyError("write failed", 29);
    });
    expect(() => file.flush()).toThrow("write failed");
    proxy.setWriteResult(null);
    file.flush();
    expect(proxy.writes).toHaveLength(2);
    expect(proxy.writes[1]?.data).toEqual(new Uint8Array([1, 2, 3]));
    file.close();
  });

  it("closes the handle and releases buffers when its final flush fails", () => {
    const before = browserProxyAdapterBufferBytes();
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/out.bin", { create: true, writable: true });
    file.writeAt(0, new Uint8Array([1, 2, 3]));
    proxy.setWriteResult(() => {
      throw new OpfsProxyError("write failed", 29);
    });
    expect(() => file.close()).toThrow("write failed");
    expect(proxy.closed).toEqual([1]);
    expect(browserProxyAdapterBufferBytes()).toBe(before);
  });

  it("opens lazily, once, with the options it was configured with", () => {
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/out.bin", {
      create: true,
      oflags: 9,
      writable: true,
    });

    expect(proxy.calls).toEqual([]);
    file.size();
    file.size();

    expect(proxy.openOptions).toEqual([{ create: true, oflags: 9, writable: true }]);
    expect(proxy.calls.filter((call) => call === "open")).toHaveLength(1);
  });

  it("defaults to a read-only, non-creating open", () => {
    proxy.setBytes("/work/rom.iso", patterned(8));
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/rom.iso");

    expect(file.size()).toBe(8);
    expect(proxy.openOptions[0]).toEqual({ create: false, oflags: 0, writable: false });
    expect(file.supportsDirectWasmRead).toBe(true);
    expect(file.scratchName).toBeNull();
  });

  it("closes the proxy handle once and refuses further work", () => {
    proxy.setBytes("/work/rom.iso", patterned(8));
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/rom.iso");
    file.size();

    file.close();
    expect(proxy.closed).toEqual([1]);

    expect(() => file.size()).toThrow(OpfsProxyError);
    expect(() => file.size()).toThrow("proxy file already closed: /work/rom.iso");
  });

  it("closes cleanly when it never opened a handle", () => {
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/rom.iso");

    file.close();
    file.close();
    expect(proxy.closed).toEqual([]);
    expect(proxy.calls).toEqual([]);
  });

  it("re-arms a closed adapter so the inode can serve another open", () => {
    proxy.setBytes("/work/rom.iso", patterned(8));
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/rom.iso");
    file.size();
    file.close();

    file.reopen();
    expect(file.size()).toBe(8);
    expect(proxy.calls.filter((call) => call === "open")).toHaveLength(2);
  });

  it("does nothing on flush before the handle exists and after it closes", () => {
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/rom.iso");

    file.flush();
    expect(proxy.flushed).toEqual([]);

    file.writeAt(0, new Uint8Array([1]));
    file.flush();
    expect(proxy.flushed).toEqual([1]);

    file.close();
    file.flush();
    expect(proxy.flushed).toEqual([1]);
  });

  it("propagates an open failure", () => {
    const failing = makeProxy({ openError: new Error("ENOENT") });
    const file = new BrowserProxyRandomAccessFile(failing.client, "/work/gone.iso");

    expect(() => file.size()).toThrow("ENOENT");
  });
});

describe("BrowserProxyRandomAccessFile reads", () => {
  it("returns nothing for an empty destination without opening", () => {
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/rom.iso");

    expect(file.readAt(0, new Uint8Array(0))).toBe(0);
    expect(proxy.calls).toEqual([]);
  });

  it("fills a small read from a cached block and only hits the proxy once", () => {
    proxy.setBytes("/work/rom.iso", patterned(1024));
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/rom.iso");

    const first = new Uint8Array(16);
    expect(file.readAt(0, first)).toBe(16);
    expect(first).toEqual(patterned(1024).subarray(0, 16));

    const second = new Uint8Array(16);
    expect(file.readAt(32, second)).toBe(16);
    expect(second[0]).toBe(32);
    expect(proxy.reads).toHaveLength(1);
    // A read-only 1 KiB file gets a file-sized block, not a 4 MiB one.
    expect(proxy.reads[0]).toMatchObject({ length: 1024, offset: 0 });
  });

  it("keeps the full cache block for a large read-only file", () => {
    proxy.setBytes("/work/rom.iso", patterned(READ_CACHE_BLOCK_BYTES + 64));
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/rom.iso");

    expect(file.readAt(0, new Uint8Array(16))).toBe(16);
    expect(proxy.reads[0]).toMatchObject({ length: READ_CACHE_BLOCK_BYTES, offset: 0 });
  });

  it("streams a request larger than the cache request cap", () => {
    proxy.setBytes("/work/rom.iso", patterned(READ_CACHE_MAX_REQUEST_BYTES + 64));
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/rom.iso");
    const dst = new Uint8Array(READ_CACHE_MAX_REQUEST_BYTES + 1);

    expect(file.readAt(0, dst)).toBe(dst.byteLength);
    expect(proxy.reads).toEqual([{ length: dst.byteLength, offset: 0 }]);
  });

  it("drops the cached block when the proxy bumps the handle version", () => {
    proxy.setBytes("/work/rom.iso", patterned(1024));
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/rom.iso");
    file.readAt(0, new Uint8Array(16));
    expect(proxy.reads).toHaveLength(1);

    proxy.setVersion(2);
    proxy.setBytes("/work/rom.iso", patterned(1024, 5));
    const refreshed = new Uint8Array(16);
    expect(file.readAt(0, refreshed)).toBe(16);

    expect(proxy.reads).toHaveLength(2);
    expect(refreshed[0]).toBe(5);
  });

  it("fills the remainder directly when a read runs past the cached block", () => {
    const size = READ_CACHE_BLOCK_BYTES + 64;
    proxy.setBytes("/work/rom.iso", patterned(size));
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/rom.iso");

    const dst = new Uint8Array(128);
    const start = READ_CACHE_BLOCK_BYTES - 64;
    expect(file.readAt(start, dst)).toBe(128);
    expect(dst[0]).toBe(start & 0xff);
    expect(dst[127]).toBe((start + 127) & 0xff);
    // One block fill plus one direct read for the tail past the block.
    expect(proxy.reads).toHaveLength(2);
    expect(proxy.reads[1]).toMatchObject({ offset: READ_CACHE_BLOCK_BYTES });

    // A full block that does not end at EOF is never clamped: the same read again returns every byte.
    const again = new Uint8Array(128);
    expect(file.readAt(start, again)).toBe(128);
    expect(again).toEqual(dst);
  });

  it("serves repeated reads past end of file when the file ends on a block boundary", () => {
    const size = READ_CACHE_BLOCK_BYTES;
    proxy.setBytes("/work/rom.iso", patterned(size));
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/rom.iso");

    for (let call = 0; call < 2; call += 1) {
      const dst = new Uint8Array(64 * 1024);
      expect(file.readAt(size - 1024, dst)).toBe(1024);
      expect(dst[1023]).toBe((size - 1) & 0xff);
    }
    expect(file.readAt(size, new Uint8Array(64))).toBe(0);
    // One block fill plus one empty tail read that finds EOF; every later read is served from the cache.
    expect(proxy.reads).toHaveLength(2);
  });

  it("serves repeated reads that run past end of file from the cached block", () => {
    const size = 24 * 1024;
    proxy.setBytes("/work/rom.iso", patterned(size));
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/rom.iso");

    for (let call = 0; call < 2; call += 1) {
      const dst = new Uint8Array(64 * 1024);
      expect(file.readAt(0, dst)).toBe(size);
      expect(dst.subarray(0, size)).toEqual(patterned(size));
    }
    const tail = new Uint8Array(64);
    expect(file.readAt(size - 10, tail)).toBe(10);
    expect(tail[9]).toBe((size - 1) & 0xff);
    expect(file.readAt(size, tail)).toBe(0);
    expect(file.readAt(size + 1, tail)).toBe(0);
    expect(proxy.reads).toHaveLength(1);
  });

  it("reports a short read at end of file", () => {
    proxy.setBytes("/work/rom.iso", patterned(8));
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/rom.iso");

    expect(file.readAt(8, new Uint8Array(16))).toBe(0);
    expect(file.readAt(4, new Uint8Array(16))).toBe(4);
  });

  it("commits buffered writes before serving a read", () => {
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/out.bin", { create: true, writable: true });
    file.writeAt(0, new Uint8Array([1, 2, 3, 4]));
    expect(proxy.writes).toEqual([]);

    const dst = new Uint8Array(4);
    expect(file.readAt(0, dst)).toBe(4);
    expect(proxy.writes).toHaveLength(1);
    expect(dst).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});

describe("BrowserProxyRandomAccessFile writes", () => {
  it("ignores an empty write without opening", () => {
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/out.bin");

    expect(file.writeAt(0, new Uint8Array(0))).toBe(0);
    expect(proxy.calls).toEqual([]);
  });

  it("coalesces contiguous writes into one proxy call", () => {
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/out.bin", { create: true, writable: true });

    expect(file.writeAt(0, new Uint8Array([1, 2]))).toBe(2);
    expect(file.writeAt(2, new Uint8Array([3, 4]))).toBe(2);
    expect(proxy.writes).toEqual([]);

    file.flush();
    expect(proxy.writes).toEqual([{ data: new Uint8Array([1, 2, 3, 4]), offset: 0 }]);
    expect(proxy.flushed).toEqual([1]);
  });

  it("commits the pending run when a write breaks the sequence", () => {
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/out.bin", { create: true, writable: true });
    file.writeAt(0, new Uint8Array([1, 2]));

    file.writeAt(64, new Uint8Array([9]));
    expect(proxy.writes).toEqual([{ data: new Uint8Array([1, 2]), offset: 0 }]);

    file.flush();
    expect(proxy.writes[1]).toEqual({ data: new Uint8Array([9]), offset: 64 });
  });

  it("streams a write at least as large as the coalescing buffer", () => {
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/out.bin", { create: true, writable: true });
    const big = patterned(WRITE_BUFFER_BYTES);

    expect(file.writeAt(0, big)).toBe(big.byteLength);
    expect(proxy.writes).toHaveLength(1);
    expect(proxy.writes[0]?.data.byteLength).toBe(WRITE_BUFFER_BYTES);
  });

  it("commits the buffered run before streaming a large write", () => {
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/out.bin", { create: true, writable: true });
    file.writeAt(0, new Uint8Array([1, 2]));

    file.writeAt(2, patterned(WRITE_BUFFER_BYTES));
    expect(proxy.writes.map((write) => write.data.byteLength)).toEqual([2, WRITE_BUFFER_BYTES]);
  });

  it("commits when the pending run would overflow the buffer", () => {
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/out.bin", { create: true, writable: true });
    const half = patterned(WRITE_BUFFER_BYTES / 2 + 8);

    file.writeAt(0, half);
    expect(proxy.writes).toEqual([]);
    file.writeAt(half.byteLength, half);

    expect(proxy.writes).toHaveLength(1);
    expect(proxy.writes[0]?.data.byteLength).toBe(half.byteLength);
  });

  it("raises EIO when the proxy accepts only part of a committed run", () => {
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/out.bin", { create: true, writable: true });
    file.writeAt(0, new Uint8Array([1, 2, 3, 4]));
    proxy.setWriteResult(() => 2);

    expect(() => file.flush()).toThrow(OpfsProxyError);
    expect(() => file.writeAt(0, new Uint8Array([1]))).toThrow(OpfsProxyError);
    proxy.setWriteResult(null);
    file.flush();
    expect(proxy.writes[2]?.data).toEqual(new Uint8Array([1, 2, 3, 4]));
    file.close();
  });

  it("commits pending writes before size and truncate", () => {
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/out.bin", { create: true, writable: true });
    file.writeAt(0, new Uint8Array([1, 2, 3, 4]));
    expect(file.size()).toBe(4);

    file.writeAt(4, new Uint8Array([5, 6]));
    file.truncate(2);
    expect(proxy.truncations).toEqual([{ handleId: 1, size: 2 }]);
    expect(proxy.bytesFor("/work/out.bin")).toEqual(new Uint8Array([1, 2]));
  });

  it("commits pending writes when the handle closes", () => {
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/out.bin", { create: true, writable: true });
    file.writeAt(0, new Uint8Array([7, 7]));

    file.close();
    expect(proxy.writes).toEqual([{ data: new Uint8Array([7, 7]), offset: 0 }]);
    expect(proxy.closed).toEqual([1]);
  });
});

describe("browserProxyAdapterBufferBytes", () => {
  it("tracks the read and write buffers live adapters hold, and releases them on close", () => {
    const before = browserProxyAdapterBufferBytes();
    proxy.setBytes("/work/rom.iso", patterned(64));
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/rom.iso", { create: true, writable: true });

    file.readAt(0, new Uint8Array(8));
    expect(browserProxyAdapterBufferBytes()).toBe(before + READ_CACHE_BLOCK_BYTES);

    file.writeAt(0, new Uint8Array([1]));
    expect(browserProxyAdapterBufferBytes()).toBe(before + READ_CACHE_BLOCK_BYTES + WRITE_BUFFER_BYTES);

    file.close();
    expect(browserProxyAdapterBufferBytes()).toBe(before);
  });

  it("stays balanced when a closed adapter is reopened and closed again", () => {
    const before = browserProxyAdapterBufferBytes();
    proxy.setBytes("/work/rom.iso", patterned(64));
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/rom.iso");

    file.readAt(0, new Uint8Array(8));
    file.close();
    file.reopen();
    file.readAt(0, new Uint8Array(8));
    file.close();

    expect(browserProxyAdapterBufferBytes()).toBe(before);
  });
});

describe("BrowserProxyRandomAccessFile write-buffer edge cases", () => {
  it("does not commit anything when the handle was never opened", () => {
    const file = new BrowserProxyRandomAccessFile(proxy.client, "/work/out.bin");
    const write = vi.spyOn(proxy.client, "write");

    file.flush();
    expect(write).not.toHaveBeenCalled();
  });
});
