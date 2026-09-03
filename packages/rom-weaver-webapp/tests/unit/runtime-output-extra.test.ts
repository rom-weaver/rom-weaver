import { describe, expect, it, vi } from "vitest";

import { createVfsFileRef } from "../../src/storage/vfs/source-ref.ts";
import type { LargeFileVfs } from "../../src/storage/vfs/types.ts";
import {
  copyRuntimeOutputToPath,
  createRuntimeOutputFromBytes,
  createRuntimeOutputFromSource,
  getRuntimeOutputStorage,
  readRuntimeOutputBlob,
  readRuntimeOutputBytes,
} from "../../src/storage/vfs/runtime-output.ts";

const createVfs = (hostKind: "browser-opfs" = "browser-opfs") => {
  const files = new Map<string, Uint8Array>();
  const vfs: LargeFileVfs = {
    createOutputRef: async (path, fileName, options = {}) => ({
      dispose: async () => undefined,
      fileName,
      mediaType: options.mediaType,
      path,
      saveAs: async () => undefined,
      size: options.size ?? files.get(path)?.byteLength ?? 0,
      vfs,
    }),
    hostKind,
    normalizePath: (path) => path as never,
    read: vi.fn(async (path, target, options = {}) => {
      const bytes = files.get(path) || new Uint8Array();
      const view =
        target instanceof ArrayBuffer
          ? new Uint8Array(target)
          : new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
      const offset = options.fileOffset || 0;
      const bufferOffset = options.bufferOffset || 0;
      const length = Math.max(0, Math.min(options.length ?? bytes.byteLength - offset, bytes.byteLength - offset));
      view.set(bytes.subarray(offset, offset + length), bufferOffset);
      return length;
    }),
    remove: vi.fn(async (path) => {
      files.delete(path);
    }),
    rootPath: "/work",
    saveAs: vi.fn(),
    stat: vi.fn(async (path) => ({ path: path as never, size: files.get(path)?.byteLength || 0 })),
    truncate: vi.fn(async (path, size) => {
      files.set(path, new Uint8Array(Math.max(0, size)));
    }),
    write: vi.fn(async (path, bytes, options = {}) => {
      const view =
        bytes instanceof ArrayBuffer
          ? new Uint8Array(bytes)
          : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const offset = options.fileOffset || 0;
      const current = files.get(path) || new Uint8Array();
      const next = new Uint8Array(Math.max(current.byteLength, offset + view.byteLength));
      next.set(current);
      next.set(view, offset);
      files.set(path, next);
      return view.byteLength;
    }),
  };
  return { files, vfs };
};

describe("runtime output source and byte paths", () => {
  it("copies a Blob source and preserves cleanup and media metadata", async () => {
    const { files, vfs } = createVfs();
    const cleanup = vi.fn();
    const output = await createRuntimeOutputFromSource(vfs, new Blob(["rom"]), "game.bin", {
      cleanup,
      mediaType: "application/octet-stream",
      pathPrefix: "blob",
    });
    expect(output.fileName).toBe("game.bin");
    expect(output.size).toBe(3);
    expect(files.get(output.path)).toEqual(new Uint8Array([114, 111, 109]));
    await output.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(files.has(output.path)).toBe(false);
  });

  it("copies a foreign VFS ref, passes through a local ref, and reads fallback blobs", async () => {
    const destination = createVfs();
    const foreign = createVfs();
    foreign.files.set("/foreign.bin", new Uint8Array([5, 6, 7]));
    const foreignRef = createVfsFileRef(foreign.vfs, "/foreign.bin", { fileName: "foreign.bin" });
    const copied = await createRuntimeOutputFromSource(destination.vfs, foreignRef, "copy.bin");
    expect(copied.size).toBe(3);
    expect(destination.files.get(copied.path)).toEqual(new Uint8Array([5, 6, 7]));

    destination.files.set("/local.bin", new Uint8Array([8]));
    const localRef = createVfsFileRef(destination.vfs, "/local.bin", { fileName: "local.bin" });
    await expect(createRuntimeOutputFromSource(destination.vfs, localRef, "fallback.bin")).resolves.toMatchObject({
      fileName: "local.bin",
      path: "/local.bin",
    });

    const fallback = await readRuntimeOutputBlob({
      mediaType: "application/test",
      path: copied.path,
      size: 3,
      vfs: destination.vfs,
    });
    expect(fallback.type).toBe("application/test");
    expect(new Uint8Array(await fallback.arrayBuffer())).toEqual(new Uint8Array([5, 6, 7]));
  });

  it("handles empty and partial reads, storage labels, and retained-copy failures", async () => {
    const { vfs } = createVfs();
    expect(await readRuntimeOutputBytes({ path: "/none", size: 0, vfs })).toEqual(new Uint8Array());
    vi.mocked(vfs.read).mockResolvedValueOnce(1);
    const partial = await readRuntimeOutputBytes({ path: "/partial", size: 3, vfs });
    expect(partial).toHaveLength(1);
    expect(getRuntimeOutputStorage({ vfs })).toBe("opfs");
    expect(getRuntimeOutputStorage({ vfs: createVfs("file").vfs })).toBe("file");

    const source = { fileName: "short.bin", path: "/short.bin", size: 4, vfs };
    vi.mocked(vfs.read).mockResolvedValue(0);
    await expect(copyRuntimeOutputToPath(source)).rejects.toThrow("ended before the retained copy");
    expect(vfs.remove).toHaveBeenCalled();
    vi.mocked(vfs.write).mockClear();
    await createRuntimeOutputFromBytes(vfs, new Uint8Array(), "empty.bin");
    expect(vfs.write).not.toHaveBeenCalled();
  });
});
