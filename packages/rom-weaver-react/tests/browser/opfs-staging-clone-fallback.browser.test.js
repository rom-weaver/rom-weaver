import { expect, test, vi } from "vitest";

test("browser OPFS source refs fail fast for non-OPFS file-handle inputs", async () => {
  vi.stubGlobal(
    "Worker",
    class UnexpectedWorker {
      constructor() {
        throw new Error("staging worker should not be used for OPFS source-ref validation");
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

    const { createBrowserOpfsSourceRef } = await import(
      "../../src/workers/protocol/browser-opfs-source-ref.ts?opfs-path-only-test"
    );
    const { getActiveBrowserVirtualFiles } = await import("../../src/workers/protocol/browser-virtual-files.ts");

    await expect(
      createBrowserOpfsSourceRef(sourceHandle, "input.chd", {
        bucket: "input",
        mountPoint: "/work",
        pathPrefix: "direct-input",
      }),
    ).rejects.toThrow(/requires OPFS-backed input paths/i);
    expect(getActiveBrowserVirtualFiles()).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("browser OPFS source refs fail fast for Blob and byte-array inputs", async () => {
  const requestFile = new File([new Uint8Array([9, 8, 7, 6])], "input.chd", {
    type: "application/octet-stream",
  });

  const { createBrowserOpfsSourceRef } = await import(
    "../../src/workers/protocol/browser-opfs-source-ref.ts?opfs-path-only-blob-test"
  );

  await expect(
    createBrowserOpfsSourceRef(requestFile, "input.chd", {
      bucket: "input",
      mountPoint: "/work",
      pathPrefix: "direct-input",
    }),
  ).rejects.toThrow(/requires OPFS-backed input paths/i);
  await expect(
    createBrowserOpfsSourceRef(new Uint8Array([1, 2, 3]), "input.bin", {
      bucket: "input",
      mountPoint: "/work",
      pathPrefix: "direct-input",
    }),
  ).rejects.toThrow(/requires OPFS-backed input paths/i);
});
