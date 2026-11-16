// An overwrite extract MUST leave only the extracted files in the output directory: the private staging
// tree that holds backups of the replaced outputs is removed once the extract commits.

import { describe, expect, it } from "vitest";
import { buildStoredZip } from "./stored-zip-fixture.mjs";
import {
  assertRunJsonSucceeded,
  joinGuestPath,
  readGuestFile,
  withTempFixture,
  writeGuestFile,
} from "./test-helpers.mjs";

const ENTRY_COUNT = 8;
const ENTRY_SIZE = 512;
// One replaced output is shorter than its new entry and one is longer: the longer one MUST NOT keep its tail.
const REPLACED_OUTPUT_SIZES = new Map([
  [3, 3],
  [5, ENTRY_SIZE + 88],
]);

const entryName = (index) => `entry-${String(index).padStart(5, "0")}.bin`;

const listDirectoryNames = async (directory, prefix = "") => {
  const names = [];
  for await (const [name, handle] of directory.entries()) {
    names.push(`${prefix}${name}`);
    if (handle.kind === "directory") names.push(...(await listDirectoryNames(handle, `${prefix}${name}/`)));
  }
  return names;
};

describe("overwrite archive extract", () => {
  it("replaces existing outputs without leaving a staging directory behind", async () => {
    await withTempFixture(
      async ({ worker, opfsHandle, dir }) => {
        const archivePath = joinGuestPath(dir, "overwrite.zip");
        const outDir = joinGuestPath(dir, "out");
        await writeGuestFile(opfsHandle, archivePath, buildStoredZip(ENTRY_COUNT, ENTRY_SIZE));
        for (const [index, size] of REPLACED_OUTPUT_SIZES) {
          await writeGuestFile(opfsHandle, joinGuestPath(outDir, entryName(index)), new Uint8Array(size).fill(0x4f));
        }

        const result = await worker.runJson(["extract", "--input", archivePath, "--out-dir", outDir]);
        assertRunJsonSucceeded(result, { command: "extract" });

        for (let index = 0; index < ENTRY_COUNT; index += 1) {
          const bytes = await readGuestFile(opfsHandle, joinGuestPath(outDir, entryName(index)));
          expect(bytes.byteLength).toBe(ENTRY_SIZE);
          expect(bytes[ENTRY_SIZE - 1]).toBe((ENTRY_SIZE - 1) & 0xff);
        }
        const outHandle = await opfsHandle.getDirectoryHandle("out", { create: false });
        const names = await listDirectoryNames(outHandle);
        expect(names.filter((name) => name.includes(".rom-weaver-extract-"))).toEqual([]);
        expect(names.sort()).toEqual(Array.from({ length: ENTRY_COUNT }, (_, index) => entryName(index)));
      },
      { prefix: "rom-weaver-extract-overwrite-" },
    );
  });

  it("replaces the outputs of an earlier run in the same worker", async () => {
    await withTempFixture(
      async ({ worker, opfsHandle, dir }) => {
        const outDir = joinGuestPath(dir, "out");
        // The last two runs extract equal archives into the directory the previous run filled.
        const sizes = [ENTRY_SIZE, ENTRY_SIZE / 2, ENTRY_SIZE / 2];
        for (const [run, size] of sizes.entries()) {
          const archivePath = joinGuestPath(dir, `repeat-${run}.zip`);
          await writeGuestFile(opfsHandle, archivePath, buildStoredZip(ENTRY_COUNT, size));

          const result = await worker.runJson(["extract", "--input", archivePath, "--out-dir", outDir]);
          assertRunJsonSucceeded(result, { command: "extract" });

          for (let index = 0; index < ENTRY_COUNT; index += 1) {
            const bytes = await readGuestFile(opfsHandle, joinGuestPath(outDir, entryName(index)));
            expect(bytes.byteLength).toBe(size);
          }
        }
        const outHandle = await opfsHandle.getDirectoryHandle("out", { create: false });
        const names = await listDirectoryNames(outHandle);
        expect(names.sort()).toEqual(Array.from({ length: ENTRY_COUNT }, (_, index) => entryName(index)));
      },
      { prefix: "rom-weaver-extract-repeat-" },
    );
  });
});
