import { expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import {
  resetRomWeaverRunner,
  runRomWeaverJson,
  warmupRomWeaverRunner,
} from "../../src/workers/rom-weaver/rom-weaver-runner.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../src/workers/shared/worker-storage/storage-layout.ts";

const loadFixtureBytes = async (filePath) => {
  const response = await fetch(`/${filePath}`);
  if (!response.ok) throw new Error(`Failed to load fixture ${filePath}`);
  return new Uint8Array(await response.arrayBuffer());
};

test("rom-weaver runtime extracts an RVZ staged through browser OPFS", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const checksumProgress = [];
  const checksumSource = `${WORKER_OPFS_MOUNTPOINT}/checksum-source-${runId}.bin`;
  const checksumSourceBytes = new Uint8Array(2 * 1024 * 1024).map((_, index) => index & 0xff);
  await browserRuntime.vfs.truncate(checksumSource, 0);
  await browserRuntime.vfs.write(checksumSource, checksumSourceBytes, { fileOffset: 0 });
  const checksums = await browserRuntime.checksum.calculate?.({
    algorithms: ["crc32"],
    onProgress: (progress) => checksumProgress.push(progress),
    source: checksumSource,
  });
  expect(checksums?.crc32).toBeTypeOf("number");
  expect(checksumProgress.some((entry) => entry.percent > 0 && entry.percent < 100)).toBe(true);

  const source = `${WORKER_OPFS_MOUNTPOINT}/game-${runId}.rvz`;
  const sourceBytes = await loadFixtureBytes("tests/fixtures/browser-generated/game.rvz");
  await browserRuntime.vfs.truncate(source, 0);
  await browserRuntime.vfs.write(source, sourceBytes, { fileOffset: 0 });
  const staged = await browserRuntime.workerIo.stageSource({
    fallbackFileName: "game.rvz",
    pathPrefix: "rvz-debug",
    scope: "rvz",
    source,
  });
  try {
    const checksumResult = await runRomWeaverJson({
      args: { algo: ["crc32"], no_extract: true, source: staged.filePath },
      type: "checksum",
    });
    expect(
      checksumResult.ok,
      checksumResult.stderr ||
        checksumResult.nonJsonLines.join("\n") ||
        [checksumResult.error?.message, checksumResult.error?.stack].filter(Boolean).join("\n"),
    ).toBe(true);
    const extractResult = await browserRuntime.compression.extract?.({
      entries: ["game.iso"],
      format: "rvz",
      options: {
        workerThreads: 8,
      },
      outputName: "game.iso",
      source,
    });
    expect(extractResult?.output.fileName).toBe("game.iso");
    expect(extractResult?.output.size).toBeGreaterThan(0);
  } finally {
    await staged.cleanup().catch(() => undefined);
    await browserRuntime.vfs.remove(checksumSource).catch(() => undefined);
    await browserRuntime.vfs.remove(source).catch(() => undefined);
  }
});

test("rom-weaver runtime creates an RVZ from a prior browser OPFS output", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const source = `${WORKER_OPFS_MOUNTPOINT}/create-from-output-${runId}.rvz`;
  const sourceBytes = await loadFixtureBytes("tests/fixtures/browser-generated/game.rvz");
  await browserRuntime.vfs.truncate(source, 0);
  await browserRuntime.vfs.write(source, sourceBytes, { fileOffset: 0 });
  let extractedOutput = null;
  let createdOutput = null;
  try {
    const extractResult = await browserRuntime.compression.extract?.({
      entries: ["game.iso"],
      format: "rvz",
      options: {
        workerThreads: 1,
      },
      outputName: "game.iso",
      source,
    });
    extractedOutput = extractResult?.output || null;
    expect(extractedOutput?.size).toBeGreaterThan(0);

    const createResult = await browserRuntime.compression.create?.({
      fileName: "game.iso",
      format: "rvz",
      options: {
        workerThreads: 8,
      },
      outputName: "created-from-output.rvz",
      rvzCompression: "zstd",
      rvzCompressionLevel: 19,
      source: extractedOutput,
    });
    createdOutput = createResult?.output || null;
    expect(createdOutput?.fileName).toBe("created-from-output.rvz");
    expect(createdOutput?.size).toBeGreaterThan(0);
    await browserRuntime.vfs.truncate(createdOutput.path, createdOutput.size);
  } finally {
    await createdOutput?.cleanup?.().catch(() => undefined);
    await extractedOutput?.cleanup?.().catch(() => undefined);
    await browserRuntime.vfs.remove(source).catch(() => undefined);
  }
});
