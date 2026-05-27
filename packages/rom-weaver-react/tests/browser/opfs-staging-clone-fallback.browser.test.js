import { expect, test, vi } from "vitest";

test("browser OPFS source refs use selected files directly as virtual WASI inputs", async () => {
  vi.stubGlobal(
    "Worker",
    class UnexpectedWorker {
      constructor() {
        throw new Error("staging worker should not be used for direct browser files");
      }
    },
  );

  try {
    const requestFile = new File([new Uint8Array([1, 2, 3, 4])], "input.chd", {
      type: "application/octet-stream",
    });
    const sourceHandle = {
      getFile: async () => requestFile,
      kind: "file",
      name: requestFile.name,
    };

    const { createBrowserOpfsSourceRef } = await import("../../src/workers/protocol/browser-opfs-source-ref.ts");
    const { getActiveBrowserVirtualFiles } = await import("../../src/workers/protocol/browser-virtual-files.ts");

    const staged = await createBrowserOpfsSourceRef(sourceHandle, "input.chd", {
      bucket: "input",
      mountPoint: "/work",
      pathPrefix: "direct-input",
    });

    expect(staged.fileName).toBe("input.chd");
    expect(staged.filePath).toMatch(/^\/work\/input\/direct-input-/);
    expect(staged.size).toBe(requestFile.size);
    expect(staged.virtual).toBe(true);
    const activeVirtualFiles = getActiveBrowserVirtualFiles();
    expect(activeVirtualFiles).toHaveLength(1);
    expect(activeVirtualFiles[0]?.path).toBe(staged.filePath);
    expect(activeVirtualFiles[0]?.proxy).toMatchObject({
      size: requestFile.size,
    });
    expect(activeVirtualFiles[0]?.proxy?.slots?.length).toBeGreaterThan(0);
    expect(activeVirtualFiles[0]?.proxy?.slots?.length).toBeLessThanOrEqual(4);
    const totalSlotBytes =
      activeVirtualFiles[0]?.proxy?.slots?.reduce((total, slot) => total + slot.dataBuffer.byteLength, 0) ?? 0;
    expect(totalSlotBytes).toBeLessThanOrEqual(4 * 1024 * 1024);

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
    const requestFile = new File([new Uint8Array([9, 8, 7, 6])], "input.chd", {
      type: "application/octet-stream",
    });
    const sourceHandle = {
      getFile: async () => requestFile,
      kind: "file",
      name: requestFile.name,
    };

    const { createBrowserOpfsSourceRef } = await import("../../src/workers/protocol/browser-opfs-source-ref.ts");
    const { getActiveBrowserVirtualFiles } = await import("../../src/workers/protocol/browser-virtual-files.ts");

    await expect(
      createBrowserOpfsSourceRef(sourceHandle, "input.chd", {
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

test("browser OPFS source refs use Blob and byte-array inputs directly as virtual files", async () => {
  const requestFile = new File([new Uint8Array([9, 8, 7, 6])], "input.chd", {
    type: "application/octet-stream",
  });
  const { createBrowserOpfsSourceRef } = await import("../../src/workers/protocol/browser-opfs-source-ref.ts");
  const { getActiveBrowserVirtualFiles } = await import("../../src/workers/protocol/browser-virtual-files.ts");

  const stagedBlob = await createBrowserOpfsSourceRef(requestFile, "input.chd", {
    bucket: "input",
    mountPoint: "/work",
    pathPrefix: "direct-input",
  });
  expect(stagedBlob.virtual).toBe(true);
  expect(getActiveBrowserVirtualFiles()).toHaveLength(1);
  await stagedBlob.cleanup();

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
