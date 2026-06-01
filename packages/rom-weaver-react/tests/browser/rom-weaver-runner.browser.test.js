import { afterEach, expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { getActiveBrowserVirtualFiles } from "../../src/workers/protocol/browser-virtual-files.ts";
import {
  getRomWeaverFailureMessage,
  getRomWeaverRunnerMetadata,
  resetRomWeaverRunner,
  runRomWeaverJson,
  warmupRomWeaverRunner,
} from "../../src/workers/rom-weaver/rom-weaver-runner.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../src/workers/shared/worker-storage/storage-layout.ts";

const encoder = new TextEncoder();
const MULTI_ROM_ZIP = "tests/fixtures/archives/multi-rom.zip";

const failureDetails = (result) =>
  [
    `exitCode=${result?.exitCode}`,
    `ok=${result?.ok}`,
    result?.stderr,
    ...(Array.isArray(result?.nonJsonLines) ? result.nonJsonLines : []),
    result?.error?.message,
    result?.error?.stack,
  ]
    .filter(Boolean)
    .join("\n");

const expectRunSucceeded = (result) => {
  expect(result?.exitCode, failureDetails(result)).toBe(0);
  expect(result?.ok, failureDetails(result)).toBe(true);
};

const loadFixtureFile = async (filePath, type = "application/octet-stream") => {
  const response = await fetch(`/${filePath}`);
  if (!response.ok) throw new Error(`Failed to load fixture ${filePath}`);
  return new File([await response.arrayBuffer()], filePath.replace(/^.*\//, ""), { type });
};

afterEach(async () => {
  await resetRomWeaverRunner();
});

test("rom-weaver runner ready metadata exposes the loaded browser wasm runtime", async () => {
  const canUseSharedMemory = typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated === true;
  if (!canUseSharedMemory) {
    await expect(warmupRomWeaverRunner()).rejects.toThrow(/cross-origin isolation|SharedArrayBuffer|COOP\/COEP/i);
    return;
  }
  performance.clearResourceTimings?.();
  const ready = await warmupRomWeaverRunner();
  const metadata = await getRomWeaverRunnerMetadata();
  const wasmResourceNames = performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => name.includes("rom-weaver-app") && name.includes(".wasm"));

  expect(ready).toEqual(metadata);
  expect(typeof ready.threaded).toBe("boolean");
  expect(ready.wasmUrl).toMatch(/rom-weaver-app(?:-threaded)?\.wasm/);
  expect(ready.wasmUrl).not.toContain("?import&url");
  expect(wasmResourceNames.some((name) => /rom-weaver-app(?:-threaded)?\.wasm/.test(name))).toBe(true);
});

test("rom-weaver failure messages ignore trace-only stderr", () => {
  const traceLine =
    "2026-05-26T04:39:38.602000Z TRACE rom_weaver_core::context: emitting progress event command=extract";
  expect(
    getRomWeaverFailureMessage(
      {
        events: [],
        exitCode: 1,
        nonJsonLines: [],
        ok: false,
        stderr: traceLine,
        traceEvents: [],
        traceNonJsonLines: [traceLine],
      },
      "Compression extract failed",
    ),
  ).toBe("Compression extract failed");
});

test("rom-weaver runner reads and writes staged /work OPFS paths", async () => {
  await warmupRomWeaverRunner();

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sourcePath = `${WORKER_OPFS_MOUNTPOINT}/browser-bench-model-${runId}.bin`;
  const outputPath = `${WORKER_OPFS_MOUNTPOINT}/browser-bench-model-${runId}.gz`;
  const source = encoder.encode("rom-weaver browser OPFS parity fixture\n");
  await browserRuntime.vfs.truncate(sourcePath, 0);
  await browserRuntime.vfs.write(sourcePath, source, { fileOffset: 0 });
  const staged = await browserRuntime.workerIo.stageSource({
    fallbackFileName: "source.bin",
    pathPrefix: "browser-bench-model",
    scope: "bench",
    source: sourcePath,
  });

  try {
    const compressEvents = [];
    const traceLines = [];
    const compressResult = await runRomWeaverJson(
      {
        args: { format: "gz", input: [staged.filePath], output: outputPath, threads: 1 },
        type: "compress",
      },
      {
        onEvent: (event) => compressEvents.push(event),
        onTraceNonJsonLine: (line) => traceLines.push(line),
      },
    );
    expectRunSucceeded(compressResult);
    expect(compressEvents.some((event) => event.command === "compress" && event.status === "running")).toBe(true);
    expect(traceLines.some((line) => line.includes("prepareKnownRequestPaths"))).toBe(false);

    const outputStat = await browserRuntime.vfs.stat(outputPath);
    expect(outputStat?.size || 0).toBeGreaterThan(0);

    const checksumResult = await runRomWeaverJson({
      args: { algo: ["crc32"], no_extract: true, source: outputPath },
      type: "checksum",
    });
    expectRunSucceeded(checksumResult);
  } finally {
    await staged.cleanup().catch(() => undefined);
    await browserRuntime.vfs.remove(sourcePath).catch(() => undefined);
    await browserRuntime.vfs.remove(outputPath).catch(() => undefined);
  }
});

test("rom-weaver runner lazily creates selected archive extract outputs", async () => {
  await warmupRomWeaverRunner();

  const archive = await browserRuntime.workerIo.stageSource({
    fallbackFileName: "multi-rom.zip",
    pathPrefix: "archive-lazy-output",
    scope: "bench",
    source: await loadFixtureFile(MULTI_ROM_ZIP, "application/zip"),
  });
  const outputPath = `${WORKER_OPFS_MOUNTPOINT}/game.bin`;
  const traceLines = [];

  try {
    await browserRuntime.vfs.remove(outputPath).catch(() => undefined);
    const result = await runRomWeaverJson(
      {
        args: {
          no_nested_extract: true,
          out_dir: WORKER_OPFS_MOUNTPOINT,
          select: ["game.bin"],
          source: archive.filePath,
        },
        type: "extract",
      },
      {
        onTraceNonJsonLine: (line) => traceLines.push(line),
      },
    );
    expectRunSucceeded(result);
    expect(traceLines.some((line) => line.includes("prepareKnownRequestPaths"))).toBe(false);

    const outputStat = await browserRuntime.vfs.stat(outputPath);
    expect(outputStat?.size || 0).toBeGreaterThan(0);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : error}\n${traceLines.join("\n")}`);
  } finally {
    await archive.cleanup().catch(() => undefined);
    await browserRuntime.vfs.remove(outputPath).catch(() => undefined);
  }
});

test("rom-weaver compress can write /work zip outputs after releasing same-name virtual inputs", async () => {
  await warmupRomWeaverRunner();

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const baseName = `Pokemon - Black Version (USA, Europe) (NDSi Enhanced)-${runId}`;
  const inputPath = `${WORKER_OPFS_MOUNTPOINT}/${baseName}.nds`;
  const outputPath = `${WORKER_OPFS_MOUNTPOINT}/${baseName}.zip`;
  const stagedVirtual = await browserRuntime.workerIo.stageSource({
    fallbackFileName: `${baseName}.zip`,
    pathPrefix: "archive-input",
    scope: "archive",
    source: new File([encoder.encode("zip input fixture")], `${baseName}.zip`, {
      type: "application/zip",
    }),
  });

  try {
    await stagedVirtual.cleanup();
    expect(getActiveBrowserVirtualFiles().map((entry) => entry.path)).not.toContain(outputPath);

    const inputBytes = encoder.encode("rom-weaver zip output regression fixture\n");
    await browserRuntime.vfs.truncate(inputPath, 0);
    await browserRuntime.vfs.write(inputPath, inputBytes, { fileOffset: 0 });

    const result = await runRomWeaverJson(
      {
        args: { format: "zip", input: [inputPath], output: outputPath, threads: 1 },
        type: "compress",
      },
      {
        invalidateMountCacheBeforeRun: true,
      },
    );
    expectRunSucceeded(result);
    const outputStat = await browserRuntime.vfs.stat(outputPath);
    expect(outputStat?.size || 0).toBeGreaterThan(0);
  } finally {
    await stagedVirtual.cleanup().catch(() => undefined);
    await browserRuntime.vfs.remove(inputPath).catch(() => undefined);
    await browserRuntime.vfs.remove(outputPath).catch(() => undefined);
  }
});
