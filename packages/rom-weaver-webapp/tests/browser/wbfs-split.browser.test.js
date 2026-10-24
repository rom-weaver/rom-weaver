import { expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { resetRomWeaverRunner, warmupRomWeaverRunner } from "../../src/workers/rom-weaver/rom-weaver-runner.ts";

const BLOCK_SIZE = 0x200000;
const SECTOR_SIZE = 0x200;
// Wii double-layer sector count >> (block shift - 15), as the WBFS reader computes it.
const MAX_BLOCKS = (143432 * 2) >> (21 - 15);
const NKIT_HEADER_OFFSET = 0x10000;

const gamecubeIso = () => {
  const iso = new Uint8Array(0x20440);
  iso.set(new TextEncoder().encode("RWTEST"));
  iso.set([0xc2, 0x33, 0x9f, 0x3d], 0x1c);
  iso.set(new TextEncoder().encode("rom-weaver-test"), 0x20);
  for (let index = 0x440; index < iso.length; index++) iso[index] = (index - 0x440) % 251;
  return iso;
};

/**
 * Builds a single-disc WBFS with the layout nod writes: header, disc table, disc header copy,
 * and block map in block 0, an NKit v2 header recording the ISO size, then one 2 MiB data block.
 */
const wbfsFromIso = (iso) => {
  const wbfs = new Uint8Array(BLOCK_SIZE * 2);
  const view = new DataView(wbfs.buffer);
  wbfs.set(new TextEncoder().encode("WBFS"));
  view.setUint32(4, wbfs.length / SECTOR_SIZE);
  wbfs.set([9, 21, 1], 8);
  wbfs[12] = 1;
  wbfs.set(iso.subarray(0, 0x100), SECTOR_SIZE);
  view.setUint16(SECTOR_SIZE + 0x100, 1);
  expect(SECTOR_SIZE + 0x100 + MAX_BLOCKS * 2).toBeLessThan(NKIT_HEADER_OFFSET);
  wbfs.set(new TextEncoder().encode("NKIT  v2"), NKIT_HEADER_OFFSET);
  view.setUint16(NKIT_HEADER_OFFSET + 8, 20);
  view.setUint16(NKIT_HEADER_OFFSET + 10, 1);
  view.setBigUint64(NKIT_HEADER_OFFSET + 12, BigInt(iso.length));
  wbfs.set(iso, BLOCK_SIZE);
  return wbfs;
};

const splitParts = (wbfs, parts) => {
  const chunk = Math.ceil(wbfs.length / parts);
  return Array.from(
    { length: parts },
    (_, index) =>
      new File([wbfs.subarray(index * chunk, (index + 1) * chunk)], index === 0 ? "Disc.wbfs" : `Disc.wbf${index}`),
  );
};

const extractAll = async (source, companionFiles) => {
  const extract = browserRuntime.compression.extract;
  if (!extract) throw new Error("Runtime compression extract capability is unavailable");
  return extract({ companionFiles, entries: [], extractAll: true, options: { threads: 1 }, source });
};

test("WASM extracts a split WBFS set byte for byte and rejects a set with a missing part", async () => {
  await resetRomWeaverRunner();
  try {
    await warmupRomWeaverRunner();
    const iso = gamecubeIso();
    const [source, ...parts] = splitParts(wbfsFromIso(iso), 3);
    const probe = await browserRuntime.compression.probe?.({ companionFiles: parts, options: { threads: 1 }, source });
    expect(probe?.platform).toBe("Nintendo GameCube");
    expect(probe?.entries.map((entry) => entry.filename)).toEqual(["Disc.iso"]);
    const result = await extractAll(source, parts);
    try {
      expect(result.outputs.map((output) => output.fileName)).toEqual(["Disc.iso"]);
      const blob = await browserRuntime.publicOutput.getBlob(result.outputs[0]);
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(iso);
    } finally {
      await Promise.all(result.outputs.map((output) => output.dispose()));
    }
    await expect(extractAll(source, parts.slice(0, 1))).rejects.toThrow(
      /Invalid WBFS file size.*\[wbfs\.size_mismatch\] \(actual=\d+, expected=\d+\)/i,
    );
  } finally {
    await resetRomWeaverRunner();
  }
});

test("WASM compresses a WBFS to RVZ that extracts to the original disc image", async () => {
  await resetRomWeaverRunner();
  const outputs = [];
  try {
    await warmupRomWeaverRunner();
    const iso = gamecubeIso();
    const { create, extract } = browserRuntime.compression;
    if (!(create && extract)) throw new Error("Runtime compression capabilities are unavailable");
    const rvz = await create({
      fileName: "Disc.wbfs",
      format: "rvz",
      options: { threads: 1 },
      outputName: "Disc.rvz",
      source: new File([wbfsFromIso(iso)], "Disc.wbfs"),
    });
    outputs.push(rvz.output);
    const extracted = await extract({
      entries: [],
      extractAll: true,
      format: "rvz",
      options: { threads: 1 },
      source: rvz.output,
    });
    outputs.push(...extracted.outputs);
    const blob = await browserRuntime.publicOutput.getBlob(extracted.outputs[0]);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(iso);
  } finally {
    await Promise.all(outputs.map((output) => output.dispose()));
    await resetRomWeaverRunner();
  }
});
