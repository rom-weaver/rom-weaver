import { describe, expect, it } from "vitest";
import { ROM_WEAVER_ARCHIVE_FORMATS } from "@rom-weaver/wasm/generated/rom-weaver-format-metadata";
import { getArchiveMagicType, getArchiveType, isArchiveFile } from "../../src/workers/protocol/archive-shared-utils.ts";

// The archive tables are canonical in Rust (`rom-weaver-containers`) and reach
// TS via typegen. These assertions guard the Rust → typegen → TS pipeline so a
// dropped extension or magic signature can't silently change archive routing.
describe("archive-shared-utils extension routing", () => {
  it("resolves archive types from extensions", () => {
    expect(getArchiveType("game.zip")).toBe("zip");
    expect(getArchiveType("game.7z")).toBe("7z");
    expect(getArchiveType("game.rar")).toBe("rar");
    expect(getArchiveType("disc.tar.gz")).toBe("tar.gz");
  });

  it("resolves single-extension aliases", () => {
    expect(getArchiveType("game.tgz")).toBe("tar.gz");
    expect(getArchiveType("game.r00")).toBe("rar");
    expect(getArchiveType("pkg.xip")).toBe("xar");
  });

  it("treats the libarchive passthrough universe as archives", () => {
    for (const extension of ["squashfs", "dmg", "vmdk", "ext4", "qcow2", "wim"]) {
      expect(isArchiveFile(`image.${extension}`)).toBe(true);
    }
  });

  it("does not treat bare ROM dumps as archives", () => {
    expect(isArchiveFile("rom.sfc")).toBe(false);
    expect(getArchiveType("rom.bin")).toBeNull();
  });

  it("keeps the full supported-extension universe", () => {
    expect(ROM_WEAVER_ARCHIVE_FORMATS.supportedExtensions.length).toBeGreaterThanOrEqual(135);
  });
});

describe("archive-shared-utils magic routing", () => {
  it("matches leading-byte signatures", () => {
    expect(getArchiveMagicType(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe("zip");
    expect(getArchiveMagicType(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))).toBe("7z");
    expect(getArchiveMagicType(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd]))).toBe("zst");
  });

  it("matches the tar ustar signature at offset 257", () => {
    const buffer = new Uint8Array(262);
    buffer.set([0x75, 0x73, 0x74, 0x61, 0x72], 257);
    expect(getArchiveMagicType(buffer)).toBe("tar");
  });

  it("returns null for unknown leading bytes", () => {
    expect(getArchiveMagicType(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBeNull();
  });
});
