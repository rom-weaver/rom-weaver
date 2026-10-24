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

it.each(["plain", "nested", "uuencoded", "triple"])(
  "validates every gzip trailer in %s TAR filters and recovers on the same worker",
  async (filter) => {
    const expected = new TextEncoder().encode("abc");
    const tar = new Uint8Array(131_072);
    const field = (offset, value) => tar.set(new TextEncoder().encode(value), offset);
    field(0, "payload.bin");
    field(100, "0000644\0");
    field(108, "0000000\0");
    field(116, "0000000\0");
    field(124, "00000000003\0");
    field(136, "00000000000\0");
    tar.fill(32, 148, 156);
    field(156, "0");
    field(257, "ustar\0");
    field(263, "00");
    const checksum = tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
    field(148, `${checksum.toString(8).padStart(6, "0")}\0 `);
    tar.set(expected, 512);
    const compress = async (bytes) =>
      new Uint8Array(
        await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
      );
    const wrap = async (bytes, uuTerminator = "end") => {
      if (filter === "plain") return compress(bytes);
      let inner;
      if (filter === "uuencoded") {
        let encoded = "begin 644 payload.tar\n";
        for (let offset = 0; offset < bytes.length; offset += 45) {
          const line = bytes.subarray(offset, offset + 45);
          encoded += String.fromCharCode(line.length + 32);
          for (let index = 0; index < line.length; index += 3) {
            const a = line[index];
            const b = line[index + 1] ?? 0;
            const c = line[index + 2] ?? 0;
            encoded += String.fromCharCode(
              (a >> 2) + 32,
              (((a << 4) | (b >> 4)) & 63) + 32,
              (((b << 2) | (c >> 6)) & 63) + 32,
              (c & 63) + 32,
            );
          }
          encoded += "\n";
        }
        inner = new TextEncoder().encode(`${encoded}\u0060\n${uuTerminator}\n`);
      } else {
        inner = await compress(bytes);
      }
      const pad = (value) => {
        const padded = new Uint8Array(value.length + 131_072);
        padded.set(value);
        return padded;
      };
      if (filter === "triple") inner = await compress(pad(inner));
      return compress(pad(inner));
    };
    const valid = await wrap(tar);
    const invalidInner = filter === "uuencoded" ? [{ label: "inner-uu", bytes: await wrap(tar, "bad") }] : [];
    tar[514] ^= 1;
    const corrupted = await wrap(tar);
    corrupted.set(valid.subarray(-8), corrupted.length - 8);
    const wrongSize = valid.slice();
    wrongSize[wrongSize.length - 4] ^= 1;

    await withTempFixture(async ({ dir, opfsHandle, worker }) => {
      const output = joinGuestPath(dir, "extracted");
      for (const { label, bytes } of [
        { label: "payload", bytes: corrupted },
        { label: "size", bytes: wrongSize },
        { label: "truncated", bytes: valid.subarray(0, -1) },
        ...invalidInner,
      ]) {
        const input = joinGuestPath(dir, `${label}.tar.gz`);
        await writeGuestFile(opfsHandle, input, bytes);
        const failed = await worker.runJson(["extract", "--input", input, "--out-dir", output]);
        expect(failed.ok, "padded TAR bypassed gzip integrity validation").toBe(false);
        expect(failed.exitCode).not.toBe(0);
        await expect(readGuestFile(opfsHandle, joinGuestPath(output, "payload.bin"))).rejects.toThrow();
      }
      const input = joinGuestPath(dir, "valid.tar.gz");
      await writeGuestFile(opfsHandle, input, valid);
      const recovered = await worker.runJson(["extract", "--input", input, "--out-dir", output]);
      assertRunJsonSucceeded(recovered, { command: "extract" });
      expect(await readGuestFile(opfsHandle, joinGuestPath(output, "payload.bin"))).toEqual(expected);
    });
  },
);
