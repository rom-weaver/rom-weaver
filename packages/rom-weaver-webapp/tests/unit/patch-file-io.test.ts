// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryByteSource } from "../../src/workers/shared/binary/byte-sources.ts";
import type { SyncByteSource } from "../../src/workers/shared/binary/types.ts";
import PatchFile from "../../src/workers/shared/file-io/patch-file.ts";

type RawPatchFile = PatchFile & {
  readBytesAt?: PatchFile["readBytesAt"];
  readU8At?: PatchFile["readU8At"];
};

const fromBytes = (values: number[]) => new PatchFile(Uint8Array.from(values).buffer);

/** A writable byte source that is not a MemoryByteSource, so PatchFile cannot mirror `_u8array`. */
const createExternalSource = (initial: number[], metadata?: { fileName?: string; filePath?: string }) => {
  const storage = new MemoryByteSource(Uint8Array.from(initial));
  const source: SyncByteSource & { writeBytesAt: (offset: number, bytes: Uint8Array) => void } = {
    fileName: metadata?.fileName ?? "external.bin",
    filePath: metadata?.filePath,
    fileSize: storage.fileSize,
    fileType: "application/octet-stream",
    readBytesAt: (offset, len) => storage.readBytesAt(offset, len),
    readIntoAt: (buffer, bufferOffset, len, fileOffset) => storage.readIntoAt(buffer, bufferOffset, len, fileOffset),
    slice: (offset, len, doNotClone) => storage.slice(offset, len, doNotClone),
    writeBytesAt: (offset, bytes) => {
      storage.writeBytesAt(offset, bytes);
      source.fileSize = storage.fileSize;
    },
  };
  return { source, storage };
};

/** Strips every built-in backing store so `readIntoAt` has to fall through to its override branches. */
const createBackinglessFile = (fileSize: number) => {
  const file = new PatchFile(0) as RawPatchFile;
  delete file._byteSource;
  delete file._u8array;
  file.fileSize = fileSize;
  return file;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PatchFile static environment", () => {
  it("detects the browser runtime from window.document", () => {
    expect(PatchFile.RUNTIME_ENVIROMENT).toBe("browser");
    expect(PatchFile.DEFAULT_CHUNK_SIZE).toBe(1024 * 1024);
    expect(PatchFile.DEVICE_LITTLE_ENDIAN).toBe(new Uint8Array(Uint16Array.of(256).buffer)[1] === 1);
  });

  it("detects a dedicated worker runtime when importScripts exists without a document", async () => {
    vi.resetModules();
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("self", { importScripts: () => undefined });
    vi.stubGlobal("importScripts", () => undefined);

    const workerModule = await import("../../src/workers/shared/file-io/patch-file.ts");

    expect(workerModule.default.RUNTIME_ENVIROMENT).toBe("webworker");
    vi.resetModules();
  });

  it("reports no runtime outside a browser and outside a worker", async () => {
    vi.resetModules();
    vi.stubGlobal("window", undefined);
    vi.stubGlobal("self", undefined);

    const bareModule = await import("../../src/workers/shared/file-io/patch-file.ts");

    expect(bareModule.default.RUNTIME_ENVIROMENT).toBeNull();
    vi.resetModules();
  });
});

describe("PatchFile construction", () => {
  it("allocates a zero-filled file from a byte count and reports it loaded", () => {
    const onLoad = vi.fn();
    const file = new PatchFile(4, onLoad);

    expect(file.fileSize).toBe(4);
    expect(Array.from(file.readBytesAt(0, 4))).toEqual([0, 0, 0, 0]);
    expect(onLoad).toHaveBeenCalledWith(file);
  });

  it("accepts ArrayBuffer and typed-array sources", () => {
    expect(Array.from(fromBytes([1, 2, 3]).readBytesAt(0, 3))).toEqual([1, 2, 3]);
    expect(Array.from(new PatchFile(Uint8Array.from([4, 5])).readBytesAt(0, 2))).toEqual([4, 5]);
  });

  it("adopts a sync byte source and mirrors its metadata", () => {
    const { source } = createExternalSource([9, 8], { fileName: "rom.sfc", filePath: "/roms/rom.sfc" });
    const file = new PatchFile(source);

    expect(file.fileName).toBe("rom.sfc");
    expect(file.filePath).toBe("/roms/rom.sfc");
    expect(file.fileSize).toBe(2);
    expect(file._u8array).toBeUndefined();
  });

  it("drops the file path when the byte source has none", () => {
    const file = new PatchFile(new MemoryByteSource(Uint8Array.from([1]), { fileName: "a.bin" }));

    expect(file.filePath).toBeUndefined();
    expect(file._u8array).toBeInstanceOf(Uint8Array);
  });

  it("rejects a live browser File", () => {
    expect(
      () => new PatchFile(new File([new Uint8Array([1])], "rom.sfc", { type: "application/octet-stream" })),
    ).toThrow(/does not accept browser File sources directly/);
  });

  it("rejects a FileList by reading its first entry", () => {
    const input = document.createElement("input");
    input.type = "file";
    // happy-dom models FileList as an array subclass; there is no other way to
    // put a File into a real FileList instance from a test.
    (input.files as unknown as File[]).push(new File([new Uint8Array([1, 2])], "patch.ips"));

    expect(() => new PatchFile(input.files as FileList)).toThrow(/does not accept browser File sources directly/);
  });

  it("rejects an empty file input as an invalid source", () => {
    const input = document.createElement("input");
    input.type = "file";

    expect(() => new PatchFile(input)).toThrow("invalid PatchFile source");
  });

  it("rejects sources it cannot read", () => {
    expect(() => new PatchFile({} as never)).toThrow("invalid PatchFile source");
    expect(() => new PatchFile("/roms/rom.sfc")).toThrow("invalid PatchFile source");
  });
});

describe("PatchFile cursor", () => {
  it("saves and restores the offset with push/pop", () => {
    const file = fromBytes([1, 2, 3, 4]);
    file.seek(3);
    file.push();
    file.seek(0);
    file.pop();

    expect(file.offset).toBe(3);
  });

  it("pops to zero when the stack is empty", () => {
    const file = fromBytes([1, 2]);
    file.seek(2);
    file.pop();

    expect(file.offset).toBe(0);
  });

  it("skips forward and reports EOF at or past the end", () => {
    const file = fromBytes([1, 2, 3]);
    file.skip(2);
    expect(file.isEOF()).toBe(false);
    file.skip(1);
    expect(file.isEOF()).toBe(true);
  });
});

describe("PatchFile read scratch", () => {
  it("reuses one buffer and grows it on demand", () => {
    const file = fromBytes([1, 2, 3, 4]);
    const small = file._getReadScratch(1);

    expect(file._getReadScratch(1)).toBe(small);
    const large = file._getReadScratch(8);
    expect(large.byteLength).toBe(8);
    expect(large).not.toBe(small);
    expect(file._getReadScratch(0).byteLength).toBe(8);
  });
});

describe("PatchFile readIntoAt fallbacks", () => {
  it("reads through the byte source", () => {
    const file = fromBytes([1, 2, 3, 4]);
    const target = new Uint8Array(4);

    expect(file.readIntoAt(target, 1, 2, 1)).toBe(2);
    expect(Array.from(target)).toEqual([0, 2, 3, 0]);
  });

  it("returns zero when the clamped read length is empty", () => {
    const file = fromBytes([1, 2]);
    expect(file.readIntoAt(new Uint8Array(2), 0, 0, 0)).toBe(0);
    expect(file.readIntoAt(new Uint8Array(2), 0, 4, 2)).toBe(0);
  });

  it("reads from a bare _u8array when there is no byte source", () => {
    const file = fromBytes([1, 2, 3, 4]) as RawPatchFile;
    file._u8array = Uint8Array.from([9, 8, 7, 6]);
    delete file._byteSource;
    const target = new Uint8Array(2);

    expect(file.readIntoAt(target, 0, 2, 1)).toBe(2);
    expect(Array.from(target)).toEqual([8, 7]);
  });

  it("delegates to an overridden readBytesAt and clamps to the bytes it returns", () => {
    const file = createBackinglessFile(4);
    file.readBytesAt = (offset, len) => Uint8Array.from([offset, len]);
    const target = new Uint8Array(4);

    expect(file.readIntoAt(target, 1, 4, 0)).toBe(2);
    expect(Array.from(target)).toEqual([0, 0, 3, 0]);
  });

  it("treats an empty readBytesAt result as a zero-byte read", () => {
    const file = createBackinglessFile(4);
    file.readBytesAt = () => undefined as unknown as Uint8Array;

    expect(file.readIntoAt(new Uint8Array(4), 0, 4, 0)).toBe(0);
  });

  it("falls back to a byte-at-a-time readU8At", () => {
    const file = createBackinglessFile(4);
    file.readU8At = (offset) => offset * 2;
    const target = new Uint8Array(4);

    expect(file.readIntoAt(target, 0, 3, 1)).toBe(3);
    expect(Array.from(target)).toEqual([2, 4, 6, 0]);
  });

  it("throws when no read primitive is available", () => {
    const file = createBackinglessFile(4);
    file.readU8At = undefined;

    expect(() => file.readIntoAt(new Uint8Array(4), 0, 4, 0)).toThrow(
      "readIntoAt is not implemented for this PatchFile",
    );
  });
});

describe("PatchFile materialize and slice", () => {
  it("copies the range and its metadata into a standalone file", () => {
    const file = fromBytes([1, 2, 3, 4]);
    file.fileName = "rom.sfc";
    file.fileType = "application/x-rom";
    file.filePath = "/roms/rom.sfc";
    file.littleEndian = true;

    const materialized = file.materialize(1, 2);

    expect(Array.from(materialized.readBytesAt(0, 2))).toEqual([2, 3]);
    expect(materialized.fileName).toBe("rom.sfc");
    expect(materialized.fileType).toBe("application/x-rom");
    expect(materialized.filePath).toBe("/roms/rom.sfc");
    expect(materialized.littleEndian).toBe(true);
  });

  it("materializes an empty range without copying bytes", () => {
    const materialized = fromBytes([1, 2]).materialize(2, 0);

    expect(materialized.fileSize).toBe(0);
  });

  it("returns itself for a whole-file slice that opts out of cloning", () => {
    const file = fromBytes([1, 2, 3]);

    expect(file.slice(0, 3, true)).toBe(file);
  });

  it("returns a byte-source view for a partial slice that opts out of cloning", () => {
    const file = fromBytes([1, 2, 3, 4]);
    file.fileName = "rom.sfc";
    file.littleEndian = true;

    const view = file.slice(1, 2, true);

    expect(view).not.toBe(file);
    expect(view.fileSize).toBe(2);
    expect(view.fileName).toBe("rom.sfc");
    expect(view.littleEndian).toBe(true);
    expect(Array.from(view.readBytesAt(0, 2))).toEqual([2, 3]);
  });

  it("clones by default", () => {
    const file = fromBytes([1, 2, 3, 4]);
    const clone = file.slice(1, 2);

    expect(Array.from(clone.readBytesAt(0, 2))).toEqual([2, 3]);
    file.writeU8At(1, 0x7f);
    expect(Array.from(clone.readBytesAt(0, 2))).toEqual([2, 3]);
  });

  it("rejects an out-of-bounds slice", () => {
    expect(() => fromBytes([1, 2]).slice(5, 1)).toThrow("out of bounds slicing");
  });
});

describe("PatchFile byte access", () => {
  it("reads single bytes from each backing store", () => {
    expect(fromBytes([7, 8]).readU8At(1)).toBe(8);

    const arrayBacked = fromBytes([7, 8]) as RawPatchFile;
    arrayBacked._u8array = Uint8Array.from([5, 6]);
    delete arrayBacked._byteSource;
    expect(arrayBacked.readU8At(0)).toBe(5);
    expect(arrayBacked.readU8At(9)).toBe(0);

    const overridden = createBackinglessFile(2);
    overridden.readBytesAt = (offset) => Uint8Array.from([offset + 100]);
    expect(overridden.readU8At(1)).toBe(101);
  });

  it("reads zero when the byte source has nothing at the offset", () => {
    expect(fromBytes([7, 8]).readU8At(5)).toBe(0);
  });

  it("reads ranges from each backing store", () => {
    expect(Array.from(fromBytes([1, 2, 3]).readBytesAt(1, 2))).toEqual([2, 3]);

    const arrayBacked = fromBytes([1, 2, 3]) as RawPatchFile;
    arrayBacked._u8array = Uint8Array.from([4, 5, 6]);
    delete arrayBacked._byteSource;
    expect(Array.from(arrayBacked.readBytesAt(1, 2))).toEqual([5, 6]);

    const fallback = createBackinglessFile(3);
    fallback.readU8At = (offset) => offset + 1;
    expect(Array.from(fallback.readBytesAt(0, 3))).toEqual([1, 2, 3]);
    expect(Array.from(fallback.readBytesAt(3, 0))).toEqual([]);
  });
});

describe("PatchFile writes", () => {
  it("writes a byte through a writable byte source and refreshes the mirrored storage", () => {
    const file = fromBytes([1, 2, 3]);
    file.writeU8At(1, 0x1ff);

    expect(Array.from(file.readBytesAt(0, 3))).toEqual([1, 0xff, 3]);
    expect(file._u8array?.[1]).toBe(0xff);
  });

  it("grows the file when a write runs past the end", () => {
    const file = fromBytes([1]);
    file.writeBytesAt(1, Uint8Array.from([2, 3]));

    expect(file.fileSize).toBe(3);
    expect(Array.from(file.readBytesAt(0, 3))).toEqual([1, 2, 3]);
  });

  it("does not mirror storage for a byte source that is not memory backed", () => {
    const { source, storage } = createExternalSource([1, 2]);
    const file = new PatchFile(source);

    file.writeBytesAt(0, Uint8Array.from([9]));

    expect(file._u8array).toBeUndefined();
    expect(file.fileSize).toBe(2);
    expect(Array.from(storage.readBytesAt(0, 2))).toEqual([9, 2]);
  });

  it("writes into a bare _u8array when there is no byte source", () => {
    const file = fromBytes([1, 2, 3]) as RawPatchFile;
    const storage = Uint8Array.from([1, 2, 3]);
    file._u8array = storage;
    delete file._byteSource;

    file.writeU8At(0, 9);
    file.writeBytesAt(1, [8, 7]);

    expect(Array.from(storage)).toEqual([9, 8, 7]);
  });

  it("refuses to write when there is no writable storage", () => {
    const file = createBackinglessFile(2);

    expect(() => file.writeU8At(0, 1)).toThrow("PatchFile is not writable");
    expect(() => file.writeBytesAt(0, [1])).toThrow("PatchFile is not writable");
  });
});

describe("PatchFile name helpers", () => {
  it("splits the extension off the file name", () => {
    const file = fromBytes([1]);
    file.fileName = "Super Game.SFC";

    expect(file.getExtension()).toBe("sfc");
    expect(file.getName()).toBe("Super Game");
    expect(file.setExtension("smc")).toBe("Super Game.smc");
    expect(file.setName("Другая")).toBe("Другая.smc");
  });

  it("handles a name with no extension", () => {
    const file = fromBytes([1]);
    file.fileName = "rom";

    expect(file.getExtension()).toBe("");
    expect(file.getName()).toBe("rom");
  });
});

describe("PatchFile sequential reads", () => {
  it("reads unsigned integers big-endian by default", () => {
    const file = fromBytes([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);

    expect(file.readU8()).toBe(0x01);
    expect(file.readU16()).toBe(0x0203);
    expect(file.readU24()).toBe(0x040506);
    expect(file.offset).toBe(6);
  });

  it("reads unsigned integers little-endian when the flag is set", () => {
    const file = fromBytes([0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    file.littleEndian = true;

    expect(file.readU16()).toBe(0x0201);
    expect(file.readU24()).toBe(0x050403);
  });

  it("reads 32-bit values in both byte orders", () => {
    const bigEndian = fromBytes([0x80, 0x00, 0x00, 0x01]);
    expect(bigEndian.readU32()).toBe(0x80000001);

    const littleEndian = fromBytes([0x01, 0x00, 0x00, 0x80]);
    littleEndian.littleEndian = true;
    expect(littleEndian.readU32()).toBe(0x80000001);
    expect(littleEndian.offset).toBe(4);
  });

  it("reads 64-bit values in both byte orders", () => {
    const bigEndian = fromBytes([0, 0, 0, 0, 0, 0, 0, 0x2a]);
    expect(bigEndian.readU64()).toBe(42);

    const littleEndian = fromBytes([0x2a, 0, 0, 0, 0, 0, 0, 0]);
    littleEndian.littleEndian = true;
    expect(littleEndian.readU64()).toBe(42);
    expect(littleEndian.offset).toBe(8);
  });

  it("reads a string and stops at the first NUL", () => {
    const file = fromBytes([0x50, 0x41, 0x54, 0x00, 0x43, 0x48]);

    expect(file.readString(6)).toBe("PAT");
    expect(file.offset).toBe(6);
  });
});

describe("PatchFile sequential writes", () => {
  it("writes unsigned integers big-endian by default", () => {
    const file = new PatchFile(10);

    file.writeU8(0x1ff);
    file.writeU16(0x0203);
    file.writeU24(0x040506);
    file.writeU32(0x0708090a);

    expect(file.offset).toBe(10);
    expect(Array.from(file.readBytesAt(0, 10))).toEqual([0xff, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a]);
  });

  it("writes unsigned integers little-endian when the flag is set", () => {
    const file = new PatchFile(9);
    file.littleEndian = true;

    file.writeU16(0x0102);
    file.writeU24(0x030405);
    file.writeU32(0x06070809);

    expect(Array.from(file.readBytesAt(0, 9))).toEqual([0x02, 0x01, 0x05, 0x04, 0x03, 0x09, 0x08, 0x07, 0x06]);
  });

  it("writes raw byte arrays at the cursor", () => {
    const file = new PatchFile(4);
    file.seek(1);
    file.writeBytes([1, 2, 3]);

    expect(file.offset).toBe(4);
    expect(Array.from(file.readBytesAt(0, 4))).toEqual([0, 1, 2, 3]);
  });

  it("pads a short string and truncates a long one", () => {
    const padded = new PatchFile(4);
    padded.writeString("AB", 4);
    expect(Array.from(padded.readBytesAt(0, 4))).toEqual([0x41, 0x42, 0, 0]);

    const truncated = new PatchFile(2);
    truncated.writeString("ABCD", 2);
    expect(Array.from(truncated.readBytesAt(0, 2))).toEqual([0x41, 0x42]);
    expect(truncated.offset).toBe(2);
  });

  it("uses the string length when no length is given", () => {
    const file = new PatchFile(3);
    file.writeString("ABC");

    expect(file.offset).toBe(3);
    expect(Array.from(file.readBytesAt(0, 3))).toEqual([0x41, 0x42, 0x43]);
  });
});
