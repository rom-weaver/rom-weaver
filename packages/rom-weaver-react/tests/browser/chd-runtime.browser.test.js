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
  const source = `${WORKER_OPFS_MOUNTPOINT}/input/chd-runtime-${runId}.chd`;
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
  const sourcePath = `${WORKER_OPFS_MOUNTPOINT}/input/chd-input-${runId}-Crash_Bandicoot_USA_.chd`;
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
