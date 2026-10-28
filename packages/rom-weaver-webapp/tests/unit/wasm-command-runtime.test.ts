import OutputCompressionManager from "../../src/lib/compression/output-compression-manager.ts";
import { COMPRESSION_DEFAULTS } from "../../src/lib/compression/compression-metadata.ts";
import { createBrowserChdRuntime } from "../../src/platform/browser/workflow-runtime-chd.ts";
import { createSharedCompressionRuntime } from "../../src/lib/runtime/workflow-runtime-core.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  invokeRomWeaverWeaveCreateWorker,
  invokeRomWeaverWeaveParseWorker,
  invokeRomWeaverCompressionCreateWorker,
  invokeRomWeaverExtractAllWorker,
  invokeRomWeaverCreatePatchCandidatesWorker,
  invokeRomWeaverCreatePatchWorker,
  invokeRomWeaverExtractWorker,
  invokeRomWeaverIdentifyHashWorker,
  invokeRomWeaverIdentifyTitlesWorker,
  invokeRomWeaverIngestWorker,
  invokeRomWeaverPatchApplyWorker,
  invokeRomWeaverPatchValidateWorker,
  invokeRomWeaverPpfUndoWorker,
  invokeRomWeaverTrimWorker,
  normalizeChdCodecArgs,
  normalizeCodecEntries,
  runRomWeaverIngestSidecarsWorker,
  runRomWeaverProbeWorker,
} from "../../src/lib/runtime/wasm-command-runtime.ts";

const mocks = vi.hoisted(() => ({ runRomWeaverJson: vi.fn() }));

vi.mock("../../src/workers/rom-weaver/rom-weaver-runner.ts", () => ({
  runRomWeaverJson: mocks.runRomWeaverJson,
}));

type RunCall = [{ args: Record<string, unknown>; type: string }, Record<string, unknown>];

const succeededResult = (details: unknown, elapsedMs = 250) => ({
  events: [{ details, elapsed_ms: elapsedMs, status: "succeeded" }],
  exitCode: 0,
  ok: true,
  stderr: "",
});

const failedResult = (label: string) => ({
  events: [{ details: {}, label, status: "failed" }],
  exitCode: 2,
  ok: false,
  stderr: "",
});

const lastCall = () => mocks.runRomWeaverJson.mock.calls.at(-1) as RunCall;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("invokeRomWeaverExtractWorker", () => {
  const extractDetails = (path = "/out/rom.sfc") => ({
    emitted_files: [{ file_name: "rom.sfc", path, size_bytes: 4096 }],
  });

  it("rejects a request with no input path or no output directory", async () => {
    await expect(invokeRomWeaverExtractWorker({ inputPath: "  ", outDirPath: "/out" })).rejects.toThrow(
      "Extract input path is required",
    );
    await expect(invokeRomWeaverExtractWorker({ inputPath: "/in.zip", outDirPath: "" })).rejects.toThrow(
      "Extract output directory is required",
    );
  });

  it("dispatches a minimal extract and reports the emitted file", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult(extractDetails()));

    const output = await invokeRomWeaverExtractWorker({ inputPath: " /in.zip ", outDirPath: " /out " });

    expect(lastCall()[0]).toEqual({ args: { input: "/in.zip", output: "/out" }, type: "extract" });
    expect(output).toMatchObject({
      fileName: "rom.sfc",
      filePath: "/out/rom.sfc",
      size: 4096,
    });
    expect(output.timing).toEqual({ elapsedMs: 250, elapsedSeconds: 0.25 });
  });

  it("passes the entry filter, the ignore flags, and the thread budget through", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult(extractDetails()));

    await invokeRomWeaverExtractWorker({
      inputPath: "/in.zip",
      noIgnore: true,
      noNestedExtract: true,
      outDirPath: "/out",
      select: [" keep.bin ", "", "  ", "other.bin"],
      threads: 4,
    });

    expect(lastCall()[0].args).toMatchObject({
      no_ignore: true,
      no_nested_extract: true,
      select: ["keep.bin", "other.bin"],
      threads: 4,
    });
  });

  it("omits the entry filter when the caller passes something that is not a list", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult(extractDetails()));

    await invokeRomWeaverExtractWorker({ inputPath: "/in.zip", outDirPath: "/out", select: undefined });

    expect(lastCall()[0].args).not.toHaveProperty("select");
  });

  it("names the output from the selected entry when the emitted file has no name", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({ emitted_files: [{ path: "/out/nested/data.bin" }] }));

    const output = await invokeRomWeaverExtractWorker({
      inputPath: "/in.zip",
      outDirPath: "/out",
      select: ["chosen.bin"],
    });

    expect(output.fileName).toBe("data.bin");
  });

  it("reports a run that emitted no output file", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({ emitted_files: [] }));

    await expect(invokeRomWeaverExtractWorker({ inputPath: "/in.zip", outDirPath: "/out" })).rejects.toThrow(
      "Extraction returned no output file",
    );
  });

  it("reports a failed extraction", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(failedResult("archive is corrupt"));

    await expect(invokeRomWeaverExtractWorker({ inputPath: "/in.zip", outDirPath: "/out" })).rejects.toThrow(
      /archive is corrupt|Extraction failed/,
    );
  });

  it("relays progress events to the caller", async () => {
    mocks.runRomWeaverJson.mockImplementation((_command: unknown, options: { onEvent?: (event: unknown) => void }) => {
      options.onEvent?.({ percent: 50, status: "running", step: "extract" });
      return Promise.resolve(succeededResult(extractDetails()));
    });
    const onProgress = vi.fn();

    await invokeRomWeaverExtractWorker({ inputPath: "/in.zip", outDirPath: "/out" }, onProgress);

    expect(onProgress).toHaveBeenCalled();
  });

  it("returns every emitted file and disables interactive selection for extract-all", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(
      succeededResult({
        emitted_files: [
          { file_name: "one.bin", path: "/out/folder/one.bin", size_bytes: 1 },
          { file_name: "two.bin", path: "/out/deeper/two.bin", size_bytes: 2 },
        ],
      }),
    );

    const outputs = await invokeRomWeaverExtractAllWorker({
      inputPath: "/in.chd",
      interactiveSelectionEnabled: false,
      noIgnore: true,
      outDirPath: "/out",
      splitBin: true,
    });

    expect(outputs).toHaveLength(2);
    expect(lastCall()[0].args).toMatchObject({ no_ignore: true, split_bin: true });
    expect(lastCall()[0].args).not.toHaveProperty("select");
    expect(lastCall()[1]).toMatchObject({ interactiveSelectionEnabled: false });
  });
});

describe("runtime argument normalization", () => {
  it("flattens, splits, trims, floors, and deduplicates codec values", () => {
    expect(normalizeCodecEntries("lzma+zstd:3")).toEqual(["lzma", "zstd:3"]);
    expect(
      normalizeCodecEntries([
        " lzma, zstd:3 ",
        ["lzma", 7.9, Number.POSITIVE_INFINITY],
        { " bzip2 ": true, zstd: " 5 ", disabled: false, empty: "0", invalid: {}, skip: null },
      ]),
    ).toEqual(["lzma", "zstd:3", "7", "bzip2", "zstd:5"]);
  });

  it("strips conflicting CHD codec levels while preserving a compatible list", () => {
    expect(normalizeChdCodecArgs(["lzma:1", "zstd:2", "lzma:1"])).toEqual({
      codecs: ["lzma", "zstd"],
      stripped: true,
    });
    const compatible = ["lzma:3", "zstd:3"];
    expect(normalizeChdCodecArgs(compatible)).toEqual({ codecs: compatible, stripped: false });
  });
});

describe("runRomWeaverProbeWorker", () => {
  it("probes both entry kinds and normalizes string and record entries", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(
      succeededResult({
        container: {
          entry_records: ["folder/game.sfc", { file_name: "patch.ips", size_bytes: 42 }, { name: "ignored.bin" }],
        },
        platform: " Super Nintendo ",
      }),
    );
    const onProgress = vi.fn();

    await expect(
      runRomWeaverProbeWorker({ patchFilter: true, romFilter: true, sourcePath: " /archive.zip " }, onProgress),
    ).resolves.toEqual({
      entries: [
        { fileName: "folder/game.sfc", filename: "folder/game.sfc", name: "game.sfc" },
        { fileName: "patch.ips", filename: "patch.ips", name: "patch.ips", size: 42 },
        { fileName: "ignored.bin", filename: "ignored.bin", name: "ignored.bin" },
      ],
      platform: "Super Nintendo",
    });
    expect(lastCall()[0]).toEqual({
      args: { filter: ["rom", "patch"], input: "/archive.zip", no_extract: true },
      type: "probe",
    });
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("reports a CHD header's digests alongside the platform", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(
      succeededResult({
        chd: { media_kind: "cd", raw_sha1: " abc ", sha1: "def" },
        container: { entry_records: ["game.bin"] },
        platform: "Sony PlayStation",
      }),
    );

    await expect(runRomWeaverProbeWorker({ romFilter: true, sourcePath: "/game.chd" })).resolves.toMatchObject({
      chd: { rawSha1: "abc", sha1: "def" },
      platform: "Sony PlayStation",
    });
  });

  it("reports validated PBP disc and stored-block counts", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({ pbp: { disc_count: 2, stored_block_count: 3 } }));
    await expect(runRomWeaverProbeWorker({ sourcePath: "/game.pbp" })).resolves.toMatchObject({
      pbp: { discCount: 2, storedBlockCount: 3 },
    });
  });

  it.each([
    {},
    { disc_count: 0, stored_block_count: 0 },
    { disc_count: 6, stored_block_count: 0 },
    { disc_count: 2, stored_block_count: -1 },
    { disc_count: 2, stored_block_count: 1.5 },
    { disc_count: "2", stored_block_count: 0 },
  ])("omits invalid PBP metadata %j", async (pbp) => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({ pbp }));
    await expect(runRomWeaverProbeWorker({ sourcePath: "/game.pbp" })).resolves.not.toHaveProperty("pbp");
  });

  it("omits the chd field for a container without header digests", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({ container: { entry_records: ["game.sfc"] } }));

    await expect(runRomWeaverProbeWorker({ sourcePath: "/game.zip" })).resolves.not.toHaveProperty("chd");
  });

  it("rejects a probe with no source path", async () => {
    await expect(runRomWeaverProbeWorker({ sourcePath: " " })).rejects.toThrow(
      "Container probe source path is required",
    );
  });
});

describe("runRomWeaverIngestSidecarsWorker", () => {
  it("returns no matches without a ROM or patch names", async () => {
    await expect(runRomWeaverIngestSidecarsWorker({ patchNames: [], romName: "game.sfc" })).resolves.toEqual([]);
    await expect(runRomWeaverIngestSidecarsWorker({ patchNames: ["game.ips"], romName: " " })).resolves.toEqual([]);
    expect(mocks.runRomWeaverJson).not.toHaveBeenCalled();
  });

  it("filters malformed sidecar matches and defaults invalid order values", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(
      succeededResult({
        sidecar_matches: [{ name: "game.ips", order: 2 }, { name: "bad.ips", order: "nope" }, {}, null],
      }),
    );

    await expect(
      runRomWeaverIngestSidecarsWorker({ patchNames: [" game.ips "], romName: " game.sfc " }),
    ).resolves.toEqual([
      { name: "game.ips", order: 2 },
      { name: "bad.ips", order: 0 },
    ]);
    expect(lastCall()[0]).toEqual({
      args: {
        input: "game.sfc",
        output: "/work/sidecar-match",
        sidecar_names: [" game.ips "],
        sidecar_only: true,
      },
      type: "ingest",
    });
  });
});

describe("invokeRomWeaverIngestWorker", () => {
  const ingestDetails = () => ({
    ingest: {
      assets: [{ checksums: { CRC32: "ABCDEF" }, copied_in_place: true, path: "/out/game.sfc", size_bytes: 12 }],
      is_rom: true,
      kind: "rom",
      patches: [],
      source_file_name: "game.zip",
    },
  });

  it("dispatches the consolidated ingest options and parses the ROM result", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult(ingestDetails()));

    await expect(
      invokeRomWeaverIngestWorker({
        checksumAlgorithms: ["CRC32", " sha1 "],
        databasePaths: [" /db.rwfp1 ", ""],
        interactiveSelectionEnabled: false,
        noIgnore: true,
        noNestedExtract: true,
        outDirPath: " /out ",
        select: [" game.sfc ", ""],
        sourcePath: " game.zip ",
        splitBin: false,
        threads: 3,
      }),
    ).resolves.toMatchObject({
      assets: [{ checksums: { crc32: "ABCDEF" }, path: "/out/game.sfc", sizeBytes: 12 }],
      isRom: true,
      kind: "rom",
      sourceFileName: "game.zip",
    });
    expect(lastCall()[0]).toEqual({
      args: {
        checksum: ["crc32", "sha1"],
        database: ["/db.rwfp1"],
        input: "game.zip",
        no_ignore: true,
        no_nested_extract: true,
        output: "/out",
        select: ["game.sfc"],
        split_bin: false,
        threads: 3,
      },
      type: "ingest",
    });
    expect(lastCall()[1]).toHaveProperty("interactiveSelectionEnabled", false);
  });

  it("rejects malformed ingest output and missing paths", async () => {
    await expect(invokeRomWeaverIngestWorker({ outDirPath: "/out", sourcePath: " " })).rejects.toThrow(
      "Ingest source path is required",
    );
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({}));
    await expect(invokeRomWeaverIngestWorker({ outDirPath: "/out", sourcePath: "/input.bin" })).rejects.toThrow(
      "Ingest result was missing or malformed",
    );
  });
});

describe("weave runtime workers", () => {
  it("parses a weave and forwards an optional extraction directory", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(
      succeededResult({ weave: { weave: { patches: [], version: 1 }, patch_sources: [], source_kind: "json" } }),
    );

    await expect(
      invokeRomWeaverWeaveParseWorker({ extractDirPath: " /out ", sourcePath: " weave.json " }),
    ).resolves.toMatchObject({ weave: { version: 1 }, patchSources: [], sourceKind: "json" });
    expect(lastCall()[0]).toEqual({
      args: { args: { input: "weave.json", output: "/out" }, type: "parse" },
      type: "weave",
    });
  });

  it("creates a weave with aligned metadata and expected checks", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(
      succeededResult({
        weave_create: { weave: { patches: [], version: 1 }, weave_path: "/out/weave.json", warnings: [] },
      }),
    );

    await expect(
      invokeRomWeaverWeaveCreateWorker({
        weavePath: " /weave.zip ",
        weaveRomPath: " /rom.sfc ",
        noWeaveRom: true,
        outputCheck: " sha1=abc ",
        outputHeader: "strip",
        outputName: "patched.sfc",
        outputPath: " /out/weave.json ",
        patchAuthors: [" Author "],
        patchBases: ["auto", "previous"],
        patchHeaders: ["auto", "keep"],
        patchNames: [" First "],
        patchOptionals: [false, true],
        patchPaths: [" /a.ips ", " /b.ips "],
        patchVersions: ["1.0"],
        romChecksums: "crc32=1234, sha1=abcd",
        romName: " input.sfc ",
        romPath: " /input.sfc ",
        romSize: 100,
      }),
    ).resolves.toMatchObject({ weavePath: "/out/weave.json" });
    expect(lastCall()[0]).toEqual({
      args: {
        args: {
          assume_in: ["crc32=1234", "sha1=abcd", "size=100"],
          weave: "/weave.zip",
          weave_rom: "/rom.sfc",
          no_weave_rom: true,
          output: "/out/weave.json",
          output_check: ["sha1=abc"],
          output_header: "strip",
          output_name: "patched.sfc",
          patch: ["/a.ips", "/b.ips"],
          patch_author: ["Author", ""],
          patch_basis: ["auto", "previous"],
          patch_header: ["auto", "keep"],
          patch_name: ["First", ""],
          patch_optional: [false, true],
          patch_version: ["1.0", ""],
          rom: "/input.sfc",
          rom_name: "input.sfc",
        },
        type: "create",
      },
      type: "weave",
    });
  });
});

describe("output-producing runtime workers", () => {
  it.each([32768, 65536, 1048576])("dispatches an RVZ block size of %i bytes", async (rvzBlockSize) => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({}));
    const input = {
      format: "rvz",
      inputPaths: ["/in/game.iso"],
      outputFileName: "game.rvz",
      rvzBlockSize: String(rvzBlockSize),
    };
    await invokeRomWeaverCompressionCreateWorker(input);
    expect(lastCall()[0].args).toMatchObject({ rvz_block_size: rvzBlockSize });
  });

  it.each([undefined, null, ""])("omits the RVZ block size when unset (%s)", async (rvzBlockSize) => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({}));
    const input = {
      format: "rvz",
      inputPaths: ["/in/game.iso"],
      outputFileName: "game.rvz",
      rvzBlockSize,
    };
    await invokeRomWeaverCompressionCreateWorker(input);
    expect(lastCall()[0].args).not.toHaveProperty("rvz_block_size");
  });

  it.each(["not-a-number", "0", "1", "65535", "32768.5", "2147483648"])(
    "rejects invalid RVZ block size %s before starting the worker",
    async (rvzBlockSize) => {
      mocks.runRomWeaverJson.mockResolvedValue(succeededResult({}));
      const input = {
        format: "rvz",
        inputPaths: ["/in/game.iso"],
        outputFileName: "game.rvz",
        rvzBlockSize,
      };
      await expect(invokeRomWeaverCompressionCreateWorker(input)).rejects.toThrow("RVZ block size");
      expect(mocks.runRomWeaverJson).not.toHaveBeenCalled();
    },
  );

  it.each(["cd", "dvd"] as const)("dispatches default %s codecs with Min, Medium, and Max profiles", async (mode) => {
    mocks.runRomWeaverJson.mockResolvedValue(
      succeededResult({ emitted_files: [{ path: "/out/game.chd", size_bytes: 99 }] }),
    );
    const chdRuntime = createBrowserChdRuntime({
      stageSource: async () => ({ filePath: "/in/game.bin", cleanup: async () => undefined }),
      createWorkerOutput: async (result: unknown) => result,
    } as never);
    const runtime = createSharedCompressionRuntime({}, chdRuntime);
    for (const compressionProfile of ["min", "medium", "max"] as const) {
      const codecs = OutputCompressionManager.getChdCodecsForMode(mode, {
        chdCreateCdCodecs: COMPRESSION_DEFAULTS.chdCreateCdCodecs,
        chdCreateDvdCodecs: COMPRESSION_DEFAULTS.chdCreateDvdCodecs,
        compressionProfile,
      });
      await runtime.create?.({
        source: { fileName: "game.bin" },
        fileName: "game.bin",
        outputName: "game.chd",
        format: "chd",
        romSpecific: { chd: { mode, compressionCodecs: codecs, compressionProfile } },
      } as never);
      expect(lastCall()[0].args).toMatchObject({
        format: `chd-${mode}`,
        level: compressionProfile,
        codec:
          compressionProfile === "medium"
            ? codecs.split(",")
            : COMPRESSION_DEFAULTS[mode === "cd" ? "chdCreateCdCodecs" : "chdCreateDvdCodecs"].split(","),
      });
    }
  });

  it("retains a single explicit CHD codec level with a selected profile", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({}));
    await invokeRomWeaverCompressionCreateWorker({
      codecs: ["cdzl:1"],
      format: "chd-cd",
      levelProfile: "max",
      inputPaths: ["/in/game.bin"],
      outputFileName: "game.chd",
    });
    expect(lastCall()[0].args).toMatchObject({ codec: ["cdzl:1"], level: "max" });
  });

  it("creates a compressed output and strips conflicting CHD codec levels", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(
      succeededResult({ emitted_files: [{ path: "/out/game.chd", size_bytes: 99 }] }),
    );

    const output = await invokeRomWeaverCompressionCreateWorker({
      codecs: ["lzma:1", "zstd:2"],
      format: "chd",
      inputPaths: ["/in/game.bin"],
      outputFileName: "game.chd",
      threads: 2,
    });

    expect(output).toMatchObject({ fileName: "game.chd", filePath: "/out/game.chd", size: 99 });
    expect(lastCall()[0].args).toMatchObject({
      codec: ["lzma", "zstd"],
      format: "chd",
      input: ["/in/game.bin"],
      output: expect.any(String),
    });
  });

  it("passes archive entry names aligned with compression inputs", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(
      succeededResult({ emitted_files: [{ path: "/out/files.zip", size_bytes: 20 }] }),
    );

    await invokeRomWeaverCompressionCreateWorker({
      entryNames: ["folder/one.bin", "deeper/two.bin"],
      format: "zip",
      inputPaths: ["/in/one.bin", "/in/two.bin"],
      outputFileName: "files.zip",
    });

    expect(lastCall()[0].args).toMatchObject({
      entry_names: ["folder/one.bin", "deeper/two.bin"],
      input: ["/in/one.bin", "/in/two.bin"],
    });
  });

  it("applies patches with per-patch headers and reports the apply summary", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(
      succeededResult({ emitted_files: [{ path: "/out/result.sfc", size_bytes: 321 }] }),
    );

    const output = await invokeRomWeaverPatchApplyWorker({
      inputSize: 100,
      options: {
        appendOutputSuffix: false,
        fixChecksum: true,
        headerModes: ["keep", "unknown"],
        n64ByteOrders: ["little-endian", "invalid"],
        patchBasis: ["base"],
        requireInputChecksumMatch: true,
        validateWithChecksums: ["crc32=abc"],
        validateWithOutputChecksums: ["sha1=def"],
      },
      patchFiles: [
        { patchFileName: "first.bps", patchFilePath: "/first.bps", patchFormat: "bps" },
        { patchFileName: "second.xdelta", patchFilePath: "/second.xdelta", patchFormat: "xdelta" },
      ],
      romFileName: "game.sfc",
      romFilePath: "/game.sfc",
    });

    expect(output).toMatchObject({ fileName: "result.sfc", filePath: "/out/result.sfc", size: 321 });
    expect(output.applySummary).toMatchObject({
      outputSize: 321,
      patches: [
        { fileName: "first.bps", format: "PATCH" },
        { fileName: "second.xdelta", format: "PATCH" },
      ],
      rom: { fileName: "game.sfc" },
    });
    expect(lastCall()[0].args).toMatchObject({
      args: {
        expect_in: ["crc32=abc"],
        expect_out: ["sha1=def"],
        filter: ["rom", "patch"],
        ignore_checksum_validation: false,
        input: "/game.sfc",
        n64_byte_order: ["little-endian", "auto"],
        no_compress: true,
        output: expect.any(String),
        output_header: "auto",
        patch_basis: ["base"],
        patch_header: ["keep", "auto"],
        patches: ["/first.bps", "/second.xdelta"],
        repair_checksum: true,
      },
      type: "apply",
    });
  });

  it("rejects unsupported trim inputs before resolving an output", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(
      succeededResult({ processed: 0, trimmed: 0, already_target: 0, skipped_unsupported: 1 }),
    );
    await expect(
      invokeRomWeaverTrimWorker({ outputName: "trimmed.bin", sourceFilePath: "/unsupported.bin" }),
    ).rejects.toThrow("This input does not support trimming");
  });

  it("retains the output of an already trimmed ROM", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(
      succeededResult({
        processed: 1,
        trimmed: 0,
        already_target: 1,
        skipped_unsupported: 0,
        emitted_files: [{ path: "/out/game.nds", size_bytes: 12288 }],
      }),
    );
    await expect(invokeRomWeaverTrimWorker({ sourceFilePath: "/game.nds" })).resolves.toMatchObject({
      filePath: "/out/game.nds",
      size: 12288,
    });
  });

  it("names a lossless disc trim by its actual format and retains logical size metadata", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(
      succeededResult({
        emitted_files: [{ path: "/out/trimmed.iso", size_bytes: 700 }],
        output_format: "rvz",
        input_size: 65536,
        raw_size: 65536,
      }),
    );
    await expect(
      invokeRomWeaverTrimWorker({ outputName: "trimmed.iso", sourceFilePath: "/game.iso" }),
    ).resolves.toMatchObject({
      fileName: "trimmed.rvz",
      filePath: "/out/trimmed.iso",
      size: 700,
      trimSizeSummary: { inputSize: 65536, rawSize: 65536 },
    });
  });

  it("creates a patch, trims a ROM, and undoes a PPF", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(
      succeededResult({ emitted_files: [{ path: "/out/custom.bin", size_bytes: 7 }] }),
    );

    await expect(
      invokeRomWeaverCreatePatchWorker({
        checksumName: true,
        format: "ips",
        modifiedFilePath: "/new.sfc",
        originalFilePath: "/old.sfc",
        outputName: "custom.ips",
        sourceCrc32: "1234",
      }),
    ).resolves.toMatchObject({ fileName: "custom.bin", filePath: "/out/custom.bin", size: 7 });
    expect(lastCall()[0].args).toMatchObject({
      args: { assume_in: ["crc32=1234"], checksum_name: true, format: "ips" },
      type: "create",
    });

    await expect(
      invokeRomWeaverTrimWorker({ extension: " .trim ", outputName: "trimmed.bin", sourceFilePath: "/game.sfc" }),
    ).resolves.toMatchObject({ fileName: "trimmed.bin", filePath: "/out/custom.bin" });
    expect(lastCall()[0]).toEqual({
      args: {
        dry_run: false,
        extension: ".trim",
        in_place: false,
        input: ["/game.sfc"],
        output: expect.any(String),
        revert: false,
      },
      type: "trim",
    });

    await expect(
      invokeRomWeaverPpfUndoWorker({
        outputName: "restored.sfc",
        patchFilePath: "/patch.ppf",
        romFilePath: "/game.sfc",
      }),
    ).resolves.toMatchObject({ fileName: "restored.sfc", filePath: "/out/custom.bin" });
    expect(lastCall()[0]).toEqual({
      args: {
        args: {
          no_extract: true,
          no_compress: true,
          output: expect.any(String),
          patch: "/patch.ppf",
          rom: "/game.sfc",
        },
        type: "ppf-undo",
      },
      type: "tools",
    });
  });

  it("passes PPF disc targets and thread settings, retains emitted companions, and relays report warnings", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(
      succeededResult({
        warnings: ["Disc warning"],
        emitted_files: [
          { path: "/out/restored.cue", size_bytes: 17 },
          { path: "/out/track.bin", size_bytes: 32 },
        ],
      }),
    );
    const onWarning = vi.fn();
    await expect(
      invokeRomWeaverPpfUndoWorker({
        outputName: "restored.cue",
        romFilePath: "/disc.cue",
        patchFilePath: "/undo.ppf",
        target: "track.bin",
        onWarning,
        settings: { workers: { threads: 2 }, output: { container: { profile: "high", zipCodec: "store" } } },
      }),
    ).resolves.toMatchObject({
      fileName: "restored.cue",
      filePath: "/out/restored.cue",
      files: expect.arrayContaining([expect.objectContaining({ path: "/out/track.bin" })]),
    });
    expect(lastCall()[0].args.args).toMatchObject({
      no_extract: true,
      no_compress: true,
      threads: 2,
      target: "track.bin",
      rom: "/disc.cue",
      patch: "/undo.ppf",
    });
    expect(onWarning).toHaveBeenCalledWith("Disc warning");
  });
});

describe("invokeRomWeaverIdentifyHashWorker", () => {
  const identifyDetails = () => ({
    identify: { checksums: { crc32: "abcdef" }, input: "/rom.sfc", matches: [], status: "unknown" },
  });

  it("rejects a request with no hash", async () => {
    await expect(invokeRomWeaverIdentifyHashWorker({ hash: "   " })).rejects.toThrow("Identify hash is required");
  });

  it("lower-cases the hash and forwards the database list", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult(identifyDetails()));

    await invokeRomWeaverIdentifyHashWorker({ databasePaths: [" /db.dat ", ""], hash: " ABCDEF " });

    expect(lastCall()[0]).toEqual({ args: { database: ["/db.dat"], hash: ["abcdef"] }, type: "identify" });
  });

  it("omits an empty database list", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult(identifyDetails()));

    await invokeRomWeaverIdentifyHashWorker({ hash: "abc" });

    expect(lastCall()[0].args).not.toHaveProperty("database");
  });

  it("reports a malformed identify payload", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({}));

    await expect(invokeRomWeaverIdentifyHashWorker({ hash: "abc" })).rejects.toThrow(
      "Identify result was missing or malformed",
    );
  });

  it("reports a failed identify run", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(failedResult("no database loaded"));

    await expect(invokeRomWeaverIdentifyHashWorker({ hash: "abc" })).rejects.toThrow(
      /no database loaded|Identify failed/,
    );
  });
});

describe("invokeRomWeaverIdentifyTitlesWorker", () => {
  const titleSearchDetails = () => ({
    identifyTitles: { matches: [{ name: "The Legend of Zelda", score: 0, slugs: ["nintendo-nes"] }] },
  });

  it("stages the title-index path in the identify command and maps infinity to u32::MAX", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult(titleSearchDetails()));

    await expect(
      invokeRomWeaverIdentifyTitlesWorker({ name: " zelda ", titleIndexPath: " /db/titles.json ", limit: Infinity }),
    ).resolves.toMatchObject({ matches: [{ name: "The Legend of Zelda", score: 0, slugs: ["nintendo-nes"] }] });

    expect(lastCall()[0]).toEqual({
      args: { limit: 0xffff_ffff, name: "zelda", title_index: "/db/titles.json" },
      type: "identify",
    });
  });

  it("uses the command default when no limit is requested", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult(titleSearchDetails()));

    await invokeRomWeaverIdentifyTitlesWorker({ name: "zelda", titleIndexPath: "/db/titles.json" });

    expect(lastCall()[0].args).not.toHaveProperty("limit");
  });

  it("rejects malformed title-search output", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({ identifyTitles: { matches: [{ name: "Zelda" }] } }));

    await expect(
      invokeRomWeaverIdentifyTitlesWorker({ name: "zelda", titleIndexPath: "/db/titles.json" }),
    ).rejects.toThrow("Identify title search result was missing or malformed");
  });
});

describe("invokeRomWeaverPatchValidateWorker", () => {
  it.each([undefined, ["crc32=e991ecc0"]])(
    "leaves UPS endpoint selection to the engine with explicit checks %j",
    async (validateWithChecksums) => {
      mocks.runRomWeaverJson.mockResolvedValue(succeededResult({ valid: true }));
      await invokeRomWeaverPatchValidateWorker({
        options: {
          plan: true,
          validateWithChecksums,
          validationRequirements: [{ sourceCrc32: "b1314226", sourceSize: 4096 }],
        },
        patchFiles: [{ patchFileName: "reverse.ups", patchFilePath: "/reverse.ups", patchFormat: "ups" }],
        romFileName: "modified.bin",
        romFilePath: "/modified.bin",
      });
      const args = lastCall()[0].args.args as Record<string, unknown>;
      expect(args.ignore_checksum_validation).toBe(false);
      expect(args.plan).toBe(true);
      if (validateWithChecksums) expect(args.expect_in).toEqual(validateWithChecksums);
      else expect(args).not.toHaveProperty("expect_in");
    },
  );

  it.each([
    ["ups", undefined],
    ["ips", 0],
  ])("keeps the worker pool for %s validation only when it hashes the source", async (patchFormat, defaultThreads) => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({ valid: true }));
    await invokeRomWeaverPatchValidateWorker({
      options: { plan: true },
      patchFiles: [{ patchFileName: `p.${patchFormat}`, patchFilePath: `/p.${patchFormat}`, patchFormat }],
      romFileName: "rom.bin",
      romFilePath: "/rom.bin",
    });
    expect((lastCall()[1] as { defaultThreads?: number }).defaultThreads).toBe(defaultThreads);
  });

  const validateInput = () => ({
    patchFiles: [
      { patchFileName: "a.ips", patchFilePath: "/a.ips", patchFormat: "ips" },
      { patchFileName: "b.ips", patchFilePath: "/b.ips", patchFormat: "ips" },
    ],
    romFileName: "rom.sfc",
    romFilePath: "/rom.sfc",
  });

  it("reads the independent-mode per-patch verdicts", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(
      succeededResult({
        patch_validation: {
          per_patch: [
            { format: "ips", index: 0, patch: "/a.ips", status: "passed" },
            { index: 1, message: "checksum mismatch", status: "failed" },
            { index: 2, message: "IPS patch ended unexpectedly", status: "failed", unreadable: true },
            { index: -1, status: "passed" },
            { index: "not-a-number", status: "passed" },
            null,
            "nope",
          ],
        },
        valid: true,
      }),
    );

    const result = await invokeRomWeaverPatchValidateWorker(validateInput());

    expect(result.perPatch).toEqual([
      { format: "ips", index: 0, patch: "/a.ips", status: "passed" },
      { index: 1, message: "checksum mismatch", status: "failed" },
      { index: 2, message: "IPS patch ended unexpectedly", status: "failed", unreadable: true },
    ]);
  });

  it("returns no per-patch verdicts for the chained default mode", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({ patch_validation: { per_patch: "none" }, valid: true }));

    expect((await invokeRomWeaverPatchValidateWorker(validateInput())).perPatch).toBeUndefined();

    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({ valid: true }));
    expect((await invokeRomWeaverPatchValidateWorker(validateInput())).perPatch).toBeUndefined();
  });
});

describe("handler warnings", () => {
  it("returns create warnings from details.warnings", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(
      succeededResult({
        emitted_files: [{ path: "/out/p.ips", size_bytes: 7 }],
        warnings: ["IPS create input is larger than modified output; double check file order"],
      }),
    );

    const output = await invokeRomWeaverCreatePatchWorker({
      format: "ips",
      modifiedFilePath: "/new.sfc",
      originalFilePath: "/old.sfc",
      outputName: "p.ips",
    });

    expect(output.warnings).toEqual(["IPS create input is larger than modified output; double check file order"]);
  });

  it("returns apply warnings in the apply summary", async () => {
    mocks.runRomWeaverJson.mockResolvedValue({
      events: [
        {
          details: {
            emitted_files: [{ path: "/out/rom.bin", size_bytes: 4 }],
            warnings: ["IPS patch did not change output; input may already be patched"],
          },
          label: "applied IPS patch; warning=IPS patch did not change output; input may already be patched",
          status: "succeeded",
        },
      ],
      exitCode: 0,
      ok: true,
      stderr: "",
    });

    const result = await invokeRomWeaverPatchApplyWorker({
      outputName: "rom.bin",
      patchFiles: [{ patchFileName: "a.ips", patchFilePath: "/a.ips" }],
      romFileName: "rom.sfc",
      romFilePath: "/rom.sfc",
    } as Parameters<typeof invokeRomWeaverPatchApplyWorker>[0]);

    expect(result.applySummary.warnings).toEqual(["IPS patch did not change output; input may already be patched"]);
  });
});

describe("invokeRomWeaverCreatePatchCandidatesWorker", () => {
  const candidateInput = () => ({
    modifiedFileName: "new.sfc",
    modifiedFilePath: "/new.sfc",
    originalFileName: "old.sfc",
    originalFilePath: "/old.sfc",
  });

  it("dispatches a plan-only patch-create and returns the format candidates", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({ patch_create_plan: { formats: [] } }));

    const candidates = await invokeRomWeaverCreatePatchCandidatesWorker({ ...candidateInput(), threads: 2 });

    expect(lastCall()[0]).toEqual({
      args: { args: { modified: "/new.sfc", original: "/old.sfc", plan: true, threads: 2 }, type: "create" },
      type: "patch",
    });
    expect(candidates).toBeDefined();
  });

  it("omits the thread budget when the caller gives none", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({ patch_create_plan: { formats: [] } }));

    await invokeRomWeaverCreatePatchCandidatesWorker(candidateInput());

    expect((lastCall()[0].args as { args: Record<string, unknown> }).args).not.toHaveProperty("threads");
  });

  it("reports a failed candidate plan", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(failedResult("inputs are identical"));

    await expect(invokeRomWeaverCreatePatchCandidatesWorker(candidateInput())).rejects.toThrow(
      /inputs are identical|Patch create candidate selection failed/,
    );
  });
});
