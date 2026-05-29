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
  performance.clearResourceTimings?.();
  const ready = await warmupRomWeaverRunner();
  const metadata = await getRomWeaverRunnerMetadata();
  const wasmResourceNames = performance
    .getEntriesByType("resource")
    .map((entry) => entry.name)
    .filter((name) => name.includes("rom-weaver-app") && name.includes(".wasm"));
  const observedSingleThreadedWasmImports = wasmResourceNames.filter(
    (name) => name.includes("rom-weaver-app.wasm") && !name.includes("threaded"),
  );

  expect(ready).toEqual(metadata);
  expect(ready.threaded).toBe(canUseSharedMemory);
  expect(ready.wasmUrl).toContain(canUseSharedMemory ? "rom-weaver-app-threaded" : "rom-weaver-app.wasm");
  expect(ready.wasmUrl).not.toContain("?import&url");
  if (canUseSharedMemory) {
    expect(observedSingleThreadedWasmImports).toEqual([]);
  }
});

test("rom-weaver runner can initialize a forced single-thread wasm runtime", async () => {
  const metadata = await getRomWeaverRunnerMetadata({ preferThreadedWasm: false });
  expect(metadata.threaded).toBe(false);
  expect(metadata.wasmUrl).toContain("rom-weaver-app.wasm");
  expect(metadata.wasmUrl).not.toContain("threaded");
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
    await browserRuntime.vfs.remove(sourcePath).catch(() => undefined);
    await browserRuntime.vfs.remove(outputPath).catch(() => undefined);
  }
});
