import { beforeEach, expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { resetRomWeaverRunner, warmupRomWeaverRunner } from "../../src/workers/rom-weaver/rom-weaver-runner.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../src/workers/shared/worker-storage/storage-layout.ts";

const loadFixtureBytes = async (filePath) => {
  const response = await fetch(`/${filePath}`);
  if (!response.ok) throw new Error(`Failed to load fixture ${filePath}`);
  return new Uint8Array(await response.arrayBuffer());
};

const parentPath = (filePath) => filePath.replace(/\/[^/]+$/, "");

const clearOpfsRuntimeBuckets = async () => {
  if (!navigator.storage?.getDirectory) return;
  const root = await navigator.storage.getDirectory();
  if (typeof root.keys === "function") {
    for await (const name of root.keys()) {
      await root.removeEntry(name, { recursive: true }).catch(() => undefined);
    }
    return;
  }
  if (typeof root.entries === "function") {
    for await (const [name] of root.entries()) {
      await root.removeEntry(name, { recursive: true }).catch(() => undefined);
    }
    return;
  }
  await browserRuntime.vfs.remove(`${WORKER_OPFS_MOUNTPOINT}/input`).catch(() => undefined);
  await browserRuntime.vfs.remove(`${WORKER_OPFS_MOUNTPOINT}/output`).catch(() => undefined);
  await browserRuntime.vfs.remove(`${WORKER_OPFS_MOUNTPOINT}/temp`).catch(() => undefined);
};

beforeEach(async () => {
  await clearOpfsRuntimeBuckets();
});

test("compression create rejects legacy flat rom-specific options", async () => {
  const create = browserRuntime.compression.create;
  if (!create) throw new Error("Runtime compression create capability is unavailable");

  await expect(
    create({
      chdSourceMode: "cd",
      fileName: "legacy.bin",
      format: "chd",
      outputName: "legacy.chd",
      source: new File([new Uint8Array([0])], "legacy.bin", { type: "application/octet-stream" }),
    }),
  ).rejects.toThrow(/Legacy compression create option fields are unsupported/);
});

const createMultiTrackChdOutput = async (runId) => {
  const stem = `multi-track-${runId}`;
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
  let output = null;
  try {
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
    output = result?.output || null;
    if (!output) throw new Error("Failed to create multi-track CHD test input");
    const sourcePath = `${WORKER_OPFS_MOUNTPOINT}/chd-runtime-${runId}-${stem}.chd`;
    const blob = await browserRuntime.publicOutput.getBlob(output);
    await browserRuntime.vfs.truncate(sourcePath, 0);
    await browserRuntime.vfs.write(sourcePath, new Uint8Array(await blob.arrayBuffer()), { fileOffset: 0 });
    return {
      source: {
        fileName: `${stem}.chd`,
        filePath: sourcePath,
      },
      sourcePath,
      stem,
    };
  } finally {
    await output?.cleanup?.().catch(() => undefined);
  }
};

const expectCueWithoutChecksumsAndBinsWithChecksums = (outputs) => {
  const cueOutput = outputs.find((entry) => /\.cue$/i.test(entry.fileName || ""));
  const binOutputs = outputs.filter((entry) => /\.bin$/i.test(entry.fileName || ""));
  expect(cueOutput?.checksums).toBeUndefined();
  for (const binOutput of binOutputs) {
    expect(binOutput.checksums?.crc32).toMatch(/^[0-9a-f]{8}$/i);
    expect(binOutput.checksums?.md5).toMatch(/^[0-9a-f]{32}$/i);
    expect(binOutput.checksums?.sha1).toMatch(/^[0-9a-f]{40}$/i);
  }
};

test("rom-weaver runtime extracts a CHD staged through browser OPFS", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const source = `${WORKER_OPFS_MOUNTPOINT}/chd-runtime-${runId}.chd`;
  const bytes = await loadFixtureBytes("tests/fixtures/browser-generated/game-cd.chd");
  await browserRuntime.vfs.truncate(source, 0);
  await browserRuntime.vfs.write(source, bytes, { fileOffset: 0 });
  const progressEvents = [];
  let outputs = [];
  try {
    const result = await browserRuntime.compression.extract?.({
      entries: ["game.bin", "game.cue"],
      format: "chd",
      options: {
        onProgress: (progress) => progressEvents.push(progress),
      },
      outputName: "game.bin",
      source,
    });

    outputs = result?.outputs || [];
    const output = result?.output || null;
    const cueOutput = outputs.find((entry) => /\.cue$/i.test(entry.fileName || ""));
    const binOutputs = outputs.filter((entry) => /\.bin$/i.test(entry.fileName || ""));
    expect(output?.fileName).toMatch(/\.(bin|iso)$/i);
    expect(output?.size).toBeGreaterThan(0);
    expect(cueOutput?.fileName).toBe("game.cue");
    expect(cueOutput?.checksums).toBeUndefined();
    expect(cueOutput?.chdCuePath).toBeUndefined();
    expect(binOutputs.length).toBeGreaterThanOrEqual(1);
    expect(output).toBe(binOutputs[0]);
    for (const binOutput of binOutputs) {
      expect(binOutput.chdCuePath).toBe(cueOutput?.path);
      expect(binOutput.checksums?.crc32).toMatch(/^[0-9a-f]{8}$/i);
      expect(binOutput.checksums?.md5).toMatch(/^[0-9a-f]{32}$/i);
      expect(binOutput.checksums?.sha1).toMatch(/^[0-9a-f]{40}$/i);
    }
    expect(progressEvents.length).toBeGreaterThan(0);
    expect(outputs.every((entry) => /^\/work\/operations\/[^/]+\//.test(entry.path))).toBe(true);
    const outputScopes = new Set(outputs.map((entry) => parentPath(entry.path)));
    expect(outputScopes.size).toBe(1);
    if (!cueOutput) throw new Error("CHD extraction did not return its cue output");
    await cueOutput.dispose();
    expect(await browserRuntime.vfs.stat(cueOutput.path)).toBeNull();
    expect(await Promise.all(binOutputs.map((entry) => browserRuntime.vfs.stat(entry.path)))).not.toContain(null);
    await Promise.all(outputs.map((entry) => entry.dispose()));
    expect(await browserRuntime.vfs.stat([...outputScopes][0])).toBeNull();
    outputs = [];
  } finally {
    await Promise.all(outputs.map((output) => output?.cleanup?.().catch(() => undefined)));
    await browserRuntime.vfs.remove(source).catch(() => undefined);
  }
});

test("rom-weaver runtime honors split-bin extraction for multi-track CD CHDs", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const { source: chdSource, sourcePath, stem } = await createMultiTrackChdOutput(runId);
  let singleOutputs = [];
  let splitOutputs = [];
  try {
    expect(chdSource.fileName).toBe(`${stem}.chd`);

    const singleResult = await browserRuntime.compression.extract?.({
      entries: [`${stem}.cue`, `${stem}.bin`],
      format: "chd",
      options: {
        chdSplitBin: false,
        workerThreads: 2,
      },
      source: chdSource,
    });
    singleOutputs = singleResult?.outputs || [];
    expect(singleResult?.output?.fileName).toBe(`${stem}.bin`);
    expect(
      singleOutputs.filter((entry) => /\.cue$/i.test(entry.fileName || "")).map((entry) => entry.fileName),
    ).toEqual([`${stem}.cue`]);
    expect(
      singleOutputs.filter((entry) => /\.bin$/i.test(entry.fileName || "")).map((entry) => entry.fileName),
    ).toEqual([`${stem}.bin`]);
    expectCueWithoutChecksumsAndBinsWithChecksums(singleOutputs);

    const splitResult = await browserRuntime.compression.extract?.({
      entries: [`${stem}.cue`, `${stem}.bin`],
      format: "chd",
      options: {
        chdSplitBin: true,
        workerThreads: 2,
      },
      source: chdSource,
    });
    splitOutputs = splitResult?.outputs || [];
    expect(splitResult?.output?.fileName).toBe(`${stem}.bin`);
    expect(splitOutputs.filter((entry) => /\.cue$/i.test(entry.fileName || "")).map((entry) => entry.fileName)).toEqual(
      [`${stem}.cue`],
    );
    expect(splitOutputs.filter((entry) => /\.bin$/i.test(entry.fileName || "")).map((entry) => entry.fileName)).toEqual(
      [`${stem}.bin`, `${stem} (Track 2).bin`],
    );
    expectCueWithoutChecksumsAndBinsWithChecksums(splitOutputs);
  } finally {
    await Promise.all([...singleOutputs, ...splitOutputs].map((output) => output?.cleanup?.().catch(() => undefined)));
    await browserRuntime.vfs.remove(sourcePath).catch(() => undefined);
  }
});

test("rom-weaver runtime descends DVD CHDs without split-bin", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sourceFileName = "Ape Escape 2 (USA).iso";
  const sourcePath = `${WORKER_OPFS_MOUNTPOINT}/chd-dvd-${runId}-${sourceFileName}`;
  const sourceBytes = new Uint8Array(2048 * 64);
  for (let index = 0; index < sourceBytes.length; index += 1) {
    sourceBytes[index] = (index * 31) & 0xff;
  }
  await browserRuntime.vfs.truncate(sourcePath, 0);
  await browserRuntime.vfs.write(sourcePath, sourceBytes, { fileOffset: 0 });

  let chdOutput = null;
  let extractOutputs = [];
  try {
    const createResult = await browserRuntime.compression.create?.({
      format: "chd",
      options: {
        workerThreads: 2,
      },
      outputName: "Ape Escape 2 (USA).chd",
      romSpecific: {
        chd: {
          compressionCodecs: "zstd:1",
          mode: "dvd",
          sourceMode: "dvd",
        },
      },
      source: {
        fileName: sourceFileName,
        filePath: sourcePath,
      },
    });
    chdOutput = createResult?.output || null;
    expect(chdOutput?.fileName).toBe("Ape Escape 2 (USA).chd");

    const extractResult = await browserRuntime.compression.extract?.({
      descendSinglePayload: true,
      entries: [],
      format: "chd",
      options: {
        chdSplitBin: true,
        workerThreads: 2,
      },
      source: chdOutput,
    });
    extractOutputs = extractResult?.outputs || [];

    expect(extractResult?.output?.fileName).toBe("Ape Escape 2 (USA).iso");
    expect(extractResult?.output?.size).toBe(sourceBytes.length);
    expect(extractOutputs.map((output) => output.fileName)).toEqual(["Ape Escape 2 (USA).iso"]);
  } finally {
    await Promise.all(extractOutputs.map((output) => output?.cleanup?.().catch(() => undefined)));
    await chdOutput?.cleanup?.().catch(() => undefined);
    await browserRuntime.vfs.remove(sourcePath).catch(() => undefined);
  }
});

test("rom-weaver runtime descends CD CHDs with merged default and base primary split-bin output name", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const { source: chdSource, sourcePath, stem } = await createMultiTrackChdOutput(runId);
  let defaultOutputs = [];
  let splitOutputs = [];
  try {
    const defaultResult = await browserRuntime.compression.extract?.({
      descendSinglePayload: true,
      entries: [],
      format: "chd",
      options: {
        workerThreads: 2,
      },
      source: chdSource,
    });
    defaultOutputs = defaultResult?.outputs || [];

    expect(defaultResult?.output?.fileName).toBe(`${stem}.bin`);
    expect(
      defaultOutputs.filter((entry) => /\.cue$/i.test(entry.fileName || "")).map((entry) => entry.fileName),
    ).toEqual([`${stem}.cue`]);
    expect(
      defaultOutputs.filter((entry) => /\.bin$/i.test(entry.fileName || "")).map((entry) => entry.fileName),
    ).toEqual([`${stem}.bin`]);
    expectCueWithoutChecksumsAndBinsWithChecksums(defaultOutputs);

    const splitResult = await browserRuntime.compression.extract?.({
      descendSinglePayload: true,
      entries: [],
      format: "chd",
      options: {
        chdSplitBin: true,
        workerThreads: 2,
      },
      source: chdSource,
    });
    splitOutputs = splitResult?.outputs || [];

    expect(splitResult?.output?.fileName).toBe(`${stem}.bin`);
    expect(splitOutputs.filter((entry) => /\.cue$/i.test(entry.fileName || "")).map((entry) => entry.fileName)).toEqual(
      [`${stem}.cue`],
    );
    expect(splitOutputs.filter((entry) => /\.bin$/i.test(entry.fileName || "")).map((entry) => entry.fileName)).toEqual(
      [`${stem}.bin`, `${stem} (Track 2).bin`],
    );
    expectCueWithoutChecksumsAndBinsWithChecksums(splitOutputs);
  } finally {
    await Promise.all([...defaultOutputs, ...splitOutputs].map((output) => output?.cleanup?.().catch(() => undefined)));
    await browserRuntime.vfs.remove(sourcePath).catch(() => undefined);
  }
});

test("rom-weaver runtime keeps original CHD basename for extracted output", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sourcePath = `${WORKER_OPFS_MOUNTPOINT}/chd-input-${runId}-Crash_Bandicoot_USA_.chd`;
  const sourceFileName = "Crash Bandicoot (USA).chd";
  const bytes = await loadFixtureBytes("tests/fixtures/browser-generated/game-cd.chd");
  await browserRuntime.vfs.truncate(sourcePath, 0);
  await browserRuntime.vfs.write(sourcePath, bytes, { fileOffset: 0 });

  let outputs = [];
  try {
    const result = await browserRuntime.compression.extract?.({
      entries: ["Crash Bandicoot (USA).bin", "Crash Bandicoot (USA).cue"],
      format: "chd",
      source: {
        fileName: sourceFileName,
        filePath: sourcePath,
      },
    });

    outputs = result?.outputs || [];
    const output = result?.output || null;
    expect(output?.fileName).toMatch(/^Crash Bandicoot \(USA\)\.(bin|iso)$/i);
    expect(output?.fileName).not.toMatch(/^chd-input-/i);
    expect(output?.size).toBeGreaterThan(0);
  } finally {
    await Promise.all(outputs.map((output) => output.cleanup?.().catch(() => undefined)));
    await browserRuntime.vfs.remove(sourcePath).catch(() => undefined);
  }
});

test("rom-weaver runtime extracts a single-bin CD CHD from an OPFS path", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sourcePath = `${WORKER_OPFS_MOUNTPOINT}/chd-input-${runId}-Crash_Bandicoot_USA_.chd`;
  const sourceFileName = "Crash Bandicoot (USA).chd";
  const outputFileName = "Crash Bandicoot (USA).bin";
  const bytes = await loadFixtureBytes("tests/fixtures/browser-generated/game-cd.chd");
  await browserRuntime.vfs.truncate(sourcePath, 0);
  await browserRuntime.vfs.write(sourcePath, bytes, { fileOffset: 0 });

  let outputs = [];
  let recompressed = null;
  try {
    const result = await browserRuntime.compression.extract?.({
      entries: [outputFileName],
      format: "chd",
      source: {
        fileName: sourceFileName,
        filePath: sourcePath,
      },
    });

    outputs = result?.outputs || [];
    const output = result?.output || null;
    expect(output?.fileName).toBe(outputFileName);
    expect(output?.size).toBeGreaterThan(0);
    expect(output?.chdCuePath).toMatch(/\.cue$/i);
    expect(output?.chdCueText).toBeUndefined();

    const createResult = await browserRuntime.compression.create?.({
      format: "chd",
      options: {
        workerThreads: 2,
      },
      outputName: "recompressed-cue-path.chd",
      romSpecific: {
        chd: {
          cueFilePath: output.chdCuePath,
        },
      },
      source: output,
    });
    recompressed = createResult?.output || null;
    expect(recompressed?.fileName).toBe("recompressed-cue-path.chd");
    expect(recompressed?.size).toBeGreaterThan(0);
  } finally {
    await recompressed?.cleanup?.().catch(() => undefined);
    await Promise.all(outputs.map((output) => output.cleanup?.().catch(() => undefined)));
    await browserRuntime.vfs.remove(sourcePath).catch(() => undefined);
  }
});

test("rom-weaver runtime creates a CD CHD from a plain 2352-byte-sector input", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sourcePath = `${WORKER_OPFS_MOUNTPOINT}/chd-create-${runId}-disc.bin`;
  const sectorBytes = 2352;
  const sectorCount = 32;
  const sourceBytes = new Uint8Array(sectorBytes * sectorCount);
  for (let index = 0; index < sourceBytes.length; index += 1) {
    sourceBytes[index] = index & 0xff;
  }
  await browserRuntime.vfs.truncate(sourcePath, 0);
  await browserRuntime.vfs.write(sourcePath, sourceBytes, { fileOffset: 0 });

  let output = null;
  try {
    const result = await browserRuntime.compression.create?.({
      format: "chd",
      options: {
        workerThreads: 2,
      },
      outputName: "created-cd.chd",
      romSpecific: {
        chd: {
          compressionCodecs: "cdlz:9,cdzl:9,cdfl:8",
          mode: "cd",
          sourceMode: "cd",
        },
      },
      source: {
        fileName: "disc.bin",
        filePath: sourcePath,
      },
    });

    output = result?.output || null;
    expect(output?.fileName).toBe("created-cd.chd");
    expect(output?.size).toBeGreaterThan(0);
    const blob = await browserRuntime.publicOutput.getBlob(output);
    const header = new TextDecoder().decode(await blob.slice(0, 8).arrayBuffer());
    expect(header).toBe("MComprHD");
  } finally {
    await output?.cleanup?.().catch(() => undefined);
    await browserRuntime.vfs.remove(sourcePath).catch(() => undefined);
  }
});

test("rom-weaver runtime creates a CD CHD from a plain 2048-byte-sector input", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sourceFileName = "Quality of life";
  const sourcePath = `${WORKER_OPFS_MOUNTPOINT}/chd-create-${runId}-${sourceFileName}`;
  const sectorBytes = 2048;
  const sectorCount = 32;
  const sourceBytes = new Uint8Array(sectorBytes * sectorCount);
  for (let index = 0; index < sourceBytes.length; index += 1) {
    sourceBytes[index] = (index * 13) & 0xff;
  }
  await browserRuntime.vfs.truncate(sourcePath, 0);
  await browserRuntime.vfs.write(sourcePath, sourceBytes, { fileOffset: 0 });

  let output = null;
  try {
    const result = await browserRuntime.compression.create?.({
      format: "chd",
      options: {
        workerThreads: 2,
      },
      outputName: "created-cd-2048.chd",
      romSpecific: {
        chd: {
          compressionCodecs: "cdlz:9,cdzl:9,cdfl:8",
          mode: "cd",
          sourceMode: "cd",
        },
      },
      source: {
        fileName: sourceFileName,
        filePath: sourcePath,
      },
    });

    output = result?.output || null;
    expect(output?.fileName).toBe("created-cd-2048.chd");
    expect(output?.size).toBeGreaterThan(0);
    const listed = await browserRuntime.compression.probe?.({
      format: "chd",
      source: output,
    });
    const entryNames = (listed?.entries || []).map((entry) => entry.filename);
    expect(entryNames).toContain("created-cd-2048.cue");
    expect(entryNames).toContain("created-cd-2048.bin");
  } finally {
    await output?.cleanup?.().catch(() => undefined);
    await browserRuntime.vfs.remove(sourcePath).catch(() => undefined);
  }
});

test("rom-weaver runtime creates a CD CHD when input lives directly under /work", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sourceFileName = "Crash Bandicoot (USA) - Quality of Life.bin";
  const sourcePath = `${WORKER_OPFS_MOUNTPOINT}/chd-create-${runId}-${sourceFileName}`;
  const sectorBytes = 2352;
  const sectorCount = 32;
  const sourceBytes = new Uint8Array(sectorBytes * sectorCount);
  for (let index = 0; index < sourceBytes.length; index += 1) {
    sourceBytes[index] = (index * 17) & 0xff;
  }
  await browserRuntime.vfs.truncate(sourcePath, 0);
  await browserRuntime.vfs.write(sourcePath, sourceBytes, { fileOffset: 0 });

  let output = null;
  try {
    const result = await browserRuntime.compression.create?.({
      format: "chd",
      options: {
        workerThreads: 2,
      },
      outputName: "Crash Bandicoot (USA) - Quality of Life.chd",
      romSpecific: {
        chd: {
          mode: "cd",
          sourceMode: "cd",
        },
      },
      source: {
        fileName: sourceFileName,
        filePath: sourcePath,
      },
    });

    output = result?.output || null;
    expect(output?.fileName).toBe("Crash Bandicoot (USA) - Quality of Life.chd");
    expect(output?.size).toBeGreaterThan(0);
    const blob = await browserRuntime.publicOutput.getBlob(output);
    const header = new TextDecoder().decode(await blob.slice(0, 8).arrayBuffer());
    expect(header).toBe("MComprHD");
  } finally {
    await output?.cleanup?.().catch(() => undefined);
    await browserRuntime.vfs.remove(sourcePath).catch(() => undefined);
  }
});

test("rom-weaver runtime creates a CD CHD from a cue source that references a sibling bin", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const binName = `chd-cue-${runId}-Crash Bandicoot (USA) - Quality of Life.bin`;
  const cueName = `chd-cue-${runId}-Crash Bandicoot (USA) - Quality of Life.cue`;

  const sectorBytes = 2352;
  const sectorCount = 32;
  const binBytes = new Uint8Array(sectorBytes * sectorCount);
  for (let index = 0; index < binBytes.length; index += 1) {
    binBytes[index] = (index * 17) & 0xff;
  }

  // Cue references the sibling bin by basename, exactly like a patched disc output on disk.
  const cueText = `FILE "${binName}" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n`;
  const cueBytes = new TextEncoder().encode(cueText);

  let output = null;
  try {
    const result = await browserRuntime.compression.create?.({
      format: "chd",
      options: {
        workerThreads: 2,
      },
      outputName: "Crash Bandicoot (USA) - Quality of Life.chd",
      romSpecific: {
        chd: {
          imageFiles: [
            {
              fileName: binName,
              source: new File([binBytes], binName, { type: "application/octet-stream" }),
            },
          ],
          mode: "cd",
          sourceMode: "cd",
        },
      },
      source: new File([cueBytes], cueName, { type: "application/x-cue" }),
    });

    output = result?.output || null;
    expect(output?.fileName).toBe("Crash Bandicoot (USA) - Quality of Life.chd");
    expect(output?.size).toBeGreaterThan(0);
    const blob = await browserRuntime.publicOutput.getBlob(output);
    const header = new TextDecoder().decode(await blob.slice(0, 8).arrayBuffer());
    expect(header).toBe("MComprHD");
  } finally {
    await output?.cleanup?.().catch(() => undefined);
  }
});
