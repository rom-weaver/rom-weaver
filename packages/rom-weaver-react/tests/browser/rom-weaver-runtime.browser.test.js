import { expect, test } from "vitest";
import {
  normalizeChdCodecArgs,
  resolvePatchApplyThreadArg,
  selectRomWeaverOutputPath,
} from "../../src/lib/runtime/wasm-command-runtime.ts";
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
