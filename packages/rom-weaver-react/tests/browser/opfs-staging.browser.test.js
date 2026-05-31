import { expect, test } from "vitest";
import { createBrowserOpfsSourceRef } from "../../src/workers/protocol/browser-opfs-source-ref.ts";
import { getActiveBrowserVirtualFiles } from "../../src/workers/protocol/browser-virtual-files.ts";
import { getManagedOpfsFileHandle } from "../../src/workers/protocol/opfs-path.ts";

test("browser OPFS source refs use selected file handles as virtual WASI inputs", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const requestFile = new File([bytes], "input.chd", {
    type: "application/octet-stream",
  });
  const sourceHandle = {
    getFile: async () => requestFile,
    kind: "file",
    name: requestFile.name,
  };

  const staged = await createBrowserOpfsSourceRef(sourceHandle, "input.chd", {
    bucket: "input",
    mountPoint: "/work",
    pathPrefix: "direct-input",
  });

  try {
    expect(staged.fileName).toBe("input.chd");
    expect(staged.filePath).toBe("/work/input.chd");
    expect(staged.size).toBe(requestFile.size);
    expect(staged.storageKind).toBe("opfs");
    expect(staged.virtual).toBe(true);
    expect(getActiveBrowserVirtualFiles()).toEqual([
      expect.objectContaining({
        path: staged.filePath,
        source: requestFile,
      }),
    ]);
    expect(await getManagedOpfsFileHandle(staged.filePath, { navigatorObject: navigator })).toBeNull();
  } finally {
    await staged.cleanup();
  }

  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});

test("browser OPFS source refs use Blob and byte-array inputs as virtual WASI inputs", async () => {
  const requestFile = new File([new Uint8Array([9, 8, 7, 6])], "input.chd", {
    type: "application/octet-stream",
  });
  const stagedBlob = await createBrowserOpfsSourceRef(requestFile, "input.chd", {
    bucket: "input",
    mountPoint: "/work",
    pathPrefix: "direct-input",
  });
  try {
    expect(stagedBlob.storageKind).toBe("opfs");
    expect(stagedBlob.virtual).toBe(true);
    expect(getActiveBrowserVirtualFiles()).toEqual([
      expect.objectContaining({
        path: stagedBlob.filePath,
        source: requestFile,
      }),
    ]);
    expect(await getManagedOpfsFileHandle(stagedBlob.filePath, { navigatorObject: navigator })).toBeNull();
  } finally {
    await stagedBlob.cleanup();
  }
  expect(getActiveBrowserVirtualFiles()).toEqual([]);

  const stagedBytes = await createBrowserOpfsSourceRef(new Uint8Array([1, 2, 3]), "input.bin", {
    bucket: "input",
    mountPoint: "/work",
    pathPrefix: "direct-input",
  });
  try {
    expect(stagedBytes.storageKind).toBe("opfs");
    expect(stagedBytes.size).toBe(3);
    expect(stagedBytes.virtual).toBe(true);
    expect(stagedBytes.filePath).toBe("/work/input.bin");
    expect(getActiveBrowserVirtualFiles()).toEqual([
      expect.objectContaining({
        path: stagedBytes.filePath,
        proxy: expect.objectContaining({ size: 3 }),
      }),
    ]);
  } finally {
    await stagedBytes.cleanup();
  }
  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});

test("browser OPFS source refs use visible suffixes for duplicate flat work paths", async () => {
  const first = await createBrowserOpfsSourceRef(new File([new Uint8Array([1])], "game.bin"), "game.bin", {
    bucket: "input",
    mountPoint: "/work",
    pathPrefix: "direct-input",
  });
  const second = await createBrowserOpfsSourceRef(new File([new Uint8Array([2])], "game.bin"), "game.bin", {
    bucket: "input",
    mountPoint: "/work",
    pathPrefix: "direct-input",
  });

  try {
    expect(first.filePath).toBe("/work/game.bin");
    expect(second.filePath).toBe("/work/game-2.bin");
    expect(getActiveBrowserVirtualFiles().map((entry) => entry.path).sort()).toEqual(["/work/game-2.bin", "/work/game.bin"]);
  } finally {
    await first.cleanup();
    await second.cleanup();
  }

  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});
