import { expect, test } from "vitest";
import { ApplyWorkflow } from "../../src/platform/browser/browser-api.ts";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";

const createMultiTrackChdFixtureFile = async () => {
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const stem = `workflow-multi-track-${runId}`;
  const firstBinName = `${stem}-track1.bin`;
  const secondBinName = `${stem}-track2.bin`;
  const cueName = `${stem}.cue`;
  const sectorBytes = 2352;
  const sectorCount = 40;
  const firstBinBytes = new Uint8Array(sectorBytes * sectorCount);
  const secondBinBytes = new Uint8Array(sectorBytes * sectorCount);
  for (let index = 0; index < firstBinBytes.length; index += 1) {
    firstBinBytes[index] = (index * 19) & 0xff;
    secondBinBytes[index] = (index * 29) & 0xff;
  }
  const cueText =
    `FILE "${firstBinName}" BINARY\n` +
    "  TRACK 01 MODE1/2352\n" +
    "    INDEX 01 00:00:00\n" +
    `FILE "${secondBinName}" BINARY\n` +
    "  TRACK 02 MODE1/2352\n" +
    "    INDEX 01 00:00:00\n";
  const result = await browserRuntime.compression.create?.({
    format: "chd",
    options: {
      workerThreads: 2,
    },
    outputName: `${stem}.chd`,
    romSpecific: {
      chd: {
        imageFiles: [
          {
            fileName: firstBinName,
            source: new File([firstBinBytes], firstBinName, { type: "application/octet-stream" }),
          },
          {
            fileName: secondBinName,
            source: new File([secondBinBytes], secondBinName, { type: "application/octet-stream" }),
          },
        ],
        mode: "cd",
        sourceMode: "cd",
      },
    },
    source: new File([new TextEncoder().encode(cueText)], cueName, { type: "application/x-cue" }),
  });
  const output = result?.output;
  if (!output) throw new Error("CHD fixture compression did not return output");
  try {
    const blob = await browserRuntime.publicOutput.getBlob(output);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return {
      cleanup: async () => undefined,
      source: new File([bytes], `${stem}.chd`, { type: "application/octet-stream" }),
      stem,
    };
  } finally {
    await output.dispose?.().catch(() => undefined);
    await output.cleanup?.().catch(() => undefined);
  }
};

test("apply workflow auto-groups a multi-track CHD into one split-bin disc without prompting", async () => {
  const { cleanup, source, stem } = await createMultiTrackChdFixtureFile();
  const selectionRequests = [];
  const workflow = new ApplyWorkflow({
    // A multi-track disc is one logical ROM, so staging must resolve it without a prompt.
    selectFile: (request) => {
      selectionRequests.push(request);
      throw new Error("Multi-track CHD must auto-resolve without a selection prompt");
    },
    settings: {
      workers: {
        threads: 2,
      },
    },
  });
  try {
    await workflow.setInput(source);

    expect(selectionRequests).toHaveLength(0);

    const input = workflow.getInput();
    expect(input?.status).toBe("ready");
    expect(input?.fileName).toBe(`${stem}.bin`);
    // The disc auto-resolves to per-track split bins; the cue rides on the bin rows via `cueText`
    // and is not a resolved input of its own.
    expect(input?.resolvedInputs?.map((entry) => entry.fileName)).toEqual([`${stem}.bin`, `${stem} (Track 2).bin`]);
    expect(input?.resolvedInputs?.every((entry) => entry.kind === "track")).toBe(true);
    expect(input?.resolvedInputs?.every((entry) => entry.cueText?.includes("FILE "))).toBe(true);
  } finally {
    await workflow.dispose();
    await cleanup();
  }
});

test("apply workflow groups CHD disc tracks under one disc id as a single logical input", async () => {
  const { cleanup, source, stem } = await createMultiTrackChdFixtureFile();
  const workflow = new ApplyWorkflow({
    selectFile: () => {
      throw new Error("Multi-track CHD must auto-resolve without a selection prompt");
    },
    settings: {
      workers: {
        threads: 2,
      },
    },
  });
  try {
    await workflow.setInput(source);

    const input = workflow.getInput();
    expect(input?.status).toBe("ready");
    // No legacy "Merged BIN" / "Split BIN" output-mode prompt is offered any more.
    expect(input?.candidates?.some((candidate) => candidate.kind === "chd-output-mode")).toBe(false);

    const resolved = input?.resolvedInputs ?? [];
    expect(resolved.map((entry) => entry.fileName)).toEqual([`${stem}.bin`, `${stem} (Track 2).bin`]);
    // Both tracks are patchable and collapse under a single shared disc group id.
    expect(resolved.every((entry) => entry.patchable === true)).toBe(true);
    const groupIds = new Set(resolved.map((entry) => entry.groupId));
    expect(groupIds.size).toBe(1);
    expect([...groupIds][0]).toBeTruthy();
    // Exactly one track is the selected primary of the one-card disc.
    expect(resolved.filter((entry) => entry.selected)).toHaveLength(1);
  } finally {
    await workflow.dispose();
    await cleanup();
  }
});
