import { describe, expect, it } from "vitest";
import {
  isGuestPathWithinMount,
  isGuestPathWithinRoots,
  joinGuestPath,
  normalizeKnownInputPaths,
  normalizeMountHandleMap,
  normalizeRelativePathParts,
  normalizeStdin,
  normalizeWritableRoots,
} from "../../src/wasm/browser-opfs-guest-paths.ts";

const directoryHandle = {
  kind: "directory" as const,
  entries: () => [],
  getDirectoryHandle: async () => directoryHandle,
  getFileHandle: async () => ({ kind: "file" as const }),
};

describe("browser OPFS guest path normalization", () => {
  it("normalizes mount handles and rejects non-directory handles", () => {
    expect(normalizeMountHandleMap({ mountHandles: null })).toEqual({});
    expect(
      normalizeMountHandleMap({
        mountHandles: {
          "/work/": directoryHandle,
          "/nested/": directoryHandle,
        },
      }),
    ).toEqual({ "/nested": directoryHandle, "/work": directoryHandle });
    expect(() => normalizeMountHandleMap({ mountHandles: { "/work": {} } })).toThrow(
      "mountHandles[/work] must be a FileSystemDirectoryHandle",
    );
  });

  it("normalizes writable and known-input roots with stable deduplication", () => {
    expect(
      normalizeWritableRoots({
        workGuestPath: "/work/",
        writableDirectories: ["/cache///", "work", "/cache"],
      }),
    ).toEqual(["/cache", "/work", "/work/"]);
    expect(
      normalizeWritableRoots({
        workGuestPath: "/work",
        writableDirectories: null,
        inherited: ["/extra", "/work"],
      }),
    ).toEqual(["/extra", "/work"]);
    expect(normalizeKnownInputPaths(undefined)).toEqual([]);
    expect(normalizeKnownInputPaths(["relative.bin", "/nested/file.bin/"])).toEqual([
      "/relative.bin",
      "/nested/file.bin",
    ]);
    expect(() => normalizeKnownInputPaths("file.bin")).toThrow("knownInputPaths must be an array");
  });

  it("keeps containment checks at path-component boundaries", () => {
    expect(isGuestPathWithinRoots("work/file.bin", ["/work"])).toBe(true);
    expect(isGuestPathWithinRoots("/work", ["/work"])).toBe(true);
    expect(isGuestPathWithinRoots("/worker/file.bin", ["/work"])).toBe(false);
    expect(isGuestPathWithinRoots("/other/file.bin", ["/work", "/other"])).toBe(true);
    expect(isGuestPathWithinMount("/work", "/work")).toBe(true);
    expect(isGuestPathWithinMount("/work/file.bin", "/work")).toBe(true);
    expect(isGuestPathWithinMount("/worker/file.bin", "/work")).toBe(false);
  });
});

describe("browser OPFS guest path helpers", () => {
  it("joins guest paths while trimming only duplicate separators", () => {
    expect(joinGuestPath("/work/", "/nested/", "file.bin")).toBe("/work/nested/file.bin");
    expect(joinGuestPath("work", null, "/file.bin/")).toBe("/work/file.bin");
    expect(joinGuestPath("/work/", "")).toBe("/work");
  });

  it("rejects unsafe relative path segments and accepts slash variants", () => {
    expect(normalizeRelativePathParts("///nested\\dir//file.bin")).toEqual(["nested", "dir", "file.bin"]);
    expect(normalizeRelativePathParts(undefined)).toEqual([]);
    for (const unsafe of [".", "nested/../file.bin", "nested/\0file.bin"]) {
      expect(() => normalizeRelativePathParts(unsafe, { label: "proxy path" })).toThrow(
        "proxy path contains an unsafe path segment",
      );
    }
  });

  it("converts supported stdin values without changing typed-array identity", () => {
    expect(normalizeStdin(undefined)).toEqual(new Uint8Array());
    expect(normalizeStdin(null)).toEqual(new Uint8Array());
    expect(normalizeStdin("hi")).toEqual(new TextEncoder().encode("hi"));
    const bytes = new Uint8Array([1, 2]);
    expect(normalizeStdin(bytes)).toBe(bytes);
    const buffer = new Uint8Array([3, 4]).buffer;
    expect(normalizeStdin(buffer)).toEqual(new Uint8Array([3, 4]));
    expect(() => normalizeStdin({})).toThrow("stdin must be a string, Uint8Array, ArrayBuffer, or undefined");
  });
});
