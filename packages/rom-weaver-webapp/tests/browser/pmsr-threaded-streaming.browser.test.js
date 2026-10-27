import { expect, it } from "vitest";
import {
  assertRunJsonSucceeded,
  joinGuestPath,
  readGuestFile,
  withTempFixture,
  writeGuestFile,
} from "../wasm/test-helpers.mjs";

const RECORD_COUNT = 16;
const RECORD_BYTES = 257;
const RECORD_STRIDE = 3072;

function patchFixture() {
  const source = new Uint8Array(64 * 1024).fill(0x5a);
  const expected = source.slice();
  const patch = new Uint8Array(8 + RECORD_COUNT * (8 + RECORD_BYTES));
  patch.set(new TextEncoder().encode("PMSR"));
  const view = new DataView(patch.buffer);
  view.setUint32(4, RECORD_COUNT);
  for (let index = 0; index < RECORD_COUNT; index += 1) {
    const offset = 113 + index * RECORD_STRIDE;
    const cursor = 8 + index * (8 + RECORD_BYTES);
    const data = new Uint8Array(RECORD_BYTES).fill(index + 1);
    view.setUint32(cursor, offset);
    view.setUint32(cursor + 4, data.byteLength);
    patch.set(data, cursor + 8);
    expected.set(data, offset);
  }
  return { expected, patch, source };
}

it.each([1, 2, 4])("keeps every streamed PMSR record with %i threads", async (threads) => {
  await withTempFixture(async ({ dir, init, opfsHandle, worker }) => {
    expect(init.threaded).toBe(true);
    const { source, patch, expected } = patchFixture();
    const sourcePath = joinGuestPath(dir, "source.bin");
    const patchPath = joinGuestPath(dir, "records.mod");
    const outputPath = joinGuestPath(dir, "applied.bin");
    await writeGuestFile(opfsHandle, sourcePath, source);
    await writeGuestFile(opfsHandle, patchPath, patch);
    const terminal = assertRunJsonSucceeded(
      await worker.runJson(
        [
          "patch",
          "apply",
          "--input",
          sourcePath,
          "--patch",
          patchPath,
          "--output",
          outputPath,
          "--threads",
          String(threads),
          "--patch-header",
          "keep",
          "--n64-byte-order",
          "keep",
          "--ignore-checksum-validation",
          "--no-compress",
        ],
        { env: { ROM_WEAVER_PATCH_IN_MEMORY_LIMIT: "0" } },
      ),
      { command: "patch-apply" },
    );
    expect(terminal.effective_threads).toBe(threads);
    expect(terminal.used_parallelism).toBe(threads > 1);
    const actual = await readGuestFile(opfsHandle, outputPath);
    expect(actual.byteLength).toBe(expected.byteLength);
    const missing = [];
    for (let index = 0; index < RECORD_COUNT; index += 1) {
      const offset = 113 + index * RECORD_STRIDE;
      if (actual.slice(offset, offset + RECORD_BYTES).some((byte) => byte !== index + 1)) missing.push(index);
    }
    expect(missing, `missing records with ${threads} threads`).toEqual([]);
    expect(actual).toEqual(expected);
  });
});
