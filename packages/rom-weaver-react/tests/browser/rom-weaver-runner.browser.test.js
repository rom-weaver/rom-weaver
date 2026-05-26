import { afterEach, expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import {
  getRomWeaverRunnerMetadata,
  resetRomWeaverRunner,
  runRomWeaverJson,
  warmupRomWeaverRunner,
} from "../../src/workers/rom-weaver/rom-weaver-runner.ts";
import { WORKER_OPFS_MOUNTPOINT } from "../../src/workers/shared/worker-storage/storage-layout.ts";

const encoder = new TextEncoder();

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

afterEach(async () => {
  await resetRomWeaverRunner();
});

test("rom-weaver runner ready metadata exposes the loaded browser wasm runtime", async () => {
  const canUseSharedMemory = typeof SharedArrayBuffer === "function" && globalThis.crossOriginIsolated === true;
  const ready = await warmupRomWeaverRunner();
  const metadata = await getRomWeaverRunnerMetadata();

  expect(ready).toEqual(metadata);
  expect(ready.threaded).toBe(canUseSharedMemory);
  expect(ready.wasmUrl).toContain(canUseSharedMemory ? "rom-weaver-cli-threaded" : "rom-weaver-cli.wasm");
});

test("rom-weaver runner reads and writes staged /work OPFS paths", async () => {
  await warmupRomWeaverRunner();

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const outputPath = `${WORKER_OPFS_MOUNTPOINT}/output/browser-bench-model-${runId}.gz`;
  const source = new File([encoder.encode("rom-weaver browser OPFS parity fixture\n")], "source.bin");
  const staged = await browserRuntime.workerIo.stageSource({
    fallbackFileName: source.name,
    pathPrefix: "browser-bench-model",
    scope: "bench",
    source,
  });

  try {
    const compressEvents = [];
    const compressResult = await runRomWeaverJson(
      ["compress", staged.filePath, "--format", "gz", "--output", outputPath, "--threads", "1"],
      {
        onEvent: (event) => compressEvents.push(event),
      },
    );
    expectRunSucceeded(compressResult);
    expect(compressEvents.some((event) => event.command === "compress" && event.status === "running")).toBe(true);

    const outputStat = await browserRuntime.vfs.stat(outputPath);
    expect(outputStat?.size || 0).toBeGreaterThan(0);

    const checksumResult = await runRomWeaverJson(["checksum", outputPath, "--algo", "crc32", "--no-extract"]);
    expectRunSucceeded(checksumResult);
  } finally {
    await staged.cleanup().catch(() => undefined);
    await browserRuntime.vfs.remove(outputPath).catch(() => undefined);
  }
});
