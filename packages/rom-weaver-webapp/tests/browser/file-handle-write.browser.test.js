import { expect, test, vi } from "vitest";
import { writeBlobToFileHandle } from "../../src/storage/browser/file-handle-write.ts";

test("writeBlobToFileHandle fails with OUTPUT_WRITE_FAILED when read/write permission is denied", async () => {
  const createWritable = vi.fn(async () => {
    throw new Error("createWritable should not be called when permission is denied");
  });
  const fileHandle = {
    createWritable,
    queryPermission: async () => "denied",
    requestPermission: async () => "denied",
  };

  await expect(writeBlobToFileHandle(fileHandle, new Blob(["test"]))).rejects.toMatchObject({
    code: "OUTPUT_WRITE_FAILED",
  });
  expect(createWritable).not.toHaveBeenCalled();
});

test("writeBlobToFileHandle maps createWritable permission errors to OUTPUT_WRITE_FAILED", async () => {
  const fileHandle = {
    createWritable: async () => {
      throw new DOMException(
        "Failed to execute 'createWritable' on 'FileSystemFileHandle': An attempt was made to modify an object where modifications are not allowed.",
        "NoModificationAllowedError",
      );
    },
  };

  await expect(writeBlobToFileHandle(fileHandle, new Blob(["test"]))).rejects.toMatchObject({
    code: "OUTPUT_WRITE_FAILED",
  });
});
