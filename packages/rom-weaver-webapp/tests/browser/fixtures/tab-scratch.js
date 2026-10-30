import { browserRuntime } from "../../../src/platform/browser/workflow-runtime.ts";
import { browserVfs } from "../../../src/platform/browser/workflow-runtime-vfs-cleanup.ts";

export const prepareTabScratch = async () => {
  const romBytes = new Uint8Array([0, 1, 2, 3]);
  const patchBytes = new TextEncoder().encode("PATCHEOF");
  const manifest = { version: 1, rom: { path: "game.bin" }, patches: [{ path: "change.ips" }] };
  const archive = await browserRuntime.compression.create({
    entries: [
      { fileName: "game.bin", file: new File([romBytes], "game.bin") },
      { fileName: "change.ips", file: new File([patchBytes], "change.ips") },
      {
        fileName: "rom-weaver-weave.json",
        file: new File([JSON.stringify(manifest)], "rom-weaver-weave.json"),
      },
    ],
    format: "zip",
    options: { outputName: "tab-weave.zip", threads: 1 },
  });
  let parsed;
  try {
    const blob = await browserRuntime.publicOutput.getBlob(archive.output);
    const archiveBytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
    parsed = await browserRuntime.weave.parse({ source: new File([new Uint8Array(archiveBytes)], "tab-weave.zip") });
    const paths = [archive.output.path, ...parsed.extractedFiles.keys()];
    return {
      paths,
      verify: async () => {
        const outputBlob = await browserRuntime.publicOutput.getBlob(archive.output);
        const outputBytes = Array.from(new Uint8Array(await outputBlob.arrayBuffer()));
        const romPath = parsed.result.romSource.extractedPath;
        const patchPath = parsed.result.patchSources[0].source.extractedPath;
        const romFile = await browserVfs.getFile(romPath);
        const patchFile = await browserVfs.getFile(patchPath);
        const applied = await browserRuntime.patch.applyPatch({
          input: { fileName: "game.bin", filePath: romPath },
          patches: [{ patchFileName: "change.ips", patchFile: { filePath: patchPath } }],
          options: { outputName: "still-readable.bin", threads: 1 },
        });
        try {
          const appliedBlob = await browserRuntime.publicOutput.getBlob(applied);
          return {
            outputMatches:
              outputBytes.length === archiveBytes.length && outputBytes.every((byte, i) => byte === archiveBytes[i]),
            romBytes: Array.from(new Uint8Array(await romFile.arrayBuffer())),
            patchBytes: Array.from(new Uint8Array(await patchFile.arrayBuffer())),
            appliedBytes: Array.from(new Uint8Array(await appliedBlob.arrayBuffer())),
          };
        } finally {
          await applied.dispose();
        }
      },
      cleanup: async () => {
        await parsed.cleanup();
        await archive.output.dispose();
      },
    };
  } catch (error) {
    await Promise.allSettled([parsed?.cleanup(), archive.output.dispose()]);
    throw error;
  }
};
