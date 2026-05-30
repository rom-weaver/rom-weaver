import { afterEach, expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import {
  getRomWeaverFailureMessage,
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
  expect(ready.threaded).toBe(true);
  expect(ready.wasmUrl).toContain("rom-weaver-app.wasm");
  expect(ready.wasmUrl).not.toContain("?import&url");
  expect(wasmResourceNames.some((name) => name.includes("rom-weaver-app.wasm"))).toBe(true);
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
  const sourcePath = `${WORKER_OPFS_MOUNTPOINT}/input/browser-bench-model-${runId}.bin`;
  const outputPath = `${WORKER_OPFS_MOUNTPOINT}/output/browser-bench-model-${runId}.gz`;
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
    const compressResult = await runRomWeaverJson(
      {
        args: { format: "gz", input: [staged.filePath], output: outputPath, threads: 1 },
        type: "compress",
      },
      {
        onEvent: (event) => compressEvents.push(event),
      },
    );
    expectRunSucceeded(compressResult);
    expect(compressEvents.some((event) => event.command === "compress" && event.status === "running")).toBe(true);

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
