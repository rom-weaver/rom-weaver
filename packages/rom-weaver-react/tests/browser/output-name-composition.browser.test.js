import { expect, test } from "vitest";
import OutputCompressionManager from "../../src/lib/compression/output-compression-manager.ts";
import { buildPatchedOutputBaseName } from "../../src/lib/output/output-name-composition.ts";
import { createPatchedRomSavePlan } from "../../src/lib/output/output-save-plan.ts";
import { getGeneratedOutputName } from "../../src/public/react/output-view-model.ts";

test("buildPatchedOutputBaseName strips duplicated input prefixes from patch names", () => {
  expect(buildPatchedOutputBaseName("Crash Bandicoot (USA)", ["Crash Bandicoot (USA)_Quality of Life"])).toBe(
    "Crash Bandicoot (USA) - Quality of Life",
  );
  expect(buildPatchedOutputBaseName("Crash Bandicoot (USA)", ["Crash Bandicoot (USA) - Quality of Life"])).toBe(
    "Crash Bandicoot (USA) - Quality of Life",
  );
});

test("buildPatchedOutputBaseName keeps non-prefixed patch names unchanged", () => {
  expect(buildPatchedOutputBaseName("Crash Bandicoot (USA)", ["Hard Mode"])).toBe("Crash Bandicoot (USA) - Hard Mode");
});

test("browser output generation prefers provided patch filenames over generated labels", () => {
  expect(
    getGeneratedOutputName(
      { fileName: "Crash Bandicoot (USA).bin" },
      [
        {
          _generatedPatchName: "Crash Bandicoot (USA)_Quality of Life",
          fileName: "Quality of Life.ips",
        },
      ],
      {},
    ),
  ).toBe("Crash Bandicoot (USA) - Quality of Life");
});

test("z3ds output naming preserves cci source type when requested name has no extension", () => {
  const savePlan = createPatchedRomSavePlan({
    compressionFormat: "z3ds",
    compressionSettings: {},
    patchedFileName: "Star Fox 64 3D (USA) (En,Fr,Es) (Rev 3)",
    romFile: {
      _z3dsSourceFileName: "Star Fox 64 3D (USA) (En,Fr,Es) (Rev 3).cci",
      fileName: "Star Fox 64 3D (USA) (En,Fr,Es) (Rev 3).cci",
      getExtension: () => "cci",
    },
  });

  expect(savePlan.finalOutputFileName).toBe("Star Fox 64 3D (USA) (En,Fr,Es) (Rev 3).zcci");
});

test("z3ds output naming falls back to z3ds metadata when source extension is missing", () => {
  const savePlan = createPatchedRomSavePlan({
    compressionFormat: "z3ds",
    compressionSettings: {},
    patchedFileName: "output",
    romFile: {
      _z3dsUnderlyingMagic: "NCSD",
      fileName: "input",
      getExtension: () => "",
    },
  });

  expect(savePlan.finalOutputFileName).toBe("output.zcci");
});

test("archive recompression preserves the rom extension for the inner entry", () => {
  const savePlan = createPatchedRomSavePlan({
    compressionFormat: "zip",
    compressionSettings: {},
    patchedFileName: "Crash Bandicoot (USA) - Quality of Life",
    romFile: {
      fileName: "Crash Bandicoot (USA).bin",
      getExtension: () => "bin",
    },
  });

  expect(savePlan.finalOutputFileName).toBe("Crash Bandicoot (USA) - Quality of Life.zip");
  expect(savePlan.archiveEntryFileName).toBe("Crash Bandicoot (USA) - Quality of Life.bin");
});

test("archive compression appends archive extension after explicit rom extension", () => {
  expect(OutputCompressionManager.getCompressedFileName({ fileName: "patched" }, "7z", {})).toBe("patched.7z");
  expect(OutputCompressionManager.getCompressedFileName({ fileName: "patched.gba" }, "7z", {})).toBe("patched.gba.7z");
  expect(OutputCompressionManager.getCompressedFileName({ fileName: "patched.sfc" }, "zip", {})).toBe(
    "patched.sfc.zip",
  );
});
