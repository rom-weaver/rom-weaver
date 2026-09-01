import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureObjectBinarySourceReaderFactories,
  copySourceToWriter,
  createBinaryObjectReader,
  createPatchFileFromSource,
  hasReadableBytes,
  toUint8Array,
} from "../../src/storage/shared/binary/binary-source-utils.ts";
import type { BinaryObjectLike } from "../../src/storage/shared/binary/source-shared.ts";

const createBlobLike = (bytes: Uint8Array, options?: { sliceable?: boolean }): BinaryObjectLike => ({
  arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
  lastModified: 1700000000000,
  name: "staged.bin",
  size: bytes.byteLength,
  slice:
    options?.sliceable === false
      ? undefined
      : (start = 0, end = bytes.byteLength) => createBlobLike(bytes.subarray(start, end), options),
  type: "application/octet-stream",
});

const collectChunks = async (source: unknown, options?: { chunkSize?: number; offset?: number; length?: number }) => {
  const chunks: Array<{ bytes: number[]; offset: number }> = [];
  const copied = await copySourceToWriter(
    source,
    (bytes, offset) => {
      chunks.push({ bytes: Array.from(bytes), offset });
    },
    options,
  );
  return { chunks, copied };
};

class FakePatchFile {
  fileName?: string;
  filePath?: string;
  fileSize?: number;
  fileType?: string;
  littleEndian?: boolean;
  input: unknown;
  _file?: unknown;
  _fileHandle?: unknown;
  _u8array?: Uint8Array;
  readIntoAt?: (buffer: Uint8Array, bufferOffset?: number, len?: number, fileOffset?: number) => number;

  constructor(input: unknown) {
    this.input = input;
  }
}

afterEach(() => {
  configureObjectBinarySourceReaderFactories([]);
});

describe("toUint8Array", () => {
  it("returns a Uint8Array source untouched", () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    expect(toUint8Array(bytes)).toBe(bytes);
  });

  it("views an ArrayBuffer and unwraps a nested source", () => {
    expect(Array.from(toUint8Array(Uint8Array.from([4, 5]).buffer))).toEqual([4, 5]);
    expect(Array.from(toUint8Array({ source: Uint8Array.from([6, 7]) }))).toEqual([6, 7]);
  });

  it("materializes a record through _u8array, materialize, or readIntoAt", () => {
    expect(Array.from(toUint8Array({ _u8array: Uint8Array.from([1]) }))).toEqual([1]);
    expect(
      Array.from(toUint8Array({ fileSize: 2, materialize: (offset: number, len: number) => [offset, len] })),
    ).toEqual([0, 2]);
    expect(
      Array.from(
        toUint8Array({
          fileSize: 3,
          readIntoAt: (buffer: Uint8Array) => {
            buffer.set([7, 8, 9]);
            return 3;
          },
        }),
      ),
    ).toEqual([7, 8, 9]);
  });

  it("rejects a record with no readable bytes", () => {
    expect(() => toUint8Array({ unrelated: true })).toThrow("Invalid byte source");
    expect(() => toUint8Array({ unrelated: true }, "Invalid patch source")).toThrow("Invalid patch source");
  });
});

describe("createBinaryObjectReader", () => {
  it("carries the blob metadata and prefers the explicit name", () => {
    const reader = createBinaryObjectReader(createBlobLike(Uint8Array.from([1, 2, 3])), "rom.sfc");

    expect(reader.name).toBe("rom.sfc");
    expect(reader.size).toBe(3);
    expect(reader.type).toBe("application/octet-stream");
    expect(reader.lastModified).toBe(1700000000000);
  });

  it("falls back to the blob name and then to the default name", () => {
    expect(createBinaryObjectReader(createBlobLike(Uint8Array.from([1]))).name).toBe("staged.bin");
    expect(createBinaryObjectReader({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)), size: 0 }).name).toBe(
      "file.bin",
    );
  });

  it("reads a clamped range", async () => {
    const reader = createBinaryObjectReader(createBlobLike(Uint8Array.from([1, 2, 3, 4])));

    expect(Array.from(await reader.readRange(1, 2))).toEqual([2, 3]);
    expect(Array.from(await reader.readRange())).toEqual([1, 2, 3, 4]);
    expect(Array.from(await reader.readRange(4, 8))).toEqual([]);
  });

  it("reads a range out of a blob that cannot slice", async () => {
    const reader = createBinaryObjectReader(createBlobLike(Uint8Array.from([1, 2, 3, 4]), { sliceable: false }));

    expect(Array.from(await reader.readRange(2, 2))).toEqual([3, 4]);
  });

  it("reads into a target buffer at an offset", async () => {
    const reader = createBinaryObjectReader(createBlobLike(Uint8Array.from([1, 2, 3, 4])));
    const target = new Uint8Array(4);

    expect(await reader.readInto(target, 1, 2, 2)).toBe(2);
    expect(Array.from(target)).toEqual([0, 3, 4, 0]);
  });

  it("clamps a read to the target buffer and the file size", async () => {
    const reader = createBinaryObjectReader(createBlobLike(Uint8Array.from([1, 2, 3, 4])));
    const target = new Uint8Array(2);

    expect(await reader.readInto(target)).toBe(2);
    expect(Array.from(target)).toEqual([1, 2]);
    expect(await reader.readInto(new Uint8Array(2), 0, 2, 4)).toBe(0);
  });
});

describe("copySourceToWriter", () => {
  it("streams a byte source in chunks and reports the copied length", async () => {
    const { chunks, copied } = await collectChunks(Uint8Array.from([1, 2, 3, 4, 5]), { chunkSize: 2 });

    expect(copied).toBe(5);
    expect(chunks).toEqual([
      { bytes: [1, 2], offset: 0 },
      { bytes: [3, 4], offset: 2 },
      { bytes: [5], offset: 4 },
    ]);
  });

  it("honours an explicit offset and length", async () => {
    const { chunks, copied } = await collectChunks(Uint8Array.from([1, 2, 3, 4, 5]).buffer, {
      chunkSize: 2,
      length: 3,
      offset: 1,
    });

    expect(copied).toBe(3);
    expect(chunks).toEqual([
      { bytes: [2, 3], offset: 1 },
      { bytes: [4], offset: 3 },
    ]);
  });

  it("copies a SharedArrayBuffer source", async () => {
    const shared = new SharedArrayBuffer(3);
    new Uint8Array(shared).set([9, 8, 7]);

    const { chunks, copied } = await collectChunks(shared);

    expect(copied).toBe(3);
    expect(chunks[0]?.bytes).toEqual([9, 8, 7]);
  });

  it("copies a record backed by a blob", async () => {
    const { chunks, copied } = await collectChunks({ _file: createBlobLike(Uint8Array.from([1, 2, 3])) });

    expect(copied).toBe(3);
    expect(chunks[0]?.bytes).toEqual([1, 2, 3]);
  });

  it("copies a record backed by _u8array", async () => {
    const { copied, chunks } = await collectChunks({ _u8array: Uint8Array.from([4, 5]), fileName: "a.bin" });

    expect(copied).toBe(2);
    expect(chunks[0]?.bytes).toEqual([4, 5]);
  });

  it("copies a record that only exposes readIntoAt", async () => {
    const backing = Uint8Array.from([1, 2, 3, 4]);
    const source = {
      fileSize: backing.byteLength,
      readIntoAt: (buffer: Uint8Array, bufferOffset = 0, len = 0, fileOffset = 0) => {
        buffer.set(backing.subarray(fileOffset, fileOffset + len), bufferOffset);
        return len;
      },
    };

    const { chunks, copied } = await collectChunks(source, { chunkSize: 3 });

    expect(copied).toBe(4);
    expect(chunks).toEqual([
      { bytes: [1, 2, 3], offset: 0 },
      { bytes: [4], offset: 3 },
    ]);
  });

  it("copies a record that only exposes materialize", async () => {
    const backing = Uint8Array.from([1, 2, 3, 4]);
    const source = {
      fileSize: backing.byteLength,
      materialize: (offset: number, len: number) => backing.subarray(offset, offset + len),
    };

    const { chunks, copied } = await collectChunks(source, { chunkSize: 3 });

    expect(copied).toBe(4);
    expect(chunks).toEqual([
      { bytes: [1, 2, 3], offset: 0 },
      { bytes: [4], offset: 3 },
    ]);
  });

  it("copies nothing for an empty materialize range", async () => {
    const { chunks, copied } = await collectChunks({ fileSize: 0, materialize: () => new Uint8Array(0) });

    expect(copied).toBe(0);
    expect(chunks).toEqual([]);
  });

  it("rejects a source that names a filesystem path", async () => {
    await expect(collectChunks({ filePath: "/roms/rom.sfc" })).rejects.toThrow(
      "Path binary source support is not configured",
    );
    // A blank path passes the named-source check but still reaches the record
    // reader, which refuses every path-backed record the same way.
    await expect(collectChunks({ fileSize: 4, filePath: "   " })).rejects.toThrow(
      "Path binary source support is not configured",
    );
  });

  it("rejects a record with no readable bytes", async () => {
    await expect(collectChunks({ unrelated: true })).rejects.toThrow("Unsupported binary source");
  });

  it("asks the configured object factories before the built-in readers", async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const declined = vi.fn(() => null);
    const accepted = vi.fn((_source: unknown, name: string, fallbackName: string) => ({
      name: name || fallbackName,
      readInto: () => 0,
      readRange: () => Promise.resolve(bytes),
      size: bytes.byteLength,
    }));
    configureObjectBinarySourceReaderFactories([declined, accepted]);

    const source = { marker: true };
    const { chunks, copied } = await collectChunks(source);

    expect(copied).toBe(3);
    expect(chunks[0]?.bytes).toEqual([1, 2, 3]);
    expect(declined).toHaveBeenCalledWith(source, "file.bin", "file.bin");
    expect(accepted).toHaveBeenCalledTimes(1);
  });
});

describe("hasReadableBytes", () => {
  it("accepts buffers, views, and readable records", () => {
    expect(hasReadableBytes(new ArrayBuffer(2))).toBe(true);
    expect(hasReadableBytes(Uint8Array.from([1]))).toBe(true);
    expect(hasReadableBytes({ _u8array: Uint8Array.from([1]) })).toBe(true);
    expect(hasReadableBytes({ fileSize: 1, readIntoAt: () => 1 })).toBe(true);
    expect(hasReadableBytes({ fileSize: 1, materialize: () => new Uint8Array(1) })).toBe(true);
  });

  it("rejects a browser-file-backed record until its bytes are staged", () => {
    expect(hasReadableBytes({ _browserFileBacked: true, fileSize: 4 })).toBe(false);
    expect(hasReadableBytes({ _browserFileBacked: true, _u8array: Uint8Array.from([1]) })).toBe(true);
  });

  it("rejects sources with nothing to read", () => {
    expect(hasReadableBytes(null)).toBe(false);
    expect(hasReadableBytes({ fileName: "rom.sfc" })).toBe(false);
  });
});

describe("createPatchFileFromSource", () => {
  it("clones an existing patch file that already owns its bytes", async () => {
    const original = new FakePatchFile(undefined);
    original._u8array = Uint8Array.from([1, 2, 3]);
    original.fileName = "original.ips";

    const clone = (await createPatchFileFromSource(original, FakePatchFile)) as FakePatchFile;

    expect(clone).toBeInstanceOf(FakePatchFile);
    expect(clone).not.toBe(original);
    expect(clone.input).toBe(original);
    expect(clone.fileName).toBe("original.ips");
  });

  it("clones an existing patch file that is backed by a path", async () => {
    const original = new FakePatchFile(undefined);
    original.filePath = "/patches/original.ips";

    const clone = (await createPatchFileFromSource(original, FakePatchFile)) as FakePatchFile;

    expect(clone.input).toBe(original);
  });

  it("materializes a buffer source into a new patch file", async () => {
    const patch = (await createPatchFileFromSource(
      { fileName: "patch.ips", source: Uint8Array.from([1, 2, 3]) },
      FakePatchFile,
    )) as FakePatchFile;

    expect(patch.fileName).toBe("patch.ips");
    expect(Array.from(new Uint8Array(patch.input as ArrayBuffer))).toEqual([1, 2, 3]);
  });

  it("hands a path source straight to the constructor", async () => {
    const patch = (await createPatchFileFromSource("/patches/from-path.ips", FakePatchFile)) as FakePatchFile;

    expect(patch.input).toBe("/patches/from-path.ips");
    expect(patch.fileName).toBe("from-path.ips");
  });

  it("carries blob metadata onto the materialized patch file", async () => {
    const blob = createBlobLike(Uint8Array.from([1, 2]));

    const patch = (await createPatchFileFromSource(blob, FakePatchFile)) as FakePatchFile;

    expect(patch._file).toBe(blob);
    expect(patch.fileSize).toBe(2);
    expect(patch.fileType).toBe("application/octet-stream");
  });

  it("keeps a file handle alongside the materialized bytes", async () => {
    const handle = {
      _u8array: Uint8Array.from([1, 2]),
      getFile: () => Promise.resolve(null),
      kind: "file",
    };

    const patch = (await createPatchFileFromSource(handle, FakePatchFile)) as FakePatchFile;

    expect(patch._fileHandle).toBe(handle);
  });

  it("copies the byte order off a patch file it had to materialize", async () => {
    const backing = Uint8Array.from([1, 2, 3]);
    const original = new FakePatchFile(undefined);
    original.fileName = "byte-order.ips";
    original.fileSize = backing.byteLength;
    original.littleEndian = true;
    original.readIntoAt = (buffer, bufferOffset = 0, len = 0, fileOffset = 0) => {
      buffer.set(backing.subarray(fileOffset, fileOffset + len), bufferOffset);
      return len;
    };

    const patch = (await createPatchFileFromSource(original, FakePatchFile)) as FakePatchFile;

    expect(patch).not.toBe(original);
    expect(patch.littleEndian).toBe(true);
    expect(Array.from(new Uint8Array(patch.input as ArrayBuffer))).toEqual([1, 2, 3]);
  });

  it("reports an unsupported source and keeps the original failure as the cause", async () => {
    await expect(createPatchFileFromSource({ unrelated: true }, FakePatchFile)).rejects.toThrow(
      "Unsupported binary source",
    );
    const failure = await createPatchFileFromSource({ unrelated: true }, FakePatchFile).catch(
      (error: unknown) => error as Error,
    );
    expect(failure.cause).toBeInstanceOf(Error);
  });
});
