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

test("rom-weaver runtime ingest returns structured checksum variants", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const source = `${WORKER_OPFS_MOUNTPOINT}/headered-${runId}.nes`;
  const bytes = new Uint8Array(16 + 1024);
  bytes.set([0x4e, 0x45, 0x53, 0x1a], 0);
  for (let index = 16; index < bytes.length; index += 1) bytes[index] = index & 0xff;
  await browserRuntime.vfs.truncate(source, 0);
  await browserRuntime.vfs.write(source, bytes, { fileOffset: 0 });
  try {
    const { result } = await browserRuntime.ingest.run({
      checksumAlgorithms: ["crc32", "md5", "sha1"],
      source,
    });
    const variants = result.assets[0]?.checksumVariants ?? [];
    const removeHeader = variants.find((variant) => variant.id === "remove-header");
    expect(variants.some((variant) => variant.id === "raw")).toBe(true);
    expect(removeHeader?.applyCompatibility?.removeHeader).toBe(true);
    expect(removeHeader?.applyCompatibility?.strip_header).toBe(true);
    expect(removeHeader?.checksums.crc32).toMatch(/^[0-9a-f]{8}$/i);
    expect(removeHeader?.checksums.md5).toMatch(/^[0-9a-f]{32}$/i);
    expect(removeHeader?.checksums.sha1).toMatch(/^[0-9a-f]{40}$/i);
  } finally {
    await browserRuntime.vfs.remove(source).catch(() => undefined);
  }
});

test("rom-weaver runtime extracts an RVZ staged through browser OPFS", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const checksumProgress = [];
  const checksumSource = `${WORKER_OPFS_MOUNTPOINT}/checksum-source-${runId}.bin`;
  const checksumSourceBytes = new Uint8Array(2 * 1024 * 1024).map((_, index) => index & 0xff);
  await browserRuntime.vfs.truncate(checksumSource, 0);
  await browserRuntime.vfs.write(checksumSource, checksumSourceBytes, { fileOffset: 0 });
  const { result: checksumResult } = await browserRuntime.ingest.run({
    checksumAlgorithms: ["crc32"],
    onProgress: (progress) => checksumProgress.push(progress),
    source: checksumSource,
  });
  expect(checksumResult.assets[0]?.checksums.crc32).toMatch(/^[0-9a-f]{8}$/i);
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
  let extractOutput = null;
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
    extractOutput = extractResult?.output || null;
    expect(extractOutput?.fileName).toBe("game.iso");
    expect(extractOutput?.size).toBeGreaterThan(0);
    expect(extractOutput?.path).toMatch(/^\/work\/operations\/[^/]+\/[^/]+\.iso$/);
    const outputScopePath = extractOutput?.path.replace(/\/[^/]+$/, "") || "";
    await extractOutput?.dispose();
    expect(await browserRuntime.vfs.stat(outputScopePath)).toBeNull();
    extractOutput = null;
  } finally {
    await extractOutput?.dispose().catch(() => undefined);
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

    const createProgress = [];
    const createResult = await browserRuntime.compression.create?.({
      fileName: "game.iso",
      format: "rvz",
      options: {
        onProgress: (event) => createProgress.push(event),
        workerThreads: 10,
      },
      outputName: "created-from-output.rvz",
      romSpecific: {
        rvz: {
          codec: "zstd",
          compressionLevel: 19,
        },
      },
      source: extractedOutput,
    });
    createdOutput = createResult?.output || null;
    expect(createdOutput?.fileName).toBe("created-from-output.rvz");
    expect(createdOutput?.size).toBeGreaterThan(0);
    expect(createProgress.some((event) => event.stage === "output" && event.percent === 0)).toBe(false);
    expect(createProgress.some((event) => event.label === "finalizing `rvz` archive" && event.percent === 99)).toBe(
      true,
    );
    expect(createProgress.some((event) => event.label === "finalizing `rvz` archive" && event.percent === null)).toBe(
      false,
    );
    await browserRuntime.vfs.truncate(createdOutput.path, createdOutput.size);
  } finally {
    await createdOutput?.cleanup?.().catch(() => undefined);
    await extractedOutput?.cleanup?.().catch(() => undefined);
    await browserRuntime.vfs.remove(source).catch(() => undefined);
  }
});
