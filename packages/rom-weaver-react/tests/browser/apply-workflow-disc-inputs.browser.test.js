import { expect, test } from "vitest";
import { ApplyWorkflow } from "../../src/platform/browser/browser-api.ts";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";

const RAW_ROM = "tests/fixtures/archive_sources/game.bin";
const RAW_PATCH = "tests/fixtures/archive_sources/change.ips";
const ONE_PATCH_7Z = "tests/fixtures/archives/one-patch.7z";
const MULTI_PATCH_ZIP = "tests/fixtures/archives/multi-patch.zip";

const loadFixtureFile = async (filePath, type = "application/octet-stream") => {
  const response = await fetch(`/${filePath}`);
  if (!response.ok) throw new Error(`Failed to load fixture ${filePath}`);
  const bytes = await response.arrayBuffer();
  return new File([bytes], filePath.split("/").pop() || "input.bin", { type });
};

const createZcciFixtureFile = async () => {
  const sourceBytes = new Uint8Array(64 * 1024);
  sourceBytes.set([0x4e, 0x43, 0x53, 0x44], 0);
  for (let index = 4; index < sourceBytes.length; index += 1) sourceBytes[index] = index % 251;
  const source = new File([sourceBytes], "source.cci", { type: "application/octet-stream" });
  const result = await browserRuntime.compression.create?.({
    fileName: source.name,
    format: "z3ds",
    options: {
      workerThreads: 1,
    },
    outputName: "game.zcci",
    source: {
      fileName: source.name,
      source,
    },
  });
  const output = result?.output;
  if (!output) throw new Error("ZCCI fixture compression did not return output");
  try {
    const blob = await browserRuntime.publicOutput.getBlob(output);
    return new File([blob], "game.zcci", { type: "application/octet-stream" });
  } finally {
    await output.dispose().catch(() => undefined);
  }
};

const readUint16Le = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8);
const readUint32Le = (bytes, offset) =>
  (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;

const readZipCentralDirectoryEntries = (bytes) => {
  const entries = [];
  const decoder = new TextDecoder();
  for (let offset = 0; offset <= bytes.length - 46; offset += 1) {
    if (readUint32Le(bytes, offset) !== 0x02014b50) continue;
    const fileNameLength = readUint16Le(bytes, offset + 28);
    const extraLength = readUint16Le(bytes, offset + 30);
    const commentLength = readUint16Le(bytes, offset + 32);
    const fileNameStart = offset + 46;
    const fileNameEnd = fileNameStart + fileNameLength;
    entries.push({
      compressedSize: readUint32Le(bytes, offset + 20),
      fileName: decoder.decode(bytes.subarray(fileNameStart, fileNameEnd)),
      localHeaderOffset: readUint32Le(bytes, offset + 42),
      method: readUint16Le(bytes, offset + 10),
      uncompressedSize: readUint32Le(bytes, offset + 24),
    });
    offset = fileNameEnd + extraLength + commentLength - 1;
  }
  return entries;
};

const readZipStoredEntryData = (bytes, entry) => {
  const offset = entry.localHeaderOffset;
  expect(readUint32Le(bytes, offset)).toBe(0x04034b50);
  const fileNameLength = readUint16Le(bytes, offset + 26);
  const extraLength = readUint16Le(bytes, offset + 28);
  const dataStart = offset + 30 + fileNameLength + extraLength;
  return bytes.subarray(dataStart, dataStart + entry.compressedSize);
};

const createTraceWorkflow = () => {
  const logs = [];
  const workflow = new ApplyWorkflow({
    settings: {
      logging: {
        level: "trace",
        sink: (record) => {
          logs.push(record || {});
        },
      },
    },
  });
  return { logs, workflow };
};

test("apply workflow resolves RVZ inputs to extracted names during staging", async () => {
  const workflow = new ApplyWorkflow();
  const progressEvents = [];
  workflow.on("progress", (event) => progressEvents.push(event));
  try {
    await workflow.setInput(await loadFixtureFile("tests/fixtures/browser-generated/game.rvz"));
    const input = workflow.getInput();
    expect(input?.fileName).toBe("game.iso");
    expect(input?.wasDecompressed).toBe(true);
    expect(input?.parentCompressions?.map((entry) => entry.fileName) || []).toContain("game.rvz");
    expect(
      progressEvents.some(
        (event) => event.role === "input" && event.stage === "decompress" && /^extracted\b/i.test(event.label || ""),
      ),
    ).toBe(false);
    const lastExtractIndex = progressEvents.findLastIndex(
      (event) => event.role === "input" && event.stage === "decompress",
    );
    const checksumIndex = progressEvents.findIndex((event) => event.role === "input" && event.stage === "checksum");
    expect(lastExtractIndex).toBeGreaterThanOrEqual(0);
    expect(checksumIndex).toBe(-1);
  } finally {
    await workflow.dispose();
  }
});

test("apply workflow resolves ZCCI inputs to extracted CCI names during staging", async () => {
  const progressEvents = [];
  const workflow = new ApplyWorkflow({
    settings: {
      workers: {
        threads: 1,
      },
    },
  });
  workflow.on("progress", (event) => progressEvents.push(event));
  try {
    await workflow.setInput(await createZcciFixtureFile());
    const input = workflow.getInput();
    expect(input?.fileName).toBe("game.cci");
    expect(input?.wasDecompressed).toBe(true);
    expect(input?.parentCompressions?.map((entry) => entry.fileName) || []).toContain("game.zcci");
    expect(input?.parentCompressions?.map((entry) => entry.fileName) || []).not.toContain("game.z3ds");
    expect(progressEvents.map((event) => `${event.label || ""} ${event.message || ""}`).join("\n")).not.toMatch(
      /game\.z3ds/i,
    );
  } finally {
    await workflow.dispose();
  }
});

test("apply workflow resolves CHD inputs to extracted names during staging", async () => {
  const workflow = new ApplyWorkflow();
  const progressEvents = [];
  workflow.on("progress", (event) => progressEvents.push(event));
  try {
    await workflow.setInput(await loadFixtureFile("tests/fixtures/browser-generated/game-cd.chd"));
    const input = workflow.getInput();
    expect(input?.fileName).not.toMatch(/\.chd$/i);
    expect(input?.wasDecompressed).toBe(true);
    const checksumIndex = progressEvents.findIndex((event) => event.role === "input" && event.stage === "checksum");
    expect(checksumIndex).toBe(-1);
  } finally {
    await workflow.dispose();
  }
});

test("patch archive staging extract dispatch omits checksum args in browser", async () => {
  const { workflow, logs } = createTraceWorkflow();
  try {
    await workflow.setInput(await loadFixtureFile(RAW_ROM));
    await workflow.addPatch(await loadFixtureFile(ONE_PATCH_7Z, "application/x-7z-compressed"));
    await expect
      .poll(
        () =>
          workflow
            .getPatches()
            .map((patch) => patch.fileName)
            .join(","),
        { timeout: 30000 },
      )
      .toMatch(/change\.ips/i);
    await expect
      .poll(
        () =>
          logs
            .filter((entry) => entry?.namespace === "runtime:rom-weaver")
            .map((entry) => String(entry?.message || "").trim())
            .some((line) => line.includes('command="extract"')),
        { timeout: 30000 },
      )
      .toBe(true);
  } finally {
    await workflow.dispose();
  }
});

test("patch archive candidate discovery does not extract every candidate", async () => {
  const { workflow, logs } = createTraceWorkflow();
  try {
    await workflow.setInput(await loadFixtureFile(RAW_ROM));
    await workflow.addPatch(await loadFixtureFile(MULTI_PATCH_ZIP, "application/zip"));
    const patch = workflow.getPatches()[0];
    expect(patch?.status).toBe("needsSelection");
    const fileCandidates = (patch?.candidates || []).filter((candidate) => candidate.type === "file");
    expect(fileCandidates.length).toBeGreaterThan(0);
    expect(fileCandidates.every((candidate) => typeof candidate.size === "number" && candidate.size > 0)).toBe(true);
    const extractDispatches = logs.filter((entry) => String(entry?.message || "") === "runJson extract dispatch");
    expect(extractDispatches).toHaveLength(0);
  } finally {
    await workflow.dispose();
  }
});

test("RVZ staging emits list then extract trace events", async () => {
  const { workflow, logs } = createTraceWorkflow();
  try {
    await workflow.setInput(await loadFixtureFile("tests/fixtures/browser-generated/game.rvz"));
    const messages = logs.map((entry) => String(entry?.message || ""));
    const listIndex = messages.findIndex((message) => message === "input.archive.list.finish");
    const extractIndex = messages.findIndex((message) => message === "input.archive.extract.start");
    const workerTraceLines = logs
      .filter((entry) => entry?.namespace === "runtime:rom-weaver")
      .map((entry) => String(entry?.message || "").trim())
      .filter((line) => !!line);
    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(extractIndex).toBeGreaterThanOrEqual(0);
    expect(extractIndex).toBeGreaterThan(listIndex);
    expect(workerTraceLines.length).toBeGreaterThan(0);
    expect(workerTraceLines.some((line) => line.includes('command="extract"'))).toBe(true);
    expect(workerTraceLines.some((line) => line.includes("scratch=1"))).toBe(true);
  } finally {
    await workflow.dispose();
  }
});

test("CHD staging emits list then extract trace events", async () => {
  const { workflow, logs } = createTraceWorkflow();
  try {
    await workflow.setInput(await loadFixtureFile("tests/fixtures/browser-generated/game-cd.chd"));
    const messages = logs.map((entry) => String(entry?.message || ""));
    const workerTraceLines = logs
      .filter((entry) => entry?.namespace === "runtime:rom-weaver")
      .map((entry) => String(entry?.message || "").trim())
      .filter((line) => !!line);
    const listIndex = messages.findIndex((message) => message === "input.archive.list.finish");
    const extractIndex = messages.findIndex((message) => message === "input.archive.extract.start");
    const checksumDispatch = logs.find((entry) => String(entry?.message || "") === "runJson checksum dispatch");
    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(extractIndex).toBeGreaterThanOrEqual(0);
    expect(extractIndex).toBeGreaterThan(listIndex);
    expect(workerTraceLines.length).toBeGreaterThan(0);
    expect(workerTraceLines.some((line) => line.includes('command="extract"'))).toBe(true);
    expect(checksumDispatch).toBeUndefined();
  } finally {
    await workflow.dispose();
  }
});

test("apply workflow stores direct CUE plus BIN raw output in one ZIP", async () => {
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const inputStem = `direct-disc-${runId}`;
  const outputStem = `patched-disc-${runId}`;
  const workflow = new ApplyWorkflow({
    settings: {
      output: {
        compression: "none",
        outputName: outputStem,
      },
      workers: {
        threads: 1,
      },
    },
  });
  try {
    const rawInput = await loadFixtureFile(RAW_ROM);
    const binFile = new File([await rawInput.arrayBuffer()], `${inputStem}.bin`, {
      type: "application/octet-stream",
    });
    const cueFile = new File(
      [`FILE "${inputStem}.bin" BINARY\n  TRACK 01 MODE1/2048\n    INDEX 01 00:00:00\n`],
      `${inputStem}.cue`,
      { type: "application/x-cue" },
    );

    await workflow.setInput([cueFile, binFile]);
    await workflow.addPatch(await loadFixtureFile(RAW_PATCH));

    const result = await workflow.run();
    try {
      expect(result.outputs).toHaveLength(1);
      expect(result.output.fileName).toBe(`${outputStem}.zip`);
      expect(result.sizeSummary?.rawSize).toBeGreaterThan(rawInput.size);

      const blob = await result.output.getBlob?.();
      expect(blob).toBeInstanceOf(Blob);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);

      const entries = readZipCentralDirectoryEntries(bytes);
      expect(entries.map((entry) => entry.fileName).sort()).toEqual([`${outputStem}.bin`, `${outputStem}.cue`]);
      expect(entries.map((entry) => entry.method)).toEqual([0, 0]);
      expect(entries.every((entry) => entry.compressedSize === entry.uncompressedSize)).toBe(true);

      const cueEntry = entries.find((entry) => entry.fileName === `${outputStem}.cue`);
      expect(cueEntry).toBeTruthy();
      const cueText = new TextDecoder().decode(readZipStoredEntryData(bytes, cueEntry));
      expect(cueText).toContain(`FILE "${outputStem}.bin" BINARY`);
    } finally {
      await result.output.dispose();
    }
  } finally {
    await workflow.dispose();
  }
});
