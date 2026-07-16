import { expect, test } from "vitest";
import { createRomWeaverOutputScope, runWithRomWeaverOutputScope } from "../../src/lib/runtime/run-output-paths.ts";
import { normalizeChdCodecArgs, resolvePatchApplyThreadArg } from "../../src/lib/runtime/wasm-command-runtime.ts";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { browserVfs } from "../../src/platform/browser/workflow-runtime-vfs-cleanup.ts";
import { createPublicSourceValidator } from "../../src/platform/shared/public-source-validation.ts";

test("normalizeChdCodecArgs strips conflicting per-codec levels", () => {
  const result = normalizeChdCodecArgs(["cdlz:9", "cdzl:9", "cdfl:8"]);
  expect(result).toEqual({
    codecs: ["cdlz", "cdzl", "cdfl"],
    stripped: true,
  });
});

test("normalizeChdCodecArgs preserves matching codec levels", () => {
  const result = normalizeChdCodecArgs(["cdlz:9", "cdzl:9"]);
  expect(result).toEqual({
    codecs: ["cdlz:9", "cdzl:9"],
    stripped: false,
  });
});

test("resolvePatchApplyThreadArg forces single-thread for xdelta patches", () => {
  for (const extension of ["xdelta", "delta", "dat", "vcdiff"]) {
    const result = resolvePatchApplyThreadArg("4", [{ patchFilePath: `/work/patch.${extension}` }]);
    expect(result).toMatchObject({
      forcedSingleThread: true,
      hasXdeltaPatch: true,
      threadArg: 1,
    });
  }
});

test("resolvePatchApplyThreadArg forces single-thread when patch format is vcdiff without extension", () => {
  const result = resolvePatchApplyThreadArg("8", [{ patchFilePath: "/work/patch-1.bin", patchFormat: "VCDIFF" }]);
  expect(result).toMatchObject({
    forcedSingleThread: true,
    hasXdeltaPatch: true,
    threadArg: 1,
  });
});

test("resolvePatchApplyThreadArg preserves configured thread count for non-xdelta patches", () => {
  const result = resolvePatchApplyThreadArg("4", [{ patchFilePath: "/work/patch.ips" }]);
  expect(result).toMatchObject({
    forcedSingleThread: false,
    hasXdeltaPatch: false,
    threadArg: "4",
  });
});

test("browser output scopes remove every owned path on cleanup and failure", async () => {
  const scope = createRomWeaverOutputScope();
  const first = scope.selectOutputPath("", "first.bin");
  const second = scope.selectOutputPath("", "second.bin", [first]);
  try {
    await browserVfs.write(first, new Uint8Array([1]), { fileOffset: 0 });
    await browserVfs.write(second, new Uint8Array([2]), { fileOffset: 0 });
    expect(await browserVfs.stat(first)).not.toBeNull();
    expect(await browserVfs.stat(second)).not.toBeNull();
  } finally {
    await scope.cleanup();
  }
  expect(await browserVfs.stat(first)).toBeNull();
  expect(await browserVfs.stat(second)).toBeNull();
  expect(await browserVfs.stat(scope.rootPath)).toBeNull();

  let failedPath = "";
  await expect(
    runWithRomWeaverOutputScope("", "failed.bin", [], async (outputPath) => {
      failedPath = outputPath;
      await browserVfs.write(outputPath, new Uint8Array([3]), { fileOffset: 0 });
      throw new Error("expected failure");
    }),
  ).rejects.toThrow("expected failure");
  expect(await browserVfs.stat(failedPath)).toBeNull();
});

test("browser output scope cleanups remove each file and keep siblings until the last release", async () => {
  const scope = createRomWeaverOutputScope();
  const first = scope.selectOutputPath("", "first-owned.bin");
  const second = scope.selectOutputPath("", "second-owned.bin", [first]);
  const [releaseFirst, releaseSecond] = await scope.createOutputCleanups([first, second], (filePath) =>
    browserVfs.remove(filePath),
  );
  if (!(releaseFirst && releaseSecond)) throw new Error("Output cleanups were not created");
  try {
    await browserVfs.write(first, new Uint8Array([1]), { fileOffset: 0 });
    await browserVfs.write(second, new Uint8Array([2]), { fileOffset: 0 });

    await releaseFirst();
    await releaseFirst();
    expect(await browserVfs.stat(first)).toBeNull();
    expect(await browserVfs.stat(second)).not.toBeNull();

    await releaseSecond();
    expect(await browserVfs.stat(second)).toBeNull();
  } finally {
    await scope.cleanup();
  }
});

test("browser output scope cleanups keep a shared path until its last reference is released", async () => {
  const scope = createRomWeaverOutputScope();
  const shared = scope.selectOutputPath("", "shared-owned.bin");
  const [releaseFirst, releaseSecond] = await scope.createOutputCleanups([shared, shared], (filePath) =>
    browserVfs.remove(filePath),
  );
  if (!(releaseFirst && releaseSecond)) throw new Error("Shared output cleanups were not created");
  const outputs = [];
  try {
    await browserVfs.write(shared, new Uint8Array([1]), { fileOffset: 0 });
    outputs.push(
      await browserRuntime.workerIo.createWorkerOutput(
        { cleanup: releaseFirst, fileName: "shared-owned.bin", filePath: shared, size: 1 },
        "shared-owned.bin",
      ),
      await browserRuntime.workerIo.createWorkerOutput(
        { cleanup: releaseSecond, fileName: "shared-owned.bin", filePath: shared, size: 1 },
        "shared-owned.bin",
      ),
    );

    await outputs[0].dispose();
    expect(await browserVfs.stat(shared)).not.toBeNull();

    await outputs[1].dispose();
    expect(await browserVfs.stat(shared)).toBeNull();
  } finally {
    await Promise.all(outputs.map((output) => output.dispose().catch(() => undefined)));
    await scope.cleanup();
  }
});

test("browser public source validation rejects path sources", () => {
  const assertPublicSource = createPublicSourceValidator({ environmentLabel: "browser" });
  expect(() => assertPublicSource("/work/input.bin")).toThrow(/Path strings/);
  expect(() => assertPublicSource({ fileName: "input.bin", source: "/work/input.bin" })).toThrow(
    /Path source wrappers/,
  );
  expect(() => assertPublicSource(new File([new Uint8Array([1])], "input.bin"))).not.toThrow();
  expect(() => assertPublicSource(new Blob([new Uint8Array([1])]))).not.toThrow();
  expect(() =>
    assertPublicSource({
      getFile: async () => new File([new Uint8Array([1])], "input.bin"),
      kind: "file",
    }),
  ).not.toThrow();
  expect(() =>
    assertPublicSource({
      fileName: "input.bin",
      source: {
        getFile: async () => new File([new Uint8Array([1])], "input.bin"),
        kind: "file",
      },
    }),
  ).not.toThrow();
});
