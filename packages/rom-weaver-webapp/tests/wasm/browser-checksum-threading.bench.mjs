import { afterAll, beforeAll, bench, describe } from "vitest";
import { createBrowserWorkerClient } from "../../src/wasm/workers/browser-worker-client.ts";
import {
  CHECKSUM_THREADING_DEFAULTS,
  createBenchOptions,
  defaultCsv,
  ensureGuestPseudoRandomFile,
  MIB,
  openPersistentBenchRoot,
  parseIntegerList,
  parseStringList,
  readEnvValue,
  readPositiveIntEnv,
  WORK_GUEST_ROOT,
} from "./browser-bench-shared.mjs";
import { assertRunJsonSucceeded, joinGuestPath, toTypedRunInput } from "./test-helpers.mjs";

const BENCH_ROOT = joinGuestPath(WORK_GUEST_ROOT, "bench-checksum-threading");
const SOURCE_PATH = joinGuestPath(BENCH_ROOT, "fixture.bin");

const ALGORITHMS = parseStringList(
  readEnvValue("ROM_WEAVER_WASM_BENCH_THREADING_ALGORITHMS") ?? defaultCsv(CHECKSUM_THREADING_DEFAULTS.algorithms),
);
const SIZES_MIB = parseIntegerList(
  readEnvValue("ROM_WEAVER_WASM_BENCH_THREADING_SIZES_MIB") ?? defaultCsv(CHECKSUM_THREADING_DEFAULTS.sizes_mib),
);
const SEQUENTIAL_THREADS = readPositiveIntEnv(
  "ROM_WEAVER_WASM_BENCH_THREADING_SEQUENTIAL_THREADS",
  CHECKSUM_THREADING_DEFAULTS.sequential_threads,
);
const PARALLEL_THREADS = readPositiveIntEnv(
  "ROM_WEAVER_WASM_BENCH_THREADING_PARALLEL_THREADS",
  CHECKSUM_THREADING_DEFAULTS.parallel_threads,
);
const STRIDE_MIB = readPositiveIntEnv(
  "ROM_WEAVER_WASM_BENCH_THREADING_STRIDE_MIB",
  CHECKSUM_THREADING_DEFAULTS.stride_mib,
);
const BENCH_OPTIONS = createBenchOptions();

let fixtureRootHandle = null;
let worker = null;
let initializationPromise = null;

describe("rom-weaver-wasm benchmark parity with python bench-checksum-threading", () => {
  beforeAll(async () => {
    await ensureRuntimeReady();
  }, 300_000);

  afterAll(async () => {
    try {
      worker?.terminate();
    } catch {
      // best-effort cleanup only
    }
  });

  for (const algorithm of ALGORITHMS) {
    for (const sizeMib of SIZES_MIB) {
      for (const threads of [SEQUENTIAL_THREADS, PARALLEL_THREADS]) {
        const strideBytes = STRIDE_MIB * MIB;
        const phaseOffset = threads === SEQUENTIAL_THREADS ? 0 : Math.floor(strideBytes / 2);
        const sizeBytes = sizeMib * MIB;
        const startBytes = phaseOffset;
        bench(
          `checksum-threading algo:${algorithm} size_mib:${sizeMib} threads:${threads}`,
          async () => {
            await ensureRuntimeReady();
            const result = await worker.runJson(
              toTypedRunInput([
                "--no-progress",
                "checksum",
                "--algo",
                algorithm,
                "--threads",
                String(threads),
                "--no-extract",
                "--start",
                String(startBytes),
                "--length",
                String(sizeBytes),
                "--input",
                SOURCE_PATH,
              ]),
            );
            assertRunJsonSucceeded(result, { command: "checksum" });
          },
          BENCH_OPTIONS,
        );
      }
    }
  }
});

async function ensureRuntimeReady() {
  if (initializationPromise == null) {
    initializationPromise = initializeRuntime();
  }
  await initializationPromise;
}

async function initializeRuntime() {
  const opened = await openPersistentBenchRoot("bench-checksum-threading");
  fixtureRootHandle = opened.fixtureRootHandle;

  worker = createBrowserWorkerClient({
    defaultThreads: PARALLEL_THREADS,
  });

  await worker.init({
    defaultThreads: PARALLEL_THREADS,
    opfsHandle: fixtureRootHandle,
    runtimeMounts: [WORK_GUEST_ROOT],
    wasmUrl: "/rom-weaver-app.wasm",
    workGuestPath: WORK_GUEST_ROOT,
  });

  const maxSizeBytes = Math.max(...SIZES_MIB) * MIB;
  const strideBytes = STRIDE_MIB * MIB;
  const headroomBytes = (BENCH_OPTIONS.warmupIterations + BENCH_OPTIONS.iterations + 2) * strideBytes;
  await ensureGuestPseudoRandomFile(fixtureRootHandle, SOURCE_PATH, maxSizeBytes + headroomBytes, {
    chunkSizeBytes: 4 * MIB,
    seed: 0xbadc0de,
  });
}
