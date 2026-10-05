import { expect, test } from "vitest";
import { browserRuntime } from "../../src/platform/browser/workflow-runtime.ts";
import { resetRomWeaverRunner, warmupRomWeaverRunner } from "../../src/workers/rom-weaver/rom-weaver-runner.ts";

const adler32 = (bytes) => {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
};

const compressedGcz = async (iso) => {
  const blockSize = 0x8000;
  const blocks = [];
  for (let offset = 0; offset < iso.length; offset += blockSize) {
    const compressed = new Blob([iso.subarray(offset, offset + blockSize)])
      .stream()
      .pipeThrough(new CompressionStream("deflate"));
    const bytes = new Uint8Array(await new Response(compressed).arrayBuffer());
    expect(bytes.length).toBeLessThan(blockSize);
    blocks.push(bytes);
  }
  const dataSize = blocks.reduce((size, block) => size + block.length, 0);
  const headerSize = 32 + blocks.length * 12;
  const gcz = new Uint8Array(headerSize + dataSize);
  const view = new DataView(gcz.buffer);
  gcz.set([0x01, 0xc0, 0x0b, 0xb1]);
  view.setBigUint64(8, BigInt(dataSize), true);
  view.setBigUint64(16, BigInt(iso.length), true);
  view.setUint32(24, blockSize, true);
  view.setUint32(28, blocks.length, true);
  let offset = 0;
  for (const [index, block] of blocks.entries()) {
    view.setBigUint64(32 + index * 8, BigInt(offset), true);
    view.setUint32(32 + blocks.length * 8 + index * 4, adler32(block), true);
    gcz.set(block, headerSize + offset);
    offset += block.length;
  }
  return new File([gcz], "game.gcz", { type: "application/octet-stream" });
};

test("WASM extracts zlib-compressed GCZ blocks byte for byte", async () => {
  await resetRomWeaverRunner();
  await warmupRomWeaverRunner();
  const iso = new Uint8Array(0x10000);
  iso.set(new TextEncoder().encode("RWTEST"));
  iso.set([0xc2, 0x33, 0x9f, 0x3d], 0x1c);
  iso.set(new TextEncoder().encode("rom-weaver-test"), 0x20);
  for (let index = 0x440; index < iso.length; index++) iso[index] = index % 251;
  const extract = browserRuntime.compression.extract;
  if (!extract) throw new Error("Runtime compression extract capability is unavailable");
  const result = await extract({
    entries: ["game.iso"],
    format: "gcz",
    options: { threads: 1 },
    outputName: "game.iso",
    source: await compressedGcz(iso),
  });
  try {
    expect(result.output.fileName).toBe("game.iso");
    const blob = await browserRuntime.publicOutput.getBlob(result.output);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(iso);
  } finally {
    await Promise.all(result.outputs.map((output) => output.dispose()));
    await resetRomWeaverRunner();
  }
});
