// libarchive's 7z writer spools compressed data into an unlinked temp file (`libarchive_XXXXXX`).
// The OPFS backing entry for that temp file MUST be gone once the run ends.

import { expect, it } from "vitest";
import { assertRunJsonSucceeded, joinGuestPath, withTempFixture, writeGuestFile } from "./test-helpers.mjs";

async function leakedTempNames(rootHandle) {
  const names = [];
  for await (const [name] of rootHandle.entries()) {
    if (name.startsWith("libarchive_")) names.push(name);
  }
  return names;
}

it("7z compress removes its libarchive temp file from OPFS", { timeout: 120000 }, async () => {
  await withTempFixture(async ({ dir, opfsHandle, worker }) => {
    const input = joinGuestPath(dir, "payload.bin");
    const bytes = new Uint8Array(256 * 1024);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31) & 0xff;
    await writeGuestFile(opfsHandle, input, bytes);
    assertRunJsonSucceeded(
      await worker.runJson([
        "compress",
        "--input",
        input,
        "--format",
        "7z",
        "--output",
        joinGuestPath(dir, "out.7z"),
        "--threads",
        "1",
      ]),
      { command: "compress" },
    );
    expect(await leakedTempNames(opfsHandle)).toEqual([]);
  });
});
