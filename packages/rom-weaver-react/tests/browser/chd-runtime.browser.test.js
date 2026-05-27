import { expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { resetRomWeaverRunner, warmupRomWeaverRunner } from "../../src/workers/rom-weaver/rom-weaver-runner.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../src/workers/shared/worker-storage/storage-layout.ts";

const loadFixtureBytes = async (filePath) => {
  const response = await fetch(`/${filePath}`);
  if (!response.ok) throw new Error(`Failed to load fixture ${filePath}`);
  return new Uint8Array(await response.arrayBuffer());
};

test("rom-weaver runtime extracts a CHD staged through browser OPFS", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const source = `${WORKER_OPFS_MOUNTPOINT}/input/chd-runtime-${runId}.chd`;
  const bytes = await loadFixtureBytes("tests/fixtures/browser-generated/game-cd.chd");
  await browserRuntime.vfs.truncate(source, 0);
  await browserRuntime.vfs.write(source, bytes, { fileOffset: 0 });
  const progressEvents = [];
  try {
    const result = await browserRuntime.compression.extract?.({
      entries: [],
      format: "chd",
      options: {
        onProgress: (progress) => progressEvents.push(progress),
      },
      outputName: "game.bin",
      source,
    });

    expect(result?.output.fileName).toMatch(/\.(bin|iso)$/i);
    expect(result?.output.size).toBeGreaterThan(0);
    expect(progressEvents.length).toBeGreaterThan(0);
  } finally {
    await browserRuntime.vfs.remove(source).catch(() => undefined);
  }
});
