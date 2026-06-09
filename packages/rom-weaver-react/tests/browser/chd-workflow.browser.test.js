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
    chdSourceMode: "cd",
    format: "chd",
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
    options: {
      workerThreads: 2,
    },
    outputName: `${stem}.chd`,
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

test("apply workflow asks before split-bin staging for multi-track CHDs", async () => {
  const { cleanup, source, stem } = await createMultiTrackChdFixtureFile();
  const selectionRequests = [];
  const workflow = new ApplyWorkflow({
    selectFile: (request) => {
      selectionRequests.push(request);
      const splitCandidate = request.candidates.find(
        (candidate) =>
          candidate.type === "group" &&
          candidate.kind === "chd-output-mode" &&
          candidate.label.startsWith("Split BIN tracks:"),
      );
      if (!splitCandidate) throw new Error("Missing split-bin candidate");
      return { id: splitCandidate.id };
    },
    settings: {
      workers: {
        threads: 2,
      },
    },
  });
  try {
    await workflow.setInput(source);

    expect(selectionRequests).toHaveLength(1);
    const groups = selectionRequests[0].candidates.filter(
      (candidate) => candidate.type === "group" && candidate.kind === "chd-output-mode",
    );
    expect(groups.map((candidate) => candidate.label)).toEqual([
      `Merged BIN: ${stem}.bin`,
      `Split BIN tracks: ${stem}.track01.bin + ${stem}.track02.bin`,
    ]);
    expect(groups.every((candidate) => candidate.selectable)).toBe(true);

    const input = workflow.getInput();
    expect(input?.status).toBe("ready");
    expect(input?.fileName).toBe(`${stem}.bin`);
    expect(input?.resolvedInputs?.map((entry) => entry.fileName)).toEqual([
      `${stem}.bin`,
      `${stem}.track02.bin`,
      `${stem}.cue`,
    ]);
  } finally {
    await workflow.dispose();
    await cleanup();
  }
});

test("apply workflow keeps merged BIN when the CHD split prompt is declined", async () => {
  const { cleanup, source, stem } = await createMultiTrackChdFixtureFile();
  const selectionRequests = [];
  const workflow = new ApplyWorkflow({
    selectFile: (request) => {
      selectionRequests.push(request);
      const mergedCandidate = request.candidates.find(
        (candidate) =>
          candidate.type === "group" &&
          candidate.kind === "chd-output-mode" &&
          candidate.label.startsWith("Merged BIN:"),
      );
      if (!mergedCandidate) throw new Error("Missing merged-bin candidate");
      return { id: mergedCandidate.id };
    },
    settings: {
      workers: {
        threads: 2,
      },
    },
  });
  try {
    await workflow.setInput(source);

    expect(selectionRequests).toHaveLength(1);
    const groups = selectionRequests[0].candidates.filter(
      (candidate) => candidate.type === "group" && candidate.kind === "chd-output-mode",
    );
    expect(groups.map((candidate) => candidate.label)).toEqual([
      `Merged BIN: ${stem}.bin`,
      `Split BIN tracks: ${stem}.track01.bin + ${stem}.track02.bin`,
    ]);

    const input = workflow.getInput();
    expect(input?.status).toBe("ready");
    expect(input?.fileName).toBe(`${stem}.bin`);
    expect(input?.resolvedInputs?.map((entry) => entry.fileName)).toEqual([`${stem}.bin`, `${stem}.cue`]);
  } finally {
    await workflow.dispose();
    await cleanup();
  }
});
