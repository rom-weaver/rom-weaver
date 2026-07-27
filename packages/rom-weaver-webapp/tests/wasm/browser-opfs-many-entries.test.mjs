// Regression guard for the many-small-files extract fan-out.
//
// Extracting an archive with thousands of entries must not hold one OPFS SyncAccessHandle (plus its
// multi-MiB coalescing buffers) per entry: iOS WebKit kills the tab long before the run finishes.
// The proxy's peak live-handle gauge is the measurable proxy for that resource, so these tests assert
// it stays bounded by concurrency instead of tracking the entry count.

import { describe, expect, it } from "vitest";
import { assertRunJsonSucceeded, joinGuestPath, withTempFixture, writeGuestFile } from "./test-helpers.mjs";

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/**
 * Minimal STORE-only zip writer. Building the fixture in-test (instead of shelling out to the CLI)
 * keeps the entry count a free parameter, which is the whole point of the measurement.
 */
function buildStoredZip(entryCount, entrySize) {
  const encoder = new TextEncoder();
  const payload = new Uint8Array(entrySize);
  for (let index = 0; index < entrySize; index += 1) payload[index] = index & 0xff;
  const payloadCrc = crc32(payload);

  const locals = [];
  const centrals = [];
  let offset = 0;
  for (let index = 0; index < entryCount; index += 1) {
    const name = encoder.encode(`entry-${String(index).padStart(5, "0")}.bin`);
    const local = new Uint8Array(30 + name.byteLength + entrySize);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint32(14, payloadCrc, true);
    localView.setUint32(18, entrySize, true);
    localView.setUint32(22, entrySize, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(payload, 30 + name.byteLength);
    locals.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint32(16, payloadCrc, true);
    centralView.setUint32(20, entrySize, true);
    centralView.setUint32(24, entrySize, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.byteLength;
  }

  const centralSize = centrals.reduce((sum, entry) => sum + entry.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entryCount, true);
  endView.setUint16(10, entryCount, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const total = offset + centralSize + end.byteLength;
  const zip = new Uint8Array(total);
  let cursor = 0;
  for (const chunk of [...locals, ...centrals, end]) {
    zip.set(chunk, cursor);
    cursor += chunk.byteLength;
  }
  return zip;
}

const parseHandleStats = (traceLines) => {
  const line = traceLines.findLast((entry) => entry.includes("[perf] opfs proxy handles"));
  if (!line) throw new Error(`no proxy handle gauge in trace (${traceLines.length} lines)`);
  const matched = /live=(\d+) peak=(\d+) opened=(\d+) adapterBufferBytes=(\d+)/.exec(line);
  if (!matched) throw new Error(`unparseable proxy handle gauge: ${line}`);
  return {
    adapterBufferBytes: Number(matched[4]),
    live: Number(matched[1]),
    opened: Number(matched[3]),
    peak: Number(matched[2]),
  };
};

async function measureManyEntryExtract({ entryCount, entrySize }) {
  let measurement = null;
  await withTempFixture(
    async ({ worker, opfsHandle, dir }) => {
      const archivePath = joinGuestPath(dir, "many-entries.zip");
      const outDir = joinGuestPath(dir, "out");
      await writeGuestFile(opfsHandle, archivePath, buildStoredZip(entryCount, entrySize));

      const traceLines = [];
      const result = await worker.runJson(["extract", "--input", archivePath, "--out-dir", outDir], {
        onTraceNonJsonLine: (line) => traceLines.push(line),
      });
      assertRunJsonSucceeded(result);
      measurement = parseHandleStats(traceLines);
    },
    { prefix: "rom-weaver-many-entries-" },
  );
  return measurement;
}

describe("many-entry archive extract", () => {
  it("keeps peak OPFS handles bounded as entry count grows", async () => {
    const small = await measureManyEntryExtract({ entryCount: 24, entrySize: 4096 });
    const large = await measureManyEntryExtract({ entryCount: 384, entrySize: 4096 });

    // Diagnostic breadcrumb: the growth curve is the evidence this test exists to protect.
    console.debug("[rom-weaver test] many-entry handle gauge", { large, small });

    // Every entry is still opened (and closed) - the fan-out is real work, not skipped work.
    expect(large.opened).toBeGreaterThan(small.opened);
    // ...but nothing may be *held*: a 16x entry count must not grow the live handle high-water mark.
    expect(large.peak).toBeLessThanOrEqual(small.peak + 2);
    // An absolute ceiling too, so a future regression that scales both measurements equally still fails.
    expect(large.peak).toBeLessThanOrEqual(16);
    expect(large.live).toBeLessThanOrEqual(16);
    // Each live adapter can retain 8 MiB of coalescing buffers; per-entry retention was the other
    // half of the tab kill. Bound it to a handful of adapters' worth, independent of entry count.
    expect(large.adapterBufferBytes).toBeLessThanOrEqual(small.adapterBufferBytes + 8 * 1024 * 1024);
    expect(large.adapterBufferBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});
