import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  invokeRomWeaverBundleCreateWorker,
  invokeRomWeaverBundleParseWorker,
  invokeRomWeaverCompressionCreateWorker,
  invokeRomWeaverCreatePatchCandidatesWorker,
  invokeRomWeaverCreatePatchWorker,
  invokeRomWeaverExtractWorker,
  invokeRomWeaverIdentifyHashWorker,
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
});

describe("runtime argument normalization", () => {
  it("flattens, splits, trims, floors, and deduplicates codec values", () => {
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

describe("bundle runtime workers", () => {
  it("parses a bundle and forwards an optional extraction directory", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(
      succeededResult({ bundle: { bundle: { patches: [], version: 1 }, patch_sources: [], source_kind: "json" } }),
    );

    await expect(
      invokeRomWeaverBundleParseWorker({ extractDirPath: " /out ", sourcePath: " bundle.json " }),
    ).resolves.toMatchObject({ bundle: { version: 1 }, patchSources: [], sourceKind: "json" });
    expect(lastCall()[0]).toEqual({
      args: { args: { input: "bundle.json", output: "/out" }, type: "parse" },
      type: "bundle",
    });
  });

  it("creates a bundle with aligned metadata and expected checks", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(
      succeededResult({
        bundle_create: { bundle: { patches: [], version: 1 }, bundle_path: "/out/bundle.json", warnings: [] },
      }),
    );

    await expect(
      invokeRomWeaverBundleCreateWorker({
        bundlePath: " /bundle.zip ",
        bundleRomPath: " /rom.sfc ",
        noBundleRom: true,
        outputCheck: " sha1=abc ",
        outputHeader: "strip",
        outputName: "patched.sfc",
        outputPath: " /out/bundle.json ",
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
    ).resolves.toMatchObject({ bundlePath: "/out/bundle.json" });
    expect(lastCall()[0]).toEqual({
      args: {
        args: {
          assume_in: ["crc32=1234", "sha1=abcd", "size=100"],
          bundle: "/bundle.zip",
          bundle_rom: "/rom.sfc",
          no_bundle_rom: true,
          output: "/out/bundle.json",
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
      type: "bundle",
    });
  });
});

describe("output-producing runtime workers", () => {
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
        ignore_checksum_validation: false,
        n64_byte_order: ["little-endian", "auto"],
        output_header: "auto",
        patch_basis: ["base"],
        patch_header: ["keep", "auto"],
        repair_checksum: true,
      },
      type: "apply",
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
    expect(lastCall()[0]).toMatchObject({ type: "trim" });

    await expect(
      invokeRomWeaverPpfUndoWorker({
        outputName: "restored.sfc",
        patchFilePath: "/patch.ppf",
        romFilePath: "/game.sfc",
      }),
    ).resolves.toMatchObject({ fileName: "restored.sfc", filePath: "/out/custom.bin" });
    expect(lastCall()[0]).toMatchObject({ type: "tools" });
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

describe("invokeRomWeaverPatchValidateWorker", () => {
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
    ]);
  });

  it("returns no per-patch verdicts for the chained default mode", async () => {
    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({ patch_validation: { per_patch: "none" }, valid: true }));

    expect((await invokeRomWeaverPatchValidateWorker(validateInput())).perPatch).toBeUndefined();

    mocks.runRomWeaverJson.mockResolvedValue(succeededResult({ valid: true }));
    expect((await invokeRomWeaverPatchValidateWorker(validateInput())).perPatch).toBeUndefined();
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
