import { expect, test } from "vitest";
import { buildPatchedOutputBaseName } from "../../src/lib/output/output-name-composition.ts";
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
