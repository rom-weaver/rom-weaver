/**
 * On-device format DIAGNOSTIC harness - not part of the core wasm runtime.
 *
 * Stands up fixtures and runs every compress/extract/patch round-trip through
 * the browser OPFS/wasm stack, asserting pass/fail patterns. Reachable only
 * from the standalone `mobile-safari-matrix.html` page (via
 * `src/webapp/mobile-safari-matrix.ts`) to verify formats on real iOS Safari /
 * WebKit. The app itself never imports this module.
 */
import { resolveAppleMobileSharedMemoryMaximumPages } from "../lib/runtime/op-memory-estimate.ts";
import {
  ROM_WEAVER_COMPRESSION_METADATA,
  ROM_WEAVER_CONTAINER_FORMATS,
  ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY,
  ROM_WEAVER_PATCH_FORMATS,
} from "./generated/rom-weaver-format-metadata.ts";
import { createRomWeaverCommand, getRomWeaverCommandLabel } from "./rom-weaver-command.ts";
import type {
  RomWeaverBrowserOpfsRunOptions,
  RomWeaverCommand,
  RomWeaverRunJsonEvent,
  RomWeaverRunJsonOptions,
  RomWeaverRunJsonResult,
} from "./rom-weaver-types.d.ts";
import { createBrowserWorkerClient } from "./workers/browser-worker-client.ts";

const OPFS_GUEST_ROOT = "/work";

type BrowserFormatMatrixBytes = string | Uint8Array | ArrayBuffer;
type BrowserFormatMatrixRunOptions = RomWeaverRunJsonOptions<RomWeaverRunJsonEvent, unknown> &
  RomWeaverBrowserOpfsRunOptions;
type BrowserFormatMatrixRunJsonResult = RomWeaverRunJsonResult<RomWeaverRunJsonEvent, unknown>;
type BrowserFormatMatrixRunJson = (
  command: RomWeaverCommand,
  options?: BrowserFormatMatrixRunOptions,
) => Promise<BrowserFormatMatrixRunJsonResult>;
type BrowserFormatMatrixRunCommand = (
  name: string,
  command: RomWeaverCommand,
  options?: BrowserFormatMatrixRunOptions,
) => Promise<BrowserFormatMatrixRunJsonResult>;
type BrowserFormatMatrixFixtureUrls = {
  patch: URL;
  source: URL;
  target: URL;
};
type BrowserFormatMatrixFixtures = {
  patch?: BrowserFormatMatrixBytes;
  source?: BrowserFormatMatrixBytes;
  target?: BrowserFormatMatrixBytes;
};
type BrowserFormatMatrixOptions = {
  clientOptions?: Parameters<typeof createBrowserWorkerClient>[0];
  hdiffFixtures?: BrowserFormatMatrixFixtures;
  hdiffFixtureUrls?: Partial<BrowserFormatMatrixFixtureUrls>;
  initOptions?: Record<string, unknown>;
  onEvent?: (event: RomWeaverRunJsonEvent) => void;
  onStep?: (step: BrowserFormatMatrixStep) => void;
  profile?: BrowserFormatMatrixProfile;
  prefix?: string;
  sourceContents?: BrowserFormatMatrixBytes;
  sourceFileName?: string;
  vcdiffFixtures?: BrowserFormatMatrixFixtures;
  vcdiffFixtureUrls?: Partial<BrowserFormatMatrixFixtureUrls>;
  wasmUrl?: string;
};
type BrowserFormatMatrixCoreFixtures = {
  hdiffPatchPath: string;
  hdiffSourcePath: string;
  hdiffTargetPath: string;
  vcdiffPatchPath: string;
  vcdiffSourcePath: string;
  vcdiffTargetPath: string;
};
type BrowserFormatMatrixCoreOptions = {
  dir: string;
  fixtures: BrowserFormatMatrixCoreFixtures;
  onEvent?: (event: RomWeaverRunJsonEvent) => void;
  onStep?: (step: BrowserFormatMatrixStep) => void;
  opfsHandle: FileSystemDirectoryHandle;
  profile?: BrowserFormatMatrixProfile;
  runJson: BrowserFormatMatrixRunJson;
  sourcePath: string;
};
export type BrowserFormatMatrixProfile = "fast" | "exhaustive";
export type BrowserFormatMatrixStep = {
  command: string;
  durationMs?: number;
  error?: string;
  name: string;
  status: "failed" | "running" | "succeeded";
  terminalStatus?: RomWeaverRunJsonEvent["status"];
  timestamp: string;
};
export type BrowserFormatMatrixSummary = {
  durationMs: number;
  failedSteps: number;
  passedSteps: number;
  steps: BrowserFormatMatrixStep[];
};
type BrowserFormatMatrixState = {
  addStep: (step: BrowserFormatMatrixStep) => void;
  emitEvent: (event: RomWeaverRunJsonEvent) => void;
  summary: () => BrowserFormatMatrixSummary;
};
const TEXT_ENCODER = new TextEncoder();
const DEFAULT_VCDIFF_FIXTURE_URLS = {
  patch: new URL("../../../../tests/fixtures/vcdiff/secondary-djw.xdelta", import.meta.url),
  source: new URL("../../../../tests/fixtures/vcdiff/secondary-source.bin", import.meta.url),
  target: new URL("../../../../tests/fixtures/vcdiff/secondary-target.bin", import.meta.url),
};
const DEFAULT_HDIFF_FIXTURE_URLS = {
  patch: new URL(
    "../../../../crates/rom-weaver-patches/tests/fixtures/hdiffpatch/upstream-hdiff13-zstd.hdiff",
    import.meta.url,
  ),
  source: new URL("../../../../crates/rom-weaver-patches/tests/fixtures/hdiffpatch/source.bin", import.meta.url),
  target: new URL("../../../../crates/rom-weaver-patches/tests/fixtures/hdiffpatch/target.bin", import.meta.url),
};
const PATCH_CREATE_FORMAT_ALIASES = ROM_WEAVER_CREATE_PATCH_FORMAT_POLICY.aliases as Readonly<Record<string, string>>;
const CONTAINER_CREATE_SPECIAL_FAILURE_EXPECTATIONS = new Map<string, RegExp>([["rvz", /failed to open input/i]]);
const BROWSER_FORMAT_MATRIX_CONTAINER_ROUND_TRIP_FORMATS = ROM_WEAVER_CONTAINER_FORMATS.filter(
  (format) => format.capabilities.create && !CONTAINER_CREATE_SPECIAL_FAILURE_EXPECTATIONS.has(format.name),
).map((format) => format.name);
const CONTAINER_SUFFIX_BY_FORMAT: ReadonlyMap<string, string> = new Map(
  ROM_WEAVER_CONTAINER_FORMATS.map((format) => [
    format.name,
    stripLeadingExtensionDot(format.extensions[0] ?? `.${format.name}`),
  ]),
);
const PATCH_EXTENSION_BY_FORMAT = createPatchExtensionMap();
const BROWSER_FORMAT_MATRIX_PATCH_FORMATS = createBrowserFormatMatrixPatchFormats();
type ExhaustiveContainerCase = {
  codec: string;
  format: "7z" | "chd" | "z3ds" | "zip";
  level?: (typeof ROM_WEAVER_COMPRESSION_METADATA.profiles)[number]["name"];
  threads: 1 | 2 | "auto";
};

export function createExhaustiveContainerCases(): ExhaustiveContainerCase[] {
  const threads = [1, 2, "auto"] as const;
  const formats = [
    { codecs: ROM_WEAVER_COMPRESSION_METADATA.codecFields.zipCodec.codecs, format: "zip" },
    { codecs: ROM_WEAVER_COMPRESSION_METADATA.codecFields.sevenZipCodec.codecs, format: "7z" },
    { codecs: ["lzma2", "zlib", "huff", "flac", "zstd"], format: "chd" },
    { codecs: [ROM_WEAVER_COMPRESSION_METADATA.defaults.z3dsCodec], format: "z3ds" },
  ] as const;
  const cases: ExhaustiveContainerCase[] = [];
  for (const { codecs, format } of formats) {
    for (const codec of codecs) {
      const codecMetadata = ROM_WEAVER_COMPRESSION_METADATA.codecs[codec];
      const minimum = format === "chd" && codec === "zlib" ? 1 : codecMetadata?.level?.min;
      const maximum = codecMetadata?.level?.max;
      const levels = codecMetadata?.level
        ? ROM_WEAVER_COMPRESSION_METADATA.profiles
            .filter((profile) => {
              const value = codecMetadata.profileKind === "zstd" ? profile.zstdLevel : profile.standardLevel;
              return value >= (minimum ?? value) && value <= (maximum ?? value);
            })
            .map((profile) => profile.name)
        : [undefined];
      for (const level of levels) {
        for (const threadCount of threads) {
          cases.push({ codec, format, ...(level ? { level } : {}), threads: threadCount });
        }
      }
    }
  }
  return cases;
}

export function getBrowserFormatMatrixMetadataCoverage() {
  return {
    containerCompressFailureFormats: Array.from(createContainerCompressFailureExpectations().keys()),
    containerFormats: ROM_WEAVER_CONTAINER_FORMATS.map((format) => format.name),
    containerRoundTripFormats: BROWSER_FORMAT_MATRIX_CONTAINER_ROUND_TRIP_FORMATS,
    exhaustiveContainerCodecs: Array.from(new Set(createExhaustiveContainerCases().map((entry) => entry.codec))),
    patchFormats: BROWSER_FORMAT_MATRIX_PATCH_FORMATS,
  };
}

export async function runBrowserFullFormatMatrix(options: BrowserFormatMatrixOptions = {}) {
  const root = await navigator.storage.getDirectory();
  const fixtureName = `${options.prefix || "rom-weaver-browser-format-matrix-"}${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
  await root.getDirectoryHandle(fixtureName, { create: true });
  const fixtureGuestRoot = joinGuestPath(OPFS_GUEST_ROOT, fixtureName);
  const sharedMemoryMaximumPages = resolveAppleMobileSharedMemoryMaximumPages();
  const wasmUrl = options.wasmUrl || new URL("./rom-weaver-app.wasm", import.meta.url).href;
  let sharedWorker: ReturnType<typeof createBrowserWorkerClient> | null = null;

  try {
    const mobileModule = sharedMemoryMaximumPages
      ? options.initOptions?.module instanceof WebAssembly.Module
        ? options.initOptions.module
        : await WebAssembly.compileStreaming(fetch(wasmUrl))
      : undefined;
    const createWorker = async () => {
      const worker = createBrowserWorkerClient(options.clientOptions || {});
      try {
        const init = await worker.init({
          runtimeMounts: [OPFS_GUEST_ROOT],
          ...(sharedMemoryMaximumPages ? { sharedMemoryMaximumPages } : {}),
          ...(mobileModule ? { module: mobileModule } : {}),
          wasmUrl,
          workGuestPath: OPFS_GUEST_ROOT,
          ...options.initOptions,
        });
        assert(init?.mode === "browser-opfs", `expected browser-opfs init mode, got ${String(init?.mode)}`);
        return worker;
      } catch (error) {
        worker.terminate();
        throw error;
      }
    };
    sharedWorker = sharedMemoryMaximumPages ? null : await createWorker();

    const sourcePath = joinGuestPath(fixtureGuestRoot, options.sourceFileName || "input.bin");
    await writeGuestFile(root, sourcePath, toBytes(options.sourceContents || "rom-weaver format matrix fixture"));

    const fixtureBytes = await loadMatrixFixtureBytes(options);
    const fixtures = {
      hdiffPatchPath: joinGuestPath(fixtureGuestRoot, "fixtures", "upstream-hdiff13-zstd.hdiff"),
      hdiffSourcePath: joinGuestPath(fixtureGuestRoot, "fixtures", "hdiff-source.bin"),
      hdiffTargetPath: joinGuestPath(fixtureGuestRoot, "fixtures", "hdiff-target.bin"),
      vcdiffPatchPath: joinGuestPath(fixtureGuestRoot, "fixtures", "secondary-djw.xdelta"),
      vcdiffSourcePath: joinGuestPath(fixtureGuestRoot, "fixtures", "secondary-source.bin"),
      vcdiffTargetPath: joinGuestPath(fixtureGuestRoot, "fixtures", "secondary-target.bin"),
    };
    await writeGuestFile(root, fixtures.vcdiffSourcePath, fixtureBytes.vcdiff.source);
    await writeGuestFile(root, fixtures.vcdiffPatchPath, fixtureBytes.vcdiff.patch);
    await writeGuestFile(root, fixtures.vcdiffTargetPath, fixtureBytes.vcdiff.target);
    await writeGuestFile(root, fixtures.hdiffSourcePath, fixtureBytes.hdiff.source);
    await writeGuestFile(root, fixtures.hdiffPatchPath, fixtureBytes.hdiff.patch);
    await writeGuestFile(root, fixtures.hdiffTargetPath, fixtureBytes.hdiff.target);

    return await runBrowserFullFormatMatrixCore({
      dir: fixtureGuestRoot,
      fixtures,
      onEvent: options.onEvent,
      onStep: options.onStep,
      opfsHandle: root,
      ...(options.profile ? { profile: options.profile } : {}),
      runJson: async (command, runOptions) => {
        if (sharedWorker) return sharedWorker.runJson(command, runOptions);
        const worker = await createWorker();
        try {
          return await worker.runJson(command, runOptions);
        } finally {
          worker.terminate();
        }
      },
      sourcePath,
    });
  } finally {
    try {
      sharedWorker?.terminate();
    } catch {
      // Best-effort cleanup; the original matrix error is more relevant.
    }
    await removeFixtureDirectory(root, fixtureName);
  }
}

export async function runBrowserFullFormatMatrixCore(input: BrowserFormatMatrixCoreOptions) {
  const { dir, fixtures, onEvent, onStep, opfsHandle, profile = "fast", runJson } = input;
  const state = createMatrixState({ onEvent, onStep });
  const runCommand: BrowserFormatMatrixRunCommand = (name, command, options) =>
    runMatrixCommand(state, runJson, name, command, options);

  const archiveSourcePath = joinGuestPath(dir, "all-format-source.bin");
  const archiveSource = new Uint8Array(8192);
  for (let index = 0; index < archiveSource.length; index += 1) {
    archiveSource[index] = index % 251;
  }
  archiveSource[archiveSource.length - 1] = 0;
  await writeGuestFile(opfsHandle, archiveSourcePath, archiveSource);

  const containerRoundTripFormats = BROWSER_FORMAT_MATRIX_CONTAINER_ROUND_TRIP_FORMATS;
  for (const format of containerRoundTripFormats) {
    for (const threads of profile === "exhaustive" ? ([1, 2, "auto"] as const) : ([1] as const)) {
      const token = `${formatToken(format)}-${threads}`;
      const archivePath = joinGuestPath(dir, `roundtrip-${token}.${containerSuffix(format)}`);
      const compressResult = await runCommand(
        `compress ${format} threads=${threads}`,
        createRomWeaverCommand("compress", {
          format,
          input: [archiveSourcePath],
          output: archivePath,
          threads,
        }),
        { invalidateMountCacheAfterRun: true },
      );
      assertRunJsonSucceeded(compressResult, { command: "compress" });
      await waitForGuestFile(opfsHandle, archivePath, compressResult);
      const archiveBytes = await readGuestFile(opfsHandle, archivePath);

      const extractDir = joinGuestPath(dir, `roundtrip-${token}-extract`);
      assertRunJsonSucceeded(
        await runCommand(
          `ingest ${format} threads=${threads}`,
          createRomWeaverCommand("ingest", {
            output: extractDir,
            input: archivePath,
            threads,
          }),
          { virtualFiles: [{ bytes: archiveBytes, path: archivePath }] },
        ),
        { command: "ingest" },
      );
    }
  }

  if (profile === "exhaustive") {
    for (const matrixCase of createExhaustiveContainerCases()) {
      const token = [matrixCase.format, matrixCase.codec, matrixCase.level || "no-level", matrixCase.threads]
        .map((value) => formatToken(String(value)))
        .join("-");
      const archivePath = joinGuestPath(dir, `options-${token}.${containerSuffix(matrixCase.format)}`);
      const compressResult = await runCommand(
        `compress ${matrixCase.format} codec=${matrixCase.codec} level=${matrixCase.level || "none"} threads=${matrixCase.threads}`,
        createRomWeaverCommand("compress", {
          codec: [matrixCase.codec],
          format: matrixCase.format,
          input: [archiveSourcePath],
          ...(matrixCase.level ? { level: matrixCase.level } : {}),
          output: archivePath,
          threads: matrixCase.threads,
        }),
        { invalidateMountCacheAfterRun: true },
      );
      assertRunJsonSucceeded(compressResult, { command: "compress" });
      await waitForGuestFile(opfsHandle, archivePath, compressResult);
      const archiveBytes = await readGuestFile(opfsHandle, archivePath);
      assertRunJsonSucceeded(
        await runCommand(
          `ingest options ${token}`,
          createRomWeaverCommand("ingest", {
            output: joinGuestPath(dir, `options-${token}-extract`),
            input: archivePath,
            threads: matrixCase.threads,
          }),
          { virtualFiles: [{ bytes: archiveBytes, path: archivePath }] },
        ),
        { command: "ingest" },
      );
    }
  }

  const containerCompressFailureExpectations = createContainerCompressFailureExpectations();
  for (const [format, pattern] of containerCompressFailureExpectations.entries()) {
    const archivePath = joinGuestPath(dir, `compress-${formatToken(format)}.${containerSuffix(format)}`);
    const compressResult = await runCommand(
      `compress unsupported ${format}`,
      createRomWeaverCommand("compress", {
        format,
        input: [archiveSourcePath],
        output: archivePath,
        threads: 1,
      }),
    );
    assertFailedByPattern(compressResult, pattern, `compress ${format}`);
  }

  const containerExtractFailureExpectations = new Map([
    ["rar", /archive is invalid|unsupported archive signature/i],
    ["tar", /failed to read entire block|unrecognized archive format|archive is invalid/i],
    ["tar.gz", /invalid gzip header|unrecognized archive format|archive is invalid/i],
    ["tar.bz2", /bz2 header missing|unrecognized archive format|archive is invalid/i],
    ["tar.xz", /invalid xz magic bytes|unrecognized archive format|archive is invalid/i],
    ["pbp", /too small to be a pbp container/i],
    ["gcz", /failed to open gcz source/i],
    ["wbfs", /failed to open wbfs source/i],
    ["wia", /failed to open wia source/i],
    ["tgc", /failed to open tgc source/i],
    ["nfs", /failed to open nfs source/i],
    ["rvz", /failed to open rvz source/i],
    ["xiso", /xiso extract is not supported yet|not an Xbox XDVDFS image|not an XDVDFS volume/i],
  ]);
  for (const [format, pattern] of containerExtractFailureExpectations.entries()) {
    const badSourcePath = joinGuestPath(dir, `extract-${formatToken(format)}.${containerSuffix(format)}`);
    await writeGuestFile(opfsHandle, badSourcePath, toBytes("not-a-real-container"));
    const outDir = joinGuestPath(dir, `extract-${formatToken(format)}-out`);
    const extractResult = await runCommand(
      `ingest invalid ${format}`,
      createRomWeaverCommand("ingest", {
        output: outDir,
        input: badSourcePath,
        threads: 1,
      }),
    );
    assertFailedByPattern(extractResult, pattern, `ingest ${format}`);
  }

  const originalPath = joinGuestPath(dir, "all-format-original.bin");
  const modifiedPath = joinGuestPath(dir, "all-format-modified.bin");
  const original = new Uint8Array(4096);
  for (let index = 0; index < original.length; index += 1) {
    original[index] = index % 251;
  }
  const modified = new Uint8Array(original);
  for (let index = 0; index < 300; index += 1) {
    modified[100 + index] = ((modified[100 + index] ?? 0) + 17) % 256;
  }
  await writeGuestFile(opfsHandle, originalPath, original);
  await writeGuestFile(opfsHandle, modifiedPath, modified);

  const patchFormats = BROWSER_FORMAT_MATRIX_PATCH_FORMATS;

  const applyFailureExpectations = new Map([
    ["apsgba", /i\/o error: unsupported|source rom checksum mismatch|validation failed/i],
    ["ppf", /i\/o error: unsupported|source rom checksum mismatch|validation failed/i],
    ["pat", /i\/o error: unsupported|source rom checksum mismatch|validation failed/i],
    ["pmsr", /i\/o error: unsupported|source rom checksum mismatch|validation failed/i],
    ["dps", /i\/o error: unsupported|source rom checksum mismatch|validation failed/i],
  ]);
  const createUnsupportedExpectationPatterns = new Map([
    ["hdiffpatch", /creation is disabled/i],
    ["ninja1", /not currently supported/i],
    ["bsp", /creation is not implemented/i],
  ]);
  const createUnsupportedExpectations = createPatchCreateUnsupportedExpectations(createUnsupportedExpectationPatterns);
  const createFailureExpectations = new Map([
    ["aps", /i\/o error: unsupported|validation failed/i],
    ["bdf", /i\/o error: unsupported|validation failed/i],
    ["dldi", /i\/o error: unsupported|validation failed/i],
  ]);

  for (const format of patchFormats) {
    // Most patch codecs are intrinsically sequential. Exercise the thread interaction on xdelta,
    // whose create/apply paths actually use the requested pool, without multiplying ignored values
    // across every sequential format.
    const threadModes = profile === "exhaustive" && format === "xdelta" ? ([1, 2, "auto"] as const) : ([1] as const);
    for (const threads of threadModes) {
      const extension = patchExtension(format);
      assert(typeof extension === "string", `missing patch extension for ${format}`);
      const patchPath = joinGuestPath(dir, `patch-${format}-${threads}.${extension}`);
      const createResult = await runCommand(
        `patch-create ${format} threads=${threads}`,
        createRomWeaverCommand("patch-create", {
          format,
          modified: modifiedPath,
          original: originalPath,
          output: patchPath,
          threads,
        }),
        {
          virtualFiles: [
            { bytes: original, path: originalPath },
            { bytes: modified, path: modifiedPath },
          ],
        },
      );

      if (createResult.ok) {
        await waitForGuestFile(opfsHandle, patchPath, createResult);
        const patchBytes = await readGuestFile(opfsHandle, patchPath);
        const { applyResult } = await runCreatedPatchApply(runCommand, {
          createResult,
          format,
          originalBytes: original,
          originalPath,
          patchBytes,
          patchPath,
          threads,
        });
        if (applyResult.ok) {
          assertRunJsonSucceeded(applyResult, { command: "patch-apply" });
          continue;
        }

        if (applyFailureExpectations.has(format)) {
          assertFailedByPattern(applyResult, applyFailureExpectations.get(format), `patch-apply ${format}`);
          continue;
        }

        throw new Error(
          `patch-apply ${format} unexpectedly failed: ${String(
            getTerminalEvent(applyResult).label || applyResult.stderr || "",
          )}`,
        );
      }

      if (createUnsupportedExpectations.has(format)) {
        assertFailedByPattern(createResult, createUnsupportedExpectations.get(format), `patch-create ${format}`);
        assert(getTerminalEvent(createResult).status === "unsupported", `patch-create ${format} should be unsupported`);
        continue;
      }

      const createFailurePattern = createFailureExpectations.get(format) ?? applyFailureExpectations.get(format);
      if (createFailurePattern) {
        assertFailedByPattern(createResult, createFailurePattern, `patch-create ${format}`);
        continue;
      }

      throw new Error(
        `patch-create ${format} unexpectedly failed: ${String(
          getTerminalEvent(createResult).label || createResult.stderr || "",
        )}`,
      );
    }
  }

  await runHdiffApplyFixture({ dir, fixtures, opfsHandle, runCommand });
  await runBspApplyFixture({ dir, opfsHandle, runCommand });

  const xdeltaApplyPath = joinGuestPath(dir, "fixture-applied-xdelta.bin");
  const xdeltaApplyEvents: RomWeaverRunJsonEvent[] = [];
  const xdeltaApplyResult = await runPatchApplyNoCompress(
    runCommand,
    {
      inputPath: fixtures.vcdiffSourcePath,
      outputPath: xdeltaApplyPath,
      patchPath: fixtures.vcdiffPatchPath,
    },
    {
      onEvent(event) {
        xdeltaApplyEvents.push(event);
      },
    },
  );
  assertRunJsonSucceeded(xdeltaApplyResult, { command: "patch-apply" });
  for (const event of xdeltaApplyEvents) {
    const format = String(event?.format || "").toLowerCase();
    const percent = typeof event?.percent === "number" ? event.percent : null;
    if (
      event.command === "patch-apply" &&
      event.status === "running" &&
      event.stage === "apply" &&
      format === "xdelta" &&
      percent !== null
    )
      assert(
        percent >= 0 && percent < 100,
        `xdelta patch-apply running apply progress should stay below completion, got ${percent}`,
      );
  }

  const vcdiffPatchPath = joinGuestPath(dir, "fixture-secondary.vcdiff");
  await runCommand(
    `patch-create gdiff fixture`,
    createRomWeaverCommand("patch-create", {
      format: "gdiff",
      modified: fixtures.vcdiffTargetPath,
      original: fixtures.vcdiffSourcePath,
      output: vcdiffPatchPath,
      threads: 1,
    }),
  );
  const vcdiffApplyPath = joinGuestPath(dir, "fixture-applied-vcdiff.bin");
  assertRunJsonSucceeded(
    await runPatchApplyNoCompress(runCommand, {
      inputPath: fixtures.vcdiffSourcePath,
      outputPath: vcdiffApplyPath,
      patchPath: fixtures.vcdiffPatchPath,
    }),
    { command: "patch-apply" },
  );

  return state.summary();
}

async function runHdiffApplyFixture({
  dir,
  fixtures,
  opfsHandle,
  runCommand,
}: {
  dir: string;
  fixtures: BrowserFormatMatrixCoreFixtures;
  opfsHandle: FileSystemDirectoryHandle;
  runCommand: BrowserFormatMatrixRunCommand;
}) {
  if (!(fixtures?.hdiffSourcePath && fixtures?.hdiffPatchPath && fixtures?.hdiffTargetPath)) {
    throw new Error("hdiffpatch fixture paths are required for the full format matrix");
  }

  const outputPath = joinGuestPath(dir, "fixture-applied-hdiffpatch.bin");
  assertRunJsonSucceeded(
    await runPatchApplyNoCompress(runCommand, {
      inputPath: fixtures.hdiffSourcePath,
      outputPath,
      patchPath: fixtures.hdiffPatchPath,
    }),
    { command: "patch-apply" },
  );
  assertBytesEqual(
    await readGuestFile(opfsHandle, outputPath),
    await readGuestFile(opfsHandle, fixtures.hdiffTargetPath),
    "hdiffpatch apply output should match fixture target",
  );
}

async function runBspApplyFixture({
  dir,
  opfsHandle,
  runCommand,
}: {
  dir: string;
  opfsHandle: FileSystemDirectoryHandle;
  runCommand: BrowserFormatMatrixRunCommand;
}) {
  const inputPath = joinGuestPath(dir, "fixture-bsp-input.bin");
  const patchPath = joinGuestPath(dir, "fixture-bsp-update.bsp");
  const outputPath = joinGuestPath(dir, "fixture-applied-bsp.bin");
  await writeGuestFile(opfsHandle, inputPath, new Uint8Array([0x01, 0x02, 0x03]));
  await writeGuestFile(opfsHandle, patchPath, new Uint8Array([0x18, 0xff, 0x06, 0x00, 0x00, 0x00, 0x00]));

  assertRunJsonSucceeded(
    await runPatchApplyNoCompress(runCommand, {
      inputPath,
      outputPath,
      patchPath,
    }),
    { command: "patch-apply" },
  );
  assertBytesEqual(
    await readGuestFile(opfsHandle, outputPath),
    new Uint8Array([0xff, 0x02, 0x03]),
    "BSP apply output should match fixture target",
  );
}

async function runPatchApplyNoCompress(
  runCommand: BrowserFormatMatrixRunCommand,
  { inputPath, patchPath, outputPath }: { inputPath: string; outputPath: string; patchPath: string },
  runOptions: BrowserFormatMatrixRunOptions | undefined = undefined,
) {
  return runCommand(
    `patch-apply ${pathBasename(patchPath)}`,
    createRomWeaverCommand("patch-apply", {
      input: inputPath,
      no_compress: true,
      output: outputPath,
      patches: [patchPath],
      threads: 1,
    }),
    runOptions,
  );
}

async function runCreatedPatchApply(
  runCommand: BrowserFormatMatrixRunCommand,
  {
    createResult,
    format,
    originalBytes,
    originalPath,
    patchBytes,
    patchPath,
    threads,
  }: {
    createResult: BrowserFormatMatrixRunJsonResult;
    format: string;
    originalBytes: Uint8Array;
    originalPath: string;
    patchBytes: Uint8Array;
    patchPath: string;
    threads: 1 | 2 | "auto";
  },
) {
  assert(createResult.ok, `patch-create ${format} should succeed`);
  assert(getTerminalEvent(createResult).status === "succeeded", `patch-create ${format} should finish succeeded`);
  const applyPath = joinGuestPath(pathDirname(patchPath), `patch-applied-${format}-${threads}.bin`);
  const applyResult = await runCommand(
    `patch-apply ${pathBasename(patchPath)} threads=${threads}`,
    createRomWeaverCommand("patch-apply", {
      input: originalPath,
      no_compress: true,
      output: applyPath,
      patches: [patchPath],
      threads,
    }),
    {
      virtualFiles: [
        { bytes: originalBytes, path: originalPath },
        { bytes: patchBytes, path: patchPath },
      ],
    },
  );
  return { applyPath, applyResult };
}

function createMatrixState({
  onEvent,
  onStep,
}: Pick<BrowserFormatMatrixOptions, "onEvent" | "onStep"> = {}): BrowserFormatMatrixState {
  const steps: BrowserFormatMatrixStep[] = [];
  const startedAt = now();
  return {
    addStep(step) {
      steps.push(step);
      onStep?.(step);
    },
    emitEvent(event) {
      onEvent?.(event);
    },
    summary() {
      return {
        durationMs: Math.round(now() - startedAt),
        failedSteps: steps.filter((step) => step.status === "failed").length,
        passedSteps: steps.filter((step) => step.status === "succeeded").length,
        steps,
      };
    },
  };
}

async function runMatrixCommand(
  state: BrowserFormatMatrixState,
  runJson: BrowserFormatMatrixRunJson,
  name: string,
  typedCommand: RomWeaverCommand,
  options: BrowserFormatMatrixRunOptions = {},
) {
  const startedAt = now();
  const commandLabel = getRomWeaverCommandLabel(typedCommand);
  state.addStep({
    command: commandLabel,
    name,
    status: "running",
    timestamp: new Date().toISOString(),
  });
  try {
    const result = await runJson(typedCommand, {
      ...options,
      onEvent(event) {
        state.emitEvent(event);
        options.onEvent?.(event);
      },
    });
    state.addStep({
      command: commandLabel,
      durationMs: Math.round(now() - startedAt),
      name,
      status: "succeeded",
      terminalStatus: getTerminalEvent(result).status,
      timestamp: new Date().toISOString(),
    });
    return result;
  } catch (error) {
    state.addStep({
      command: commandLabel,
      durationMs: Math.round(now() - startedAt),
      error: errorMessage(error),
      name,
      status: "failed",
      timestamp: new Date().toISOString(),
    });
    throw error;
  }
}

function getTerminalEvent(result: BrowserFormatMatrixRunJsonResult): RomWeaverRunJsonEvent {
  assert(Array.isArray(result?.events), "runJson result should include events");
  assert(result.events.length > 0, "runJson result should include at least one event");
  const event = result.events.at(-1);
  assert(event, "runJson result should include a terminal event");
  return event;
}

function assertRunJsonSucceeded(result: BrowserFormatMatrixRunJsonResult, options: { command?: string } = {}) {
  const terminal = getTerminalEvent(result);
  const commandName = options.command ?? "command";
  const failureMessage = [
    `expected ${commandName} to succeed`,
    `exitCode=${result.exitCode}`,
    `ok=${result.ok}`,
    `label=${JSON.stringify(terminal?.label ?? "")}`,
    `details=${JSON.stringify(terminal?.details ?? null)}`,
    `stderr=${JSON.stringify(result.stderr ?? "")}`,
    `error=${JSON.stringify(errorMessage(result.error))}`,
    `stack=${JSON.stringify(errorStack(result.error))}`,
  ].join(" ");
  assert(result.exitCode === 0, failureMessage);
  assert(result.ok === true, failureMessage);
  assert(terminal.status === "succeeded", failureMessage);
  if (typeof options.command === "string") {
    assert(
      terminal.command === options.command,
      `expected terminal command ${options.command}, got ${terminal.command}`,
    );
  }
  return terminal;
}

function assertFailedByPattern(result: BrowserFormatMatrixRunJsonResult, pattern: RegExp | undefined, context: string) {
  assert(pattern, `${context} should have a failure expectation`);
  assert(result.ok === false, `${context} should fail in the current wasm matrix`);
  assert(result.exitCode !== 0, `${context} should not exit with code 0`);
  const terminal = getTerminalEvent(result);
  const label = String(terminal.label || "");
  const stderr = String(result.stderr || "");
  const matches = pattern.test(label) || pattern.test(stderr);
  assert(
    matches,
    `${context} should match ${pattern}; label=${JSON.stringify(label)} stderr=${JSON.stringify(stderr)}`,
  );
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, message: string) {
  assert(
    actual.byteLength === expected.byteLength,
    `${message}; length ${actual.byteLength} !== ${expected.byteLength}`,
  );
  for (let index = 0; index < actual.byteLength; index += 1) {
    assert(actual[index] === expected[index], `${message}; byte ${index} ${actual[index]} !== ${expected[index]}`);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errorMessage(error: unknown) {
  if (!error) return "";
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorStack(error: unknown) {
  const stack = error && typeof error === "object" ? (error as { stack?: unknown }).stack : undefined;
  if (typeof stack === "string") return stack;
  return "";
}

function now() {
  return typeof performance === "object" && typeof performance.now === "function" ? performance.now() : Date.now();
}

async function loadMatrixFixtureBytes(options: BrowserFormatMatrixOptions) {
  const vcdiffUrls = normalizeFixtureUrls(options.vcdiffFixtureUrls, DEFAULT_VCDIFF_FIXTURE_URLS);
  const hdiffUrls = normalizeFixtureUrls(options.hdiffFixtureUrls, DEFAULT_HDIFF_FIXTURE_URLS);
  const [vcdiffSource, vcdiffPatch, vcdiffTarget, hdiffSource, hdiffPatch, hdiffTarget] = await Promise.all([
    loadFixtureBytes(options.vcdiffFixtures?.source, vcdiffUrls.source),
    loadFixtureBytes(options.vcdiffFixtures?.patch, vcdiffUrls.patch),
    loadFixtureBytes(options.vcdiffFixtures?.target, vcdiffUrls.target),
    loadFixtureBytes(options.hdiffFixtures?.source, hdiffUrls.source),
    loadFixtureBytes(options.hdiffFixtures?.patch, hdiffUrls.patch),
    loadFixtureBytes(options.hdiffFixtures?.target, hdiffUrls.target),
  ]);
  return {
    hdiff: {
      patch: hdiffPatch,
      source: hdiffSource,
      target: hdiffTarget,
    },
    vcdiff: {
      patch: vcdiffPatch,
      source: vcdiffSource,
      target: vcdiffTarget,
    },
  };
}

function normalizeFixtureUrls(
  value: Partial<BrowserFormatMatrixFixtureUrls> | undefined,
  defaults: BrowserFormatMatrixFixtureUrls,
): BrowserFormatMatrixFixtureUrls {
  return {
    patch: value?.patch || defaults.patch,
    source: value?.source || defaults.source,
    target: value?.target || defaults.target,
  };
}

async function loadFixtureBytes(value: BrowserFormatMatrixBytes | undefined, fallbackUrl: URL) {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || typeof value === "string") {
    return toBytes(value);
  }
  return fetchBytes(fallbackUrl);
}

async function fetchBytes(url: URL) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch fixture ${url}: ${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function toBytes(value: BrowserFormatMatrixBytes) {
  if (typeof value === "string") return TEXT_ENCODER.encode(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError("expected string, Uint8Array, or ArrayBuffer");
}

function joinGuestPath(...parts: string[]) {
  const tokens: string[] = [];
  for (const part of parts) {
    const value = String(part);
    for (const token of value.split("/")) {
      if (token.length > 0) tokens.push(token);
    }
  }
  return `/${tokens.join("/")}`;
}

async function readGuestFile(rootHandle: FileSystemDirectoryHandle, guestPath: string) {
  const fileHandle = await getGuestFileHandle(rootHandle, guestPath);
  const file = await fileHandle.getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function waitForGuestFile(
  rootHandle: FileSystemDirectoryHandle,
  guestPath: string,
  result: BrowserFormatMatrixRunJsonResult,
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const handle = await getGuestFileHandle(rootHandle, guestPath);
      const file = await handle.getFile();
      if (file.size > 0) return;
    } catch {
      // OPFS visibility can lag a completed threaded writer briefly.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`command succeeded without output ${guestPath}; events=${JSON.stringify(result.events)}`);
}

async function writeGuestFile(rootHandle: FileSystemDirectoryHandle, guestPath: string, contents: Uint8Array) {
  const fileHandle = await getGuestFileHandle(rootHandle, guestPath, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(contents as FileSystemWriteChunkType);
  await writable.close();
}

function pathBasename(path: string) {
  const normalized = String(path).replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index < 0) return normalized;
  return normalized.slice(index + 1);
}

function pathDirname(path: string) {
  const normalized = String(path).replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index <= 0) return "/";
  return normalized.slice(0, index);
}

function toGuestRelativePath(guestPath: string) {
  const normalized = String(guestPath);
  if (normalized === OPFS_GUEST_ROOT) return "";

  const prefix = `${OPFS_GUEST_ROOT}/`;
  if (!normalized.startsWith(prefix)) {
    throw new Error(`guest path must start with ${prefix}: ${guestPath}`);
  }

  return normalized.slice(prefix.length);
}

function splitRelativePath(relativePath: string) {
  if (relativePath.length === 0) return [];
  return relativePath.split("/").filter((token) => token.length > 0);
}

async function getOrCreateDirectoryHandle(rootHandle: FileSystemDirectoryHandle, relativeDirectoryPath: string) {
  const segments = splitRelativePath(relativeDirectoryPath);
  let current = rootHandle;
  for (const segment of segments) {
    current = await current.getDirectoryHandle(segment, { create: true });
  }
  return current;
}

async function getGuestFileHandle(
  rootHandle: FileSystemDirectoryHandle,
  guestPath: string,
  { create = false }: { create?: boolean } = {},
) {
  const relativePath = toGuestRelativePath(guestPath);
  const fileName = pathBasename(relativePath);
  const parentPath = pathDirname(relativePath);
  const parentHandle = await getOrCreateDirectoryHandle(rootHandle, parentPath === "/" ? "" : parentPath);
  return parentHandle.getFileHandle(fileName, { create });
}

async function removeFixtureDirectory(rootHandle: FileSystemDirectoryHandle, directoryName: string) {
  try {
    await rootHandle.removeEntry(directoryName, { recursive: true });
  } catch {
    // Best-effort cleanup for browsers that hold transient OPFS locks after worker termination.
  }
}

function createContainerCompressFailureExpectations() {
  const expectations = new Map<string, RegExp>();
  for (const format of ROM_WEAVER_CONTAINER_FORMATS) {
    if (BROWSER_FORMAT_MATRIX_CONTAINER_ROUND_TRIP_FORMATS.includes(format.name)) continue;
    expectations.set(format.name, CONTAINER_CREATE_SPECIAL_FAILURE_EXPECTATIONS.get(format.name) ?? /extract-only/i);
  }
  return expectations;
}

function createBrowserFormatMatrixPatchFormats() {
  const formats: string[] = [];
  const seen = new Set<string>();
  for (const format of ROM_WEAVER_PATCH_FORMATS) {
    const normalized = normalizePatchCreateFormat(format.name);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    formats.push(normalized);
  }
  return formats;
}

function createPatchCreateUnsupportedExpectations(patterns: ReadonlyMap<string, RegExp>) {
  const expectations = new Map<string, RegExp>();
  for (const format of ROM_WEAVER_PATCH_FORMATS) {
    const normalized = normalizePatchCreateFormat(format.name);
    if (format.capabilities.create || expectations.has(normalized)) continue;
    const pattern = patterns.get(normalized);
    assert(pattern, `missing patch-create unsupported expectation for ${normalized}`);
    expectations.set(normalized, pattern);
  }
  return expectations;
}

function createPatchExtensionMap() {
  const map = new Map<string, string>();
  for (const format of ROM_WEAVER_PATCH_FORMATS) {
    setPatchExtension(map, format.name, format.extensions);
    for (const alias of format.aliases) setPatchExtension(map, alias, format.extensions);
  }
  for (const [alias, canonical] of Object.entries(PATCH_CREATE_FORMAT_ALIASES)) {
    map.set(alias, map.get(canonical) ?? map.get(alias) ?? alias);
  }
  return map;
}

function setPatchExtension(map: Map<string, string>, format: string, extensions: readonly string[]) {
  const normalized = normalizeFormatName(format);
  if (!normalized || map.has(normalized)) return;
  const matchingExtension = extensions.find((extension) => stripLeadingExtensionDot(extension) === normalized);
  map.set(normalized, stripLeadingExtensionDot(matchingExtension ?? extensions[0] ?? `.${normalized}`));
}

function normalizeFormatName(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function normalizePatchCreateFormat(value: string) {
  const normalized = normalizeFormatName(value);
  return PATCH_CREATE_FORMAT_ALIASES[normalized] ?? normalized;
}

function stripLeadingExtensionDot(extension: string) {
  return extension.replace(/^\./, "");
}

function formatToken(value: string) {
  return value.replace(/[^a-z0-9]+/gi, "-");
}

function containerSuffix(format: string) {
  return CONTAINER_SUFFIX_BY_FORMAT.get(format) ?? format;
}

function patchExtension(format: string) {
  return PATCH_EXTENSION_BY_FORMAT.get(format);
}

export function summarizeBrowserFormatMatrixResult(result: Partial<BrowserFormatMatrixSummary> | null | undefined) {
  return [
    `passed=${result?.passedSteps ?? 0}`,
    `failed=${result?.failedSteps ?? 0}`,
    `durationMs=${result?.durationMs ?? 0}`,
  ].join(" ");
}
