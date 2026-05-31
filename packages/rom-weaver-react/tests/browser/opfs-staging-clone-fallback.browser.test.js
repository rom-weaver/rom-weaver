import { expect, test, vi } from "vitest";

test("browser OPFS source refs use non-CHD selected files directly as virtual WASI inputs", async () => {
  vi.stubGlobal(
    "Worker",
    class UnexpectedWorker {
      constructor() {
        throw new Error("staging worker should not be used for direct browser files");
      }
    },
  );

  try {
    const requestFile = new File([new Uint8Array([1, 2, 3, 4])], "input.bin", {
      type: "application/octet-stream",
    });
    const sourceHandle = {
      getFile: async () => requestFile,
      kind: "file",
      name: requestFile.name,
    };

    const { createBrowserOpfsSourceRef } = await import("../../src/workers/protocol/browser-opfs-source-ref.ts");
    const { getActiveBrowserVirtualFiles } = await import("../../src/workers/protocol/browser-virtual-files.ts");

    const staged = await createBrowserOpfsSourceRef(sourceHandle, "input.bin", {
      bucket: "input",
      mountPoint: "/work",
      pathPrefix: "direct-input",
    });

    expect(staged.fileName).toBe("input.bin");
    expect(staged.filePath).toBe("/work/input.bin");
    expect(staged.size).toBe(requestFile.size);
    expect(staged.virtual).toBe(true);
    const activeVirtualFiles = getActiveBrowserVirtualFiles();
    expect(activeVirtualFiles).toHaveLength(1);
    expect(activeVirtualFiles[0]?.path).toBe(staged.filePath);
    expect(activeVirtualFiles[0]?.source).toBeInstanceOf(File);
    expect(activeVirtualFiles[0]?.source?.size).toBe(requestFile.size);
    expect(activeVirtualFiles[0]?.proxy).toBeUndefined();

    await staged.cleanup();
    expect(getActiveBrowserVirtualFiles()).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("browser OPFS source refs reject direct virtual inputs when Atomics.waitAsync is unavailable", async () => {
  vi.stubGlobal(
    "Worker",
    class UnexpectedWorker {
      constructor() {
        throw new Error("staging worker should not be used for direct browser files");
      }
    },
  );

  const originalWaitAsync = Atomics.waitAsync;
  Object.defineProperty(Atomics, "waitAsync", {
    configurable: true,
    value: undefined,
    writable: true,
  });

  try {
    const { createBrowserOpfsSourceRef } = await import("../../src/workers/protocol/browser-opfs-source-ref.ts");
    const { getActiveBrowserVirtualFiles } = await import("../../src/workers/protocol/browser-virtual-files.ts");

    await expect(
      createBrowserOpfsSourceRef(new Uint8Array([9, 8, 7, 6]), "input.bin", {
        bucket: "input",
        mountPoint: "/work",
        pathPrefix: "direct-input",
      }),
    ).rejects.toThrow(/Atomics\.waitAsync/);

    expect(getActiveBrowserVirtualFiles()).toEqual([]);
  } finally {
    Object.defineProperty(Atomics, "waitAsync", {
      configurable: true,
      value: originalWaitAsync,
      writable: true,
    });
    vi.unstubAllGlobals();
  }
});

test("browser OPFS source refs keep CHD blobs and byte-array inputs virtual", async () => {
  const requestFile = new File([new Uint8Array([9, 8, 7, 6])], "input.chd", {
    type: "application/octet-stream",
  });
  const { createBrowserOpfsSourceRef } = await import("../../src/workers/protocol/browser-opfs-source-ref.ts");
  const { getActiveBrowserVirtualFiles } = await import("../../src/workers/protocol/browser-virtual-files.ts");
  const { getManagedOpfsFileHandle } = await import("../../src/workers/protocol/opfs-path.ts");

  const stagedBlob = await createBrowserOpfsSourceRef(requestFile, "input.chd", {
    bucket: "input",
    mountPoint: "/work",
    pathPrefix: "direct-input",
  });
  expect(stagedBlob.virtual).toBe(true);
  expect(stagedBlob.filePath).toBe("/work/input.chd");
  expect(stagedBlob.size).toBe(requestFile.size);
  expect(getActiveBrowserVirtualFiles()).toEqual([
    expect.objectContaining({
      path: stagedBlob.filePath,
      source: requestFile,
    }),
  ]);
  expect(await getManagedOpfsFileHandle(stagedBlob.filePath, { navigatorObject: navigator })).toBeNull();
  await stagedBlob.cleanup();
  expect(getActiveBrowserVirtualFiles()).toEqual([]);

  const stagedBytes = await createBrowserOpfsSourceRef(new Uint8Array([1, 2, 3]), "input.bin", {
    bucket: "input",
    mountPoint: "/work",
    pathPrefix: "direct-input",
  });
  expect(stagedBytes.virtual).toBe(true);
  expect(stagedBytes.size).toBe(3);
  expect(getActiveBrowserVirtualFiles()).toHaveLength(1);
  await stagedBytes.cleanup();
  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});

test("browser OPFS virtual RVZ staging preserves the original filename leaf", async () => {
  const sourceName = "Luigi's Mansion (USA).rvz";
  const sourceFile = new File([new Uint8Array([1, 2, 3, 4])], sourceName, {
    type: "application/octet-stream",
  });
  const { createBrowserOpfsSourceRef } = await import("../../src/workers/protocol/browser-opfs-source-ref.ts");
  const { getActiveBrowserVirtualFiles } = await import("../../src/workers/protocol/browser-virtual-files.ts");
  const staged = await createBrowserOpfsSourceRef(sourceFile, sourceName, {
    bucket: "input",
    mountPoint: "/work",
    pathPrefix: "rvz-input",
  });
  try {
    expect(staged.virtual).toBe(true);
    expect(staged.fileName).toBe(sourceName);
    expect(staged.filePath).toBe("/work/Luigi's Mansion (USA).rvz");
    expect(getActiveBrowserVirtualFiles()).toEqual([
      expect.objectContaining({
        path: staged.filePath,
        proxy: expect.objectContaining({ size: sourceFile.size }),
      }),
    ]);
  } finally {
    await staged.cleanup();
  }
  expect(getActiveBrowserVirtualFiles()).toEqual([]);
});
