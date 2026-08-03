// Regression guard for the many-small-files extract fan-out.
//
// Extracting an archive with thousands of entries must not hold one OPFS SyncAccessHandle (plus its
// multi-MiB coalescing buffers) per entry: iOS WebKit kills the tab long before the run finishes.
// The proxy's peak live-handle gauge is the measurable proxy for that resource, so these tests assert
// it stays bounded by concurrency instead of tracking the entry count.

import { describe, expect, it } from "vitest";
import { buildStoredZip } from "./stored-zip-fixture.mjs";
import { assertRunJsonSucceeded, joinGuestPath, withTempFixture, writeGuestFile } from "./test-helpers.mjs";

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

const parseThreadWorkerStats = (traceLines) => {
  const line = traceLines.findLast((entry) => entry.includes("[perf] thread workers"));
  if (!line) throw new Error(`no thread worker gauge in trace (${traceLines.length} lines)`);
  const matched = /created=(\d+) total=(\d+)/.exec(line);
  if (!matched) throw new Error(`unparseable thread worker gauge: ${line}`);
  return { threadWorkersCreated: Number(matched[1]), threadWorkersTotal: Number(matched[2]) };
};

const listDirectoryEntries = async (rootHandle, relativePath) => {
  let directory = rootHandle;
  for (const part of relativePath.split("/").filter(Boolean)) {
    directory = await directory.getDirectoryHandle(part, { create: false });
  }
  const names = [];
  for await (const [name] of directory.entries()) names.push(name);
  return names;
};

async function measureManyEntryExtract({ entryCount, entrySize, extraArgs = [] }) {
  let measurement = null;
  await withTempFixture(
    async ({ worker, opfsHandle, dir }) => {
      const archivePath = joinGuestPath(dir, "many-entries.zip");
      const outDir = joinGuestPath(dir, "out");
      await writeGuestFile(opfsHandle, archivePath, buildStoredZip(entryCount, entrySize));

      const traceLines = [];
      const startedAtMs = performance.now();
      const result = await worker.runJson(["extract", "--input", archivePath, "--out-dir", outDir, ...extraArgs], {
        onTraceNonJsonLine: (line) => traceLines.push(line),
      });
      const durationMs = performance.now() - startedAtMs;
      assertRunJsonSucceeded(result);
      const names = await listDirectoryEntries(opfsHandle, "out");
      const scratchNames = await listDirectoryEntries(opfsHandle, "rom-weaver-out").catch(() => []);
      measurement = {
        ...parseHandleStats(traceLines),
        ...parseThreadWorkerStats(traceLines),
        durationMs,
        extractedFiles: names.filter((name) => /^entry-\d+\.bin$/.test(name)).length,
      };
      expect(names.filter((name) => name.startsWith(".rom-weaver-extract-"))).toEqual([]);
      expect(scratchNames.filter((name) => name.startsWith("rw-"))).toEqual([]);
    },
    { prefix: "rom-weaver-many-entries-" },
  );
  return measurement;
}

// Live handles are bounded by concurrency, not entry count: each participating realm keeps at most
// IdleFilePool's capacity (8) parked plus its in-flight fds. Well under the proxy's 1024-handle table.
const MAX_EXPECTED_PEAK_HANDLES = 64;

// Worker creations are bounded by concurrency too: the runner's pool (<= 20 shells) plus, for each
// pooled parent thread, its own small nested free-list. Never by the entry count.
const MAX_EXPECTED_THREAD_WORKERS = 25;

describe("many-entry archive extract", () => {
  it("keeps peak OPFS handles bounded as entry count grows", async () => {
    const small = await measureManyEntryExtract({ entryCount: 24, entrySize: 4096 });
    const large = await measureManyEntryExtract({ entryCount: 384, entrySize: 4096 });

    // Diagnostic breadcrumb: the growth curve is the evidence this test exists to protect.
    console.debug("[rom-weaver test] many-entry handle gauge", { large, small });

    expect(small.extractedFiles).toBe(24);
    expect(large.extractedFiles).toBe(384);
    // Every entry is still opened (and closed) - the fan-out is real work, not skipped work.
    expect(large.opened).toBeGreaterThan(small.opened);
    // ...but nothing may be *held*: a 16x entry count must not grow the live handle high-water mark.
    expect(large.peak).toBeLessThanOrEqual(small.peak + 2);
    // An absolute ceiling too, so a future regression that scales both measurements equally still fails.
    expect(large.peak).toBeLessThanOrEqual(MAX_EXPECTED_PEAK_HANDLES);
    expect(large.live).toBeLessThanOrEqual(MAX_EXPECTED_PEAK_HANDLES);
    // Each live adapter can retain 8 MiB of coalescing buffers; per-entry retention was the other
    // half of the tab kill. Bound it to a handful of adapters' worth, independent of entry count.
    expect(large.adapterBufferBytes).toBeLessThanOrEqual(small.adapterBufferBytes + 8 * 1024 * 1024);
    expect(large.adapterBufferBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  });

  // The iOS stress corpus's real command shape: threaded fan-out with per-entry checksums. Spawned
  // WASI threads build their own mounts, and each entry used to get a brand-new dedicated Worker
  // (a ~7 MB wasm instantiation plus an OPFS mount rebuild apiece). Verify the full output while
  // bounding both resources in the same run.
  it("validates a threaded 2048-entry extract with bounded resources", async () => {
    const measured = await measureManyEntryExtract({
      entryCount: 2048,
      entrySize: 4096,
      extraArgs: ["--threads", "auto", "--checksum", "sha256"],
    });

    console.debug("[rom-weaver test] threaded stress-size gauges", measured);

    expect(measured.extractedFiles).toBe(2048);
    expect(measured.threadWorkersTotal).toBeLessThanOrEqual(MAX_EXPECTED_THREAD_WORKERS);
    expect(measured.peak).toBeLessThanOrEqual(MAX_EXPECTED_PEAK_HANDLES);
    expect(measured.adapterBufferBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});
