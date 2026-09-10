import { expect, test } from "vitest";
import { loadLocalBundleSession } from "../../src/lib/bundle/local-bundle-session.ts";
import { ApplyWorkflow } from "../../src/platform/browser/browser-api.ts";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { readStoredZipEntries } from "./patcher-test-shared.js";

const createIpsPatch = (fileName, offset, value) => {
  const bytes = new Uint8Array(14);
  bytes.set(new TextEncoder().encode("PATCH"));
  bytes.set([(offset >>> 16) & 0xff, (offset >>> 8) & 0xff, offset & 0xff, 0, 1, value], 5);
  bytes.set(new TextEncoder().encode("EOF"), 11);
  return new File([bytes], fileName, { type: "application/octet-stream" });
};

const createDisc = (runId) => {
  const trackOneName = `target-chain-${runId}-track01.bin`;
  const trackTwoName = `target-chain-${runId}-track02.bin`;
  const cueName = `target-chain-${runId}.cue`;
  const trackOne = new Uint8Array(2352 * 40);
  const trackTwo = new Uint8Array(2352 * 40);
  for (let index = 0; index < trackOne.length; index += 1) {
    trackOne[index] = (index * 19) & 0xff;
    trackTwo[index] = (index * 29) & 0xff;
  }
  const cue = new File(
    [
      `FILE "${trackOneName}" BINARY\n` +
        "  TRACK 01 MODE1/2352\n" +
        "    INDEX 01 00:00:00\n" +
        `FILE "${trackTwoName}" BINARY\n` +
        "  TRACK 02 MODE1/2352\n" +
        "    INDEX 01 00:00:00\n",
    ],
    cueName,
    { type: "application/x-cue" },
  );
  return {
    cue,
    trackOne: new File([trackOne], trackOneName, { type: "application/octet-stream" }),
    trackOneBytes: trackOne,
    trackTwo: new File([trackTwo], trackTwoName, { type: "application/octet-stream" }),
    trackTwoBytes: trackTwo,
  };
};

const applyImportedBundle = async ({ disc, entries, patchFiles, runId, withOptional }) => {
  const workflow = new ApplyWorkflow({
    settings: {
      output: { compression: "none", outputName: `target-chain-result-${runId}` },
      workers: { threads: 1 },
    },
  });
  try {
    await workflow.setInput([disc.cue, disc.trackOne, disc.trackTwo]);
    const selected = entries.filter((entry) => withOptional || !entry.optional);
    for (const [index, entry] of selected.entries()) {
      const patch = patchFiles.get(entry.fileName);
      if (!patch) throw new Error(`Imported patch is missing: ${entry.fileName}`);
      await workflow.addPatch(patch);
      await workflow.setPatchOption(index, {
        id: entry.id,
        ...(entry.input ? { input: entry.input } : {}),
        ...(entry.target ? { target: entry.target } : {}),
      });
    }
    const result = await workflow.run();
    try {
      const blob = await result.output.getBlob?.();
      if (!blob) throw new Error("Disc apply did not produce an output blob");
      return readStoredZipEntries(new Uint8Array(await blob.arrayBuffer())).filter((entry) =>
        entry.fileName.endsWith(".bin"),
      );
    } finally {
      await result.output.dispose();
    }
  } finally {
    await workflow.dispose();
  }
};

test("bundle targets preserve a selected track chain when an optional patch is enabled after import", async () => {
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const disc = createDisc(runId);
  const patches = [
    createIpsPatch("a.ips", 0, 0xa1),
    createIpsPatch("b.ips", 1, 0xb2),
    createIpsPatch("d.ips", 0, 0xd4),
    createIpsPatch("c.ips", 2, 0xc3),
  ];
  const patchFiles = new Map(patches.map((patch) => [patch.name, patch]));
  const targetOne = { member: disc.trackOne.name, rom: true };
  const targetTwo = { member: disc.trackTwo.name, rom: true };
  const created = await browserRuntime.bundle.create?.({
    bundleFileName: `target-chain-${runId}.zip`,
    noBundleRom: true,
    patches: [
      { fileName: "a.ips", id: "a", source: patches[0], target: targetOne },
      { fileName: "b.ips", id: "b", optional: true, source: patches[1], target: targetOne },
      { fileName: "d.ips", id: "d", source: patches[2], target: targetTwo },
      { fileName: "c.ips", id: "c", source: patches[3], target: targetOne },
    ],
    rom: { fileName: disc.cue.name, source: disc.cue },
  });
  if (!created) throw new Error("Bundle create is unavailable");
  try {
    expect(created.result.bundle.patches.map((patch) => patch.target)).toEqual([
      targetOne,
      targetOne,
      targetTwo,
      targetOne,
    ]);
    const bundleBytes = await (await browserRuntime.publicOutput.getBlob(created.bundleOutput)).arrayBuffer();
    const bundleFile = new File([bundleBytes], "rom-weaver-bundle.json", { type: "application/json" });
    const imported = await loadLocalBundleSession(bundleFile, [disc.cue, disc.trackOne, disc.trackTwo, ...patches]);
    try {
      expect(imported.session.entries.map((entry) => entry.target)).toEqual([
        targetOne,
        targetOne,
        targetTwo,
        targetOne,
      ]);
      const withoutOptional = await applyImportedBundle({
        disc,
        entries: imported.session.entries,
        patchFiles,
        runId: `${runId}-without-b`,
        withOptional: false,
      });
      const withOptional = await applyImportedBundle({
        disc,
        entries: imported.session.entries,
        patchFiles,
        runId: `${runId}-with-b`,
        withOptional: true,
      });
      const firstTrackWithoutOptional = withoutOptional.find((entry) => entry.bytes[0] === 0xa1);
      const firstTrackWithOptional = withOptional.find((entry) => entry.bytes[0] === 0xa1);
      const secondTrack = withOptional.find((entry) => entry.bytes[0] === 0xd4);
      const expectedWithoutOptional = disc.trackOneBytes.slice();
      expectedWithoutOptional[0] = 0xa1;
      expectedWithoutOptional[2] = 0xc3;
      const expectedWithOptional = expectedWithoutOptional.slice();
      expectedWithOptional[1] = 0xb2;
      const expectedTrackTwo = disc.trackTwoBytes.slice();
      expectedTrackTwo[0] = 0xd4;
      expect(firstTrackWithoutOptional?.bytes).toEqual(expectedWithoutOptional);
      expect(firstTrackWithOptional?.bytes).toEqual(expectedWithOptional);
      expect(secondTrack?.bytes).toEqual(expectedTrackTwo);
    } finally {
      await imported.cleanup();
    }
  } finally {
    await created.bundleOutput.dispose();
    await created.archiveOutput?.dispose();
  }
}, 180000);
