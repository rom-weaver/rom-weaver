import { expect, test } from "vitest";

test("webapp boot leaves existing OPFS entries untouched", async () => {
  const root = await navigator.storage.getDirectory();
  const siblingName = `live-sibling-${crypto.randomUUID()}`;
  const sibling = await root.getDirectoryHandle(siblingName, { create: true });
  const file = await sibling.getFileHandle("owned-by-another-tab.bin", { create: true });
  const writable = await file.createWritable();
  await writable.write(new Uint8Array([1, 2, 3]));
  await writable.close();

  const appRoot = document.createElement("div");
  appRoot.id = "webapp-root";
  document.body.append(appRoot);

  try {
    await import("../../src/webapp/webapp.ts");
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));

    const survivingDirectory = await root.getDirectoryHandle(siblingName);
    const survivingFile = await survivingDirectory.getFileHandle("owned-by-another-tab.bin");
    await expect(survivingFile.getFile()).resolves.toMatchObject({ size: 3 });
  } finally {
    await root.removeEntry(siblingName, { recursive: true }).catch(() => undefined);
  }
});
