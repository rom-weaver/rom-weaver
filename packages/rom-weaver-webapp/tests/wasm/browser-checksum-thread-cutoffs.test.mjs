import { expect, it } from "vitest";
import {
  assertRunJsonSucceeded,
  getGuestFileSize,
  joinGuestPath,
  withTempFixture,
  writeGuestFile,
} from "./test-helpers.mjs";

const MIB = 1024 * 1024;
// The wasm values of STREAMING_PARALLEL_THRESHOLD (whole-file hashing) and FANOUT_PARALLEL_THRESHOLD
// (range hashing) in crates/rom-weaver-checksum/src/core.rs; this test MUST change with them.
const WHOLE_FILE_CUTOFF = 3 * MIB;
const RANGE_CUTOFF = 24 * MIB;
// The default algorithm set runs one worker per algorithm when hashing is threaded.
const DEFAULT_ALGORITHMS = ["crc32", "md5", "sha1"];
const INLINE = { effective_threads: 1, used_parallelism: false };
const THREADED = { effective_threads: DEFAULT_ALGORITHMS.length, used_parallelism: true };

// Fixtures are one exact-size write: Playwright's Linux WebKit writes a subarray's whole backing
// buffer, which turns the chunked pattern helpers' cut-off-minus-one file into a cut-off file.
async function writeFixture(opfsHandle, path, bytes) {
  await writeGuestFile(opfsHandle, path, new Uint8Array(bytes));
  expect(await getGuestFileSize(opfsHandle, path)).toBe(bytes);
}

async function checksumThreadPlan(worker, args, label) {
  const terminal = assertRunJsonSucceeded(
    await worker.runJson(["checksum", "--threads", "4", "--no-extract", ...args]),
    { command: "checksum" },
  );
  expect(Object.keys(terminal.details.checksums).sort(), label).toEqual(DEFAULT_ALGORITHMS);
  return { effective_threads: terminal.effective_threads, used_parallelism: terminal.used_parallelism };
}

it("whole-file checksum hashes inline below the cut-off and threads from it", async () => {
  await withTempFixture(async ({ dir, init, opfsHandle, worker }) => {
    expect(init.threaded).toBe(true);
    for (const { bytes, plan } of [
      { bytes: WHOLE_FILE_CUTOFF - 1, plan: INLINE },
      { bytes: WHOLE_FILE_CUTOFF, plan: THREADED },
    ]) {
      const input = joinGuestPath(dir, `whole-${bytes}.bin`);
      await writeFixture(opfsHandle, input, bytes);
      const label = `whole file of ${bytes} bytes`;
      expect(await checksumThreadPlan(worker, ["--input", input], label), label).toEqual(plan);
    }
  });
});

it("range checksum hashes sequentially below the fan-out cut-off and fans out from it", async () => {
  await withTempFixture(async ({ dir, init, opfsHandle, worker }) => {
    expect(init.threaded).toBe(true);
    const input = joinGuestPath(dir, "range.bin");
    await writeFixture(opfsHandle, input, RANGE_CUTOFF);
    for (const { bytes, plan } of [
      { bytes: RANGE_CUTOFF - 1, plan: INLINE },
      { bytes: RANGE_CUTOFF, plan: THREADED },
    ]) {
      const label = `range of ${bytes} bytes`;
      const args = ["--start", "0", "--length", String(bytes), "--input", input];
      expect(await checksumThreadPlan(worker, args, label), label).toEqual(plan);
    }
  });
});
