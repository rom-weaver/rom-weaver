import { expect, test, vi } from "vitest";

const gate = vi.hoisted(() => ({ release: undefined, entered: false }));
vi.mock("../../src/storage/browser/browser-opfs-cleanup.ts", async (importOriginal) => {
  const original = await importOriginal();
  const ready = new Promise((resolve) => {
    gate.release = resolve;
  });
  return {
    ...original,
    waitForBrowserOpfsBootCleanup: async () => {
      gate.entered = true;
      await ready;
      await original.waitForBrowserOpfsBootCleanup();
    },
  };
});

import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { createBrowserRuntimeVfsIo } from "../../src/platform/browser/browser-runtime-vfs.ts";
import { createBrowserLargeFileVfs } from "../../src/storage/browser/browser-large-file-vfs.ts";

test("ROM and patch writes wait for boot readiness and remain readable when staged together", async () => {
  const vfs = createBrowserLargeFileVfs();
  const io = createBrowserRuntimeVfsIo({ vfs });
  const prefix = `/work/operations/boot-${crypto.randomUUID()}`;
  const inputs = [
    { fileName: "rom.bin", bytes: new Uint8Array([0, 1, 2, 3, 4]) },
    { fileName: "patch.ips", bytes: new TextEncoder().encode("PATCHEOF") },
  ];
  let completed = 0;
  const writes = inputs.map(async ({ fileName, bytes }) => {
    const path = `${prefix}/${fileName}`;
    await vfs.truncate(path, 0);
    await vfs.write(path, bytes);
    completed += 1;
    return { fileName, path, vfs };
  });
  await expect.poll(() => gate.entered).toBe(true);
  expect(completed).toBe(0);
  gate.release();
  try {
    const sources = await Promise.all(writes);
    const staged = await io.stageSources(
      sources.map((source) => ({
        fallbackFileName: source.fileName,
        scope: "archive",
        source,
      })),
    );
    try {
      for (const [index, source] of staged.entries()) {
        const bytes = new Uint8Array(source.size);
        await expect(vfs.read(source.filePath, bytes)).resolves.toBe(inputs[index].bytes.length);
        expect(bytes).toEqual(inputs[index].bytes);
      }
      const manifest = { version: 1, rom: { path: "rom.bin" }, patches: [{ path: "patch.ips" }] };
      const archive = await browserRuntime.compression.create({
        entries: [
          ...inputs.map(({ fileName, bytes }) => ({ fileName, file: new File([bytes], fileName) })),
          { fileName: "rom-weaver-weave.json", file: new File([JSON.stringify(manifest)], "rom-weaver-weave.json") },
        ],
        format: "zip",
        options: { outputName: "boot-weave.zip", threads: 1 },
      });
      let parsed;
      try {
        const blob = await browserRuntime.publicOutput.getBlob(archive.output);
        parsed = await browserRuntime.weave.parse({ source: new File([await blob.arrayBuffer()], "boot-weave.zip") });
        expect(parsed.result.romSource.kind).toBe("extracted");
        expect(parsed.result.patchSources[0].source.kind).toBe("extracted");
        const extracted = [parsed.result.romSource.extractedPath, parsed.result.patchSources[0].source.extractedPath];
        for (const [index, path] of extracted.entries()) {
          const file = parsed.extractedFiles.get(path);
          expect(new Uint8Array(await file.arrayBuffer())).toEqual(inputs[index].bytes);
        }
      } finally {
        await parsed?.cleanup();
        await archive.output.dispose();
      }
    } finally {
      await Promise.all(staged.map((source) => source.cleanup()));
    }
  } finally {
    await Promise.all(inputs.map(({ fileName }) => vfs.remove(`${prefix}/${fileName}`)));
  }
});
