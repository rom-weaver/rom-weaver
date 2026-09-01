import { describe, expect, it } from "vitest";
import PatchFile from "../../src/workers/shared/file-io/patch-file.ts";

const sourceFile = () => {
  const file = new PatchFile(new Uint8Array([1, 2, 3, 4]).buffer);
  file.fileName = "game.sfc";
  file.fileType = "application/octet-stream";
  file.littleEndian = true;
  return file;
};

describe("new PatchFile(patchFile)", () => {
  it("copies the metadata of the file it is given", () => {
    const copy = new PatchFile(sourceFile());

    expect(copy.fileName).toBe("game.sfc");
    expect(copy.fileType).toBe("application/octet-stream");
    expect(copy.fileSize).toBe(4);
    expect(copy.littleEndian).toBe(true);
    expect(Array.from(copy.readBytesAt(0, 4))).toEqual([1, 2, 3, 4]);
  });

  it("takes the source's byte source rather than the source object itself", () => {
    const source = sourceFile();
    const copy = new PatchFile(source);

    // A PatchFile satisfies SyncByteSource, so an unordered constructor made
    // every copy a view onto the previous copy.
    expect(copy._byteSource).toBe(source._byteSource);
    expect(copy._byteSource).not.toBe(source);
    expect(new PatchFile(copy)._byteSource).toBe(source._byteSource);
  });

  it("keeps its own cursor and endianness after the copy", () => {
    const source = sourceFile();
    const copy = new PatchFile(source);

    copy.seek(2);
    copy.littleEndian = false;

    expect(source.offset).toBe(0);
    expect(source.littleEndian).toBe(true);
  });

  it("materialize gives the independent bytes the shared copy does not", () => {
    const source = sourceFile();
    const materialized = source.materialize();

    materialized.writeU8At(0, 0xaa);

    expect(source.readBytesAt(0, 1)[0]).toBe(1);
    expect(materialized.readBytesAt(0, 1)[0]).toBe(0xaa);
    expect(materialized.littleEndian).toBe(true);
  });
});
