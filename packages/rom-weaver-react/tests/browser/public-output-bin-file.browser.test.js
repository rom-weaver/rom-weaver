import { expect, test, vi } from "vitest";
import {
  getPatchFileBytes,
  getPatchFileExternalSource,
  isLazyExternalPatchFile,
} from "../../src/lib/input/binary-service.ts";
import { createPatchFileFromPublicOutput } from "../../src/lib/runtime/public-output-bin-file.ts";

const createVfs = () => ({
  createOutputRef: vi.fn(),
  hostKind: "browser-opfs",
  normalizePath: vi.fn((filePath) => filePath),
  read: vi.fn(async () => {
    throw new Error("output bytes should not be materialized");
  }),
  remove: vi.fn(),
  rootPath: "/work",
  saveAs: vi.fn(),
  stat: vi.fn(),
  truncate: vi.fn(),
  write: vi.fn(),
});

test("public VFS outputs can stay lazy without reading bytes", async () => {
  const vfs = createVfs();
  const output = {
    cleanup: vi.fn(),
    dispose: vi.fn(),
    fileName: "large.nds",
    path: "/work/large.nds",
    saveAs: vi.fn(),
    size: 128 * 1024 * 1024,
    vfs,
  };

  const file = await createPatchFileFromPublicOutput(output, "large.nds", {
    materializeBlob: false,
    preferExternalFilePath: true,
  });

  expect(isLazyExternalPatchFile(file)).toBe(true);
  expect(vfs.read).not.toHaveBeenCalled();
  const sourceRef = getPatchFileExternalSource(file, "large.nds");
  expect(sourceRef?.fileName).toBe("large.nds");
  expect(sourceRef?.size).toBe(output.size);
  expect(sourceRef?.source).toMatchObject({
    path: "/work/large.nds",
    vfs,
  });
  expect(() => getPatchFileBytes(file)).toThrow(/Browser-backed file cannot be read synchronously/);
});

test("direct Blob public outputs can stay lazy", async () => {
  const blob = new File([new Uint8Array([1, 2, 3, 4])], "entry.bin", {
    type: "application/octet-stream",
  });
  const output = {
    blob,
    cleanup: vi.fn(),
    dispose: vi.fn(),
    fileName: "entry.bin",
    saveAs: vi.fn(),
    size: blob.size,
  };

  const file = await createPatchFileFromPublicOutput(output, "entry.bin", {
    materializeBlob: false,
  });

  expect(isLazyExternalPatchFile(file)).toBe(true);
  const sourceRef = getPatchFileExternalSource(file, "entry.bin", {
    preferDirectBrowserSource: true,
  });
  expect(sourceRef?.source).toBe(blob);
  expect(() => getPatchFileBytes(file)).toThrow(/Browser-backed file cannot be read synchronously/);
});
