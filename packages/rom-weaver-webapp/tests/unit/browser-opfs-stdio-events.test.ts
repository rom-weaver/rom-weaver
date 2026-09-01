import * as wasiShim from "@bjorn3/browser_wasi_shim";
import { describe, expect, it, vi } from "vitest";

import {
  createLineTrace,
  createOutputCollector,
  decodeChunks,
  formatArgsForTrace,
  installDirectWasiFileIoImports,
  monotonicNowMs,
  summarizeNormalizedVirtualFiles,
  summarizeRawVirtualFiles,
  traceDirectWasiFileIoStats,
  traceFlushOpenWasiFileDescriptors,
  traceRandomAccessFileIoStats,
} from "../../src/wasm/browser-opfs-stdio-events.ts";

const ERRNO_SUCCESS = wasiShim.wasi.ERRNO_SUCCESS;
const ERRNO_NOTSUP = wasiShim.wasi.ERRNO_NOTSUP;
const ERRNO_IO = wasiShim.wasi.ERRNO_IO;

type ImportTable = {
  __romWeaverDirectFileIo?: unknown;
  __romWeaverDirectFileIoStats?: unknown;
  fd_pread: (fd: number, iovsPtr: number, iovsLen: number, offset: number | bigint, nreadPtr: number) => unknown;
  fd_pwrite: (fd: number, iovsPtr: number, iovsLen: number, offset: number | bigint, nwrittenPtr: number) => unknown;
  fd_read: (fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number) => unknown;
  fd_write: (fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number) => unknown;
  path_open?: (...args: never[]) => number;
};

type Harness = {
  imports: ImportTable;
  memory: WebAssembly.Memory;
  originals: {
    fd_pread: ReturnType<typeof vi.fn>;
    fd_pwrite: ReturnType<typeof vi.fn>;
    fd_read: ReturnType<typeof vi.fn>;
    fd_write: ReturnType<typeof vi.fn>;
  };
  wasi: { fds: unknown[]; inst: { exports: { memory: WebAssembly.Memory } }; wasiImport: ImportTable };
};

const IOVS_PTR = 64;
const NRESULT_PTR = 32;

function makeHarness(fds: unknown[] = [], options: { memory?: boolean } = {}): Harness {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const originals = {
    fd_pread: vi.fn(() => "orig-pread"),
    fd_pwrite: vi.fn(() => "orig-pwrite"),
    fd_read: vi.fn(() => "orig-read"),
    fd_write: vi.fn(() => "orig-write"),
  };
  const imports: ImportTable = {
    fd_pread: originals.fd_pread,
    fd_pwrite: originals.fd_pwrite,
    fd_read: originals.fd_read,
    fd_write: originals.fd_write,
  };
  const inst = { exports: options.memory === false ? {} : { memory } } as {
    exports: { memory: WebAssembly.Memory };
  };
  return { imports, memory, originals, wasi: { fds, inst, wasiImport: imports } };
}

/** Lay out `len` iovecs at IOVS_PTR, each {buf, buf_len}, with data buffers after them. */
function writeIovecs(memory: WebAssembly.Memory, lengths: number[]): number[] {
  const view = new DataView(memory.buffer);
  const bufs: number[] = [];
  let dataPtr = IOVS_PTR + lengths.length * 8 + 8;
  lengths.forEach((length, index) => {
    view.setUint32(IOVS_PTR + index * 8, dataPtr, true);
    view.setUint32(IOVS_PTR + index * 8 + 4, length, true);
    bufs.push(dataPtr);
    dataPtr += length;
  });
  return bufs;
}

function readResult(memory: WebAssembly.Memory): number {
  return new DataView(memory.buffer).getUint32(NRESULT_PTR, true);
}

describe("createLineTrace", () => {
  it("forwards stringified lines to a callable sink", () => {
    const sink = vi.fn();
    createLineTrace(sink)(42);
    expect(sink).toHaveBeenCalledWith("42");
  });

  it("swallows sink failures and ignores non-callable sinks", () => {
    const throwing = createLineTrace(() => {
      throw new Error("sink exploded");
    });
    expect(() => throwing("line")).not.toThrow();
    expect(() => createLineTrace(null)("line")).not.toThrow();
    expect(() => createLineTrace("nope")("line")).not.toThrow();
  });
});

describe("virtual file summaries", () => {
  it("counts proxy vs direct entries and sums sizes across every raw source key", () => {
    expect(summarizeRawVirtualFiles([])).toBe("count=0");
    expect(summarizeRawVirtualFiles("not-an-array")).toBe("count=0");
    expect(
      summarizeRawVirtualFiles([
        { source: { size: 10 } },
        { file: { size: 20 } },
        { blob: { size: 3 } },
        { bytes: { byteLength: 4 } },
        { data: { byteLength: 5 } },
        { source: { size: 100 }, useProxyHandle: true },
        null,
      ]),
    ).toBe("count=7 proxy=1 direct=6 bytes=142");
  });

  it("reads only the normalized source key", () => {
    expect(summarizeNormalizedVirtualFiles([])).toBe("count=0");
    expect(summarizeNormalizedVirtualFiles([{ file: { size: 20 } }, { source: { size: 7 } }])).toBe(
      "count=2 proxy=0 direct=2 bytes=7",
    );
  });
});

describe("formatArgsForTrace", () => {
  it("reduces path arguments to basenames", () => {
    expect(formatArgsForTrace(["convert", "/work/roms/game.iso", 7])).toBe('["convert","game.iso","7"]');
  });

  it("renders non-arrays and empty arrays as an empty list", () => {
    expect(formatArgsForTrace([])).toBe("[]");
    expect(formatArgsForTrace(undefined)).toBe("[]");
  });
});

describe("installDirectWasiFileIoImports guards", () => {
  it("does nothing without a wasi instance", () => {
    expect(() => installDirectWasiFileIoImports(null)).not.toThrow();
    expect(() => installDirectWasiFileIoImports(undefined)).not.toThrow();
    expect(() => installDirectWasiFileIoImports({})).not.toThrow();
  });

  it("leaves an import table missing any of the four io entries untouched", () => {
    const { imports, wasi } = makeHarness();
    const original = imports.fd_pwrite;
    delete (imports as Partial<ImportTable>).fd_pwrite;
    installDirectWasiFileIoImports(wasi);
    expect(imports.__romWeaverDirectFileIo).toBeUndefined();
    expect(imports.fd_read).toBe(wasi.wasiImport.fd_read);
    imports.fd_pwrite = original;
  });

  it("is idempotent once the marker is set", () => {
    const { imports, wasi } = makeHarness();
    installDirectWasiFileIoImports(wasi);
    const installedRead = imports.fd_read;
    installDirectWasiFileIoImports(wasi);
    expect(imports.fd_read).toBe(installedRead);
  });

  it("marks the table and traces the install", () => {
    const trace = vi.fn();
    const { imports, originals, wasi } = makeHarness();
    installDirectWasiFileIoImports(wasi, trace);
    expect(imports.__romWeaverDirectFileIo).toBe(true);
    expect(imports.fd_read).not.toBe(originals.fd_read);
    expect(trace).toHaveBeenCalledWith("[browser-opfs] direct file io imports installed");
  });
});

describe("installDirectWasiFileIoImports path_open tracing", () => {
  it("traces failed opens with the decoded guest path and caps the trace count", () => {
    const trace = vi.fn();
    const { imports, memory, wasi } = makeHarness();
    const pathPtr = 512;
    const pathBytes = new TextEncoder().encode("/work/missing.cue");
    new Uint8Array(memory.buffer).set(pathBytes, pathPtr);
    const pathOpen = vi.fn(() => 44);
    imports.path_open = pathOpen as unknown as ImportTable["path_open"];

    installDirectWasiFileIoImports(wasi, trace);

    const call = () =>
      (imports.path_open as (...args: unknown[]) => number)(3, 1, pathPtr, pathBytes.length, 0, 0n, 0n, 0, 8);

    expect(call()).toBe(44);
    expect(pathOpen).toHaveBeenCalledWith(3, 1, pathPtr, pathBytes.length, 0, 0n, 0n, 0, 8);
    expect(trace).toHaveBeenCalledWith("[browser-opfs] wasi path_open failed dirfd=3 errno=44 path=/work/missing.cue");

    trace.mockClear();
    for (let index = 0; index < 30; index += 1) call();
    expect(trace).toHaveBeenCalledTimes(19);
  });

  it("does not trace successful opens", () => {
    const trace = vi.fn();
    const { imports, wasi } = makeHarness();
    imports.path_open = vi.fn(() => 0) as unknown as ImportTable["path_open"];
    installDirectWasiFileIoImports(wasi, trace);
    trace.mockClear();
    (imports.path_open as (...args: unknown[]) => number)(3, 0, 0, 0, 0, 0n, 0n, 0, 0);
    expect(trace).not.toHaveBeenCalled();
  });

  it("renders the path as ? when guest memory is unreachable", () => {
    const trace = vi.fn();
    const { imports, wasi } = makeHarness([], { memory: false });
    imports.path_open = vi.fn(() => 2) as unknown as ImportTable["path_open"];
    installDirectWasiFileIoImports(wasi, trace);
    (imports.path_open as (...args: unknown[]) => number)(3, 0, 16, 4, 0, 0n, 0n, 0, 0);
    expect(trace).toHaveBeenCalledWith("[browser-opfs] wasi path_open failed dirfd=3 errno=2 path=?");
  });

  it("renders the path as ? when the pointer runs past guest memory", () => {
    const trace = vi.fn();
    const { imports, memory, wasi } = makeHarness();
    imports.path_open = vi.fn(() => 2) as unknown as ImportTable["path_open"];
    installDirectWasiFileIoImports(wasi, trace);
    const pastEnd = memory.buffer.byteLength - 4;
    (imports.path_open as (...args: unknown[]) => number)(3, 0, pastEnd, 64, 0, 0n, 0n, 0, 0);
    expect(trace).toHaveBeenCalledWith("[browser-opfs] wasi path_open failed dirfd=3 errno=2 path=?");
  });
});

describe("installDirectWasiFileIoImports direct reads", () => {
  it("delegates to the original import when the fd has no direct read hook", () => {
    const { imports, originals, wasi } = makeHarness([{}]);
    installDirectWasiFileIoImports(wasi);
    expect(imports.fd_read(0, IOVS_PTR, 1, NRESULT_PTR)).toBe("orig-read");
    expect(originals.fd_read).toHaveBeenCalledWith(0, IOVS_PTR, 1, NRESULT_PTR);
  });

  it("fills every iovec, records nread and accumulates stats", () => {
    const fd = {
      fd_pread_into: vi.fn(() => ({ nread: 0, ret: ERRNO_SUCCESS })),
      fd_read_into: vi.fn((target: Uint8Array) => {
        target.fill(0xab);
        return { nread: target.byteLength, ret: ERRNO_SUCCESS };
      }),
    };
    const { imports, memory, wasi } = makeHarness([fd]);
    const bufs = writeIovecs(memory, [4, 6]);
    installDirectWasiFileIoImports(wasi);

    expect(imports.fd_read(0, IOVS_PTR, 2, NRESULT_PTR)).toBe(ERRNO_SUCCESS);
    expect(readResult(memory)).toBe(10);
    expect(fd.fd_read_into).toHaveBeenCalledTimes(2);
    expect(new Uint8Array(memory.buffer, bufs[0], 4)).toEqual(new Uint8Array([0xab, 0xab, 0xab, 0xab]));

    const stats = imports.__romWeaverDirectFileIoStats as { readBytes: number; readCalls: number };
    expect(stats).toMatchObject({ readBytes: 10, readCalls: 2 });
  });

  it("stops at the first short read", () => {
    const fd = {
      fd_pread_into: vi.fn(() => ({ nread: 0, ret: ERRNO_SUCCESS })),
      fd_read_into: vi.fn(() => ({ nread: 2, ret: ERRNO_SUCCESS })),
    };
    const { imports, memory, wasi } = makeHarness([fd]);
    writeIovecs(memory, [4, 6]);
    installDirectWasiFileIoImports(wasi);

    expect(imports.fd_read(0, IOVS_PTR, 2, NRESULT_PTR)).toBe(ERRNO_SUCCESS);
    expect(readResult(memory)).toBe(2);
    expect(fd.fd_read_into).toHaveBeenCalledTimes(1);
  });

  it("falls back to the original only when ENOTSUP arrives before any bytes", () => {
    const fd = {
      fd_pread_into: vi.fn(() => ({ nread: 0, ret: ERRNO_SUCCESS })),
      fd_read_into: vi.fn(() => ({ nread: 0, ret: ERRNO_NOTSUP })),
    };
    const { imports, originals, memory, wasi } = makeHarness([fd]);
    writeIovecs(memory, [4]);
    installDirectWasiFileIoImports(wasi);
    expect(imports.fd_read(0, IOVS_PTR, 1, NRESULT_PTR)).toBe("orig-read");
    expect(originals.fd_read).toHaveBeenCalledTimes(1);
  });

  it("reports a mid-stream errno with the bytes read so far", () => {
    let call = 0;
    const fd = {
      fd_pread_into: vi.fn(() => ({ nread: 0, ret: ERRNO_SUCCESS })),
      fd_read_into: vi.fn((target: Uint8Array) => {
        call += 1;
        if (call === 1) return { nread: target.byteLength, ret: ERRNO_SUCCESS };
        return { nread: 0, ret: ERRNO_IO };
      }),
    };
    const { imports, memory, wasi } = makeHarness([fd]);
    writeIovecs(memory, [4, 6]);
    installDirectWasiFileIoImports(wasi);

    expect(imports.fd_read(0, IOVS_PTR, 2, NRESULT_PTR)).toBe(ERRNO_IO);
    expect(readResult(memory)).toBe(4);
  });

  it("swallows a throw before any bytes and rethrows one after a partial read", () => {
    let call = 0;
    const fd = {
      fd_pread_into: vi.fn(() => ({ nread: 0, ret: ERRNO_SUCCESS })),
      fd_read_into: vi.fn((target: Uint8Array) => {
        call += 1;
        if (call === 1) throw new Error("first boom");
        if (call === 2) return { nread: target.byteLength, ret: ERRNO_SUCCESS };
        throw new Error("second boom");
      }),
    };
    const { imports, memory, wasi } = makeHarness([fd]);
    writeIovecs(memory, [4, 6]);
    installDirectWasiFileIoImports(wasi);

    expect(imports.fd_read(0, IOVS_PTR, 2, NRESULT_PTR)).toBe("orig-read");
    expect(() => imports.fd_read(0, IOVS_PTR, 2, NRESULT_PTR)).toThrow("second boom");
  });

  it("delegates when the instance exports no memory", () => {
    const fd = {
      fd_pread_into: vi.fn(),
      fd_read_into: vi.fn(),
    };
    const { imports, wasi } = makeHarness([fd], { memory: false });
    installDirectWasiFileIoImports(wasi);
    expect(imports.fd_read(0, IOVS_PTR, 1, NRESULT_PTR)).toBe("orig-read");
    expect(fd.fd_read_into).not.toHaveBeenCalled();
  });

  it("advances the positional offset across iovecs for fd_pread", () => {
    const offsets: bigint[] = [];
    const fd = {
      fd_pread_into: vi.fn((target: Uint8Array, offset: bigint) => {
        offsets.push(offset);
        return { nread: target.byteLength, ret: ERRNO_SUCCESS };
      }),
      fd_read_into: vi.fn(),
    };
    const { imports, memory, wasi } = makeHarness([fd]);
    writeIovecs(memory, [4, 6]);
    installDirectWasiFileIoImports(wasi);

    expect(imports.fd_pread(0, IOVS_PTR, 2, 100, NRESULT_PTR)).toBe(ERRNO_SUCCESS);
    expect(offsets).toEqual([100n, 104n]);
    expect(readResult(memory)).toBe(10);
  });

  it("falls back on fd_pread when the fd exposes no positional read", () => {
    const { imports, originals, wasi } = makeHarness([{ fd_read_into: vi.fn() }]);
    installDirectWasiFileIoImports(wasi);
    expect(imports.fd_pread(0, IOVS_PTR, 1, 0, NRESULT_PTR)).toBe("orig-pread");
    expect(originals.fd_pread).toHaveBeenCalledWith(0, IOVS_PTR, 1, 0, NRESULT_PTR);
  });

  it("replays the original fd_pread when the positional read reports ENOTSUP", () => {
    const fd = {
      fd_pread_into: vi.fn(() => ({ nread: 0, ret: ERRNO_NOTSUP })),
      fd_read_into: vi.fn(),
    };
    const { imports, originals, memory, wasi } = makeHarness([fd]);
    writeIovecs(memory, [4]);
    installDirectWasiFileIoImports(wasi);
    expect(imports.fd_pread(0, IOVS_PTR, 1, 16, NRESULT_PTR)).toBe("orig-pread");
    expect(originals.fd_pread).toHaveBeenCalledWith(0, IOVS_PTR, 1, 16, NRESULT_PTR);
  });
});

describe("installDirectWasiFileIoImports direct writes", () => {
  it("writes every iovec and records nwritten plus stats", () => {
    const seen: Uint8Array[] = [];
    const fd = {
      fd_pwrite: vi.fn(() => ({ nwritten: 0, ret: ERRNO_SUCCESS })),
      fd_write: vi.fn((source: Uint8Array) => {
        seen.push(new Uint8Array(source));
        return { nwritten: source.byteLength, ret: ERRNO_SUCCESS };
      }),
    };
    const { imports, memory, wasi } = makeHarness([fd]);
    const bufs = writeIovecs(memory, [3, 5]);
    new Uint8Array(memory.buffer).set([1, 2, 3], bufs[0]);
    installDirectWasiFileIoImports(wasi);

    expect(imports.fd_write(0, IOVS_PTR, 2, NRESULT_PTR)).toBe(ERRNO_SUCCESS);
    expect(readResult(memory)).toBe(8);
    expect(seen[0]).toEqual(new Uint8Array([1, 2, 3]));
    expect(imports.__romWeaverDirectFileIoStats).toMatchObject({ writeBytes: 8, writeCalls: 2 });
  });

  it("stops at a short write and reports the partial count", () => {
    const fd = {
      fd_pwrite: vi.fn(),
      fd_write: vi.fn(() => ({ nwritten: 1, ret: ERRNO_SUCCESS })),
    };
    const { imports, memory, wasi } = makeHarness([fd]);
    writeIovecs(memory, [3, 5]);
    installDirectWasiFileIoImports(wasi);
    expect(imports.fd_write(0, IOVS_PTR, 2, NRESULT_PTR)).toBe(ERRNO_SUCCESS);
    expect(readResult(memory)).toBe(1);
    expect(fd.fd_write).toHaveBeenCalledTimes(1);
  });

  it("falls back on ENOTSUP before any bytes and surfaces later errnos", () => {
    const notsup = {
      fd_pwrite: vi.fn(),
      fd_write: vi.fn(() => ({ nwritten: 0, ret: ERRNO_NOTSUP })),
    };
    const notsupHarness = makeHarness([notsup]);
    writeIovecs(notsupHarness.memory, [3]);
    installDirectWasiFileIoImports(notsupHarness.wasi);
    expect(notsupHarness.imports.fd_write(0, IOVS_PTR, 1, NRESULT_PTR)).toBe("orig-write");

    let call = 0;
    const failing = {
      fd_pwrite: vi.fn(),
      fd_write: vi.fn((source: Uint8Array) => {
        call += 1;
        if (call === 1) return { nwritten: source.byteLength, ret: ERRNO_SUCCESS };
        return { nwritten: 0, ret: ERRNO_IO };
      }),
    };
    const failingHarness = makeHarness([failing]);
    writeIovecs(failingHarness.memory, [3, 5]);
    installDirectWasiFileIoImports(failingHarness.wasi);
    expect(failingHarness.imports.fd_write(0, IOVS_PTR, 2, NRESULT_PTR)).toBe(ERRNO_IO);
    expect(readResult(failingHarness.memory)).toBe(3);
  });

  it("advances the positional offset across iovecs for fd_pwrite", () => {
    const offsets: bigint[] = [];
    const fd = {
      fd_pwrite: vi.fn((source: Uint8Array, offset: bigint) => {
        offsets.push(offset);
        return { nwritten: source.byteLength, ret: ERRNO_SUCCESS };
      }),
      fd_write: vi.fn(),
    };
    const { imports, memory, wasi } = makeHarness([fd]);
    writeIovecs(memory, [3, 5]);
    installDirectWasiFileIoImports(wasi);
    expect(imports.fd_pwrite(0, IOVS_PTR, 2, 8n, NRESULT_PTR)).toBe(ERRNO_SUCCESS);
    expect(offsets).toEqual([8n, 11n]);
  });

  it("falls back when the fd lacks the matching write hook or memory is gone", () => {
    const { imports, originals, wasi } = makeHarness([{ fd_write: vi.fn() }]);
    installDirectWasiFileIoImports(wasi);
    expect(imports.fd_pwrite(0, IOVS_PTR, 1, 0, NRESULT_PTR)).toBe("orig-pwrite");
    expect(originals.fd_pwrite).toHaveBeenCalledTimes(1);

    const plain = makeHarness([{}]);
    installDirectWasiFileIoImports(plain.wasi);
    expect(plain.imports.fd_write(0, IOVS_PTR, 1, NRESULT_PTR)).toBe("orig-write");
    expect(plain.originals.fd_write).toHaveBeenCalledWith(0, IOVS_PTR, 1, NRESULT_PTR);

    const noMemory = makeHarness([{ fd_write: vi.fn() }], { memory: false });
    installDirectWasiFileIoImports(noMemory.wasi);
    expect(noMemory.imports.fd_write(0, IOVS_PTR, 1, NRESULT_PTR)).toBe("orig-write");
  });

  it("replays the original fd_pwrite when the positional write reports ENOTSUP", () => {
    const fd = {
      fd_pwrite: vi.fn(() => ({ nwritten: 0, ret: ERRNO_NOTSUP })),
      fd_write: vi.fn(),
    };
    const { imports, originals, memory, wasi } = makeHarness([fd]);
    writeIovecs(memory, [3]);
    installDirectWasiFileIoImports(wasi);
    expect(imports.fd_pwrite(0, IOVS_PTR, 1, 24, NRESULT_PTR)).toBe("orig-pwrite");
    expect(originals.fd_pwrite).toHaveBeenCalledWith(0, IOVS_PTR, 1, 24, NRESULT_PTR);
  });

  it("swallows a throw before any bytes and rethrows one after a partial write", () => {
    let call = 0;
    const fd = {
      fd_pwrite: vi.fn(),
      fd_write: vi.fn((source: Uint8Array) => {
        call += 1;
        if (call === 1) throw new Error("first boom");
        if (call === 2) return { nwritten: source.byteLength, ret: ERRNO_SUCCESS };
        throw new Error("second boom");
      }),
    };
    const { imports, memory, wasi } = makeHarness([fd]);
    writeIovecs(memory, [3, 5]);
    installDirectWasiFileIoImports(wasi);
    expect(imports.fd_write(0, IOVS_PTR, 2, NRESULT_PTR)).toBe("orig-write");
    expect(() => imports.fd_write(0, IOVS_PTR, 2, NRESULT_PTR)).toThrow("second boom");
  });
});

describe("traceDirectWasiFileIoStats", () => {
  it("emits a single labelled line once direct io ran", () => {
    const fd = {
      fd_pread_into: vi.fn(),
      fd_read_into: vi.fn((target: Uint8Array) => ({ nread: target.byteLength, ret: ERRNO_SUCCESS })),
    };
    const { imports, memory, wasi } = makeHarness([fd]);
    writeIovecs(memory, [4]);
    installDirectWasiFileIoImports(wasi);
    imports.fd_read(0, IOVS_PTR, 1, NRESULT_PTR);

    const trace = vi.fn();
    traceDirectWasiFileIoStats(trace, wasi, "[io]");
    expect(trace).toHaveBeenCalledTimes(1);
    expect(trace.mock.calls[0][0]).toMatch(/^\[io\] readCalls=1 readBytes=4 readMs=/);
    expect(trace.mock.calls[0][0]).toContain("writeCalls=0 writeBytes=0");
  });

  it("stays silent without a trace sink, without stats, or with no io recorded", () => {
    const trace = vi.fn();
    traceDirectWasiFileIoStats(null, null, "[io]");
    traceDirectWasiFileIoStats(trace, null, "[io]");
    traceDirectWasiFileIoStats(trace, { wasiImport: { __romWeaverDirectFileIoStats: { readCalls: 1 } } }, "[io]");
    const { wasi } = makeHarness();
    installDirectWasiFileIoImports(wasi);
    traceDirectWasiFileIoStats(trace, wasi, "[io]");
    expect(trace).not.toHaveBeenCalled();
  });
});

describe("traceRandomAccessFileIoStats", () => {
  const statsFile = (overrides: Record<string, number>) => ({
    snapshotIoStats: () => overrides,
  });

  it("walks fds, nested mounts and directory contents, de-duplicating shared files", () => {
    const shared = statsFile({ opfsReadBytes: 2048, opfsReadCalls: 2, opfsReadMs: 1 });
    const nested = new Map<string, unknown>([
      ["track.bin", { file: statsFile({ blobReadBytes: 512, blobReadCalls: 1 }) }],
    ]);
    const fds = [
      { file: shared },
      { inode: { file: shared } },
      { mount: { contents: new Map<string, unknown>([["dir", { contents: nested }]]) } },
      null,
      "not-an-object",
    ];

    const trace = vi.fn();
    traceRandomAccessFileIoStats(trace, fds, "[fs]");
    expect(trace).toHaveBeenCalledTimes(1);
    const line = String(trace.mock.calls[0][0]);
    expect(line.startsWith("[fs] ")).toBe(true);
    // shared counted once despite two references
    expect(line).toContain("opfsReadCalls=2 opfsReadBytes=2048");
    expect(line).toContain("blobReadCalls=1 blobReadBytes=512");
    expect(line).toContain("opfsFlushCalls=0");
  });

  it("stays silent for no sink, no fds, or all-zero stats", () => {
    const trace = vi.fn();
    traceRandomAccessFileIoStats(null, [{ file: statsFile({ opfsReadCalls: 1 }) }], "[fs]");
    traceRandomAccessFileIoStats(trace, null, "[fs]");
    traceRandomAccessFileIoStats(trace, [{ file: statsFile({}) }], "[fs]");
    traceRandomAccessFileIoStats(trace, [{ file: {} }], "[fs]");
    expect(trace).not.toHaveBeenCalled();
  });
});

describe("traceFlushOpenWasiFileDescriptors", () => {
  it("flushes only fds with pending bytes and reports the totals once", () => {
    const flushed = {
      flushPendingWrite: vi.fn(() => ERRNO_SUCCESS),
      pendingWriteBufferLength: vi.fn(() => 300),
    };
    const empty = {
      flushPendingWrite: vi.fn(() => ERRNO_SUCCESS),
      pendingWriteBufferLength: vi.fn(() => 0),
    };
    const trace = vi.fn();
    traceFlushOpenWasiFileDescriptors(trace, [flushed, empty, null, {}], "[flush]");

    expect(flushed.flushPendingWrite).toHaveBeenCalledTimes(1);
    expect(empty.flushPendingWrite).not.toHaveBeenCalled();
    expect(trace).toHaveBeenCalledTimes(1);
    expect(String(trace.mock.calls[0][0])).toMatch(/^\[flush\] count=1 bytes=300 ms=/);
  });

  it("throws with the errno when a flush fails", () => {
    const fd = {
      flushPendingWrite: vi.fn(() => ERRNO_IO),
      pendingWriteBufferLength: vi.fn(() => 16),
    };
    expect(() => traceFlushOpenWasiFileDescriptors(null, [fd], "[flush]")).toThrow(
      `failed to flush buffered WASI fd writes: errno=${ERRNO_IO}`,
    );
  });

  it("does not trace when nothing was pending or fds is not an array", () => {
    const trace = vi.fn();
    traceFlushOpenWasiFileDescriptors(trace, null, "[flush]");
    traceFlushOpenWasiFileDescriptors(trace, [], "[flush]");
    expect(trace).not.toHaveBeenCalled();
  });
});

describe("createOutputCollector", () => {
  it("keeps every chunk and emits complete lines with CRLF trimmed", () => {
    const lines: string[] = [];
    const collector = createOutputCollector(wasiShim.ConsoleStdout, { onLine: (line) => lines.push(line) });
    const encoder = new TextEncoder();

    collector.fd.fd_write(encoder.encode("first\r\nsec"));
    expect(lines).toEqual(["first"]);
    collector.fd.fd_write(encoder.encode("ond\nthird-no-newline"));
    expect(lines).toEqual(["first", "second"]);

    collector.flush();
    expect(lines).toEqual(["first", "second", "third-no-newline"]);
    expect(collector.chunks).toHaveLength(2);
    expect(decodeChunks(collector.chunks)).toBe("first\r\nsecond\nthird-no-newline");
  });

  it("copies each chunk so a reused guest buffer cannot corrupt history", () => {
    const collector = createOutputCollector(wasiShim.ConsoleStdout);
    const buffer = new Uint8Array([104, 105]);
    collector.fd.fd_write(buffer);
    buffer.fill(0);
    expect(decodeChunks(collector.chunks)).toBe("hi");
    expect(() => {
      collector.flush();
    }).not.toThrow();
  });

  it("decodes multi-byte characters split across chunks", () => {
    const encoded = new TextEncoder().encode("héllo");
    expect(decodeChunks([encoded.subarray(0, 2), encoded.subarray(2)])).toBe("héllo");
    expect(decodeChunks([])).toBe("");
  });
});

describe("monotonicNowMs", () => {
  it("returns a non-decreasing millisecond clock", () => {
    const first = monotonicNowMs();
    const second = monotonicNowMs();
    expect(Number.isFinite(first)).toBe(true);
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it("falls back to Date.now when performance.now is unavailable", () => {
    const original = globalThis.performance;
    Reflect.deleteProperty(globalThis, "performance");
    try {
      expect(monotonicNowMs()).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(globalThis, "performance", { configurable: true, value: original, writable: true });
    }
  });
});
