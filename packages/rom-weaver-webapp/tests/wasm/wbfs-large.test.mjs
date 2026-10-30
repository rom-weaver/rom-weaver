import { describe, expect, it } from "vitest";
import { assertRunJsonSucceeded, joinGuestPath, withTempFixture } from "./test-helpers.mjs";

/* Opt-in (ROM_WEAVER_WASM_STRESS_WBFS_4GB=1, `npm run test:browser:wasm:stress:wbfs-4gb`): a
   multi-GiB OPFS workload is not CI-friendly. The WBFS is a sparse, dual-layer-sized image: only
   three 2 MiB blocks hold data, placed either side of the 4 GiB logical offset and at the far end
   of an 8+ GiB physical file. The extracted ISO is checked block by block, never held whole. */
const RUN_WBFS_4GB =
  typeof __ROM_WEAVER_WASM_STRESS_WBFS_4GB__ !== "undefined" && __ROM_WEAVER_WASM_STRESS_WBFS_4GB__ === true;

const SECTOR_SIZE = 0x200;
const BLOCK_SIZE = 0x200000;
const PHYSICAL_BLOCKS = 4100;
const NKIT_HEADER_OFFSET = 0x10000;
// Logical block -> physical block. 2047 ends just below 4 GiB and 2048 starts at it.
const MAPPED = [
  [0, 1],
  [2047, 2],
  [2048, PHYSICAL_BLOCKS - 1],
];
const ISO_BLOCKS = 2049;
const ISO_SIZE = ISO_BLOCKS * BLOCK_SIZE;

const dataBlock = (logical) => {
  const block = new Uint8Array(BLOCK_SIZE);
  for (let index = 0; index < BLOCK_SIZE; index++) block[index] = (index * 7 + logical * 31) % 251;
  if (logical === 0) {
    // A Wii reader parses partition tables and region data in the first 0x50000 bytes: keep them zero.
    block.fill(0, 0, 0x100000);
    block.set(new TextEncoder().encode("RWTEST"));
    block.set([0x5d, 0x1c, 0x9e, 0xa3], 0x18); // Wii magic
    block.set(new TextEncoder().encode("rom-weaver-large"), 0x20);
  }
  return block;
};

const wbfsHead = (firstBlock) => {
  const head = new Uint8Array(BLOCK_SIZE);
  const view = new DataView(head.buffer);
  head.set(new TextEncoder().encode("WBFS"));
  view.setUint32(4, (PHYSICAL_BLOCKS * BLOCK_SIZE) / SECTOR_SIZE);
  head.set([9, 21, 1], 8);
  head[12] = 1;
  head.set(firstBlock.subarray(0, 0x100), SECTOR_SIZE);
  for (const [logical, physical] of MAPPED) view.setUint16(SECTOR_SIZE + 0x100 + logical * 2, physical);
  head.set(new TextEncoder().encode("NKIT  v2"), NKIT_HEADER_OFFSET);
  view.setUint16(NKIT_HEADER_OFFSET + 8, 20);
  view.setUint16(NKIT_HEADER_OFFSET + 10, 1);
  view.setBigUint64(NKIT_HEADER_OFFSET + 12, BigInt(ISO_SIZE));
  return head;
};

const writeSparseWbfs = async (rootHandle, name) => {
  const handle = await rootHandle.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write({ data: wbfsHead(dataBlock(0)), position: 0, type: "write" });
  for (const [logical, physical] of MAPPED) {
    await writable.write({ data: dataBlock(logical), position: physical * BLOCK_SIZE, type: "write" });
  }
  await writable.truncate(PHYSICAL_BLOCKS * BLOCK_SIZE);
  await writable.close();
};

/** Compares the extracted ISO to the expected pattern one 2 MiB block at a time. */
const verifyIso = async (file) => {
  expect(file.size).toBe(ISO_SIZE);
  const mapped = new Map(MAPPED.map(([logical]) => [logical, dataBlock(logical)]));
  for (let logical = 0; logical < ISO_BLOCKS; logical++) {
    const actual = new Uint8Array(await file.slice(logical * BLOCK_SIZE, (logical + 1) * BLOCK_SIZE).arrayBuffer());
    const expected = mapped.get(logical);
    if (expected) {
      expect(
        actual.every((byte, index) => byte === expected[index]),
        `block ${logical} differs`,
      ).toBe(true);
    } else if (actual.some((byte) => byte !== 0)) {
      throw new Error(`block ${logical} should be zero-filled`);
    }
  }
};

describe("rom-weaver-wasm >4 GiB WBFS", () => {
  it.runIf(RUN_WBFS_4GB)(
    "extracts a dual-layer-sized WBFS to a byte-exact ISO larger than 4 GiB",
    async () => {
      await withTempFixture(async ({ dir, opfsHandle, worker }) => {
        await writeSparseWbfs(opfsHandle, "Big.wbfs");
        const extractDir = joinGuestPath(dir, "extract-out");
        assertRunJsonSucceeded(
          await worker.runJson([
            "extract",
            "--input",
            joinGuestPath(dir, "Big.wbfs"),
            "--out-dir",
            extractDir,
            "--threads",
            "1",
          ]),
          { command: "extract" },
        );
        const outDir = await opfsHandle.getDirectoryHandle("extract-out");
        const iso = await (await outDir.getFileHandle("Big.iso")).getFile();
        await verifyIso(iso);
      });
    },
    45 * 60 * 1000,
  );
});
