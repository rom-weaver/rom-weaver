import { beforeEach, expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { resetRomWeaverRunner, warmupRomWeaverRunner } from "../../src/workers/rom-weaver/rom-weaver-runner.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../src/workers/shared/worker-storage/storage-layout.ts";

const loadFixtureBytes = async (filePath) => {
  const response = await fetch(`/${filePath}`);
  if (!response.ok) throw new Error(`Failed to load fixture ${filePath}`);
  return new Uint8Array(await response.arrayBuffer());
};

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

test("rom-weaver runtime extracts a CHD staged through browser OPFS", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const source = `${WORKER_OPFS_MOUNTPOINT}/chd-runtime-${runId}.chd`;
  const bytes = await loadFixtureBytes("tests/fixtures/browser-generated/game-cd.chd");
  await browserRuntime.vfs.truncate(source, 0);
  await browserRuntime.vfs.write(source, bytes, { fileOffset: 0 });
  const progressEvents = [];
  let output = null;
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

    output = result?.output || null;
    expect(output?.fileName).toMatch(/\.(bin|iso)$/i);
    expect(output?.size).toBeGreaterThan(0);
    expect(progressEvents.length).toBeGreaterThan(0);
  } finally {
    await output?.cleanup?.().catch(() => undefined);
    await browserRuntime.vfs.remove(source).catch(() => undefined);
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

  let output = null;
  try {
    const result = await browserRuntime.compression.extract?.({
      entries: ["Crash Bandicoot (USA).bin", "Crash Bandicoot (USA).cue"],
      format: "chd",
      source: {
        fileName: sourceFileName,
        filePath: sourcePath,
      },
    });

    output = result?.output || null;
    expect(output?.fileName).toMatch(/^Crash Bandicoot \(USA\)\.(bin|iso)$/i);
    expect(output?.fileName).not.toMatch(/^chd-input-/i);
    expect(output?.size).toBeGreaterThan(0);
  } finally {
    await output?.cleanup?.().catch(() => undefined);
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

  let output = null;
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

    output = result?.output || null;
    expect(output?.fileName).toBe(outputFileName);
    expect(output?.size).toBeGreaterThan(0);
    expect(output?.chdCuePath).toMatch(/\.cue$/i);
    expect(output?.chdCueText).toBeUndefined();

    const createResult = await browserRuntime.compression.create?.({
      cueFilePath: output.chdCuePath,
      format: "chd",
      options: {
        workerThreads: 2,
      },
      outputName: "recompressed-cue-path.chd",
      source: output,
    });
    recompressed = createResult?.output || null;
    expect(recompressed?.fileName).toBe("recompressed-cue-path.chd");
    expect(recompressed?.size).toBeGreaterThan(0);
  } finally {
    await recompressed?.cleanup?.().catch(() => undefined);
    await output?.cleanup?.().catch(() => undefined);
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
      chdSourceMode: "cd",
      compressionCodecs: "cdlz:9,cdzl:9,cdfl:8",
      format: "chd",
      mode: "cd",
      options: {
        workerThreads: 2,
      },
      outputName: "created-cd.chd",
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
      chdSourceMode: "cd",
      compressionCodecs: "cdlz:9,cdzl:9,cdfl:8",
      format: "chd",
      mode: "cd",
      options: {
        workerThreads: 2,
      },
      outputName: "created-cd-2048.chd",
      source: {
        fileName: sourceFileName,
        filePath: sourcePath,
      },
    });

    output = result?.output || null;
    expect(output?.fileName).toBe("created-cd-2048.chd");
    expect(output?.size).toBeGreaterThan(0);
    const listed = await browserRuntime.compression.list?.({
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
      chdSourceMode: "cd",
      format: "chd",
      mode: "cd",
      options: {
        workerThreads: 2,
      },
      outputName: "Crash Bandicoot (USA) - Quality of Life.chd",
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
  const binPath = `${WORKER_OPFS_MOUNTPOINT}/${binName}`;
  const cuePath = `${WORKER_OPFS_MOUNTPOINT}/${cueName}`;

  const sectorBytes = 2352;
  const sectorCount = 32;
  const binBytes = new Uint8Array(sectorBytes * sectorCount);
  for (let index = 0; index < binBytes.length; index += 1) {
    binBytes[index] = (index * 17) & 0xff;
  }
  await browserRuntime.vfs.truncate(binPath, 0);
  await browserRuntime.vfs.write(binPath, binBytes, { fileOffset: 0 });

  // Cue references the sibling bin by basename, exactly like a patched disc output on disk.
  const cueText = `FILE "${binName}" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n`;
  const cueBytes = new TextEncoder().encode(cueText);
  await browserRuntime.vfs.truncate(cuePath, 0);
  await browserRuntime.vfs.write(cuePath, cueBytes, { fileOffset: 0 });

  let output = null;
  try {
    const result = await browserRuntime.compression.create?.({
      chdSourceMode: "cd",
      format: "chd",
      mode: "cd",
      options: {
        workerThreads: 2,
      },
      outputName: "Crash Bandicoot (USA) - Quality of Life.chd",
      source: {
        fileName: cueName,
        filePath: cuePath,
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
    await browserRuntime.vfs.remove(binPath).catch(() => undefined);
    await browserRuntime.vfs.remove(cuePath).catch(() => undefined);
  }
});
