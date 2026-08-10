import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPatchFile } from "../../src/lib/input/binary-service.ts";
import {
  buildSessionOutputFiles,
  createSingleFileRomSpecificOutput,
  getRustOutputExportOptions,
  shouldUseRustOutputExport,
} from "../../src/lib/output/output-build-service.ts";
import type { InputAsset } from "../../src/lib/input/input-assets.ts";
import type { PatchFileInstance } from "../../src/lib/input/binary-service.ts";
import type { ApplyWorkflowOptions } from "../../src/types/workflow-runtime-types.ts";
import type { WorkflowRuntime } from "../../src/types/workflow-runtime-adapter.ts";

const makeFile = async (contents: string, fileName: string): Promise<PatchFileInstance> =>
  createPatchFile(new File([contents], fileName), fileName);

const makeAsset = (id: string, kind: InputAsset["kind"], file: PatchFileInstance, groupId?: string): InputAsset => ({
  file,
  fileName: file.fileName,
  groupId,
  id,
  kind,
  patchable: kind !== "cue" && kind !== "gdi",
  size: file.fileSize,
});

// archive-output-service.ts does real archive-byte assembly (7z/zip encoders) - irrelevant to
// output-build-service's own decision logic (naming, format selection, entry construction, error
// propagation), so it is faked the same way staged-rom-source-session-cleanup.test.ts fakes a sibling
// service module.
vi.mock("../../src/lib/output/archive-output-service.ts", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/output/archive-output-service.ts")>(
    "../../src/lib/output/archive-output-service.ts",
  );
  return {
    ...actual,
    createArchiveEntryInputFromPatchFile: vi.fn((file: PatchFileInstance, outputFileName: string) => ({
      entry: { data: new Uint8Array(file.fileSize || 0), filename: outputFileName },
      size: file.fileSize || 0,
    })),
    createArchivePatchFileOutput: vi.fn(),
    createPatchFileFromRuntimeOutput: vi.fn(),
  };
});

import {
  createArchiveEntryInputFromPatchFile,
  createArchivePatchFileOutput,
  createPatchFileFromRuntimeOutput,
} from "../../src/lib/output/archive-output-service.ts";

const mockCreateArchivePatchFileOutput = vi.mocked(createArchivePatchFileOutput);
const mockCreatePatchFileFromRuntimeOutput = vi.mocked(createPatchFileFromRuntimeOutput);

describe("buildSessionOutputFiles", () => {
  beforeEach(() => {
    mockCreateArchivePatchFileOutput.mockReset();
    mockCreatePatchFileFromRuntimeOutput.mockReset();
    vi.mocked(createArchiveEntryInputFromPatchFile).mockClear();
  });

  it("returns the sole patched file unchanged when compression is none and no output name was requested", async () => {
    const romFile = await makeFile("rom-bytes", "game.bin");
    const patchedFile = await makeFile("patched-rom-bytes", "patched.bin");
    const assets = [makeAsset("a1", "rom", romFile)];
    const patchedById = new Map([["a1", patchedFile]]);
    const options: ApplyWorkflowOptions = { output: { compression: "none" } } as never;

    const result = await buildSessionOutputFiles(assets, patchedById, options);

    expect(result.files).toEqual([patchedFile]);
    expect(result.rawOutputSize).toBe(patchedFile.fileSize);
    expect(result.compressionTimeMs).toBeUndefined();
    expect(mockCreateArchivePatchFileOutput).not.toHaveBeenCalled();
  });

  it("appends the source extension to a requested output name lacking one when compression is none", async () => {
    const romFile = await makeFile("rom-bytes", "game.bin");
    const patchedFile = await makeFile("patched-rom-bytes", "patched.bin");
    const assets = [makeAsset("a1", "rom", romFile)];
    const patchedById = new Map([["a1", patchedFile]]);
    const options: ApplyWorkflowOptions = {
      output: { compression: "none", outputName: "MyRenamedGame" },
    } as never;

    const result = await buildSessionOutputFiles(assets, patchedById, options);

    expect(result.files[0]?.fileName).toBe("MyRenamedGame.bin");
  });

  it("uses a requested output name verbatim when it already has an extension", async () => {
    const romFile = await makeFile("rom-bytes", "game.bin");
    const patchedFile = await makeFile("patched-rom-bytes", "patched.bin");
    const assets = [makeAsset("a1", "rom", romFile)];
    const patchedById = new Map([["a1", patchedFile]]);
    const options: ApplyWorkflowOptions = {
      output: { compression: "none", outputName: "MyRenamedGame.gba" },
    } as never;

    const result = await buildSessionOutputFiles(assets, patchedById, options);

    expect(result.files[0]?.fileName).toBe("MyRenamedGame.gba");
  });

  it("routes a single patched asset through archive compression and returns the compressed output", async () => {
    const romFile = await makeFile("rom-bytes", "game.bin");
    const patchedFile = await makeFile("patched-rom-bytes", "patched.bin");
    const assets = [makeAsset("a1", "rom", romFile)];
    const patchedById = new Map([["a1", patchedFile]]);
    const compressedFile = await makeFile("compressed-bytes", "patched.zip");
    mockCreateArchivePatchFileOutput.mockResolvedValue(compressedFile);
    const options: ApplyWorkflowOptions = { output: { compression: "zip" } } as never;

    const result = await buildSessionOutputFiles(assets, patchedById, options);

    expect(mockCreateArchivePatchFileOutput).toHaveBeenCalledTimes(1);
    const call = mockCreateArchivePatchFileOutput.mock.calls[0]?.[0];
    expect(call?.compression).toBe("zip");
    expect(result.files).toEqual([compressedFile]);
  });

  it("groups multiple ROM assets (no cue/track) into a single zip archive, defaulting compression 'none' to zip with store codec", async () => {
    const romA = await makeFile("rom-a-bytes", "gameA.bin");
    const romB = await makeFile("rom-b-bytes", "gameB.bin");
    const assets = [makeAsset("a1", "rom", romA), makeAsset("a2", "rom", romB)];
    const patchedById = new Map<string, PatchFileInstance>();
    const compressedFile = await makeFile("zip-bytes", "gameA.zip");
    mockCreateArchivePatchFileOutput.mockResolvedValue(compressedFile);
    const options: ApplyWorkflowOptions = { output: { compression: "none" } } as never;

    const result = await buildSessionOutputFiles(assets, patchedById, options);

    expect(mockCreateArchivePatchFileOutput).toHaveBeenCalledTimes(1);
    const call = mockCreateArchivePatchFileOutput.mock.calls[0]?.[0];
    expect(call?.compression).toBe("zip");
    expect(call?.outputName).toBe("gameA.zip");
    expect(call?.overrides).toEqual({ zipCodec: "store" });
    expect(result.files).toEqual([compressedFile]);
    expect(result.rawOutputSize).toBe(romA.fileSize + romB.fileSize);
  });

  it("uses the CUE asset's base name for a multi-track disc group archive", async () => {
    const cueFile = await makeFile('FILE "t1.bin" BINARY', "disc.cue");
    const trackA = await makeFile("track-a-bytes", "t1.bin");
    const trackB = await makeFile("track-b-bytes", "t2.bin");
    const assets = [
      makeAsset("cue", "cue", cueFile, "group"),
      makeAsset("t1", "track", trackA, "group"),
      makeAsset("t2", "track", trackB, "group"),
    ];
    const patchedById = new Map<string, PatchFileInstance>();
    const compressedFile = await makeFile("zip-bytes", "disc.zip");
    mockCreateArchivePatchFileOutput.mockResolvedValue(compressedFile);
    const options: ApplyWorkflowOptions = { output: { compression: "zip" } } as never;

    await buildSessionOutputFiles(assets, patchedById, options);

    const call = mockCreateArchivePatchFileOutput.mock.calls[0]?.[0];
    expect(call?.outputName).toBe("disc.zip");
    // More than one track means the cue-track-renaming branch is skipped, so each non-cue asset keeps
    // its own entry via createArchiveEntryInputFromPatchFile (the cue asset takes the text-encoding
    // branch instead, so only the 2 track assets go through the mocked helper).
    expect(vi.mocked(createArchiveEntryInputFromPatchFile)).toHaveBeenCalledTimes(2);
  });

  it("throws when RVZ compression is requested for a multi-asset (CD disc group) output", async () => {
    const cueFile = await makeFile('FILE "t1.bin" BINARY', "disc.cue");
    const trackA = await makeFile("track-a-bytes", "t1.bin");
    const assets = [makeAsset("cue", "cue", cueFile, "group"), makeAsset("t1", "track", trackA, "group")];
    const options: ApplyWorkflowOptions = { output: { compression: "rvz" } } as never;

    await expect(buildSessionOutputFiles(assets, new Map(), options)).rejects.toThrow(
      "RVZ output is not supported for CD disc groups",
    );
  });

  it("throws when Z3DS compression is requested for a multi-asset (CD disc group) output", async () => {
    const cueFile = await makeFile('FILE "t1.bin" BINARY', "disc.cue");
    const trackA = await makeFile("track-a-bytes", "t1.bin");
    const assets = [makeAsset("cue", "cue", cueFile, "group"), makeAsset("t1", "track", trackA, "group")];
    const options: ApplyWorkflowOptions = { output: { compression: "z3ds" } } as never;

    await expect(buildSessionOutputFiles(assets, new Map(), options)).rejects.toThrow(
      "Z3DS output is not supported for CD disc groups",
    );
  });

  it("throws when a CHD disc-group output has no CUE or no tracks", async () => {
    const romA = await makeFile("rom-a-bytes", "gameA.bin");
    const romB = await makeFile("rom-b-bytes", "gameB.bin");
    const assets = [makeAsset("a1", "rom", romA), makeAsset("a2", "rom", romB)];
    const options: ApplyWorkflowOptions = { output: { compression: "chd" } } as never;

    await expect(buildSessionOutputFiles(assets, new Map(), options)).rejects.toThrow(
      "CHD output requires a CUE disc group with tracks",
    );
  });

  it("throws when a CHD disc-group output has no runtime compression capability", async () => {
    const cueFile = await makeFile('FILE "t1.bin" BINARY', "disc.cue");
    const trackA = await makeFile("track-a-bytes", "t1.bin");
    const assets = [makeAsset("cue", "cue", cueFile, "group"), makeAsset("t1", "track", trackA, "group")];
    const options: ApplyWorkflowOptions = { output: { compression: "chd" } } as never;
    const runtime = { compression: {} } as unknown as WorkflowRuntime;

    await expect(buildSessionOutputFiles(assets, new Map(), options, runtime)).rejects.toThrow(
      "Runtime CHD compression capability is unavailable",
    );
  });

  it("builds a CHD output for a CUE disc group via runtime.compression.create", async () => {
    const cueFile = await makeFile('FILE "t1.bin" BINARY', "disc.cue");
    const trackA = await makeFile("track-a-bytes", "t1.bin");
    const assets = [makeAsset("cue", "cue", cueFile, "group"), makeAsset("t1", "track", trackA, "group")];
    const options: ApplyWorkflowOptions = { output: { compression: "chd" } } as never;
    const chdOutputFile = await makeFile("chd-bytes", "disc.chd");
    const create = vi.fn(async () => ({ output: { fileName: "disc.chd" } }));
    const runtime = { compression: { create } } as unknown as WorkflowRuntime;
    mockCreatePatchFileFromRuntimeOutput.mockResolvedValue(chdOutputFile);

    const result = await buildSessionOutputFiles(assets, new Map(), options, runtime);

    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0]?.[0];
    expect(request.format).toBe("chd");
    expect(request.outputName).toBe("disc.chd");
    expect(request.romSpecific.chd.mode).toBe("cd");
    expect(request.romSpecific.chd.imageFiles).toEqual([{ fileName: "t1.bin", source: expect.anything() }]);
    expect(result.files).toEqual([chdOutputFile]);
  });
});

describe("getRustOutputExportOptions", () => {
  it("selects DVD CHD codecs for DVD sources", () => {
    const options: ApplyWorkflowOptions = { output: { compression: "chd" } } as never;

    const result = getRustOutputExportOptions("chd", options, "dvd");

    expect(result.codecs?.some((codec) => codec.startsWith("lzma"))).toBe(true);
    expect(result.codecs?.some((codec) => codec.startsWith("cdlz"))).toBe(false);
  });

  it("passes through a configured Z3DS compression level", () => {
    const options: ApplyWorkflowOptions = {
      output: { compression: "z3ds", container: { z3dsCompressionLevel: 12 } },
    } as never;

    const result = getRustOutputExportOptions("z3ds", options);

    expect(result.codecs).toEqual(["zstd:12"]);
  });

  it("carries a single-file archive entry name into the Rust export", () => {
    const options: ApplyWorkflowOptions = { output: { compression: "zip" } } as never;

    const result = getRustOutputExportOptions("zip", options, undefined, "patched.nes");

    expect(result.entryName).toBe("patched.nes");
  });

  it("falls back when CHD sidecars or custom RVZ settings need metadata-aware compression", async () => {
    const cueFile = await makeFile("rom-bytes", "game.bin");
    cueFile.metadata = { cuePath: "/work/game.cue" };
    const chdOptions: ApplyWorkflowOptions = { output: { compression: "chd" } } as never;
    const rvzOptions: ApplyWorkflowOptions = {
      output: { compression: "rvz", container: { rvzBlockSize: 65536 } },
    } as never;

    expect(shouldUseRustOutputExport("chd", chdOptions, cueFile)).toBe(false);
    expect(shouldUseRustOutputExport("rvz", rvzOptions)).toBe(false);
    expect(shouldUseRustOutputExport("rvz", { output: { compression: "rvz" } } as never)).toBe(true);
  });
});

describe("createSingleFileRomSpecificOutput", () => {
  it("returns null when the runtime has no compression.create capability", async () => {
    const outputFile = await makeFile("rom-bytes", "game.iso");
    const runtime = { compression: {} } as unknown as WorkflowRuntime;

    const result = await createSingleFileRomSpecificOutput({
      compression: "chd",
      options: undefined,
      outputFile,
      runtime,
    });

    expect(result).toBeNull();
  });

  it("builds a CHD single-file request, cleans up the source, and returns the compressed output", async () => {
    const outputFile = await makeFile("rom-bytes", "game.bin");
    const cleanup = vi.fn();
    (outputFile as PatchFileInstance & { _cleanup?: () => void })._cleanup = cleanup;
    const compressed = await makeFile("chd-bytes", "game.chd");
    const create = vi.fn(async () => ({ output: { fileName: "game.chd" } }));
    const runtime = { compression: { create } } as unknown as WorkflowRuntime;
    mockCreatePatchFileFromRuntimeOutput.mockResolvedValue(compressed);

    const result = await createSingleFileRomSpecificOutput({
      compression: "chd",
      options: { output: { outputName: "game.chd" } } as never,
      outputFile,
      runtime,
    });

    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0]?.[0];
    expect(request.format).toBe("chd");
    expect(request.fileName).toBe("game.bin");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(result).toBe(compressed);
  });

  it("returns null when the runtime produced no output for the requested format", async () => {
    const outputFile = await makeFile("rom-bytes", "game.bin");
    const create = vi.fn(async () => ({ output: null }));
    const runtime = { compression: { create } } as unknown as WorkflowRuntime;
    mockCreatePatchFileFromRuntimeOutput.mockResolvedValue(undefined as never);

    const result = await createSingleFileRomSpecificOutput({
      compression: "rvz",
      options: undefined,
      outputFile,
      runtime,
    });

    expect(result).toBeNull();
  });
});
