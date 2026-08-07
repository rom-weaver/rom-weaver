import { describe, expect, it, vi } from "vitest";
import { retainUncompressedWorkerOutputs } from "../../src/lib/apply/workflow.ts";
import type { LargeFileVfs } from "../../src/storage/vfs/types.ts";

const createVfs = () => {
  const files = new Map<string, Uint8Array>();
  const vfs: LargeFileVfs = {
    createOutputRef: async (path, fileName, options = {}) => ({
      dispose: async () => undefined,
      fileName,
      path,
      saveAs: async () => undefined,
      size: options.size || 0,
      vfs,
    }),
    hostKind: "browser-opfs",
    normalizePath: (path) => path,
    read: async (path, buffer, options = {}) => {
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
    },
    remove: async (path) => {
      files.delete(path);
    },
    rootPath: "/work",
    saveAs: async () => undefined,
    stat: async () => null,
    truncate: async (path) => {
      files.set(path, new Uint8Array());
    },
    write: async (path, bytes, options = {}) => {
      const view =
        bytes instanceof ArrayBuffer
          ? new Uint8Array(bytes)
          : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const current = files.get(path) || new Uint8Array();
      const fileOffset = options.fileOffset || 0;
      const next = new Uint8Array(Math.max(current.byteLength, fileOffset + view.byteLength));
      next.set(current);
      next.set(view, fileOffset);
      files.set(path, next);
      return view.byteLength;
    },
  };
  return { files, vfs };
};

const createWorkerOutput = (vfs: LargeFileVfs) => ({
  fileName: "game.nes",
  path: "/work/patched.nes",
  size: 3,
  vfs,
});

describe("apply workflow emulator retention", () => {
  it("invokes the callback with path metadata and copies only when it requests retention", async () => {
    const { files, vfs } = createVfs();
    files.set("/work/patched.nes", new Uint8Array([1, 2, 3]));
    let retainedPath = "";
    const retain = vi.fn(async (request: { retain: () => Promise<{ path: string }> }) => {
      retainedPath = (await request.retain()).path;
    });

    await retainUncompressedWorkerOutputs({
      inputAssets: [
        { fileName: "game.nes", id: "input-1", romType: { platform: "Nintendo Entertainment System" } } as never,
      ],
      options: { output: { compression: "zip" }, retainUncompressedOutput: retain } as never,
      workerOutputsById: new Map([["input-1", createWorkerOutput(vfs) as never]]),
    });

    expect(retain).toHaveBeenCalledOnce();
    expect(retain.mock.calls[0]?.[0]).toMatchObject({
      fileName: "game.nes",
      platform: "Nintendo Entertainment System",
      size: 3,
    });
    expect(retainedPath).toMatch(/^\/work\/runtime-output\/emulator\//);
    expect(files.get(retainedPath)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("does not invoke retention when output compression is none", async () => {
    const retain = vi.fn();
    await retainUncompressedWorkerOutputs({
      inputAssets: [{ fileName: "game.nes", id: "input-1", size: 3 } as never],
      options: { output: { compression: "none" }, retainUncompressedOutput: retain } as never,
      workerOutputsById: new Map([["input-1", createWorkerOutput(createVfs().vfs) as never]]),
    });

    expect(retain).not.toHaveBeenCalled();
  });

  it("logs retention failures and continues the workflow", async () => {
    const onLog = vi.fn();
    const retain = vi.fn(async () => {
      throw new Error("quota exceeded");
    });

    await expect(
      retainUncompressedWorkerOutputs({
        inputAssets: [{ fileName: "game.nes", id: "input-1", size: 3 } as never],
        options: {
          logging: { level: "debug" },
          onLog,
          output: { compression: "zip" },
          retainUncompressedOutput: retain,
        } as never,
        workerOutputsById: new Map([["input-1", createWorkerOutput(createVfs().vfs) as never]]),
      }),
    ).resolves.toBeUndefined();
    expect(onLog).toHaveBeenCalledWith(expect.objectContaining({ level: "warn" }));
  });
});
