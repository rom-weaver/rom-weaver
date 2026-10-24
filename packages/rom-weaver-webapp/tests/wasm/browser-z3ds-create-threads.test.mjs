import { expect, it } from "vitest";
import { createRomWeaverCommand } from "../../src/wasm/rom-weaver-command.ts";
import { assertRunJsonSucceeded, joinGuestPath, withTempFixture, writeGuestFile } from "./test-helpers.mjs";

const IMAGE_BYTES = 24 * 1024 * 1024;
const THREADS = 16;
// Without the caller-sized heap reservation the first run trapped "memory access out of bounds" in
// headless Chromium (16 level-22 workers allocate ~18 MiB zstd contexts while siblings run), so 12
// runs are ample. Earlier 20+ run loops lost the renderer when a host-wide kernel OOM kill hit the
// browser; keep the loop short so one run holds shared memory for a bounded time.
const RUNS = 12;
const RUN_TIMEOUT_MS = 60_000;

// NCSD-style header with semi-compressible payload, so every 1 MiB frame does real zstd work.
function buildImage() {
  const image = new Uint8Array(IMAGE_BYTES);
  let seed = 0x2545f491;
  for (let offset = 0; offset < image.length; offset += 1) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    image[offset] = (seed >>> 24) & (offset % 64 < 48 ? 0x0f : 0xff);
  }
  image.set([0x4e, 0x43, 0x53, 0x44], 0x100);
  return image;
}

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
  "threaded z3ds create finishes every run without a wasm thread trapping",
  async () => {
    await withTempFixture(async ({ dir, opfsHandle, worker }) => {
      const inputPath = joinGuestPath(dir, "disc.3ds");
      await writeGuestFile(opfsHandle, inputPath, buildImage());
      for (let run = 1; run <= RUNS; run += 1) {
        const label = `z3ds create run ${run}/${RUNS}`;
        const result = await runUntilThreadFailure(
          worker,
          createRomWeaverCommand("compress", {
            format: "z3ds",
            input: [inputPath],
            level: "max",
            output: joinGuestPath(dir, `disc-${run}.z3ds`),
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
