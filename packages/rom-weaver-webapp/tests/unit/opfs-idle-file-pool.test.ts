import { describe, expect, it } from "vitest";
import { IdleFilePool } from "../../src/wasm/browser-opfs-idle-file-pool.ts";
import type { RandomAccessFileLike } from "../../src/wasm/browser-opfs-wasi-file-inode.ts";
import { WasiRandomAccessFileInode } from "../../src/wasm/browser-opfs-wasi-file-inode.ts";

class FakeRandomAccessFile implements RandomAccessFileLike {
  closeCount = 0;
  open = false;
  openCount = 0;
  reopenCount = 0;

  /** Every access opens the underlying handle, mirroring BrowserProxyRandomAccessFile.ensureOpen. */
  private ensureOpen(): void {
    if (this.open) return;
    this.open = true;
    this.openCount += 1;
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.closeCount += 1;
  }

  flush(): void {
    this.ensureOpen();
  }

  readAt(): number {
    this.ensureOpen();
    return 0;
  }

  reopen(): void {
    this.reopenCount += 1;
  }

  size(): number {
    this.ensureOpen();
    return 0;
  }

  truncate(): void {
    this.ensureOpen();
  }

  writeAt(_offset: number | bigint, data: Uint8Array): number {
    this.ensureOpen();
    return data.byteLength;
  }
}

const makeInode = (pool: IdleFilePool) => {
  const file = new FakeRandomAccessFile();
  return { file, inode: new WasiRandomAccessFileInode(file, { closeOnLastFdClose: true, idlePool: pool }) };
};

/** Open, touch, and close one fd, exactly as a per-entry extract output file is used. */
const writeAndClose = (inode: WasiRandomAccessFileInode) => {
  const opened = inode.path_open(0, 0n, 0);
  expect(opened.ret).toBe(0);
  opened.fd_obj?.fd_write(new Uint8Array(8));
  opened.fd_obj?.fd_close();
};

describe("idle OPFS file pool", () => {
  it("keeps live files bounded by capacity, not by the number of files", () => {
    const pool = new IdleFilePool({ capacity: 4 });
    const entries = Array.from({ length: 200 }, () => makeInode(pool));

    for (const entry of entries) writeAndClose(entry.inode);

    const live = entries.filter((entry) => entry.file.open).length;
    expect(live).toBe(4);
    expect(pool.size).toBe(4);
    // Everything past the capacity window was actually released, not merely dropped on the floor.
    expect(entries.filter((entry) => entry.file.closeCount > 0)).toHaveLength(196);
  });

  it("reopens an evicted file transparently on the next open", () => {
    const pool = new IdleFilePool({ capacity: 1 });
    const first = makeInode(pool);
    const second = makeInode(pool);

    writeAndClose(first.inode);
    writeAndClose(second.inode);
    expect(first.file.open).toBe(false);

    writeAndClose(first.inode);
    expect(first.file.reopenCount).toBe(1);
    expect(first.file.openCount).toBe(2);
    expect(first.file.open).toBe(true);
  });

  it("does not leak a handle when only metadata is read", () => {
    const pool = new IdleFilePool({ capacity: 2 });
    const entries = Array.from({ length: 50 }, () => makeInode(pool));

    for (const entry of entries) {
      writeAndClose(entry.inode);
      // A stat pass over every extracted entry must go through the pool, not open a stray handle.
      expect(entry.inode.stat().size).toBe(0n);
    }

    expect(entries.filter((entry) => entry.file.open)).toHaveLength(2);
  });

  it("closes everything it is holding when drained", () => {
    const pool = new IdleFilePool({ capacity: 8 });
    const entries = Array.from({ length: 5 }, () => makeInode(pool));
    for (const entry of entries) writeAndClose(entry.inode);
    expect(entries.filter((entry) => entry.file.open)).toHaveLength(5);

    pool.closeAll();

    expect(pool.size).toBe(0);
    expect(entries.filter((entry) => entry.file.open)).toHaveLength(0);
  });
});
