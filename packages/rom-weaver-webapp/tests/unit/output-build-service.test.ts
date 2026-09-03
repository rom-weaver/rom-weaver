import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPatchFile } from "../../src/lib/input/binary-service.ts";
import {
  buildSessionOutputFiles,
  createSingleFileRomSpecificOutput,
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

  it("routes multiple assets through the registry-selected 7z archive path", async () => {
    const romA = await makeFile("rom-a-bytes", "gameA.bin");
    const romB = await makeFile("rom-b-bytes", "gameB.bin");
    const assets = [makeAsset("a1", "rom", romA), makeAsset("a2", "rom", romB)];
    const compressedFile = await makeFile("7z-bytes", "gameA.7z");
    mockCreateArchivePatchFileOutput.mockResolvedValue(compressedFile);
    const options: ApplyWorkflowOptions = { output: { compression: "7z" } } as never;

    const result = await buildSessionOutputFiles(assets, new Map(), options);

    expect(mockCreateArchivePatchFileOutput).toHaveBeenCalledTimes(1);
    const call = mockCreateArchivePatchFileOutput.mock.calls[0]?.[0];
    expect(call?.compression).toBe("7z");
    expect(call?.outputName).toBe("gameA.7z");
    expect(call).not.toHaveProperty("overrides");
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

  it("renames a single BIN track and its CUE entry to the requested base name", async () => {
    const cueText = 'FILE "disc.bin" BINARY\nTRACK 01 MODE1/2352\n';
    const cueFile = await makeFile(cueText, "original.cue");
    cueFile.metadata = { cueText };
    const trackFile = await makeFile("track-bytes", "disc.bin");
    const assets = [makeAsset("cue", "cue", cueFile, "group"), makeAsset("track", "track", trackFile, "group")];
    const compressed = await makeFile("zip-bytes", "renamed.zip");
    mockCreateArchivePatchFileOutput.mockResolvedValue(compressed);

    await buildSessionOutputFiles(assets, new Map(), {
      output: { compression: "zip", outputName: "renamed" },
    } as never);

    const entries = mockCreateArchivePatchFileOutput.mock.calls[0]?.[0].entries as Array<{
      data?: Uint8Array;
      filename?: string;
    }>;
    expect(entries.map((entry) => entry.filename)).toEqual(["renamed.cue", "renamed.bin"]);
    expect(new TextDecoder().decode(entries[0]?.data)).toContain('FILE "renamed.bin" BINARY');
  });

  it("routes a seven-zip multi-asset output through the archive writer and cleans files once", async () => {
    const first = await makeFile("first", "first.bin");
    const second = await makeFile("second", "second.bin");
    const cleanup = vi.fn();
    (first as PatchFileInstance & { _cleanup?: () => void })._cleanup = cleanup;
    (second as PatchFileInstance & { _cleanup?: () => void })._cleanup = cleanup;
    const assets = [makeAsset("a", "rom", first), makeAsset("b", "rom", second)];
    const compressed = await makeFile("7z-bytes", "bundle.7z");
    mockCreateArchivePatchFileOutput.mockResolvedValue(compressed);

    const result = await buildSessionOutputFiles(assets, new Map(), { output: { compression: "7z" } } as never);

    expect(mockCreateArchivePatchFileOutput.mock.calls[0]?.[0]).toMatchObject({
      compression: "7z",
      outputName: "first.7z",
    });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(result.files).toEqual([compressed]);
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

  it("passes configured RVZ settings through the shared output plan", async () => {
    const outputFile = await makeFile("rom-bytes", "game.iso");
    const compressed = await makeFile("rvz-bytes", "game.rvz");
    const create = vi.fn(async () => ({ output: { fileName: "game.rvz" } }));
    const runtime = { compression: { create } } as unknown as WorkflowRuntime;
    mockCreatePatchFileFromRuntimeOutput.mockResolvedValue(compressed);

    await createSingleFileRomSpecificOutput({
      compression: "rvz",
      options: {
        output: {
          outputName: "game.rvz",
          container: {
            rvzBlockSize: 262144,
            rvzCodec: "zstd",
            rvzCompressionLevel: 7,
            rvzScrub: true,
          },
        },
      } as never,
      outputFile,
      runtime,
    });

    const request = create.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      format: "rvz",
      outputName: "game.rvz",
      romSpecific: {
        rvz: {
          blockSize: 262144,
          codec: "zstd",
          compressionLevel: 7,
          scrub: true,
        },
      },
    });
  });

  it("builds RVZ and Z3DS single-file requests with runtime-specific options", async () => {
    const outputFile = await makeFile("rom-bytes", "game.iso");
    (outputFile as PatchFileInstance & { _lazyExternalSource?: boolean })._lazyExternalSource = true;
    (outputFile as PatchFileInstance & { _sourceRef?: unknown })._sourceRef = {
      fileName: "game.iso",
      size: outputFile.fileSize,
      source: "/work/game.iso",
    };
    const compressed = await makeFile("compressed", "game.out");
    const create = vi.fn(async (request: Record<string, unknown>) => ({ output: { fileName: request.outputName } }));
    const runtime = { compression: { create } } as unknown as WorkflowRuntime;
    mockCreatePatchFileFromRuntimeOutput.mockResolvedValue(compressed);

    await createSingleFileRomSpecificOutput({
      compression: "rvz",
      options: { output: { outputName: "game.rvz" }, workers: { threads: 4 } } as never,
      outputFile,
      runtime,
    });
    await createSingleFileRomSpecificOutput({
      compression: "z3ds",
      options: { output: { outputName: "game.z3ds" } } as never,
      outputFile,
      runtime,
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      format: "rvz",
      outputName: "game.rvz",
      romSpecific: { rvz: { sourceFileName: undefined } },
      source: "/work/game.iso",
    });
    expect(create.mock.calls[1]?.[0]).toMatchObject({
      format: "z3ds",
      outputName: "game.z3ds",
      romSpecific: { z3ds: { sourceFileName: undefined } },
    });
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
