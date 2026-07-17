import { describe, expect, it } from "vitest";
import {
  createExhaustiveContainerCases,
  getBrowserFormatMatrixMetadataCoverage,
} from "../../src/wasm/browser-format-matrix.ts";
import {
  ROM_WEAVER_COMPRESSION_METADATA,
  ROM_WEAVER_CONTAINER_FORMATS,
  ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY,
  ROM_WEAVER_FILE_FILTERS,
  ROM_WEAVER_PATCH_FORMATS,
} from "../../src/wasm/generated/rom-weaver-format-metadata.ts";

const unique = (values) => [...new Set(values)];
const sorted = (values) => [...values].sort((left, right) => left.localeCompare(right));

describe("generated format metadata parity", () => {
  it("keeps file filters derived from format registries", () => {
    expect(sorted(ROM_WEAVER_FILE_FILTERS.containerExtensions)).toEqual(
      sorted(ROM_WEAVER_CONTAINER_FORMATS.flatMap((format) => format.extensions)),
    );
    expect(ROM_WEAVER_FILE_FILTERS.patchExtensions).toEqual([
      ...ROM_WEAVER_PATCH_FORMATS.flatMap((format) => format.extensions),
      ".pds",
      ".dcp",
    ]);
  });

  it("keeps the browser format matrix covering generated registries", () => {
    const coverage = getBrowserFormatMatrixMetadataCoverage();
    expect(
      sorted(unique([...coverage.containerRoundTripFormats, ...coverage.containerCompressFailureFormats])),
    ).toEqual(sorted(ROM_WEAVER_CONTAINER_FORMATS.map((format) => format.name)));

    const createAliases = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.aliases;
    const patchFormats = unique(ROM_WEAVER_PATCH_FORMATS.map((format) => createAliases[format.name] ?? format.name));
    expect(coverage.patchFormats).toEqual(patchFormats);
    expect(coverage.patchFormats).toContain("pmsr");
    expect(coverage.patchFormats).toContain("xdelta");
    expect(coverage.patchFormats).not.toContain("mod");
    expect(coverage.patchFormats).not.toContain("vcdiff");
  });

  it("keeps the exhaustive matrix covering every compression profile and thread mode", () => {
    const cases = createExhaustiveContainerCases();
    expect(unique(cases.map((entry) => entry.format)).sort()).toEqual(["7z", "chd", "z3ds", "zip"]);
    expect(unique(cases.map((entry) => entry.threads)).sort()).toEqual([1, 2, "auto"]);
    expect(unique(cases.map((entry) => entry.level).filter(Boolean)).sort()).toEqual(
      ROM_WEAVER_COMPRESSION_METADATA.profiles.map((profile) => profile.name).sort(),
    );
    expect(
      unique(cases.map((entry) => `${entry.format}:${entry.codec}:${entry.level || "none"}:${entry.threads}`)),
    ).toHaveLength(cases.length);
  });
});
