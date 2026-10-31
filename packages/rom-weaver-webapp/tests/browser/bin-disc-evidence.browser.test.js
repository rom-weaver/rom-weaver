import { expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { resetRomWeaverRunner, warmupRomWeaverRunner } from "../../src/workers/rom-weaver/rom-weaver-runner.ts";
import { getCompressFormats, validateCompressInputs } from "../../src/webapp/compress-service.ts";

// A `.bin` is a CD image only on header evidence; a sector-aligned size alone (a cartridge dump) is not.
const cartridgeBin = () => new File([new Uint8Array(524_288).fill(0x5a)], "cart.bin");
const rawCdBin = () => {
  const bytes = new Uint8Array(2352 * 20).fill(0x11);
  bytes.set([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x02, 0x00, 0x01]);
  return new File([bytes], "disc.bin");
};
const isoBin = () => {
  const bytes = new Uint8Array(2048 * 20).fill(0x22);
  bytes.set([0x01, ...new TextEncoder().encode("CD001"), 0x01], 16 * 2048);
  return new File([bytes], "disc2048.bin");
};

const formatsOf = async (files, load) => getCompressFormats(await validateCompressInputs(files, load));

test("WASM probe offers CHD for CD-evidence .bin files and not for a cartridge .bin", async () => {
  await resetRomWeaverRunner();
  try {
    await warmupRomWeaverRunner();
    const load = async () => browserRuntime;
    expect(await formatsOf([cartridgeBin()], load)).toEqual(["zip", "7z"]);
    expect(await formatsOf([rawCdBin()], load)).toContain("chd");
    expect(await formatsOf([isoBin()], load)).toContain("chd");
    const probe = browserRuntime.compression.probe;
    expect((await probe({ source: rawCdBin(), options: { threads: 1 } })).discFormat).toBe("CD");
    expect((await probe({ source: isoBin(), options: { threads: 1 } })).discFormat).toBe("CD");
  } finally {
    await resetRomWeaverRunner();
  }
});
