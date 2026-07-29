import { expect, test } from "vitest";

test("webapp boot clears transient OPFS entries but preserves unrelated data", async () => {
  const root = await navigator.storage.getDirectory();
  const siblingName = `live-sibling-${crypto.randomUUID()}`;
  const sibling = await root.getDirectoryHandle(siblingName, { create: true });
  const file = await sibling.getFileHandle("owned-by-another-tab.bin", { create: true });
  const writable = await file.createWritable();
  await writable.write(new Uint8Array([1, 2, 3]));
  await writable.close();

  const bundleParse = await root.getDirectoryHandle("bundle-parse", { create: true });
  const bundleParseFile = await bundleParse.getFileHandle("scratch.bin", { create: true });
  const bundleParseWritable = await bundleParseFile.createWritable();
  await bundleParseWritable.write(new Uint8Array([4, 5, 6]));
  await bundleParseWritable.close();

  const appRoot = document.createElement("div");
  appRoot.id = "webapp-root";
  document.body.append(appRoot);

  try {
    await import("../../src/webapp/webapp.ts");
    await new Promise((resolve) => requestAnimationFrame(() => resolve()));

    const survivingDirectory = await root.getDirectoryHandle(siblingName);
    const survivingFile = await survivingDirectory.getFileHandle("owned-by-another-tab.bin");
    await expect(survivingFile.getFile()).resolves.toMatchObject({ size: 3 });
    await expect
      .poll(
        async () => {
          try {
            await root.getDirectoryHandle("bundle-parse");
            return false;
          } catch {
            return true;
          }
        },
        { timeout: 5000 },
      )
      .toBe(true);
  } finally {
    await root.removeEntry(siblingName, { recursive: true }).catch(() => undefined);
  }
});
