import { describe, expect, it, vi } from "vitest";

import { openSyncAccessHandle } from "../../src/wasm/browser-opfs-sync-access.ts";

const stubHandle = () => ({}) as never;

describe("openSyncAccessHandle mode fallback", () => {
  it("falls back to the default handle when a writable mode is rejected", async () => {
    const invalidState = Object.assign(new Error("The object is in an invalid state."), {
      name: "InvalidStateError",
    });
    const fallback = stubHandle();
    const createSyncAccessHandle = vi.fn(async (options?: { mode?: string }) => {
      if (options?.mode !== undefined) throw invalidState;
      return fallback;
    });

    const result = await openSyncAccessHandle({
      fileHandle: { createSyncAccessHandle },
      mode: "readwrite-unsafe",
    });

    expect(result).toBe(fallback);
    // First call with the mode, second with no options.
    expect(createSyncAccessHandle).toHaveBeenNthCalledWith(1, { mode: "readwrite-unsafe" });
    expect(createSyncAccessHandle).toHaveBeenLastCalledWith();
  });

  it("uses the requested mode when the browser accepts it", async () => {
    const handle = stubHandle();
    const createSyncAccessHandle = vi.fn(async () => handle);

    const result = await openSyncAccessHandle({
      fileHandle: { createSyncAccessHandle },
      mode: "readwrite-unsafe",
    });

    expect(result).toBe(handle);
    expect(createSyncAccessHandle).toHaveBeenCalledTimes(1);
    expect(createSyncAccessHandle).toHaveBeenCalledWith({ mode: "readwrite-unsafe" });
  });
});
