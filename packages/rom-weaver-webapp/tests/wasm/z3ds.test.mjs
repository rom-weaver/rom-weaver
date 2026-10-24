import { expect, it } from "vitest";
import {
  assertRunJsonSucceeded,
  joinGuestPath,
  readGuestFile,
  withTempFixture,
  writeGuestFile,
} from "./test-helpers.mjs";

it.each(["NCSD", "NCCH", "NONE"])("Z3DS preserves a 3DSX containing %s in rodata", async (magic) => {
  await withTempFixture(async ({ dir, worker, opfsHandle }) => {
    const payload = new Uint8Array(588);
    const view = new DataView(payload.buffer);
    payload.set(new TextEncoder().encode("3DSX"));
    view.setUint16(4, 44, true);
    view.setUint16(6, 8, true);
    view.setUint32(16, 4, true);
    view.setUint32(20, 512, true);
    view.setUint32(24, 4, true);
    payload.set(new TextEncoder().encode(magic), 0x100);
    const source = joinGuestPath(dir, "source.3dsx");
    const archive = joinGuestPath(dir, "generic.z3ds");
    const output = joinGuestPath(dir, "extracted");
    await writeGuestFile(opfsHandle, source, payload);
    assertRunJsonSucceeded(
      await worker.runJson(["compress", "--input", source, "--format", "z3ds", "--output", archive]),
      { command: "compress" },
    );
    const compressed = await readGuestFile(opfsHandle, archive);
    expect(new TextDecoder().decode(compressed.subarray(4, 8))).toBe("3DSX");
    assertRunJsonSucceeded(await worker.runJson(["extract", "--input", archive, "--out-dir", output]), {
      command: "extract",
    });
    expect(await readGuestFile(opfsHandle, joinGuestPath(output, "generic.3dsx"))).toEqual(payload);
  });
});
