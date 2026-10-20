import { describe, expect, it } from "vitest";
import { buildPbp, buildPbpDiscBytes } from "./pbp-fixture.mjs";
import {
  assertRunJsonSucceeded,
  joinGuestPath,
  readGuestFile,
  withTempFixture,
  writeGuestFile,
} from "./test-helpers.mjs";

// Multi-disc PS1 PBP through the real wasm app. Fixtures are synthetic (see pbp-fixture.mjs).
// CHD holds one disc, so each CHD run converts one disc's cue; ZIP and 7z keep every disc's
// cue/bin pair in one archive.
//
// Each conversion runs in a fresh fixture whose inputs are written before its first command:
// compressing files written from JS between two runs in one fixture failed with ENOENT. The exact
// trigger is not narrowed down.
const DISCS = [
  { discId: "SLUS00001", iso: buildPbpDiscBytes(72, 7) },
  { discId: "SLUS00002", iso: buildPbpDiscBytes(80, 23) },
];
const stemFor = (index) => `multi.disc${String(index + 1).padStart(2, "0")}`;
const sameBytes = (actual, expected) =>
  actual.length === expected.length && actual.every((byte, i) => byte === expected[i]);

async function extractDiscFiles() {
  const files = new Map();
  await withTempFixture(async ({ dir, opfsHandle, worker }) => {
    const pbpPath = joinGuestPath(dir, "multi.pbp");
    const outDir = joinGuestPath(dir, "pbp-out");
    await writeGuestFile(opfsHandle, pbpPath, buildPbp(DISCS));
    assertRunJsonSucceeded(
      await worker.runJson(["extract", "--input", pbpPath, "--out-dir", outDir, "--threads", "1"]),
      {
        command: "extract",
      },
    );
    for (const [index] of DISCS.entries()) {
      for (const ext of ["cue", "bin"]) {
        const name = `${stemFor(index)}.${ext}`;
        files.set(name, await readGuestFile(opfsHandle, joinGuestPath(outDir, name)));
      }
    }
  });
  return files;
}

async function convertAndExtract(files, names, outputName) {
  let outputs;
  await withTempFixture(async ({ dir, opfsHandle, worker }) => {
    for (const name of names) await writeGuestFile(opfsHandle, joinGuestPath(dir, "src", name), files.get(name));
    const archive = joinGuestPath(dir, outputName);
    const compressInputs = outputName.endsWith(".chd") ? names.filter((name) => name.endsWith(".cue")) : names;
    assertRunJsonSucceeded(
      await worker.runJson([
        "compress",
        ...compressInputs.flatMap((name) => ["--input", joinGuestPath(dir, "src", name)]),
        "--output",
        archive,
        "--threads",
        "1",
      ]),
      { command: "compress" },
    );
    const back = joinGuestPath(dir, "back");
    assertRunJsonSucceeded(await worker.runJson(["extract", "--input", archive, "--out-dir", back, "--threads", "1"]), {
      command: "extract",
    });
    outputs = new Map();
    for (const name of names.filter((entry) => entry.endsWith(".bin"))) {
      outputs.set(name, await readGuestFile(opfsHandle, joinGuestPath(back, name)));
    }
  });
  return outputs;
}

describe("PBP in the browser wasm runtime", () => {
  it("extracts every disc of a multi-disc PBP byte for byte", async () => {
    const files = await extractDiscFiles();
    for (const [index, { iso }] of DISCS.entries()) {
      expect(sameBytes(files.get(`${stemFor(index)}.bin`), iso), `disc ${index + 1} bytes`).toBe(true);
      const cue = new TextDecoder().decode(files.get(`${stemFor(index)}.cue`));
      expect(cue).toContain(`FILE "${stemFor(index)}.bin" BINARY`);
    }
  });

  it("converts each disc to its own CHD that round-trips", async () => {
    const files = await extractDiscFiles();
    for (const [index, { iso }] of DISCS.entries()) {
      const names = [`${stemFor(index)}.cue`, `${stemFor(index)}.bin`];
      const outputs = await convertAndExtract(files, names, `${stemFor(index)}.chd`);
      expect(sameBytes(outputs.get(`${stemFor(index)}.bin`), iso), `chd disc ${index + 1}`).toBe(true);
    }
  });

  it.each(["zip", "7z"])("converts both discs into one %s archive", async (format) => {
    const files = await extractDiscFiles();
    const names = DISCS.flatMap((_disc, index) => ["cue", "bin"].map((ext) => `${stemFor(index)}.${ext}`));
    const outputs = await convertAndExtract(files, names, `multi.${format}`);
    for (const [index, { iso }] of DISCS.entries()) {
      expect(sameBytes(outputs.get(`${stemFor(index)}.bin`), iso), `${format} disc ${index + 1}`).toBe(true);
    }
  });
});
