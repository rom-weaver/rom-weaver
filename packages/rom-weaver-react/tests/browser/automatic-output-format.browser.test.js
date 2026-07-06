import { expect, test } from "vitest";
import {
  getRomSpecificExtractedFileName,
  normalizeRomSpecificExtractedFileName,
  resolveAutomaticCompressionFormat,
} from "../../src/lib/compression/container-format-registry.ts";
import OutputCompressionManager from "../../src/lib/compression/output-compression-manager.ts";
import { getCompressionIntermediateFileName } from "../../src/lib/output/output-files.ts";

test("automatic output format uses the innermost parent compression after nested extraction", () => {
  expect(
    resolveAutomaticCompressionFormat({
      parentCompressions: [{ kind: "7z" }, { kind: "rvz" }],
      sourceFileName: "game.iso",
    }),
  ).toBe("rvz");
});

test("automatic output format falls back to outer known parent compression when inner kind is unknown", () => {
  expect(
    resolveAutomaticCompressionFormat({
      parentCompressions: [{ kind: "7z" }, { kind: "unknown-format" }],
      sourceFileName: "game.iso",
    }),
  ).toBe("7z");
});

test("automatic output format uses unambiguous special compression input extensions", () => {
  expect(resolveAutomaticCompressionFormat({ fallback: "zip", sourceFileName: "game.gcm" })).toBe("rvz");
  expect(resolveAutomaticCompressionFormat({ fallback: "zip", sourceFileName: "game.wbfs" })).toBe("rvz");
  expect(resolveAutomaticCompressionFormat({ fallback: "zip", sourceFileName: "disc.cue" })).toBe("chd");
  expect(resolveAutomaticCompressionFormat({ fallback: "zip", sourceFileName: "game.cci" })).toBe("z3ds");
});

test("z3ds browser extraction names preserve subtype extensions", () => {
  expect(getRomSpecificExtractedFileName("z3ds", { fileName: "game.zcci" })).toBe("game.cci");
  expect(getRomSpecificExtractedFileName("z3ds", { fileName: "game.zcia" })).toBe("game.cia");
  expect(getRomSpecificExtractedFileName("z3ds", { fileName: "game.zcxi" })).toBe("game.cxi");
  expect(getRomSpecificExtractedFileName("z3ds", { fileName: "game.z3dsx" })).toBe("game.3dsx");
  expect(
    getRomSpecificExtractedFileName("z3ds", { fileName: "game.z3ds", metadata: { underlyingMagic: "NCSD" } }),
  ).toBe("game.cci");
  expect(
    getRomSpecificExtractedFileName("z3ds", { fileName: "game.z3ds", metadata: { underlyingMagic: "NCCH" } }),
  ).toBe("game.cxi");
  expect(
    getRomSpecificExtractedFileName("z3ds", { fileName: "game.z3ds", metadata: { underlyingMagic: "CIA\u0000" } }),
  ).toBe("game.cia");
  expect(
    getRomSpecificExtractedFileName("z3ds", { fileName: "game.z3ds", metadata: { underlyingMagic: "3DSX" } }),
  ).toBe("game.3dsx");
  expect(getRomSpecificExtractedFileName("z3ds", { fileName: "game.z3ds" })).toBe("game.3ds");
});

test("z3ds browser extraction normalizes generic worker names using source subtype", () => {
  expect(normalizeRomSpecificExtractedFileName("z3ds", "game.3ds", { fileName: "game.zcci" })).toBe("game.cci");
  expect(normalizeRomSpecificExtractedFileName("z3ds", "game.3ds", { fileName: "game.zcia" })).toBe("game.cia");
  expect(normalizeRomSpecificExtractedFileName("z3ds", "game.3ds", { fileName: "game.zcxi" })).toBe("game.cxi");
  expect(normalizeRomSpecificExtractedFileName("z3ds", "game.3ds", { fileName: "game.z3dsx" })).toBe("game.3dsx");
  expect(
    normalizeRomSpecificExtractedFileName("z3ds", "game.3ds", {
      fileName: "game.z3ds",
      metadata: { underlyingMagic: "NCSD" },
    }),
  ).toBe("game.cci");
});

test("z3ds browser intermediate names preserve decompressed subtype extensions", () => {
  expect(
    getCompressionIntermediateFileName("patched", "z3ds", { fileName: "game.zcci", getExtension: () => "zcci" }),
  ).toBe("patched.cci");
  expect(
    getCompressionIntermediateFileName("patched.zcia", "z3ds", { fileName: "game.zcia", getExtension: () => "zcia" }),
  ).toBe("patched.cia");
  expect(
    getCompressionIntermediateFileName("patched.zcxi", "z3ds", { fileName: "game.zcxi", getExtension: () => "zcxi" }),
  ).toBe("patched.cxi");
  expect(
    getCompressionIntermediateFileName("patched.z3dsx", "z3ds", {
      fileName: "game.z3dsx",
      getExtension: () => "z3dsx",
    }),
  ).toBe("patched.3dsx");
  expect(
    getCompressionIntermediateFileName("patched.z3ds", "z3ds", {
      fileName: "game.z3ds",
      getExtension: () => "z3ds",
      metadata: { underlyingMagic: "NCSD" },
    }),
  ).toBe("patched.cci");
  expect(
    getCompressionIntermediateFileName("patched.z3ds", "z3ds", { fileName: "game.z3ds", getExtension: () => "z3ds" }),
  ).toBe("patched.3ds");
});

test("automatic output format does not guess for iso without compression context", () => {
  expect(resolveAutomaticCompressionFormat({ fallback: "zip", sourceFileName: "game.iso" })).toBe("zip");
  expect(
    OutputCompressionManager.resolveOutputCompression(
      { fileName: "game.iso" },
      {
        compressionFormat: "auto",
      },
    ),
  ).toBe("7z");
});
