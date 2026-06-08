import { expect, test } from "vitest";
import {
  normalizeChdCodecArgs,
  resolveCompressionCreateThreadArg,
  resolvePatchApplyThreadArg,
  selectRomWeaverOutputPath,
} from "../../src/lib/runtime/rom-weaver-runtime.ts";
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

test("resolveCompressionCreateThreadArg caps zip zstd max to one browser thread for 256 MiB inputs", () => {
  const totalBytes = 256 * 1024 * 1024;
  const result = resolveCompressionCreateThreadArg({
    codecs: ["zstd:22"],
    format: "zip",
    totalBytes,
    workerThreads: 4,
  });

  expect(result).toMatchObject({
    forcedSingleThread: true,
    forceSingleThreadReason: "zip-zstd-browser-memory",
    requestedThreadArg: 4,
    threadArg: 1,
    threadCap: 1,
    zipZstdLevel: 22,
  });
});

test("resolveCompressionCreateThreadArg forces one thread when zip zstd max would otherwise use browser defaults", () => {
  const result = resolveCompressionCreateThreadArg({
    codecs: ["zstd"],
    format: "zip",
    levelProfile: "max",
    totalBytes: 256 * 1024 * 1024,
  });

  expect(result).toMatchObject({
    forcedSingleThread: true,
    requestedThreadArg: null,
    threadArg: 1,
    threadCap: 1,
    zipZstdLevel: 22,
  });
});

test("resolveCompressionCreateThreadArg uses negative zstd min profile level", () => {
  const result = resolveCompressionCreateThreadArg({
    codecs: ["zstd"],
    format: "zip",
    levelProfile: "min",
    totalBytes: 256 * 1024 * 1024,
    workerThreads: 8,
  });

  expect(result.zipZstdLevel).toBe(-7);
  expect(result.threadArg).toBe(8);
  expect(result.threadCap).toBeGreaterThanOrEqual(8);
});

test("resolveCompressionCreateThreadArg preserves requested zip zstd threads when the browser cap allows them", () => {
  const result = resolveCompressionCreateThreadArg({
    codecs: ["zstd:3"],
    format: "zip",
    totalBytes: 256 * 1024 * 1024,
    workerThreads: 8,
  });

  expect(result.threadArg).toBe(8);
  expect(result.threadCap).toBeGreaterThanOrEqual(8);
});

test("resolveCompressionCreateThreadArg leaves non-zstd archive thread requests unchanged", () => {
  expect(
    resolveCompressionCreateThreadArg({
      codecs: ["deflate:9"],
      format: "zip",
      totalBytes: 256 * 1024 * 1024,
      workerThreads: 4,
    }),
  ).toMatchObject({
    forcedSingleThread: false,
    threadArg: 4,
    threadCap: null,
  });
});

test("selectRomWeaverOutputPath writes flat work outputs and rejects active input collisions", () => {
  expect(selectRomWeaverOutputPath("/work/input.bin", "patched.bin", ["/work/patch.bps"])).toBe("/work/patched.bin");
  expect(() => selectRomWeaverOutputPath("/work/patched.bin", "patched.bin")).toThrow(/conflicts/);
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
