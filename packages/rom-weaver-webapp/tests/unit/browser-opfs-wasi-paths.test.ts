import * as wasiShim from "@bjorn3/browser_wasi_shim";
import { describe, expect, it } from "vitest";
import {
  findEntryInDirectory,
  inodeMapContents,
  lastPathPart,
  normalizeWasiRelativePathParts,
  pathExistsInDirectory,
  pathIsDirectoryInDirectory,
  pathRequiresDirectory,
  requestsWriteRights,
  resolveParentDirectory,
  unlinkEntryFromDirectory,
  validateWasiRelativePath,
} from "../../src/wasm/browser-opfs-wasi-paths.ts";

const makeTree = () => {
  const payload = new wasiShim.File([1, 2, 3]);
  const nested = new wasiShim.Directory(new Map([["payload.bin", payload]]));
  const root = new Map<string, wasiShim.Inode>([
    ["nested", nested],
    ["plain.bin", new wasiShim.File([4])],
  ]);
  return { nested, payload, root };
};

describe("WASI relative path validation", () => {
  it("normalizes safe segments and rejects root escapes or NUL bytes", () => {
    expect(normalizeWasiRelativePathParts("alpha//./beta/../file.bin")).toEqual(["alpha", "file.bin"]);
    expect(normalizeWasiRelativePathParts("/absolute")).toBeNull();
    expect(normalizeWasiRelativePathParts("../escape")).toBeNull();
    expect(normalizeWasiRelativePathParts("nested/../../escape")).toBeNull();
    expect(normalizeWasiRelativePathParts("safe/\0name")).toBeNull();

    expect(validateWasiRelativePath("alpha//./beta/../file.bin")).toBe(wasiShim.wasi.ERRNO_SUCCESS);
    expect(validateWasiRelativePath("/absolute")).toBe(wasiShim.wasi.ERRNO_NOTCAPABLE);
    expect(validateWasiRelativePath("../escape")).toBe(wasiShim.wasi.ERRNO_NOTCAPABLE);
    expect(validateWasiRelativePath("safe/\0name")).toBe(wasiShim.wasi.ERRNO_INVAL);
  });

  it("distinguishes files, directories, and missing entries during lookup", () => {
    const { nested, payload, root } = makeTree();

    expect(findEntryInDirectory(root, "nested/../plain.bin")).toBe(root.get("plain.bin"));
    expect(findEntryInDirectory(root, "nested/payload.bin")).toBe(payload);
    expect(findEntryInDirectory(root, "plain.bin/child")).toBeNull();
    expect(findEntryInDirectory(root, "nested/missing.bin")).toBeNull();
    expect(findEntryInDirectory(root, "/nested")).toBeNull();
    expect(findEntryInDirectory(root, "")).toBeInstanceOf(wasiShim.Directory);

    expect(pathExistsInDirectory(root, "nested/payload.bin")).toBe(true);
    expect(pathExistsInDirectory(root, "nested/missing.bin")).toBe(false);
    expect(pathIsDirectoryInDirectory(root, "nested")).toBe(true);
    expect(pathIsDirectoryInDirectory(root, "plain.bin")).toBe(false);
    expect(inodeMapContents(nested)).toBe(nested.contents);
    expect(inodeMapContents(payload)).toBeNull();
  });
});

describe("WASI path mutations", () => {
  it("resolves parents and returns the correct unlink status", () => {
    const { nested, payload, root } = makeTree();

    expect(resolveParentDirectory(root, ["nested", "payload.bin"])).toEqual({
      entries: nested.contents,
      name: "payload.bin",
      ret: wasiShim.wasi.ERRNO_SUCCESS,
    });
    expect(resolveParentDirectory(root, ["missing", "payload.bin"]).ret).toBe(wasiShim.wasi.ERRNO_NOENT);
    expect(resolveParentDirectory(root, ["plain.bin", "payload.bin"]).ret).toBe(wasiShim.wasi.ERRNO_NOTDIR);
    expect(lastPathPart(["nested", "payload.bin"])).toBe("payload.bin");
    expect(() => lastPathPart([])).toThrow("path has no segments");

    expect(unlinkEntryFromDirectory(root, "nested/payload.bin")).toEqual({
      inode_obj: payload,
      ret: wasiShim.wasi.ERRNO_SUCCESS,
    });
    expect(nested.contents.has("payload.bin")).toBe(false);
    expect(unlinkEntryFromDirectory(root, "nested/payload.bin").ret).toBe(wasiShim.wasi.ERRNO_NOENT);
    expect(unlinkEntryFromDirectory(root, "plain.bin/child").ret).toBe(wasiShim.wasi.ERRNO_NOTDIR);
    expect(unlinkEntryFromDirectory(root, "../escape").ret).toBe(wasiShim.wasi.ERRNO_NOTCAPABLE);
    expect(unlinkEntryFromDirectory(root, "").ret).toBe(wasiShim.wasi.ERRNO_INVAL);
  });
});

describe("WASI path operation flags", () => {
  it("detects write rights and directory requirements from flags", () => {
    expect(requestsWriteRights(BigInt(wasiShim.wasi.RIGHTS_FD_WRITE), 0)).toBe(true);
    expect(requestsWriteRights(0n, wasiShim.wasi.OFLAGS_TRUNC)).toBe(true);
    expect(requestsWriteRights(0n, wasiShim.wasi.OFLAGS_CREAT)).toBe(true);
    expect(requestsWriteRights(0n, 0)).toBe(false);

    expect(pathRequiresDirectory("nested/", 0)).toBe(true);
    expect(pathRequiresDirectory("nested", wasiShim.wasi.OFLAGS_DIRECTORY)).toBe(true);
    expect(pathRequiresDirectory("payload.bin", 0)).toBe(false);
  });
});
