import { afterAll, beforeAll, bench, describe } from "vitest";
import { createBrowserWorkerClient } from "@rom-weaver/wasm/workers/browser-worker-client";
import {
  COMMAND_PATHS_DEFAULTS,
  createBenchOptions,
  ensureGuestGamecubeIsoFixture,
  ensureGuestPseudoRandomFile,
  MIB,
  openPersistentBenchRoot,
  readBooleanEnv,
  readEnvValue,
  readPositiveIntEnv,
  WORK_GUEST_ROOT,
} from "./browser-bench-shared.mjs";
import {
  assertRunJsonSucceeded,
  getGuestFileSize,
  joinGuestPath,
  toTypedRunInput,
  writeGuestFile,
} from "./test-helpers.mjs";

const BENCH_ROOT = joinGuestPath(WORK_GUEST_ROOT, "bench-command-paths");
const FIXTURE_ROOT = joinGuestPath(BENCH_ROOT, "fixtures");
const ARTIFACT_ROOT = joinGuestPath(BENCH_ROOT, "artifacts");
const OUTPUT_ROOT = joinGuestPath(BENCH_ROOT, "outputs");
const ARCHIVE_FIXTURE_ROOT = joinGuestPath(FIXTURE_ROOT, "archive-sources");
const SOURCE_PATH = joinGuestPath(FIXTURE_ROOT, "source.bin");
const DISC_SOURCE_PATH = joinGuestPath(FIXTURE_ROOT, "source-disc.iso");
const PATCH_ORIGINAL_PATH = joinGuestPath(FIXTURE_ROOT, "patch-original.bin");
const PATCH_MODIFIED_PATH = joinGuestPath(FIXTURE_ROOT, "patch-modified.bin");
const IPS_EBP_PATCH_ORIGINAL_PATH = joinGuestPath(FIXTURE_ROOT, "ips-ebp-patch-original.bin");
const IPS_EBP_PATCH_MODIFIED_PATH = joinGuestPath(FIXTURE_ROOT, "ips-ebp-patch-modified.bin");

const DEFAULT_COMMANDS = COMMAND_PATHS_DEFAULTS.commands;
const DEFAULT_SOURCE_SIZE_MIB = COMMAND_PATHS_DEFAULTS.size_mib;
const DEFAULT_PATCH_SIZE_MIB = COMMAND_PATHS_DEFAULTS.patch_size_mib;
const DEFAULT_BENCH_FORMATS = COMMAND_PATHS_DEFAULTS.container_formats_default;
const DEFAULT_BENCH_FORMATS_CSV = DEFAULT_BENCH_FORMATS.join(",");
const CHECKSUM_MODE_VALUES = ["raw", "auto-extract", "archive-no-extract"];
const CONTAINER_FORMAT_ALIASES = { z3d3: "z3ds" };
const DEFAULT_CHECKSUM_COMBO_ALGOS = COMMAND_PATHS_DEFAULTS.checksum_combo_algorithms;
const DEFAULT_CHECKSUM_COMBO_ALGOS_CSV = DEFAULT_CHECKSUM_COMBO_ALGOS.join(",");
const CONTAINER_FORMATS = COMMAND_PATHS_DEFAULTS.container_formats;
const CONTAINER_SUFFIX = {
  "tar.bz2": "tar.bz2",
  "tar.gz": "tar.gz",
  "tar.xz": "tar.xz",
};
const EXPECTED_COMPRESS_SKIPS = {
  ...COMMAND_PATHS_DEFAULTS.expected_compress_skips,
};
const EXPECTED_PATCH_CREATE_SKIPS = COMMAND_PATHS_DEFAULTS.expected_patch_create_skips;
const WASM_PATCH_CREATE_SKIPS = {
  // dldi create needs a real DLDI-format input; the random source/modified bench
  // fixtures have no patchable DLDI slot (this is a fixture limitation, not the
  // os-error-44 worker-read bug, which is fixed).
  dldi: "wasm benchmark limitation: dldi patch-create needs a DLDI-format fixture",
};
// apsgba/dps/mod/pat/ppf apply and aps/bdf create previously failed with os error 44
// (worker threads opening OPFS source). Those reads are now gated to the main thread
// in wasm, and all are browser-verified, so they no longer need skipping.
const WASM_PATCH_APPLY_SKIPS = {};
const WASM_RUNTIME_DEFAULT = "default";
const DISC_COMPRESS_INPUT_FORMATS = new Set(COMMAND_PATHS_DEFAULTS.disc_compress_input_formats);
const ROM_WEAVER_COMPRESS_CODEC_BY_FORMAT = COMMAND_PATHS_DEFAULTS.compress_codec_by_format;
const ROM_WEAVER_CODEC_MATRIX_BY_FORMAT = COMMAND_PATHS_DEFAULTS.codec_matrix_by_format;
const CHECKSUM_ALGORITHMS = COMMAND_PATHS_DEFAULTS.checksum_algorithms;
const PATCH_FORMATS = COMMAND_PATHS_DEFAULTS.patch_formats;
const PATCH_EXTENSION = COMMAND_PATHS_DEFAULTS.patch_extension;

const SELECTED_COMMANDS = parseCommandFilter(readEnvValue("ROM_WEAVER_WASM_BENCH_COMMANDS") ?? DEFAULT_COMMANDS);
const SELECTED_CONTAINER_FORMATS = parseValueFilter(
  readEnvValue("ROM_WEAVER_WASM_BENCH_CONTAINER_FORMATS") ?? DEFAULT_BENCH_FORMATS_CSV,
  CONTAINER_FORMATS,
  "--container-formats",
  CONTAINER_FORMAT_ALIASES,
);
const SELECTED_PATCH_FORMATS = parseValueFilter(
  readEnvValue("ROM_WEAVER_WASM_BENCH_PATCH_FORMATS") ?? "all",
  PATCH_FORMATS,
  "--patch-formats",
);
const SELECTED_CHECKSUM_ALGORITHMS = parseValueFilter(
  readEnvValue("ROM_WEAVER_WASM_BENCH_CHECKSUM_ALGOS") ?? "all",
  CHECKSUM_ALGORITHMS,
  "--checksum-algos",
);
const SELECTED_CHECKSUM_MODES = new Set(
  parseValueFilter(
    readEnvValue("ROM_WEAVER_WASM_BENCH_CHECKSUM_MODES") ?? COMMAND_PATHS_DEFAULTS.checksum_modes,
    CHECKSUM_MODE_VALUES,
    "--checksum-modes",
  ),
);
const CHECKSUM_COMBO_ALGORITHMS = parseOptionalChecksumComboAlgorithms(
  readEnvValue("ROM_WEAVER_WASM_BENCH_CHECKSUM_COMBO_ALGOS") ?? DEFAULT_CHECKSUM_COMBO_ALGOS_CSV,
);
const SELECTED_CODEC_LABELS = parseOptionalCodecLabels(readEnvValue("ROM_WEAVER_WASM_BENCH_CODECS") ?? "all");
const SOURCE_SIZE_BYTES = readPositiveIntEnv("ROM_WEAVER_WASM_BENCH_SOURCE_MIB", DEFAULT_SOURCE_SIZE_MIB) * MIB;
const PATCH_SIZE_BYTES = readPositiveIntEnv("ROM_WEAVER_WASM_BENCH_PATCH_SOURCE_MIB", DEFAULT_PATCH_SIZE_MIB) * MIB;
const THREAD_COUNT = readPositiveIntEnv("ROM_WEAVER_WASM_BENCH_THREADS", 4);
const BENCH_OPTIONS = createBenchOptions();

const NEEDS_ARCHIVE_SOURCES =
  SELECTED_COMMANDS.has("extract") ||
  (SELECTED_COMMANDS.has("checksum") &&
    (SELECTED_CHECKSUM_MODES.has("auto-extract") || SELECTED_CHECKSUM_MODES.has("archive-no-extract")));
const NEEDS_CHECKSUM_ARCHIVE_SOURCES =
  SELECTED_COMMANDS.has("checksum") &&
  (SELECTED_CHECKSUM_MODES.has("auto-extract") || SELECTED_CHECKSUM_MODES.has("archive-no-extract"));
const NEEDS_RAW_SOURCE = SELECTED_COMMANDS.has("checksum") && SELECTED_CHECKSUM_MODES.has("raw");
const NEEDS_COMPRESS_SOURCE = SELECTED_COMMANDS.has("compress");
const NEEDS_DISC_SOURCE =
  NEEDS_COMPRESS_SOURCE && SELECTED_CONTAINER_FORMATS.some((formatName) => DISC_COMPRESS_INPUT_FORMATS.has(formatName));
const NEEDS_PATCH_PAIR =
  (SELECTED_COMMANDS.has("patch-create") || SELECTED_COMMANDS.has("patch-apply")) &&
  SELECTED_PATCH_FORMATS.some((formatName) => !patchCreateSkipReason(formatName));

let fixtureRootHandle = null;
let fixtureName = null;
const workersByRuntime = new Map();
let initializationPromise = null;
const archiveSources = new Map();
const archiveSourcesDefault = new Map();
const unavailableArchiveSources = new Map();
const patchSeedSources = new Map();
const unavailablePatchSeedSources = new Map();

describe("rom-weaver-wasm benchmark parity with python bench-command-paths", () => {
  beforeAll(async () => {
    await ensureRuntimeReady();
  }, 600_000);

  afterAll(async () => {
    for (const worker of workersByRuntime.values()) {
      try {
        worker.terminate();
      } catch {
        // best-effort cleanup only
      }
    }
    workersByRuntime.clear();

    fixtureName = null;
  });

  const registerCompressBenches = () => {
    if (SELECTED_COMMANDS.has("compress")) {
      for (const formatName of SELECTED_CONTAINER_FORMATS) {
        for (const [codecLabel, codecValue] of selectedCodecCasesForFormat(formatName)) {
          const pathId = formatCodecPathId(formatName, codecLabel);
          const skipReason = EXPECTED_COMPRESS_SKIPS[formatName] ?? null;
          const benchName = `compress ${pathId}`;
          if (skipReason) {
            bench.skip(`${benchName} (skip: ${skipReason})`, () => {
              // skipped: placeholder body for a skipped benchmark
            });
            continue;
          }
          bench(
            benchName,
            async () => {
              await ensureRuntimeReady();
              const outputPath = compressOutputPath(formatName, codecLabel);
              const inputPath = compressInputForFormat(formatName);
              const args = romWeaverCompressArgs({
                codecOverride: codecValue,
                formatName,
                inputPath,
                outputPath,
                threads: THREAD_COUNT,
              });
              await runBenchmarkCommand(args, "compress", {
                wasmRuntime: defaultWasmRuntime(),
              });
              await markArchiveSourceReady(formatName, codecLabel);
            },
            benchOptions({
              setup: () => prepareArchiveOutputFile(formatName, codecLabel),
            }),
          );
        }
      }
    }
  };
  registerCompressBenches();

  const registerExtractBenches = () => {
    if (SELECTED_COMMANDS.has("extract")) {
      for (const formatName of SELECTED_CONTAINER_FORMATS) {
        for (const [codecLabel] of selectedCodecCasesForFormat(formatName)) {
          const pathId = formatCodecPathId(formatName, codecLabel);
          const sourceKey = archiveSourceKey(formatName, codecLabel);
          const benchName = `extract ${pathId}`;
          const skipReason = extractSkipReason(formatName);
          if (skipReason) {
            bench.skip(`${benchName} (skip: ${skipReason})`, () => {
              // skipped: placeholder body for a skipped benchmark
            });
            continue;
          }
          bench(
            benchName,
            async () => {
              await ensureRuntimeReady();
              const source = archiveSources.get(sourceKey);
              if (!source) {
                throw new Error(
                  `extract source unavailable for ${pathId}: ${archiveSourceUnavailableReason(sourceKey)}`,
                );
              }
              const outputDir = extractOutputDirPath(formatName, codecLabel);
              await runBenchmarkCommand(
                ["extract", "--input", source.path, "--out-dir", outputDir, "--threads", String(THREAD_COUNT)],
                "extract",
              );
            },
            benchOptions({
              setup: () => prepareExtractBenchmarkSource(formatName, codecLabel),
              teardown: () => cleanupExtractBenchmarkSource(formatName, codecLabel),
            }),
          );
        }
      }
    }
  };
  registerExtractBenches();

  const registerRawChecksumBenches = () => {
    if (SELECTED_COMMANDS.has("checksum") && SELECTED_CHECKSUM_MODES.has("raw")) {
      for (const algorithm of SELECTED_CHECKSUM_ALGORITHMS) {
        bench(
          `checksum raw:algo:${algorithm}`,
          async () => {
            await ensureRuntimeReady();
            await runBenchmarkCommand(
              [
                "checksum",
                "--input",
                SOURCE_PATH,
                "--algo",
                algorithm,
                "--no-extract",
                "--threads",
                String(THREAD_COUNT),
              ],
              "checksum",
            );
          },
          BENCH_OPTIONS,
        );
      }

      if (CHECKSUM_COMBO_ALGORITHMS.length > 0) {
        const comboLabel = CHECKSUM_COMBO_ALGORITHMS.join("+");
        bench(
          `checksum raw:combo:${comboLabel}`,
          async () => {
            await ensureRuntimeReady();
            const comboArgs = checksumMultiAlgorithmArgs(CHECKSUM_COMBO_ALGORITHMS);
            await runBenchmarkCommand(
              ["checksum", "--input", SOURCE_PATH, ...comboArgs, "--no-extract", "--threads", String(THREAD_COUNT)],
              "checksum",
            );
          },
          BENCH_OPTIONS,
        );
      }
    }
  };
  registerRawChecksumBenches();

  const registerAutoExtractChecksumBenches = () => {
    if (SELECTED_COMMANDS.has("checksum") && SELECTED_CHECKSUM_MODES.has("auto-extract")) {
      for (const formatName of SELECTED_CONTAINER_FORMATS) {
        for (const algorithm of SELECTED_CHECKSUM_ALGORITHMS) {
          const benchName = `checksum auto-extract:${formatName},algo:${algorithm}`;
          bench(
            benchName,
            async () => {
              await ensureRuntimeReady();
              const currentSource = archiveSourcesDefault.get(formatName);
              if (!currentSource) {
                return;
              }
              await runBenchmarkCommand(
                ["checksum", "--input", currentSource.path, "--algo", algorithm, "--threads", String(THREAD_COUNT)],
                "checksum",
              );
            },
            BENCH_OPTIONS,
          );
        }
      }
    }
  };
  registerAutoExtractChecksumBenches();

  const registerArchiveChecksumBenches = () => {
    if (SELECTED_COMMANDS.has("checksum") && SELECTED_CHECKSUM_MODES.has("archive-no-extract")) {
      for (const formatName of SELECTED_CONTAINER_FORMATS) {
        for (const algorithm of SELECTED_CHECKSUM_ALGORITHMS) {
          const benchName = `checksum no-extract:${formatName},algo:${algorithm}`;
          bench(
            benchName,
            async () => {
              await ensureRuntimeReady();
              const currentSource = archiveSourcesDefault.get(formatName);
              if (!currentSource) {
                return;
              }
              await runBenchmarkCommand(
                [
                  "checksum",
                  "--input",
                  currentSource.path,
                  "--algo",
                  algorithm,
                  "--no-extract",
                  "--threads",
                  String(THREAD_COUNT),
                ],
                "checksum",
              );
            },
            BENCH_OPTIONS,
          );
        }
      }
    }
  };
  registerArchiveChecksumBenches();

  const registerPatchCreateBenches = () => {
    if (SELECTED_COMMANDS.has("patch-create")) {
      for (const formatName of SELECTED_PATCH_FORMATS) {
        const skipReason = patchCreateSkipReason(formatName);
        const benchName = `patch-create format:${formatName}`;
        if (skipReason) {
          bench.skip(`${benchName} (skip: ${skipReason})`, () => {
            // skipped: placeholder body for a skipped benchmark
          });
          continue;
        }
        bench(
          benchName,
          async () => {
            await ensureRuntimeReady();
            const patchArtifactPath = patchArtifactPathForBench("patch-create", formatName);
            const { originalPath, modifiedPath } = patchFixturePairForFormat(formatName);
            await runBenchmarkCommand(
              [
                "patch",
                "create",
                "--original",
                originalPath,
                "--modified",
                modifiedPath,
                "--format",
                formatName,
                "--output",
                patchArtifactPath,
                "--threads",
                String(THREAD_COUNT),
              ],
              "patch-create",
            );
          },
          BENCH_OPTIONS,
        );
      }
    }
  };
  registerPatchCreateBenches();

  const registerPatchApplyBenches = () => {
    if (SELECTED_COMMANDS.has("patch-apply")) {
      for (const formatName of SELECTED_PATCH_FORMATS) {
        const skipReason = patchApplySkipReason(formatName);
        const benchName = `patch-apply format:${formatName}`;
        if (skipReason) {
          bench.skip(`${benchName} (skip: ${skipReason})`, () => {
            // skipped: placeholder body for a skipped benchmark
          });
          continue;
        }
        bench(
          benchName,
          async () => {
            await ensureRuntimeReady();
            const patchSource = resolvePatchApplySource(formatName);
            if (!patchSource) {
              throw new Error(
                `patch source unavailable for format:${formatName}: ${patchSourceUnavailableReason(formatName)}`,
              );
            }
            const outputPath = patchApplyOutputPath(formatName);
            const args = [
              "patch",
              "apply",
              "--input",
              patchSource.inputPath,
              "--patch",
              patchSource.patchPath,
              "--output",
              outputPath,
              "--no-compress",
              "--threads",
              String(THREAD_COUNT),
            ];
            if (formatName === "mod") {
              args.splice(args.length - 2, 0, "--ignore-checksum-validation");
            }
            const result = await runBenchmarkCommandAllowFailure(args);
            if (!result.ok) {
              throw new Error(`patch-apply format:${formatName} failed: ${terminalLabelFromResult(result)}`);
            }
          },
          benchOptions({
            setup: () => prepareOutputFile(patchApplyOutputPath(formatName)),
            teardown: () => removeGuestPath(fixtureRootHandle, patchApplyOutputPath(formatName), { recursive: false }),
          }),
        );
      }
    }
  };
  registerPatchApplyBenches();
});

async function ensureSourceFixture() {
  await ensureGuestPseudoRandomFile(fixtureRootHandle, SOURCE_PATH, SOURCE_SIZE_BYTES, {
    chunkSizeBytes: 4 * MIB,
    seed: 0xbadc0de,
  });
}

async function ensureDiscSourceFixture() {
  await ensureGuestGamecubeIsoFixture(fixtureRootHandle, DISC_SOURCE_PATH, SOURCE_SIZE_BYTES, {
    chunkSizeBytes: 4 * MIB,
  });
}

async function ensurePatchPairFixtures() {
  await ensureGuestPseudoRandomFile(fixtureRootHandle, PATCH_ORIGINAL_PATH, PATCH_SIZE_BYTES, {
    chunkSizeBytes: 4 * MIB,
    seed: 0xc0ffee,
  });
  await ensureGuestPseudoRandomFile(fixtureRootHandle, PATCH_MODIFIED_PATH, PATCH_SIZE_BYTES, {
    chunkSizeBytes: 4 * MIB,
    mutate: true,
    seed: 0xc0ffee,
  });
}

async function prepareArchiveSources() {
  for (const formatName of SELECTED_CONTAINER_FORMATS) {
    for (const [codecLabel] of selectedCodecCasesForFormat(formatName)) {
      await ensureArchiveSource(formatName, codecLabel);
    }
  }
}

async function prepareExtractBenchmarkSource(formatName, codecLabel) {
  await ensureRuntimeReady();
  const outputDir = extractOutputDirPath(formatName, codecLabel);
  await removeGuestPath(fixtureRootHandle, outputDir, { recursive: true });

  const source = await ensureArchiveSource(formatName, codecLabel);
  if (!source) {
    const sourceKey = archiveSourceKey(formatName, codecLabel);
    throw new Error(
      `extract source unavailable for ${formatName} codec:${codecLabel}: ${archiveSourceUnavailableReason(sourceKey)}`,
    );
  }
}

async function cleanupExtractBenchmarkSource(formatName, codecLabel) {
  await ensureRuntimeReady();
  const sourceKey = archiveSourceKey(formatName, codecLabel);
  archiveSources.delete(sourceKey);
  await removeGuestPath(fixtureRootHandle, extractOutputDirPath(formatName, codecLabel), {
    recursive: true,
  });
}

async function ensureArchiveSource(formatName, codecLabel) {
  const sourceKey = archiveSourceKey(formatName, codecLabel);
  const skipReason = EXPECTED_COMPRESS_SKIPS[formatName] ?? null;
  if (skipReason) {
    unavailableArchiveSources.set(sourceKey, skipReason);
    return null;
  }

  const codecCase = selectedCodecCasesForFormat(formatName).find(([candidateLabel]) => candidateLabel === codecLabel);
  if (!codecCase) {
    unavailableArchiveSources.set(sourceKey, `unknown selected codec ${codecLabel} for ${formatName}`);
    return null;
  }

  const sourcePath = archiveArtifactPath(formatName, codecLabel);
  const markerPath = archiveArtifactReadyMarkerPath(formatName, codecLabel);
  if (await archiveSourceCacheReady(sourcePath, markerPath)) {
    benchLog(`using cached archive source ${formatName} codec:${codecLabel}`);
    return recordArchiveSource(formatName, codecLabel, sourcePath);
  }

  const [, codecValue] = codecCase;
  await removeGuestPath(fixtureRootHandle, markerPath, { recursive: false });
  await removeGuestPath(fixtureRootHandle, sourcePath, { recursive: false });

  benchLog(`prepare archive source ${formatName} codec:${codecLabel}`);
  const result = await runBenchmarkCommandAllowFailure(
    romWeaverCompressArgs({
      codecOverride: codecValue,
      formatName,
      inputPath: compressInputForFormat(formatName),
      outputPath: sourcePath,
      threads: THREAD_COUNT,
    }),
    {
      assumeReady: true,
      wasmRuntime: defaultWasmRuntime(),
    },
  );
  if (!result.ok) {
    const reason =
      terminalLabelFromResult(result) || `failed to prepare archive source ${formatName} codec:${codecLabel}`;
    unavailableArchiveSources.set(sourceKey, reason);
    await removeGuestPath(fixtureRootHandle, markerPath, { recursive: false });
    await removeGuestPath(fixtureRootHandle, sourcePath, { recursive: false });
    return null;
  }

  await writeGuestFile(fixtureRootHandle, markerPath, new TextEncoder().encode("ok\n"));
  benchLog(`prepared archive source ${formatName} codec:${codecLabel}`);
  return recordArchiveSource(formatName, codecLabel, sourcePath);
}

async function prepareArchiveOutputFile(formatName, codecLabel) {
  await ensureRuntimeReady();
  await removeGuestPath(fixtureRootHandle, archiveArtifactReadyMarkerPath(formatName, codecLabel), {
    recursive: false,
  });
  await removeGuestPath(fixtureRootHandle, archiveArtifactPath(formatName, codecLabel), {
    recursive: false,
  });
}

async function markArchiveSourceReady(formatName, codecLabel) {
  await writeGuestFile(
    fixtureRootHandle,
    archiveArtifactReadyMarkerPath(formatName, codecLabel),
    new TextEncoder().encode("ok\n"),
  );
  benchLog(`marked archive source ${formatName} codec:${codecLabel}`);
  recordArchiveSource(formatName, codecLabel, archiveArtifactPath(formatName, codecLabel));
}

function recordArchiveSource(formatName, codecLabel, sourcePath) {
  const sourceKey = archiveSourceKey(formatName, codecLabel);
  const source = {
    format: formatName,
    path: sourcePath,
    payloadBytes: sourcePayloadBytesForFormat(formatName),
    sourceKind: "generated",
  };
  archiveSources.set(sourceKey, source);
  if (!archiveSourcesDefault.has(formatName)) {
    archiveSourcesDefault.set(formatName, source);
  }
  return source;
}

async function archiveSourceCacheReady(sourcePath, markerPath) {
  const [sourceBytes, markerBytes] = await Promise.all([
    guestFileSizeOrNull(sourcePath),
    guestFileSizeOrNull(markerPath),
  ]);
  benchLog(
    `archive cache check source:${sourceBytes ?? "missing"} marker:${markerBytes ?? "missing"} path:${sourcePath}`,
  );
  return sourceBytes !== null && sourceBytes > 0 && markerBytes !== null && markerBytes > 0;
}

async function guestFileSizeOrNull(guestPath) {
  try {
    return await getGuestFileSize(fixtureRootHandle, guestPath);
  } catch {
    return null;
  }
}

async function preparePatchSeedSources() {
  for (const formatName of SELECTED_PATCH_FORMATS) {
    const skipReason = patchCreateSkipReason(formatName);
    if (skipReason) {
      unavailablePatchSeedSources.set(formatName, skipReason);
      continue;
    }

    const extension = PATCH_EXTENSION[formatName];
    if (!extension) {
      unavailablePatchSeedSources.set(formatName, "missing patch extension mapping");
      continue;
    }

    const patchPath = joinGuestPath(ARTIFACT_ROOT, "patch-seed", `${token(formatName)}.${extension}`);
    await removeGuestPath(fixtureRootHandle, patchPath, { recursive: false });
    const { originalPath, modifiedPath } = patchFixturePairForFormat(formatName);
    const result = await runBenchmarkCommandAllowFailure(
      [
        "patch",
        "create",
        "--original",
        originalPath,
        "--modified",
        modifiedPath,
        "--format",
        formatName,
        "--output",
        patchPath,
        "--threads",
        String(THREAD_COUNT),
      ],
      { assumeReady: true },
    );
    if (!result.ok) {
      const terminalLabel = terminalLabelFromResult(result);
      unavailablePatchSeedSources.set(formatName, terminalLabel || `failed to prepare patch seed for ${formatName}`);
      continue;
    }

    patchSeedSources.set(formatName, {
      inputPath: originalPath,
      patchPath,
      sourceKind: "generated",
    });
  }
}

function patchFixturePairForFormat(formatName) {
  if (formatName === "ips" || formatName === "ebp") {
    return {
      modifiedPath: IPS_EBP_PATCH_MODIFIED_PATH,
      originalPath: IPS_EBP_PATCH_ORIGINAL_PATH,
    };
  }
  return {
    modifiedPath: PATCH_MODIFIED_PATH,
    originalPath: PATCH_ORIGINAL_PATH,
  };
}

function resolvePatchApplySource(formatName) {
  return patchSeedSources.get(formatName) ?? null;
}

function patchSourceUnavailableReason(formatName) {
  return unavailablePatchSeedSources.get(formatName) ?? "no prepared patch source";
}

function archiveSourceUnavailableReason(sourceKey) {
  return unavailableArchiveSources.get(sourceKey) ?? "no prepared archive source";
}

function patchCreateSkipReason(formatName) {
  return EXPECTED_PATCH_CREATE_SKIPS[formatName] ?? WASM_PATCH_CREATE_SKIPS[formatName] ?? null;
}

function patchApplySkipReason(formatName) {
  return WASM_PATCH_APPLY_SKIPS[formatName] ?? patchCreateSkipReason(formatName);
}

function extractSkipReason(formatName) {
  return EXPECTED_COMPRESS_SKIPS[formatName] ?? null;
}

function compressOutputPath(formatName, codecLabel) {
  return archiveArtifactPath(formatName, codecLabel);
}

function extractOutputDirPath(formatName, codecLabel) {
  return joinGuestPath(OUTPUT_ROOT, "extract", `${token(formatName)}-${token(codecLabel)}`);
}

function archiveArtifactPath(formatName, codecLabel) {
  return joinGuestPath(
    ARCHIVE_FIXTURE_ROOT,
    `seed-${token(formatName)}-${token(codecLabel)}.${containerSuffix(formatName)}`,
  );
}

function archiveArtifactReadyMarkerPath(formatName, codecLabel) {
  return joinGuestPath(
    ARCHIVE_FIXTURE_ROOT,
    `seed-${token(formatName)}-${token(codecLabel)}.${containerSuffix(formatName)}.ready`,
  );
}

function patchArtifactPathForBench(commandName, formatName) {
  const extension = PATCH_EXTENSION[formatName] ?? "patch";
  return joinGuestPath(OUTPUT_ROOT, commandName, `${token(formatName)}.${extension}`);
}

function patchApplyOutputPath(formatName) {
  return joinGuestPath(OUTPUT_ROOT, "patch-apply", `${token(formatName)}.bin`);
}

function benchOptions({ setup, teardown } = {}) {
  return {
    ...BENCH_OPTIONS,
    ...(setup
      ? {
          setup: (...args) => {
            if (isEmptyWarmupHook(args[1])) return undefined;
            return setup(...args);
          },
        }
      : {}),
    ...(teardown
      ? {
          teardown: (...args) => {
            if (isEmptyWarmupHook(args[1])) return undefined;
            return teardown(...args);
          },
        }
      : {}),
  };
}

function isEmptyWarmupHook(mode) {
  return mode === "warmup" && BENCH_OPTIONS.warmupTime === 0 && BENCH_OPTIONS.warmupIterations === 0;
}

async function prepareOutputFile(guestPath) {
  await ensureRuntimeReady();
  await removeGuestPath(fixtureRootHandle, guestPath, { recursive: false });
}

function benchLog(message) {
  if (readBooleanEnv("ROM_WEAVER_WASM_BENCH_LOG", false)) {
    console.info(`[browser-bench] ${message}`);
  }
}

function compressInputForFormat(formatName) {
  return DISC_COMPRESS_INPUT_FORMATS.has(formatName) ? DISC_SOURCE_PATH : SOURCE_PATH;
}

function sourcePayloadBytesForFormat(formatName) {
  return DISC_COMPRESS_INPUT_FORMATS.has(formatName) ? SOURCE_SIZE_BYTES : SOURCE_SIZE_BYTES;
}

function formatCodecPathId(formatName, codecLabel) {
  return `format:${formatName},codec:${codecLabel}`;
}

function archiveSourceKey(formatName, codecLabel) {
  return `${formatName}|${codecLabel}`;
}

function checksumMultiAlgorithmArgs(algorithms) {
  const args = [];
  for (const algorithm of algorithms) {
    args.push("--algo", algorithm);
  }
  return args;
}

function containerSuffix(formatName) {
  return CONTAINER_SUFFIX[formatName] ?? formatName;
}

function codecCasesForFormat(formatName) {
  const matrixCases = ROM_WEAVER_CODEC_MATRIX_BY_FORMAT[formatName];
  if (Array.isArray(matrixCases)) {
    return matrixCases;
  }
  const defaultCodec = ROM_WEAVER_COMPRESS_CODEC_BY_FORMAT[formatName];
  if (defaultCodec) {
    return [[defaultCodec, defaultCodec]];
  }
  return [["default", null]];
}

function selectedCodecCasesForFormat(formatName) {
  const cases = codecCasesForFormat(formatName);
  if (SELECTED_CODEC_LABELS === null) return cases;
  return cases.filter(([codecLabel]) => SELECTED_CODEC_LABELS.has(codecLabel));
}

function romWeaverCompressArgs({ inputPath, formatName, outputPath, threads, codecOverride = null }) {
  const args = [
    "compress",
    "--input",
    inputPath,
    "--format",
    formatName,
    "--output",
    outputPath,
    "--threads",
    String(threads),
  ];
  const codec = codecOverride ?? ROM_WEAVER_COMPRESS_CODEC_BY_FORMAT[formatName] ?? null;
  if (codec) {
    args.push("--codec", codec);
  }
  return args;
}

async function runBenchmarkCommand(args, command, options = {}) {
  const result = await runBenchmarkCommandAllowFailure(args, options);
  assertRunJsonSucceeded(result, { command });
  return result;
}

async function runBenchmarkCommandAllowFailure(args, { assumeReady = false, wasmRuntime = defaultWasmRuntime() } = {}) {
  if (!assumeReady) {
    await ensureRuntimeReady();
  }
  const worker = workersByRuntime.get(wasmRuntime);
  if (!worker) {
    throw new Error(`benchmark ${wasmRuntime} worker is not initialized`);
  }
  // The browser runtime requires typed command/run-request objects; convert the CLI-style arg
  // arrays the benchmark builds into that shape, mirroring the test suite's worker wrapper.
  return worker.runJson(toTypedRunInput(["--no-progress", ...args]));
}

function defaultWasmRuntime() {
  return WASM_RUNTIME_DEFAULT;
}

function neededWasmRuntimes() {
  return new Set([defaultWasmRuntime()]);
}

function terminalLabelFromResult(result) {
  if (!(result && Array.isArray(result.events)) || result.events.length === 0) {
    return "";
  }
  const terminal = result.events.at(-1);
  return typeof terminal?.label === "string" ? terminal.label : "";
}

async function ensureRuntimeReady() {
  if (initializationPromise == null) {
    initializationPromise = initializeRuntime();
  }
  await initializationPromise;
}

async function initializeRuntime() {
  const opened = await openPersistentBenchRoot(`bench-command-paths-${benchmarkCacheProfileName()}`);
  fixtureName = opened.fixtureName;
  fixtureRootHandle = opened.fixtureRootHandle;
  benchLog(`fixture cache ${fixtureName}`);

  if (NEEDS_RAW_SOURCE || NEEDS_COMPRESS_SOURCE || NEEDS_ARCHIVE_SOURCES) {
    await ensureSourceFixture();
  }
  if (NEEDS_DISC_SOURCE) {
    await ensureDiscSourceFixture();
  }
  if (NEEDS_PATCH_PAIR) {
    await ensurePatchPairFixtures();
  }

  for (const wasmRuntime of neededWasmRuntimes()) {
    const worker = createBrowserWorkerClient({
      defaultThreads: THREAD_COUNT,
    });
    await worker.init({
      defaultThreads: THREAD_COUNT,
      opfsHandle: fixtureRootHandle,
      runtimeMounts: [WORK_GUEST_ROOT],
      wasmUrl: "/rom-weaver-app.wasm",
      workGuestPath: WORK_GUEST_ROOT,
    });
    workersByRuntime.set(wasmRuntime, worker);
  }

  if (NEEDS_CHECKSUM_ARCHIVE_SOURCES) {
    await prepareArchiveSources();
  }
  if (SELECTED_COMMANDS.has("patch-apply")) {
    await preparePatchSeedSources();
  }
  await prepareBenchmarkOutputPaths();
}

async function prepareBenchmarkOutputPaths() {
  await removeGuestPath(fixtureRootHandle, OUTPUT_ROOT, { recursive: true });
}

function toGuestRelativePath(guestPath) {
  const normalized = String(guestPath).replace(/\/+$/, "");
  if (normalized === WORK_GUEST_ROOT) return "";
  const prefix = `${WORK_GUEST_ROOT}/`;
  if (!normalized.startsWith(prefix)) {
    throw new Error(`guest path must start with ${prefix}: ${guestPath}`);
  }
  return normalized.slice(prefix.length);
}

async function removeGuestPath(rootHandle, guestPath, { recursive }) {
  const relativePath = toGuestRelativePath(guestPath);
  if (relativePath.length === 0) return;
  const parts = relativePath.split("/").filter(Boolean);
  const entryName = parts.pop();
  if (!entryName) return;

  let directoryHandle = rootHandle;
  for (const part of parts) {
    try {
      directoryHandle = await directoryHandle.getDirectoryHandle(part, { create: false });
    } catch {
      return;
    }
  }

  try {
    await directoryHandle.removeEntry(entryName, { recursive });
  } catch {
    // Ignore missing-path failures between benchmark cycles.
  }
}

function parseCommandFilter(raw) {
  const values = new Set(parseCsvLower(raw));
  if (values.size === 0) {
    throw new Error("--commands must include at least one command");
  }
  const valid = new Set(["compress", "extract", "checksum", "patch-create", "patch-apply"]);
  for (const value of values) {
    if (!valid.has(value)) {
      throw new Error(`unknown command in --commands: ${value}`);
    }
  }
  return values;
}

function parseValueFilter(raw, validValues, flagName, aliases = null) {
  const values = parseCsvLower(raw).map((value) => aliases?.[value] ?? value);
  if (values.length === 0) {
    throw new Error(`${flagName} must include at least one value`);
  }
  const uniqueValues = new Set(values);
  if (uniqueValues.size === 1 && (uniqueValues.has("all") || uniqueValues.has("*"))) {
    return [...validValues];
  }
  if (uniqueValues.has("all") || uniqueValues.has("*")) {
    throw new Error(`${flagName} cannot combine all/* with specific values`);
  }
  const validSet = new Set(validValues);
  const unknown = [...uniqueValues].filter((value) => !validSet.has(value));
  if (unknown.length > 0) {
    throw new Error(`unknown values in ${flagName}: ${unknown.join(", ")}`);
  }
  return validValues.filter((value) => uniqueValues.has(value));
}

function parseOptionalChecksumComboAlgorithms(raw) {
  const normalized = String(raw).trim().toLowerCase();
  if (["", "none", "off", "false", "0"].includes(normalized)) {
    return [];
  }
  return parseValueFilter(raw, CHECKSUM_ALGORITHMS, "--checksum-combo-algos");
}

function parseOptionalCodecLabels(raw) {
  const normalized = String(raw).trim().toLowerCase();
  if (["", "all", "*"].includes(normalized)) return null;
  return new Set(parseCsvLower(raw));
}

function parseCsvLower(raw) {
  return String(raw)
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

function token(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/--+/g, "-") || "unknown"
  );
}

function benchmarkCacheProfileName() {
  return token(
    [
      `formats-${SELECTED_CONTAINER_FORMATS.join("+")}`,
      `codecs-${SELECTED_CODEC_LABELS === null ? "all" : [...SELECTED_CODEC_LABELS].sort().join("+")}`,
      `patch-${SELECTED_PATCH_FORMATS.join("+")}`,
      `checksums-${SELECTED_CHECKSUM_ALGORITHMS.join("+")}`,
      `modes-${[...SELECTED_CHECKSUM_MODES].sort().join("+")}`,
      `combo-${CHECKSUM_COMBO_ALGORITHMS.join("+") || "none"}`,
      `source-${SOURCE_SIZE_BYTES}`,
      `patch-size-${PATCH_SIZE_BYTES}`,
      `threads-${THREAD_COUNT}`,
      `wasm-${benchmarkWasmRuntimeProfile()}`,
    ].join("__"),
  ).slice(0, 160);
}

function benchmarkWasmRuntimeProfile() {
  return "threaded";
}
