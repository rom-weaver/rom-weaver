import { expect, it } from "vitest";
import { createRomWeaverCommand } from "../../src/wasm/rom-weaver-command.ts";
import { assertRunJsonSucceeded, joinGuestPath, withTempFixture, writeGuestFile } from "./test-helpers.mjs";

const CD_SECTOR_BYTES = 2352;
const CD_SECTORS = 400;
const THREADS = 16;
// Each run starts from a fresh shared memory, so every run is an independent chance for a thread
// to trap. Without the heap reservation about one run in ten trapped in headless Chromium on a
// 16-core host, so 60 runs miss the race well under 1% of the time.
const RUNS = 60;
const RUN_TIMEOUT_MS = 20_000;

// Mode 1 raw sectors with semi-compressible payloads, so CD FLAC encodes every hunk.
function buildCdImage() {
  const image = new Uint8Array(CD_SECTOR_BYTES * CD_SECTORS);
  let seed = 0x2545f491;
  for (let sector = 0; sector < CD_SECTORS; sector += 1) {
    const base = sector * CD_SECTOR_BYTES;
    image.fill(0xff, base + 1, base + 11);
    image.set([Math.floor(sector / 4500), (Math.floor(sector / 75) % 60) + 2, sector % 75, 1], base + 12);
    for (let offset = 16; offset < 16 + 2048; offset += 1) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      image[base + offset] = (seed >>> 24) & (offset % 64 < 48 ? 0x0f : 0xff);
    }
  }
  return image;
}

// A trapped wasi thread never reaches its join, so the run would otherwise wait out the timeout.
// The coordinator can trap too, and the runner then waits forever on the workers it left blocked.
const TRAP_TRACE = /pool thread failed|wasi\.start threw/;

function runUntilThreadFailure(worker, command, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} did not finish within ${RUN_TIMEOUT_MS}ms`)),
      RUN_TIMEOUT_MS,
    );
    worker
      .runJson(command, {
        onTraceNonJsonLine: (line) => {
          if (!TRAP_TRACE.test(String(line))) return;
          clearTimeout(timer);
          reject(new Error(`${label}: ${line}`));
        },
      })
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

it(
  "threaded CD FLAC CHD create finishes every run without a wasm thread trapping",
  async () => {
    await withTempFixture(async ({ dir, opfsHandle, worker }) => {
      const cuePath = joinGuestPath(dir, "disc.cue");
      await writeGuestFile(opfsHandle, joinGuestPath(dir, "disc.bin"), buildCdImage());
      await writeGuestFile(
        opfsHandle,
        cuePath,
        new TextEncoder().encode('FILE "disc.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n'),
      );
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `chd create run ${run}/${RUNS}`;
        const result = await runUntilThreadFailure(
          worker,
          createRomWeaverCommand("compress", {
            codec: ["cdfl"],
            format: "chd",
            input: [cuePath],
            level: "min",
            output: joinGuestPath(dir, `disc-${run}.chd`),
            threads: THREADS,
          }),
          label,
        );
        const terminal = assertRunJsonSucceeded(result, { command: "compress" });
        expect(terminal.effective_threads, label).toBe(THREADS);
      }
    });
  },
  RUNS * RUN_TIMEOUT_MS,
);
