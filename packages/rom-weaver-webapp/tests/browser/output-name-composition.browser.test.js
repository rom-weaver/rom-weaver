import { expect, test } from "vitest";
import OutputCompressionManager from "../../src/lib/compression/output-compression-manager.ts";
import {
  CREATE_BPS_DEFAULT_LIMIT_BYTES,
  CREATE_IPS_SIZE_LIMIT_BYTES,
  CREATE_LEGACY_PATCH_SIZE_LIMIT_BYTES,
  getPreferredCreatePatchFormat,
  normalizeCreatePatchFormat,
} from "../../src/lib/create/patch-format-limits.ts";
import { buildPatchedOutputBaseName, createPatchMetadataLabel } from "../../src/lib/output/output-name-composition.ts";
import { createPatchedRomSavePlan } from "../../src/lib/output/output-save-plan.ts";
import {
  createApplyOutputOptions,
  createCreateOutputCompressionOptions,
  createCreatePatchFormatOptions,
  createTrimOutputOptions,
  getCreatePatchExtensionWarning,
  getCreatePatchFormatForFileName,
  getOutputExtensionWarning,
  getOutputFileNameForFormat,
  getOutputFormatForFileName,
  getGeneratedOutputName,
} from "../../src/public/react/output-view-model.ts";

test("buildPatchedOutputBaseName strips duplicated input prefixes from patch names", () => {
  expect(buildPatchedOutputBaseName("Crash Bandicoot (USA)", ["Crash Bandicoot (USA)_Quality of Life"])).toBe(
    "Crash Bandicoot (USA) [Quality of Life]",
  );
  expect(buildPatchedOutputBaseName("Crash Bandicoot (USA)", ["Crash Bandicoot (USA) - Quality of Life"])).toBe(
    "Crash Bandicoot (USA) [Quality of Life]",
  );
});

test("buildPatchedOutputBaseName wraps non-prefixed patch names in brackets", () => {
  expect(buildPatchedOutputBaseName("Crash Bandicoot (USA)", ["Hard Mode"])).toBe("Crash Bandicoot (USA) [Hard Mode]");
});

test("buildPatchedOutputBaseName sanitizes bracket delimiters in fallback names", () => {
  expect(buildPatchedOutputBaseName("Crash", ["Hard]Mode"])).toBe("Crash [Hard Mode]");
});

test("buildPatchedOutputBaseName appends a trailing bracket label verbatim", () => {
  expect(buildPatchedOutputBaseName("Crash", ["super awesome [big jump by foo v1.0]"])).toBe(
    "Crash [big jump by foo v1.0]",
  );
});

test("patch metadata becomes an automatic bracket label", () => {
  expect(
    buildPatchedOutputBaseName("Crash Bandicoot (USA)", [
      createPatchMetadataLabel({
        author: "Jane Doe",
        description: "Description fallback",
        name: "Hard Mode",
        version: "1.2",
      }),
    ]),
  ).toBe("Crash Bandicoot (USA) [Hard Mode Jane Doe 1.2]");
});

test("patch metadata falls back to the description", () => {
  expect(createPatchMetadataLabel({ author: "Jane Doe", description: "Hard Mode" })).toBe("[Hard Mode Jane Doe]");
});

test("patch metadata removes bracket characters from the label", () => {
  expect(createPatchMetadataLabel({ author: "Jane] Doe", description: "Hard [Mode]" })).toBe("[Hard Mode Jane Doe]");
});

test("buildPatchedOutputBaseName keeps bracket and plain patch names alongside each other", () => {
  expect(buildPatchedOutputBaseName("Crash", ["Hard Mode", "super awesome [big jump by foo v1.0]"])).toBe(
    "Crash [Hard Mode] [big jump by foo v1.0]",
  );
  expect(buildPatchedOutputBaseName("Crash", ["[color fix]", "[hud rework]"])).toBe("Crash [color fix] [hud rework]");
});

test("browser output generation appends the patch bracket label to the rom name", () => {
  expect(
    getGeneratedOutputName(
      { fileName: "Crash.chd" },
      [{ fileName: "super awesome [big jump by foo v1.0].xdelta" }],
      {},
    ),
  ).toBe("Crash [big jump by foo v1.0]");
});

test("browser output generation brackets a patch filename without metadata", () => {
  expect(getGeneratedOutputName({ fileName: "Crash.chd" }, [{ fileName: "hard-mode.ips" }], {})).toBe(
    "Crash [hard-mode]",
  );
});

test("browser output generation uses a generated metadata label", () => {
  expect(
    getGeneratedOutputName(
      { fileName: "Crash.chd" },
      [{ _generatedPatchName: "[Hard Mode Jane Doe 1.2]", fileName: "hard-mode.ips" }],
      {},
    ),
  ).toBe("Crash [Hard Mode Jane Doe 1.2]");
});

test("browser output generation strips an input archive extension without patches", () => {
  expect(getGeneratedOutputName({ fileName: "Crash.zip" }, [], {})).toBe("Crash");
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
  ).toBe("Crash Bandicoot (USA) [Quality of Life]");
});

test("z3ds output naming preserves cci source type when requested name has no extension", () => {
  const savePlan = createPatchedRomSavePlan({
    compressionFormat: "z3ds",
    compressionSettings: {},
    patchedFileName: "Star Fox 64 3D (USA) (En,Fr,Es) (Rev 3)",
    romFile: {
      fileName: "Star Fox 64 3D (USA) (En,Fr,Es) (Rev 3).cci",
      getExtension: () => "cci",
      metadata: { sourceFileName: "Star Fox 64 3D (USA) (En,Fr,Es) (Rev 3).cci" },
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
      fileName: "input",
      getExtension: () => "",
      metadata: { underlyingMagic: "NCSD" },
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
  expect(
    OutputCompressionManager.getCompressedFileName({ fileName: "patched.sfc" }, "zip", {
      zipCodec: "zstd",
    }),
  ).toBe("patched.sfc.zip");
});

test("apply output options preserve configured compression order and labels", () => {
  expect(createApplyOutputOptions(["none", "zip", "7z"], { fileName: "game.gba" })).toEqual([
    { label: "Raw ROM", value: "none" },
    { label: "Small ZIP", value: "zip" },
    { label: "Smaller 7z", value: "7z" },
  ]);
});

test("apply output options label unknown uncompressed output as none", () => {
  expect(createApplyOutputOptions(["none", "zip", "7z"])).toEqual([
    { label: "Raw ROM", value: "none" },
    { label: "Small ZIP", value: "zip" },
    { label: "Smaller 7z", value: "7z" },
  ]);
});

test("apply output options name disc containers", () => {
  expect(
    createApplyOutputOptions([
      { label: ".gba", value: "none" },
      { label: ".chd", value: "chd" },
      { label: ".rvz", value: "rvz" },
      { label: ".zcci", value: "z3ds" },
    ]),
  ).toEqual([
    { label: "Raw ROM", value: "none" },
    { label: "CHD disc image", value: "chd" },
    { label: "RVZ disc image", value: "rvz" },
    { label: "Z3DS image", value: "z3ds" },
  ]);
});

test("output extension matching selects formats and warns on unknown extensions", () => {
  const options = [
    { label: ".gba", value: "none" },
    { label: ".zip", value: "zip" },
  ];
  expect(getOutputFormatForFileName("game.zip", options)).toBe("zip");
  expect(getOutputFormatForFileName("game.sfc", options, { rawExtensions: ["sfc"] })).toBe("none");
  expect(getOutputExtensionWarning("game.zip", options)).toBeNull();
  expect(getOutputExtensionWarning("game.bad", options)).toContain(".bad");
  expect(getOutputFileNameForFormat("game.zip", "none", options, { rawExtensions: ["sfc"] })).toBe("game.gba");
  expect(getOutputFileNameForFormat("game", "zip", options)).toBe("game.zip");
  expect(
    getOutputFileNameForFormat("patch.bps", "xdelta", [
      { label: ".bps", value: "bps" },
      { label: ".xdelta", value: "xdelta" },
    ]),
  ).toBe("patch.xdelta");
});

test("create patch extension matching accepts registry aliases", () => {
  const options = [
    { label: ".bps", value: "bps" },
    { label: ".xdelta", value: "xdelta" },
  ];
  expect(getCreatePatchFormatForFileName("game.vcdiff", options)).toBe("xdelta");
  expect(getCreatePatchExtensionWarning("game.vcdiff", options)).toBeNull();
  expect(getCreatePatchExtensionWarning("game.zip", options, [{ label: ".zip", value: "zip" }])).toBeNull();
  expect(getCreatePatchExtensionWarning("game.zip", options, [{ label: ".zip", value: "zip" }], "none")).toContain(
    ".zip",
  );
  expect(getCreatePatchExtensionWarning("game.bad", options)).toContain(".bad");
});

test("create output options expose patch format and archive choices", () => {
  expect(createCreateOutputCompressionOptions("bps")).toEqual([
    { label: "None", value: "none" },
    { label: ".zip", value: "zip" },
    { label: ".7z", value: "7z" },
  ]);
  expect(createCreatePatchFormatOptions().map((option) => option.value)).toEqual([
    "bps",
    "xdelta",
    "aps",
    "bdf",
    "ebp",
    "ips",
    "pmsr",
    "ppf",
    "rup",
    "ups",
  ]);
  expect(
    createCreatePatchFormatOptions({ originalSize: CREATE_IPS_SIZE_LIMIT_BYTES }).map((option) => option.value),
  ).toEqual(["bps", "xdelta", "aps", "bdf", "pmsr", "ppf", "rup", "ups"]);
  expect(
    createCreatePatchFormatOptions({ originalSize: CREATE_BPS_DEFAULT_LIMIT_BYTES }).map((option) => option.value),
  ).toEqual(["xdelta", "bps", "aps", "bdf", "pmsr", "ppf", "rup", "ups"]);
  expect(
    createCreatePatchFormatOptions({ originalSize: CREATE_LEGACY_PATCH_SIZE_LIMIT_BYTES + 1 }).map(
      (option) => option.value,
    ),
  ).toEqual(["xdelta", "ppf"]);
  expect(createCreatePatchFormatOptions({ candidateFormats: ["xdelta", "bps"] }).map((option) => option.value)).toEqual(
    ["xdelta", "bps"],
  );
});

test("create format policy steers defaults by size", () => {
  expect(normalizeCreatePatchFormat("vcdiff")).toBe("xdelta");
  expect(getPreferredCreatePatchFormat({ requestedFormat: "bps" })).toBe("bps");
  expect(
    getPreferredCreatePatchFormat({
      automaticFormatSelection: true,
      originalSize: CREATE_BPS_DEFAULT_LIMIT_BYTES,
      requestedFormat: "bps",
    }),
  ).toBe("xdelta");
  expect(
    getPreferredCreatePatchFormat({
      automaticFormatSelection: false,
      originalSize: CREATE_BPS_DEFAULT_LIMIT_BYTES,
      requestedFormat: "bps",
    }),
  ).toBe("bps");
  expect(
    getPreferredCreatePatchFormat({
      originalSize: 40 * 1024 * 1024,
      requestedFormat: "bps",
    }),
  ).toBe("bps");
  expect(
    getPreferredCreatePatchFormat({
      candidateDefaultFormat: "xdelta",
      candidateFormats: ["xdelta", "bps"],
      requestedFormat: "bps",
    }),
  ).toBe("xdelta");
  expect(
    getPreferredCreatePatchFormat({
      automaticFormatSelection: false,
      candidateDefaultFormat: "xdelta",
      candidateFormats: ["xdelta", "bps"],
      requestedFormat: "bps",
    }),
  ).toBe("bps");
});

test("trim output options keep raw source extension alongside archive choices", () => {
  expect(createTrimOutputOptions("nds")).toEqual([
    { label: ".nds", value: "nds" },
    { label: ".chd", value: "chd" },
    { label: ".rvz", value: "rvz" },
    { label: ".z3ds", value: "z3ds" },
    { label: ".zip", value: "zip" },
    { label: ".7z", value: "7z" },
  ]);
});

test("trim output options can label an unknown raw extension as none", () => {
  expect(createTrimOutputOptions("raw", { rawLabel: "None" })[0]).toEqual({ label: "None", value: "raw" });
});
