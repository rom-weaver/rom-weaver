// The proxy caches directory handles between opens.
// Removing an output directory outside the proxy MUST NOT break the next extract.
// The stale handle is dropped and the directory is made again.

import { describe, expect, it } from "vitest";
import { buildStoredZip } from "./stored-zip-fixture.mjs";
import {
  assertRunJsonSucceeded,
  joinGuestPath,
  readGuestFile,
  withTempFixture,
  writeGuestFile,
} from "./test-helpers.mjs";

const ENTRY_COUNT = 4;
const ENTRY_SIZE = 256;

const entryName = (index) => `entry-${String(index).padStart(5, "0")}.bin`;

describe("proxy directory cache", () => {
  it("extracts again after the output directory was removed outside the proxy", async () => {
    await withTempFixture(
      async ({ worker, opfsHandle, dir }) => {
        const archivePath = joinGuestPath(dir, "again.zip");
        const outDir = joinGuestPath(dir, "out");
        await writeGuestFile(opfsHandle, archivePath, buildStoredZip(ENTRY_COUNT, ENTRY_SIZE));

        assertRunJsonSucceeded(await worker.runJson(["extract", "--input", archivePath, "--out-dir", outDir]), {
          command: "extract",
        });
        await opfsHandle.removeEntry("out", { recursive: true });
        assertRunJsonSucceeded(await worker.runJson(["extract", "--input", archivePath, "--out-dir", outDir]), {
          command: "extract",
        });

        for (let index = 0; index < ENTRY_COUNT; index += 1) {
          const bytes = await readGuestFile(opfsHandle, joinGuestPath(outDir, entryName(index)));
          expect(bytes.byteLength).toBe(ENTRY_SIZE);
        }
      },
      { prefix: "rom-weaver-directory-cache-" },
    );
  });
});
