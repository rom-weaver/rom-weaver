import { expect, test } from "vitest";
import {
  getRomSpecificExtractedFileName,
  normalizeRomSpecificExtractedFileName,
  resolveAutomaticCompressionFormat,
} from "../../src/lib/compression/container-format-registry.ts";
import OutputCompressionManager from "../../src/lib/compression/output-compression-manager.ts";
import { getCompressionIntermediateFileName } from "../../src/lib/output/output-files.ts";
import { resolveCompressionState } from "../../src/public/react/use-compression-resolver.ts";

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

test("automatic output format prefers the engine rom-specific recommendation for a bare .iso", () => {
  // A bare GameCube/PS .iso has no rom-specific extension, so extension heuristics alone would
  // fall to 7z. The engine content verdict (recommendedFormat, from ingest identity) must win.
  expect(
    OutputCompressionManager.resolveOutputCompression(
      { fileName: "game.iso", metadata: { recommendedFormat: "rvz" } },
      { compressionFormat: "auto" },
    ),
  ).toBe("rvz");
  expect(
    OutputCompressionManager.resolveOutputCompression(
      { fileName: "game.iso", metadata: { recommendedFormat: "chd" } },
      { compressionFormat: "auto" },
    ),
  ).toBe("chd");
  // A GameCube/Wii disc reports disc_format=DVD (chd-ish disc metadata), but the engine verdict
  // recommends rvz - the verdict must win over the CHD disc-metadata heuristic.
  expect(
    OutputCompressionManager.resolveOutputCompression(
      { fileName: "game.iso", metadata: { format: "DVD", mode: "dvd", recommendedFormat: "rvz" } },
      { compressionFormat: "auto" },
    ),
  ).toBe("rvz");
  // No verdict → a bare .iso falls through to the archive fallback (7z).
  expect(
    OutputCompressionManager.resolveOutputCompression({ fileName: "game.iso" }, { compressionFormat: "auto" }),
  ).toBe("7z");
  // An explicit non-auto choice always wins over the verdict.
  expect(
    OutputCompressionManager.resolveOutputCompression(
      { fileName: "game.iso", metadata: { recommendedFormat: "rvz" } },
      { compressionFormat: "zip" },
    ),
  ).toBe("zip");
});

test("engine recommendation is honored or suppressed per the default-compression setting", () => {
  const romInputs = [{ info: { fileName: "game.iso" }, size: 5_000_000 }];
  const effectiveInputs = [{ fileName: "game.iso", size: 5_000_000 }];
  const z3dsLabelSource = { fileName: "game.iso", metadata: { recommendedFormat: "rvz" }, size: 5_000_000 };
  const run = (defaultCompression) =>
    resolveCompressionState({
      activeSettings: { defaultCompression },
      effectiveInputs,
      outputCompressionEdited: false,
      romInputs,
      z3dsLabelSource,
    }).requestedCompression;
  // Special-allowing modes honor the rvz verdict over the 7z/zip default archive.
  expect(run("7z/special")).toBe("rvz");
  expect(run("auto")).toBe("rvz");
  // "* only" modes force the default archive and suppress the verdict.
  expect(run("7z only")).toBe("7z");
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
