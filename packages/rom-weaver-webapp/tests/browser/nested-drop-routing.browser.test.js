import { expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { countDropEntries, readDropEntries } from "../../src/public/react/drop-destination.ts";
import { loadFixtureFile, ONE_ROM_ZIP, NESTED_CHAIN_ZIP, NESTED_WEAVE_ZIP } from "./patcher-test-shared.js";

test("classifies nested ROM leaves before choosing the Create workflow", async () => {
  const inner = await loadFixtureFile(ONE_ROM_ZIP);
  const result = await browserRuntime.compression.create({
    entries: [{ file: inner, fileName: "nested/original.zip" }],
    format: "zip",
    options: { outputName: "nested.zip", preservePaths: true, threads: 1 },
  });
  try {
    const blob = await browserRuntime.publicOutput.getBlob(result.output);
    const nested = new File([blob], "nested.zip");
    const entries = await readDropEntries([nested, new File(["modified"], "modified.bin")]);
    expect(entries[0].archiveBucket).toBe("rom");
    expect(countDropEntries(entries)).toMatchObject({ roms: 2, patches: 0 });
  } finally {
    await result.output.dispose();
  }
});

test.each([NESTED_CHAIN_ZIP, NESTED_WEAVE_ZIP])("preserves nested patch routing for %s", async (path) => {
  const entries = await readDropEntries([await loadFixtureFile(path)]);
  expect(entries[0].archiveBucket).toBe("patch");
  expect(countDropEntries(entries)).toMatchObject({ roms: 0, patches: 1 });
});
