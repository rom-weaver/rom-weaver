import { afterEach, describe, expect, it, vi } from "vitest";
import { handleKeptRomFile } from "../../src/wasm/kept-rom-file-worker.ts";
import { CHROMIUM_SYNC_WRITE_NO_SPACE_COUNT } from "../../src/wasm/browser-opfs-proxy-protocol.ts";

const name = `${"a".repeat(40)}-11111111-1111-1111-1111-111111111111.rom`;
afterEach(() => vi.unstubAllGlobals());

const setup = (write: (bytes: Uint8Array) => number) => {
  const close = vi.fn();
  const access = { write: vi.fn(write), close, flush: vi.fn(), truncate: vi.fn(), getSize: () => 3 };
  const file = { createSyncAccessHandle: async () => access };
  const directory = { getFileHandle: vi.fn(async () => file) };
  vi.stubGlobal("navigator", {
    storage: { getDirectory: async () => ({ getDirectoryHandle: async () => directory }) },
  });
  return { access, directory };
};

describe("kept ROM proxy writes", () => {
  it("preserves the storage-full error when closing the failed write also fails", async () => {
    const { access } = setup(() => CHROMIUM_SYNC_WRITE_NO_SPACE_COUNT);
    access.close.mockImplementation(() => {
      throw new Error("close failed");
    });
    const result = await handleKeptRomFile(
      {
        type: "kept-rom-file",
        action: "write",
        requestId: "close",
        name,
        blob: new Blob(["ROM"]),
      },
      navigator.storage.getDirectory(),
    );
    expect(result.error).toMatchObject({ name: "QuotaExceededError" });
  });
  it("handles short writes and always closes the access handle", async () => {
    const { access } = setup(() => 1);
    const result = await handleKeptRomFile(
      {
        type: "kept-rom-file",
        action: "write",
        requestId: "one",
        name,
        blob: new Blob(["ROM"]),
      },
      navigator.storage.getDirectory(),
    );
    expect(result.error).toBeUndefined();
    expect(access.write).toHaveBeenCalledTimes(3);
    expect(access.close).toHaveBeenCalledOnce();
  });

  it.each([0, CHROMIUM_SYNC_WRITE_NO_SPACE_COUNT])("reports full storage for write count %d", async (count) => {
    const { access } = setup(() => count);
    const result = await handleKeptRomFile(
      {
        type: "kept-rom-file",
        action: "write",
        requestId: "full",
        name,
        blob: new Blob(["ROM"]),
      },
      navigator.storage.getDirectory(),
    );
    expect(result.error).toMatchObject({ name: "QuotaExceededError" });
    expect(access.close).toHaveBeenCalledOnce();
  });

  it.each([-1, 4, 1.5])("rejects invalid write count %d", async (count) => {
    const { access } = setup(() => count);
    const result = await handleKeptRomFile(
      {
        type: "kept-rom-file",
        action: "write",
        requestId: "bad",
        name,
        blob: new Blob(["ROM"]),
      },
      navigator.storage.getDirectory(),
    );
    expect(result.error?.message).toContain("invalid ROM write size");
    expect(access.close).toHaveBeenCalledOnce();
  });
});
