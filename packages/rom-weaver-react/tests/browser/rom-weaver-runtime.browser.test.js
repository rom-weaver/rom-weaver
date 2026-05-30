import { expect, test } from "vitest";
import { normalizeChdCodecArgs, resolvePatchApplyThreadArg } from "../../src/lib/runtime/rom-weaver-runtime.ts";

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
  const result = resolvePatchApplyThreadArg("4", [{ patchFilePath: "/work/input/patch.xdelta" }]);
  expect(result).toMatchObject({
    forcedSingleThread: true,
    hasXdeltaPatch: true,
    threadArg: "1",
  });
});

test("resolvePatchApplyThreadArg preserves configured thread count for non-xdelta patches", () => {
  const result = resolvePatchApplyThreadArg("4", [{ patchFilePath: "/work/input/patch.ips" }]);
  expect(result).toMatchObject({
    forcedSingleThread: false,
    hasXdeltaPatch: false,
    threadArg: "4",
  });
});
