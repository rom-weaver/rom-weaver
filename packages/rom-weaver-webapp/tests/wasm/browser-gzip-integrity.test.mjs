import { expect, it } from "vitest";
import {
  assertRunJsonSucceeded,
  joinGuestPath,
  readGuestFile,
  withTempFixture,
  writeGuestFile,
} from "./test-helpers.mjs";

it("rejects damaged gzip trailers and extracts a corrected input on the same worker", async () => {
  const expected = Uint8Array.from({ length: 131_073 }, (_, index) => (index * 31 + 17) % 251);
  const compressed = new Uint8Array(
    await new Response(new Blob([expected]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
  );
  const wrongCrc = compressed.slice();
  wrongCrc[wrongCrc.length - 8] ^= 1;
  const wrongSize = compressed.slice();
  wrongSize[wrongSize.length - 4] ^= 1;

  await withTempFixture(async ({ dir, opfsHandle, worker }) => {
    for (const { label, bytes } of [
      { label: "crc", bytes: wrongCrc },
      { label: "size", bytes: wrongSize },
      { label: "truncated", bytes: compressed.subarray(0, -1) },
    ]) {
      const input = joinGuestPath(dir, `${label}.bin.gz`);
      await writeGuestFile(opfsHandle, input, bytes);
      const failed = await worker.runJson(["extract", "--input", input, "--out-dir", joinGuestPath(dir, label)]);
      expect(failed.ok, `${label}: damaged gzip was accepted`).toBe(false);
      expect(failed.exitCode, `${label}: damaged gzip exited successfully`).not.toBe(0);
      expect(failed.events.at(-1)?.status).toBe("failed");
    }

    const input = joinGuestPath(dir, "payload.bin.gz");
    await writeGuestFile(opfsHandle, input, compressed);
    const output = joinGuestPath(dir, "recovered");
    const recovered = await worker.runJson(["extract", "--input", input, "--out-dir", output]);
    assertRunJsonSucceeded(recovered, { command: "extract" });
    expect(await readGuestFile(opfsHandle, joinGuestPath(output, "payload.bin"))).toEqual(expected);
  });
});
