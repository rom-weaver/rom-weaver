import { expect, test } from "vitest";
import { ApplyWorkflow } from "../../src/platform/browser/browser-api.ts";
import { DCP_DISC_REQUIRED_MESSAGE, DCP_PATCH_ALONE_MESSAGE } from "../../src/lib/workflow/apply-dcp-patch.ts";
import { loadFixtureFile, RAW_PATCH, RAW_ROM, readStoredZipEntries } from "./patcher-test-shared.js";

// Fixtures and the CLI results they must match come from scripts/generate-dcp-fixtures.mjs.
const FIXTURES = "tests/fixtures/dcp";
const TRACKS = ["track01.bin", "track02.bin", "track03.bin"];

const loadExpected = async () => {
  const response = await fetch(`/${FIXTURES}/expected.json`);
  if (!response.ok) throw new Error("Failed to load the DCP expectations");
  return response.json();
};

const sha1 = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-1", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const discFiles = async (sheet) =>
  Promise.all([`disc.${sheet}`, ...TRACKS].map((name) => loadFixtureFile(`${FIXTURES}/${name}`)));

const applyDcp = async (input, compression) => {
  const workflow = new ApplyWorkflow({
    settings: { output: { compression, outputName: "patched" }, workers: { threads: 1 } },
  });
  try {
    await workflow.setInput(input);
    await workflow.addPatch(await loadFixtureFile(`${FIXTURES}/game.dcp`));
    const result = await workflow.run();
    try {
      expect(result.outputs).toHaveLength(1);
      const blob = await result.output.getBlob?.();
      return new Uint8Array(await blob.arrayBuffer());
    } finally {
      await Promise.all(result.outputs.map((output) => output.dispose?.().catch(() => undefined)));
    }
  } finally {
    await workflow.dispose();
  }
};

// Uncompressed disc output is a stored ZIP of the sheet and its tracks.
const expectCliTracks = async (bytes, expectedTracks) => {
  const tracks = readStoredZipEntries(bytes).filter((entry) => /\.bin$/i.test(entry.fileName));
  const actual = await Promise.all(tracks.map((entry) => sha1(entry.bytes)));
  const byText = (a, b) => a.localeCompare(b);
  expect(actual.sort(byText)).toEqual(Object.values(expectedTracks).sort(byText));
};

for (const sheet of ["gdi", "cue"]) {
  test(`a DCP applied to a ${sheet.toUpperCase()} disc matches the CLI's tracks and CHD`, async () => {
    const expected = (await loadExpected())[sheet];
    await expectCliTracks(await applyDcp(await discFiles(sheet), "none"), expected.tracks);
    expect(await sha1(await applyDcp(await discFiles(sheet), "chd"))).toBe(expected.chd);
  });
}

test("a DCP applied to a GD-ROM CHD matches the CLI's output for the same disc", async () => {
  const expected = (await loadExpected()).gdi;
  const chd = await loadFixtureFile(`${FIXTURES}/disc.chd`);
  expect(await sha1(await applyDcp(chd, "chd"))).toBe(expected.chd);
  await expectCliTracks(await applyDcp(await loadFixtureFile(`${FIXTURES}/disc.chd`), "none"), expected.tracks);
});

test("a DCP applied to a zipped GDI disc matches the CLI's tracks", async () => {
  const expected = (await loadExpected()).gdi;
  await expectCliTracks(await applyDcp(await loadFixtureFile(`${FIXTURES}/disc.zip`), "none"), expected.tracks);
});

const stageDcpWith = async (input, extraPatches = []) => {
  const workflow = new ApplyWorkflow({ settings: { workers: { threads: 1 } } });
  await workflow.setInput(input);
  await workflow.addPatch(await loadFixtureFile(`${FIXTURES}/game.dcp`));
  for (const patch of extraPatches) await workflow.addPatch(patch);
  await workflow.validatePatches();
  return workflow;
};

const getDcpPatch = (workflow) => workflow.getPatches().find((patch) => patch.dcp);

test("a DCP combined with another patch is rejected on its card and at apply", async () => {
  const workflow = await stageDcpWith(await discFiles("gdi"), [await loadFixtureFile(RAW_PATCH)]);
  try {
    const dcp = getDcpPatch(workflow);
    expect(dcp?.patchValidation).toMatchObject({ message: DCP_PATCH_ALONE_MESSAGE, status: "invalid" });
    // Give the byte patch a track so its own missing-target fault cannot mask the DCP guard.
    await workflow.setPatchTarget(1, "track03.bin");
    await expect(workflow.run()).rejects.toThrow(DCP_PATCH_ALONE_MESSAGE);
  } finally {
    await workflow.dispose();
  }
});

test("a DCP with ROM cheats is rejected on its card", async () => {
  const workflow = await stageDcpWith(await discFiles("gdi"));
  try {
    expect(getDcpPatch(workflow)?.patchValidation).toBeUndefined();
    expect(getDcpPatch(workflow)?.targetInputFileName).toBe("disc.gdi");
    workflow.setCheats([
      {
        description: "Infinite lives",
        gameId: "fixture",
        id: "cheat-1",
        rawCode: "00000000 00000000",
        rawFields: {},
        sourceFile: "fixture.cht",
        sourceIndex: 0,
        sourceRevision: "1",
        system: "dreamcast",
      },
    ]);
    expect(getDcpPatch(workflow)?.patchValidation?.message).toBe(DCP_PATCH_ALONE_MESSAGE);
  } finally {
    await workflow.dispose();
  }
});

test("a DCP beside a ROM that is not a disc asks for a GD-ROM disc", async () => {
  const workflow = await stageDcpWith(await loadFixtureFile(RAW_ROM));
  try {
    expect(getDcpPatch(workflow)?.patchValidation).toMatchObject({
      message: DCP_DISC_REQUIRED_MESSAGE,
      status: "invalid",
    });
  } finally {
    await workflow.dispose();
  }
});
