import { expect, it } from "vitest";
import { createRomWeaverCommand } from "../../src/wasm/rom-weaver-command.ts";
import { assertRunJsonSucceeded, joinGuestPath, withTempFixture, writeGuestFile } from "./test-helpers.mjs";

// 20 requested threads size the browser WASI pool to its 20-worker cap
// (`MAX_BROWSER_THREAD_POOL_SIZE`), so a 20-thread decode wave beside the checksum workers overflows it.
const THREADS = 20;
const POOL_SIZE = 20;
const CD_SECTOR_BYTES = 2352;
// 400 CD hunks of 8 frames: one decode batch, which splits into one chunk per decode thread.
const CD_SECTORS = 3200;
// 1,024 raw hunks of 4 KiB: also one decode batch.
const RAW_BYTES = 4 * 1024 * 1024;
// With one decode batch, an extract's spawns are its decode wave plus its checksum workers, so their
// count is the most pool workers it can hold at once. Counting them is deterministic, unlike waiting
// for the pool to saturate, which these small chunks can finish before.
const SPAWN_REQUEST_TRACE = /thread spawn requested/;
// The spawner traces before it waits on a busy worker and before it refuses a spawn; each refusal
// costs a 250 ms wait.
const SATURATED_POOL_TRACE = /thread spawn (waiting for idle pooled worker|no idle pooled worker)/;

function nextSeed(seed) {
  return (Math.imul(seed, 1103515245) + 12345) >>> 0;
}

// Mode 1 raw sectors with semi-compressible payloads.
function buildCdImage() {
  const image = new Uint8Array(CD_SECTOR_BYTES * CD_SECTORS);
  let seed = 0x2545f491;
  for (let sector = 0; sector < CD_SECTORS; sector += 1) {
    const base = sector * CD_SECTOR_BYTES;
    image.fill(0xff, base + 1, base + 11);
    image.set([Math.floor(sector / 4500), (Math.floor(sector / 75) % 60) + 2, sector % 75, 1], base + 12);
    for (let offset = 16; offset < 16 + 2048; offset += 1) {
      seed = nextSeed(seed);
      image[base + offset] = (seed >>> 24) & (offset % 64 < 48 ? 0x0f : 0xff);
    }
  }
  return image;
}

// Semi-compressible bytes with no CD sync, partition table, or A/V header, so create infers raw media.
function buildRawImage() {
  const image = new Uint8Array(RAW_BYTES);
  let seed = 0x6c078965;
  for (let offset = 0; offset < image.length; offset += 1) {
    seed = nextSeed(seed);
    image[offset] = (seed >>> 24) & (offset % 64 < 48 ? 0x0f : 0xff);
  }
  return image;
}

async function extractWithinThreadPool(worker, dir, chdPath, label) {
  let spawnRequests = 0;
  const saturationTraces = [];
  const result = await worker.runJson(
    createRomWeaverCommand("extract", {
      checksum: ["crc32", "md5", "sha1"],
      force: true,
      input: chdPath,
      output: joinGuestPath(dir, `${label}-out`),
      threads: THREADS,
    }),
    {
      onTraceNonJsonLine: (line) => {
        const text = String(line);
        if (SPAWN_REQUEST_TRACE.test(text)) spawnRequests += 1;
        if (SATURATED_POOL_TRACE.test(text)) saturationTraces.push(text);
      },
    },
  );
  const terminal = assertRunJsonSucceeded(result, { command: "extract" });
  expect(terminal.effective_threads, label).toBe(THREADS);
  // A threaded decode wave ran at all, so the bound below is not met trivially.
  expect(spawnRequests, label).toBeGreaterThan(THREADS / 2);
  expect(spawnRequests, label).toBeLessThanOrEqual(POOL_SIZE);
  expect(saturationTraces, label).toEqual([]);
}

it("single-output CHD extracts fit decode and checksum workers into the browser thread pool", async () => {
  await withTempFixture(async ({ dir, opfsHandle, worker }) => {
    const cuePath = joinGuestPath(dir, "disc.cue");
    const rawPath = joinGuestPath(dir, "data.raw");
    await writeGuestFile(opfsHandle, joinGuestPath(dir, "disc.bin"), buildCdImage());
    await writeGuestFile(
      opfsHandle,
      cuePath,
      new TextEncoder().encode('FILE "disc.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n'),
    );
    await writeGuestFile(opfsHandle, rawPath, buildRawImage());

    for (const [label, input] of [
      ["cd", cuePath],
      ["raw", rawPath],
    ]) {
      const chdPath = joinGuestPath(dir, `${label}.chd`);
      assertRunJsonSucceeded(
        await worker.runJson(
          createRomWeaverCommand("compress", {
            format: "chd",
            input: [input],
            level: "min",
            output: chdPath,
            threads: THREADS,
          }),
        ),
        { command: "compress" },
      );
      await extractWithinThreadPool(worker, dir, chdPath, label);
    }
  });
});
