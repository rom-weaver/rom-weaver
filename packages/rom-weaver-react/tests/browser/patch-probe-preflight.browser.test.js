import { expect, test } from "vitest";
import { getPatchProbeRequirements, parsePatchForApply } from "../../src/lib/apply/patch-apply-service.ts";
import { createPatchFile } from "../../src/lib/input/binary-service.ts";

const loadFixtureFile = async (filePath, type = "application/octet-stream") => {
  const response = await fetch(`/${filePath}`);
  if (!response.ok) throw new Error(`Failed to load fixture ${filePath}`);
  const bytes = await response.arrayBuffer();
  const fileName = filePath.split("/").at(-1) || "patch.bin";
  return new File([bytes], fileName, { type });
};

// Stub the consolidated `ingest` runtime the apply staging now uses as its patch-requirements source:
// `parsePatchForApply` runs ingest over the patch leaf and maps `result.patches[0]` (a parsed
// PatchDescriptor with camelCase number fields) onto the preflight requirements shape.
const ingestRuntime = (descriptor) => ({
  ingest: {
    run: async () => ({
      outputs: [],
      patchOutputs: [],
      result: { assets: [], isRom: false, kind: "patch", patches: [descriptor], sourceFileName: "" },
    }),
  },
});

test("parsePatchForApply maps ingest descriptor requirements for BPS patches", async () => {
  const patchFile = await createPatchFile(
    await loadFixtureFile("tests/fixtures/browser-generated/patch-matrix/raw/change.bps"),
    "change.bps",
  );
  const parsedPatch = await parsePatchForApply(
    patchFile,
    ingestRuntime({
      fileName: "change.bps",
      filenameChecksums: {},
      format: "bps",
      leafPath: "change.bps",
      patchCrc32: 1,
      recordCount: 42,
      sizeBytes: 23,
      sourceCrc32: 0x1234abcd,
      sourceSize: 4194304,
      targetCrc32: 0xabcd1234,
      targetSize: 4198400,
    }),
  );
  expect(parsedPatch).not.toBeNull();
  expect(getPatchProbeRequirements(parsedPatch)).toEqual({
    format: "BPS",
    patchCrc32: "00000001",
    recordCount: 42,
    sourceCrc32: "1234abcd",
    sourceSize: 4194304,
    targetCrc32: "abcd1234",
    targetSize: 4198400,
  });
});

test("parsePatchForApply maps VCDIFF source requirements without source checksum/size", async () => {
  for (const extension of ["xdelta", "delta", "dat"]) {
    const patchFile = await createPatchFile(
      await loadFixtureFile("tests/fixtures/browser-generated/patch-matrix/raw/change.xdelta"),
      `change.${extension}`,
    );
    const parsedPatch = await parsePatchForApply(
      patchFile,
      ingestRuntime({
        fileName: `change.${extension}`,
        filenameChecksums: {},
        format: "xdelta",
        leafPath: `change.${extension}`,
        minimumSourceSize: 1048576,
        recordCount: 3,
        sizeBytes: 64,
        targetSize: 1048600,
      }),
    );
    expect(parsedPatch).not.toBeNull();
    expect(parsedPatch?.constructor?.name).toBe("VCDIFF");
    expect(parsedPatch?.isXdeltaPatch).toBe(true);
    expect(getPatchProbeRequirements(parsedPatch)).toEqual({
      format: "XDELTA",
      minimumSourceSize: 1048576,
      recordCount: 3,
      targetSize: 1048600,
    });
  }
});

test("parsePatchForApply renders numeric descriptor checksums as padded hex", async () => {
  const patchFile = await createPatchFile(
    await loadFixtureFile("tests/fixtures/browser-generated/patch-matrix/raw/change.ups"),
    "change.ups",
  );
  const parsedPatch = await parsePatchForApply(
    patchFile,
    ingestRuntime({
      fileName: "change.ups",
      filenameChecksums: {},
      format: "ups",
      leafPath: "change.ups",
      patchCrc32: 1,
      sizeBytes: 32,
      sourceCrc32: 0x1234abcd,
      sourceSize: 2097152,
      targetCrc32: 0x89abcdef,
      targetSize: 2099200,
    }),
  );
  expect(parsedPatch).not.toBeNull();
  expect(getPatchProbeRequirements(parsedPatch)).toEqual({
    format: "UPS",
    patchCrc32: "00000001",
    sourceCrc32: "1234abcd",
    sourceSize: 2097152,
    targetCrc32: "89abcdef",
    targetSize: 2099200,
  });
});

test("parsePatchForApply leaves requirements empty when the descriptor carries no embedded metadata", async () => {
  const patchFile = await createPatchFile(
    await loadFixtureFile("tests/fixtures/browser-generated/patch-matrix/raw/change.ips"),
    "change.ips",
  );
  const parsedPatch = await parsePatchForApply(
    patchFile,
    ingestRuntime({
      fileName: "change.ips",
      filenameChecksums: {},
      format: "unknown",
      leafPath: "change.ips",
      sizeBytes: 14,
    }),
  );
  expect(parsedPatch).not.toBeNull();
  expect(getPatchProbeRequirements(parsedPatch)).toBeUndefined();
});
