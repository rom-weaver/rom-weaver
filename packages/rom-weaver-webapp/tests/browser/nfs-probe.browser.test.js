import { expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { ApplyWorkflow } from "../../src/platform/browser/browser-api.ts";
import {
  resetRomWeaverRunner,
  setInputSelectionHandler,
  warmupRomWeaverRunner,
} from "../../src/workers/rom-weaver/rom-weaver-runner.ts";

import { syntheticNfs } from "../fixtures/synthetic-nfs.mjs";

const nfsArchive = async (source, key, otherRom = false) => {
  const entries = [{ file: source, fileName: source.name }];
  if (key) entries.push({ file: key, fileName: key.name });
  if (otherRom) entries.push({ file: new File(["other"], "other.nes"), fileName: "other.nes" });
  const archive = await browserRuntime.compression.create({
    format: "zip",
    entries,
    options: { threads: 1, outputName: "nfs-with-key.zip" },
  });
  try {
    const blob = await browserRuntime.publicOutput.getBlob(archive.output);
    return new File([await blob.arrayBuffer()], "nfs-with-key.zip");
  } finally {
    await archive.output.dispose();
  }
};

test("WASM probes the decrypted NFS header with a grouped synthetic htk.bin", async () => {
  await resetRomWeaverRunner();
  try {
    await warmupRomWeaverRunner();
    const { source, key } = await syntheticNfs();
    const probe = browserRuntime.compression.probe;
    if (!probe) throw new Error("Runtime compression probe capability is unavailable");
    expect(source.size).toBe(0x20200);
    const result = await probe({ source, companionFiles: [key], format: "nfs", options: { threads: 1 } });
    expect(result.platform).toBe("Nintendo GameCube");
    expect(result.entries.map((entry) => entry.filename)).toEqual(["hif_000000.iso"]);
    await expect(
      probe({
        source,
        companionFiles: [new File([new Uint8Array(16)], "htk.bin")],
        format: "nfs",
        options: { threads: 1 },
      }),
    ).rejects.toThrow(/Invalid disc header/i);
  } finally {
    await resetRomWeaverRunner();
  }
});

test("Apply rejects loose NFS missing and incorrect keys distinctly", async () => {
  const workflow = new ApplyWorkflow({ settings: { workers: { threads: 1 } } });
  try {
    const { source } = await syntheticNfs();
    await expect(workflow.setInput(source)).rejects.toThrow(/htk\.bin/i);
    await expect(workflow.setInput([source, new File([new Uint8Array(16)], "htk.bin")])).rejects.toThrow(
      /Invalid disc header/i,
    );
  } finally {
    await workflow.dispose();
    await resetRomWeaverRunner();
  }
});

test("Apply distinguishes ZIP NFS key errors and handles repeated selection cancellation", async () => {
  const workflow = new ApplyWorkflow({ settings: { workers: { threads: 1 } } });
  try {
    const { source, key } = await syntheticNfs();
    await expect(workflow.setInput(await nfsArchive(source))).rejects.toThrow(/htk\.bin/i);
    const wrongKey = new File([new Uint8Array(16)], "htk.bin");
    await expect(workflow.setInput(await nfsArchive(source, wrongKey))).rejects.toThrow(/Invalid disc header/i);
    const file = await nfsArchive(source, key, true);
    let selectionCount = 0;
    setInputSelectionHandler(() => {
      selectionCount += 1;
      return [];
    });
    await expect(workflow.setInput(file)).rejects.toThrow(/selection.*cancelled/i);
    await expect(workflow.setInput(file)).rejects.toThrow(/selection.*cancelled/i);
    expect(selectionCount).toBe(2);
  } finally {
    setInputSelectionHandler();
    await workflow.dispose();
    await resetRomWeaverRunner();
  }
});
