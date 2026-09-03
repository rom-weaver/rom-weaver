import { describe, expect, it, vi } from "vitest";

const { writeBlobToFileHandle } = await import("../../src/storage/browser/file-handle-write.ts");

describe("file handle output writes", () => {
  it("writes and closes a handle without permission APIs", async () => {
    const write = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const handle = { createWritable: vi.fn(async () => ({ close, write })) };
    const blob = new Blob(["data"]);
    await writeBlobToFileHandle(handle as never, blob);
    expect(handle.createWritable).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(blob);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("accepts a granted query permission without requesting again", async () => {
    const queryPermission = vi.fn(async () => "granted" as const);
    const requestPermission = vi.fn(async () => "denied" as const);
    const write = vi.fn(async () => undefined);
    const handle = {
      createWritable: vi.fn(async () => ({ close: vi.fn(async () => undefined), write })),
      queryPermission,
      requestPermission,
    };
    await writeBlobToFileHandle(handle as never, new Blob(["ok"]));
    expect(queryPermission).toHaveBeenCalledWith({ mode: "readwrite" });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("requests permission after an indeterminate query and rejects denial", async () => {
    const handle = {
      queryPermission: vi.fn(async () => "prompt" as const),
      requestPermission: vi.fn(async () => "denied" as const),
      createWritable: vi.fn(),
    };
    await expect(writeBlobToFileHandle(handle as never, new Blob(["data"]))).rejects.toMatchObject({
      code: "OUTPUT_WRITE_FAILED",
      name: "OutputWriteError",
    });
    expect(handle.createWritable).not.toHaveBeenCalled();
  });

  it("wraps permission failures from createWritable and preserves other failures", async () => {
    const permissionFailure = new DOMException("permission denied", "NotAllowedError");
    const permissionHandle = {
      createWritable: vi.fn(async () => {
        throw permissionFailure;
      }),
    };
    await expect(writeBlobToFileHandle(permissionHandle as never, new Blob())).rejects.toMatchObject({
      cause: permissionFailure,
      code: "OUTPUT_WRITE_FAILED",
    });

    const otherFailure = new Error("disk failed");
    const otherHandle = { createWritable: vi.fn(async () => Promise.reject(otherFailure)) };
    await expect(writeBlobToFileHandle(otherHandle as never, new Blob())).rejects.toBe(otherFailure);
  });

  it("aborts a writable after a write failure and ignores abort failures", async () => {
    const writeFailure = new Error("write failed");
    const abort = vi.fn(async () => {
      throw new Error("abort failed");
    });
    const close = vi.fn(async () => undefined);
    const handle = {
      createWritable: vi.fn(async () => ({ abort, close, write: vi.fn(async () => Promise.reject(writeFailure)) })),
    };
    await expect(writeBlobToFileHandle(handle as never, new Blob(["bad"]))).rejects.toBe(writeFailure);
    expect(abort).toHaveBeenCalledWith(writeFailure);
    expect(close).not.toHaveBeenCalled();
  });
});
