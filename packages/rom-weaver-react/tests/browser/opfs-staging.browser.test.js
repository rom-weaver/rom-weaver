import { expect, test } from "vitest";
import { createBrowserOpfsSourceRef } from "../../src/workers/protocol/browser-opfs-source-ref.ts";
import { getActiveBrowserVirtualFiles } from "../../src/workers/protocol/browser-virtual-files.ts";
import { getManagedOpfsFileHandle } from "../../src/workers/protocol/opfs-path.ts";

// Input staging into OPFS is retired: every browser input (a File handle, a wrapped handle, or a plain
// Blob) is registered as a read-only, Blob-backed virtual file served by guest path — never copied into
// OPFS. So a staged ref is `virtual: true`, exposes no real OPFS handle, and appears in
// getActiveBrowserVirtualFiles() until its cleanup unregisters it.

const activeVirtualPaths = () => getActiveBrowserVirtualFiles().map((file) => file.path);

test("browser OPFS source refs resolve selected file handles to virtual work-path sources", async () => {
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
    expect(activeVirtualPaths()).toEqual([staged.filePath]);
    expect(await getManagedOpfsFileHandle(staged.filePath, { navigatorObject: navigator })).toBeNull();
  } finally {
    await staged.cleanup();
  }

  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});

test("browser OPFS source refs resolve file-handle wrappers to virtual work-path sources", async () => {
  const bytes = new Uint8Array([5, 6, 7, 8]);
  const requestFile = new File([bytes], "wrapped-input.bin", {
    type: "application/octet-stream",
  });
  const sourceHandle = {
    getFile: async () => requestFile,
    kind: "file",
    name: requestFile.name,
  };

  const staged = await createBrowserOpfsSourceRef(
    {
      fileHandle: sourceHandle,
      fileName: "wrapped-input.bin",
    },
    "fallback.bin",
    {
      bucket: "input",
      mountPoint: "/work",
      pathPrefix: "direct-input",
    },
  );

  try {
    expect(staged.fileName).toBe("wrapped-input.bin");
    expect(staged.filePath).toBe("/work/wrapped-input.bin");
    expect(staged.size).toBe(requestFile.size);
    expect(staged.storageKind).toBe("opfs");
    expect(staged.virtual).toBe(true);
    expect(activeVirtualPaths()).toEqual([staged.filePath]);
    expect(await getManagedOpfsFileHandle(staged.filePath, { navigatorObject: navigator })).toBeNull();
  } finally {
    await staged.cleanup();
  }

  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});

test("browser OPFS source refs resolve plain Blob inputs to virtual work-path sources", async () => {
  const requestBlob = new Blob([new Uint8Array([9, 8, 7, 6])], {
    type: "application/octet-stream",
  });
  expect(requestBlob).not.toBeInstanceOf(File);

  const stagedBlob = await createBrowserOpfsSourceRef(requestBlob, "blob-input.chd", {
    bucket: "input",
    mountPoint: "/work",
    pathPrefix: "direct-input",
  });
  try {
    expect(stagedBlob.fileName).toBe("blob-input.chd");
    expect(stagedBlob.filePath).toBe("/work/blob-input.chd");
    expect(stagedBlob.size).toBe(requestBlob.size);
    expect(stagedBlob.storageKind).toBe("opfs");
    expect(stagedBlob.virtual).toBe(true);
    expect(await getManagedOpfsFileHandle(stagedBlob.filePath, { navigatorObject: navigator })).toBeNull();
    // The Blob itself is registered as the virtual file's read-only source — no OPFS copy is made.
    const [virtualFile] = getActiveBrowserVirtualFiles();
    expect(virtualFile?.path).toBe(stagedBlob.filePath);
    expect(virtualFile?.source?.size).toBe(requestBlob.size);
  } finally {
    await stagedBlob.cleanup();
  }
  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});

test("browser OPFS source refs reject raw byte-array inputs", async () => {
  await expect(
    createBrowserOpfsSourceRef(new Uint8Array([1, 2, 3]), "input.bin", {
      bucket: "input",
      mountPoint: "/work",
      pathPrefix: "direct-input",
    }),
  ).rejects.toThrow(/File, Blob, FileSystemFileHandle, or OPFS path/);

  await expect(
    createBrowserOpfsSourceRef({ fileName: "input.bin", source: new Uint8Array([1, 2, 3]) }, "input.bin", {
      bucket: "input",
      mountPoint: "/work",
      pathPrefix: "direct-input",
    }),
  ).rejects.toThrow(/File, Blob, FileSystemFileHandle, or OPFS path/);

  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});

test("browser OPFS source refs use visible suffixes for concurrently-live duplicate work paths", async () => {
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
    expect(activeVirtualPaths().sort()).toEqual(["/work/game-2.bin", "/work/game.bin"]);
  } finally {
    await first.cleanup();
    await second.cleanup();
  }

  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});
