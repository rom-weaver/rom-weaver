import { describe, expect, it, vi } from "vitest";
import {
  copyRuntimeOutputToPath,
  createRuntimeOutputFromBytes,
  readRuntimeOutputBlob,
} from "../../src/storage/vfs/runtime-output.ts";
import type { LargeFileVfs } from "../../src/storage/vfs/types.ts";

const createVfs = () => {
  const files = new Map<string, Uint8Array>();
  const vfs: LargeFileVfs = {
    createOutputRef: async (path: string, fileName: string, options = {}) => ({
      dispose: async () => undefined,
      fileName,
      path,
      saveAs: async () => undefined,
      size: (options as { size?: number }).size ?? 0,
      vfs,
    }),
    hostKind: "browser-opfs",
    normalizePath: (path: string) => path,
    read: vi.fn(async (path: string, buffer: ArrayBuffer | ArrayBufferView, options = {}) => {
      const source = files.get(path) || new Uint8Array();
      const fileOffset = options.fileOffset || 0;
      const bufferOffset = options.bufferOffset || 0;
      const length = Math.min(options.length ?? source.byteLength - fileOffset, source.byteLength - fileOffset);
      const target =
        buffer instanceof ArrayBuffer
          ? new Uint8Array(buffer)
          : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      if (length > 0) target.set(source.subarray(fileOffset, fileOffset + length), bufferOffset);
      return Math.max(0, length);
    }),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
    }),
    rootPath: "/work",
    saveAs: vi.fn(),
    stat: vi.fn(),
    truncate: vi.fn(async (path: string) => {
      files.set(path, new Uint8Array());
    }),
    write: vi.fn(async (path: string, bytes: ArrayBuffer | ArrayBufferView) => {
      const view =
        bytes instanceof ArrayBuffer
          ? new Uint8Array(bytes)
          : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      files.set(path, new Uint8Array(view));
      return view.byteLength;
    }),
  };
  return { files, vfs };
};

describe("runtime output paths", () => {
  it("copies a path-backed output into the emulator retention scope", async () => {
    const { files, vfs } = createVfs();
    files.set("/work/patched.nes", new Uint8Array([1, 2, 3]));

    const retained = await copyRuntimeOutputToPath(
      {
        fileName: "patched.nes",
        path: "/work/patched.nes",
        size: 3,
        vfs,
      },
      "patched.nes",
    );

    expect(retained.path).toMatch(/^\/work\/runtime-output\/emulator\/[0-9a-f-]+-patched\.nes$/);
    expect(files.get(retained.path)).toEqual(new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(await (await retained.getBlob()).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    await retained.dispose();
    expect(files.has(retained.path)).toBe(false);
  });

  it("returns a native VFS file snapshot without reading the output into a second buffer", async () => {
    const { vfs } = createVfs();
    const nativeFile = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "application/octet-stream" }) as File;
    vfs.getFile = vi.fn(async () => nativeFile);

    const blob = await readRuntimeOutputBlob({
      mediaType: "application/x-rom",
      path: "/work/large.bin",
      size: 3,
      vfs,
    });

    expect(vfs.getFile).toHaveBeenCalledWith("/work/large.bin");
    expect(vfs.read).not.toHaveBeenCalled();
    expect(blob.type).toBe("application/x-rom");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("removes a randomized output path and runs caller cleanup when construction fails", async () => {
    const { files, vfs } = createVfs();
    const cleanup = vi.fn();
    vi.mocked(vfs.write).mockRejectedValueOnce(new Error("write failed"));

    await expect(
      createRuntimeOutputFromBytes(vfs, new Uint8Array([1]), "failed.bin", { cleanup, pathPrefix: "failed" }),
    ).rejects.toThrow("write failed");

    const outputPath = vi.mocked(vfs.truncate).mock.calls[0]?.[0];
    expect(outputPath).toMatch(/^\/work\/failed\/[0-9a-f-]+-failed\.bin$/);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(vfs.remove).toHaveBeenCalledWith(outputPath);
    expect(files.has(outputPath || "")).toBe(false);
  });

  it("keeps same-basename outputs in their path-prefix ownership scopes", async () => {
    const { files, vfs } = createVfs();
    const first = await createRuntimeOutputFromBytes(vfs, new Uint8Array([1]), "same.bin", { pathPrefix: "shared" });
    const second = await createRuntimeOutputFromBytes(vfs, new Uint8Array([2]), "same.bin", {
      pathPrefix: "shared",
    });

    expect(first.path).toMatch(/^\/work\/shared\/[0-9a-f-]+-same\.bin$/);
    expect(second.path).toMatch(/^\/work\/shared\/[0-9a-f-]+-same\.bin$/);
    expect(second.path).not.toBe(first.path);
    expect(files.get(first.path)).toEqual(new Uint8Array([1]));
    expect(files.get(second.path)).toEqual(new Uint8Array([2]));

    await first.dispose();
    expect(files.has(first.path)).toBe(false);
    expect(files.get(second.path)).toEqual(new Uint8Array([2]));
  });
});
