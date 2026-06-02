import { expect, test } from "vitest";
import { getPatchInspectRequirements, parsePatchForApply } from "../../src/lib/apply/patch-apply-service.ts";
import { createPatchFile } from "../../src/lib/input/binary-service.ts";

const loadFixtureFile = async (filePath, type = "application/octet-stream") => {
  const response = await fetch(`/${filePath}`);
  if (!response.ok) throw new Error(`Failed to load fixture ${filePath}`);
  const bytes = await response.arrayBuffer();
  const fileName = filePath.split("/").at(-1) || "patch.bin";
  return new File([bytes], fileName, { type });
};

test("parsePatchForApply normalizes inspect requirements for BPS patches", async () => {
  const patchFile = await createPatchFile(
    await loadFixtureFile("tests/fixtures/browser-generated/patch-matrix/raw/change.bps"),
    "change.bps",
  );
  const parsedPatch = await parsePatchForApply(patchFile, {
    patch: {
      inspectPatch: async () => ({
        format: "bps",
        patch_crc32: 1,
        record_count: 42,
        source_crc32: 0x1234abcd,
        source_size: 4194304,
        target_crc32: 0xabcd1234,
        target_size: 4198400,
      }),
    },
  });
  expect(parsedPatch).not.toBeNull();
  expect(getPatchInspectRequirements(parsedPatch)).toEqual({
    format: "BPS",
    patchCrc32: "00000001",
    recordCount: 42,
    sourceCrc32: "1234abcd",
    sourceSize: 4194304,
    targetCrc32: "abcd1234",
    targetSize: 4198400,
  });
});

test("parsePatchForApply normalizes VCDIFF source requirements without Adler values", async () => {
  const patchFile = await createPatchFile(
    await loadFixtureFile("tests/fixtures/browser-generated/patch-matrix/raw/change.xdelta"),
    "change.xdelta",
  );
  const parsedPatch = await parsePatchForApply(patchFile, {
    patch: {
      inspectPatch: async () => ({
        format: "xdelta",
        minimum_source_size: 1048576,
        patch_crc32: null,
        record_count: 3,
        source_crc32: null,
        source_size: null,
        source_window_count: 3,
        target_crc32: null,
        target_size: 1048600,
        target_window_count: 0,
        window_adler32_checksums: ["12345678", "89abcdef", "00112233"],
        window_checksum_count: 3,
      }),
    },
  });
  expect(parsedPatch).not.toBeNull();
  expect(getPatchInspectRequirements(parsedPatch)).toEqual({
    format: "XDELTA",
    minimumSourceSize: 1048576,
    recordCount: 3,
    targetSize: 1048600,
  });
});

test("parsePatchForApply normalizes decimal and hex inspect checksum variants", async () => {
  const patchFile = await createPatchFile(
    await loadFixtureFile("tests/fixtures/browser-generated/patch-matrix/raw/change.ups"),
    "change.ups",
  );
  const parsedPatch = await parsePatchForApply(patchFile, {
    patch: {
      inspectPatch: async () => ({
        format: "ups",
        patch_crc32: "0x1",
        source_crc32: "305441741",
        source_size: "2097152",
        target_crc32: "0x89abcdef",
        target_size: "2099200",
      }),
    },
  });
  expect(parsedPatch).not.toBeNull();
  expect(getPatchInspectRequirements(parsedPatch)).toEqual({
    format: "UPS",
    patchCrc32: "00000001",
    sourceCrc32: "1234abcd",
    sourceSize: 2097152,
    targetCrc32: "89abcdef",
    targetSize: 2099200,
  });
});

test("parsePatchForApply leaves requirements empty when inspect details are unavailable", async () => {
  const patchFile = await createPatchFile(
    await loadFixtureFile("tests/fixtures/browser-generated/patch-matrix/raw/change.ips"),
    "change.ips",
  );
  const parsedPatch = await parsePatchForApply(patchFile, {
    patch: {
      inspectPatch: async () => ({
        format: null,
        patch_crc32: null,
        record_count: null,
        source_crc32: null,
        source_size: null,
        target_crc32: null,
        target_size: null,
      }),
    },
  });
  expect(parsedPatch).not.toBeNull();
  expect(getPatchInspectRequirements(parsedPatch)).toBeUndefined();
});
