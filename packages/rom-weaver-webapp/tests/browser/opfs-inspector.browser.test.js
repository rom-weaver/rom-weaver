import { expect, test } from "vitest";

test("lists nested OPFS paths through the storage worker", async () => {
  const root = await navigator.storage.getDirectory();
  const rootName = `opfs-inspector-${crypto.randomUUID()}`;
  const rootDirectory = await root.getDirectoryHandle(rootName, { create: true });
  const nestedDirectory = await rootDirectory.getDirectoryHandle("nested", { create: true });
  const file = await nestedDirectory.getFileHandle("path.bin", { create: true });
  const writable = await file.createWritable();
  await writable.write(new Uint8Array([1, 2, 3, 4]));
  await writable.close();

  try {
    const { listBrowserOpfs } = await import("../../src/storage/browser/browser-opfs-cleanup.ts");
    const entries = await listBrowserOpfs();
    expect(entries).toEqual(
      expect.arrayContaining([
        { kind: "directory", path: `/${rootName}` },
        { kind: "directory", path: `/${rootName}/nested` },
        { kind: "file", path: `/${rootName}/nested/path.bin`, size: 4 },
      ]),
    );
  } finally {
    await root.removeEntry(rootName, { recursive: true }).catch(() => undefined);
  }
});
