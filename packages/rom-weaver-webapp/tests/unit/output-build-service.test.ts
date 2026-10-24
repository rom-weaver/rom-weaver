import { readBrowserOpfsPrefix } from "../../src/workers/protocol/browser-opfs-worker-client.ts";
import { createPatchFileFromPublicOutput } from "../../src/lib/runtime/public-output-bin-file.ts";
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

// Fake archive assembly to isolate output naming, entry construction, format selection, and error handling.
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

vi.mock("../../src/workers/protocol/browser-opfs-worker-client.ts", () => ({ readBrowserOpfsPrefix: vi.fn() }));

const mockCreateArchivePatchFileOutput = vi.mocked(createArchivePatchFileOutput);
const mockCreatePatchFileFromRuntimeOutput = vi.mocked(createPatchFileFromRuntimeOutput);

describe("buildSessionOutputFiles", () => {
  beforeEach(() => {
    vi.mocked(readBrowserOpfsPrefix).mockReset();
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

  it.each([
    ["Zelda Hack v1.2", "Zelda Hack v1.2.bin"],
    ["Game 2.2", "Game 2.2.bin"],
    ["MyRenamedGame.BIN", "MyRenamedGame.BIN"],
    ["MyRenamedGame.gba", "MyRenamedGame.gba"],
    ["Hack v1.2b", "Hack v1.2b.bin"],
    ["Hack v1.0-beta", "Hack v1.0-beta.bin"],
    ["Game (USA) (v1.1)", "Game (USA) (v1.1).bin"],
    ["Mario.Bros", "Mario.Bros.bin"],
  ])("treats requested raw output name %s as a base name", async (outputName, expected) => {
    const romFile = await makeFile("rom-bytes", "game.bin");
    const patchedFile = await makeFile("patched-rom-bytes", "patched.bin");
    const assets = [makeAsset("a1", "rom", romFile)];
    const patchedById = new Map([["a1", patchedFile]]);
    const options: ApplyWorkflowOptions = { output: { compression: "none", outputName } } as never;

    const result = await buildSessionOutputFiles(assets, patchedById, options);

    expect(result.files[0]?.fileName).toBe(expected);
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

  it("keeps a dotted version in a typed name and appends the ROM extension to the ZIP entry", async () => {
    const romFile = await makeFile("rom-bytes", "game.sfc");
    const patchedFile = await makeFile("patched-rom-bytes", "patched.sfc");
    const assets = [makeAsset("a1", "rom", romFile)];
    const patchedById = new Map([["a1", patchedFile]]);
    mockCreateArchivePatchFileOutput.mockResolvedValue(await makeFile("zip-bytes", "out.zip"));
    const options: ApplyWorkflowOptions = { output: { compression: "zip", outputName: "Zelda Hack v1.2" } } as never;

    await buildSessionOutputFiles(assets, patchedById, options);

    expect(vi.mocked(createArchiveEntryInputFromPatchFile).mock.calls[0]?.[1]).toBe("Zelda Hack v1.2.sfc");
  });

  it.each([
    ["chd", "Hack v1.2.chd"],
    ["rvz", "Hack v1.2.rvz"],
  ])("appends the %s extension to a typed dotted-version name for a single ISO", async (compression, expected) => {
    const romFile = await makeFile("rom-bytes", "game.iso");
    const patchedFile = await makeFile("patched-rom-bytes", "patched.iso");
    const assets = [makeAsset("a1", "rom", romFile)];
    const patchedById = new Map([["a1", patchedFile]]);
    const create = vi.fn(async () => ({ output: { fileName: expected } }));
    mockCreatePatchFileFromRuntimeOutput.mockResolvedValue(await makeFile("out", expected));
    const options: ApplyWorkflowOptions = { output: { compression, outputName: "Hack v1.2" } } as never;

    await buildSessionOutputFiles(assets, patchedById, options, {
      compression: { create },
    } as unknown as WorkflowRuntime);

    expect(create.mock.calls[0]?.[0].outputName).toBe(expected);
  });

  it("keeps a dotted version in a typed name and appends the ROM extension to the ZIP entry", async () => {
    const romFile = await makeFile("rom-bytes", "game.sfc");
    const patchedFile = await makeFile("patched-rom-bytes", "patched.sfc");
    const assets = [makeAsset("a1", "rom", romFile)];
    const patchedById = new Map([["a1", patchedFile]]);
    mockCreateArchivePatchFileOutput.mockResolvedValue(await makeFile("zip-bytes", "out.zip"));
    const options: ApplyWorkflowOptions = { output: { compression: "zip", outputName: "Zelda Hack v1.2" } } as never;

    await buildSessionOutputFiles(assets, patchedById, options);

    expect(vi.mocked(createArchiveEntryInputFromPatchFile).mock.calls[0]?.[1]).toBe("Zelda Hack v1.2.sfc");
  });

  it.each([
    ["chd", "Hack v1.2.chd"],
    ["rvz", "Hack v1.2.rvz"],
  ])("appends the %s extension to a typed dotted-version name for a single ISO", async (compression, expected) => {
    const romFile = await makeFile("rom-bytes", "game.iso");
    const patchedFile = await makeFile("patched-rom-bytes", "patched.iso");
    const assets = [makeAsset("a1", "rom", romFile)];
    const patchedById = new Map([["a1", patchedFile]]);
    const create = vi.fn(async () => ({ output: { fileName: expected } }));
    mockCreatePatchFileFromRuntimeOutput.mockResolvedValue(await makeFile("out", expected));
    const options: ApplyWorkflowOptions = { output: { compression, outputName: "Hack v1.2" } } as never;

    await buildSessionOutputFiles(assets, patchedById, options, {
      compression: { create },
    } as unknown as WorkflowRuntime);

    expect(create.mock.calls[0]?.[0].outputName).toBe(expected);
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

  it("throws when a CHD disc-group output has no disc sheet or no tracks", async () => {
    const romA = await makeFile("rom-a-bytes", "gameA.bin");
    const romB = await makeFile("rom-b-bytes", "gameB.bin");
    const assets = [makeAsset("a1", "rom", romA), makeAsset("a2", "rom", romB)];
    const options: ApplyWorkflowOptions = { output: { compression: "chd" } } as never;

    await expect(buildSessionOutputFiles(assets, new Map(), options)).rejects.toThrow(
      "CHD output requires a disc sheet group with tracks",
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
    const options: ApplyWorkflowOptions = { output: { compression: "chd", container: { profile: "min" } } } as never;
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
    expect(request.romSpecific.chd.compressionProfile).toBe("min");
    expect(request.romSpecific.chd.imageFiles).toEqual([{ fileName: "t1.bin", source: expect.anything() }]);
    expect(result.files).toEqual([chdOutputFile]);
  });

  it("drops a typed disc extension from a multi-track CHD name", async () => {
    const cueFile = await makeFile('FILE "t1.bin" BINARY', "disc.cue");
    const trackA = await makeFile("track-a-bytes", "t1.bin");
    const trackB = await makeFile("track-b-bytes", "t2.bin");
    const assets = [
      makeAsset("cue", "cue", cueFile, "group"),
      makeAsset("t1", "track", trackA, "group"),
      makeAsset("t2", "track", trackB, "group"),
    ];
    const create = vi.fn(async () => ({ output: { fileName: "x.chd" } }));
    const runtime = { compression: { create } } as unknown as WorkflowRuntime;
    mockCreatePatchFileFromRuntimeOutput.mockResolvedValue(await makeFile("chd-bytes", "x.chd"));

    await buildSessionOutputFiles(
      assets,
      new Map(),
      { output: { compression: "chd", outputName: "My Hack.cue" } } as never,
      runtime,
    );

    expect(create.mock.calls[0]?.[0].outputName).toBe("My Hack.chd");
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

  it.each([
    ["x.cue", "x"],
    ["Foo.gba", "Foo"],
    ["Hack v1.2b", "Hack v1.2b"],
    ["Mario.Bros", "Mario.Bros"],
  ])("names a single BIN track and CUE for typed name %s", async (outputName, base) => {
    const cueText = 'FILE "disc.bin" BINARY\nTRACK 01 MODE1/2352\n';
    const cueFile = await makeFile(cueText, "original.cue");
    cueFile.metadata = { cueText };
    const trackFile = await makeFile("track-bytes", "disc.bin");
    const assets = [makeAsset("cue", "cue", cueFile, "group"), makeAsset("track", "track", trackFile, "group")];
    mockCreateArchivePatchFileOutput.mockResolvedValue(await makeFile("zip-bytes", "out.zip"));

    await buildSessionOutputFiles(assets, new Map(), { output: { compression: "zip", outputName } } as never);

    const entries = mockCreateArchivePatchFileOutput.mock.calls[0]?.[0].entries as Array<{ filename?: string }>;
    expect(entries.map((entry) => entry.filename)).toEqual([`${base}.cue`, `${base}.bin`]);
  });

  it("routes a seven-zip multi-asset output through the archive writer and cleans files once", async () => {
    const first = await makeFile("first", "first.bin");
    const second = await makeFile("second", "second.bin");
    const cleanup = vi.fn();
    (first as PatchFileInstance & { _cleanup?: () => void })._cleanup = cleanup;
    (second as PatchFileInstance & { _cleanup?: () => void })._cleanup = cleanup;
    const assets = [makeAsset("a", "rom", first), makeAsset("b", "rom", second)];
    const compressed = await makeFile("7z-bytes", "weave.7z");
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

describe("lazy CHD output codec planning", () => {
  it("does not read an already aborted Blob output", async () => {
    const blob = new Blob([new Uint8Array(2352)]);
    const slice = vi.spyOn(blob, "slice");
    const file = await createPatchFileFromPublicOutput(
      { fileName: "disc.bin", size: blob.size, blob } as never,
      "disc.bin",
      { materializeBlob: false },
    );
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);
    const create = vi.fn();
    await expect(
      createSingleFileRomSpecificOutput({
        compression: "chd",
        outputFile: file,
        options: { signal: controller.signal } as never,
        runtime: { compression: { create } } as unknown as WorkflowRuntime,
      }),
    ).rejects.toBe(reason);
    expect(slice).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["unreadable source", "aborted"])("propagates %s probe failures before compression", async (message) => {
    const blob = new Blob([new Uint8Array(2352)]);
    const file = await createPatchFileFromPublicOutput(
      {
        fileName: "disc.bin",
        path: "/disc.bin",
        size: blob.size,
        vfs: { normalizePath: (path: string) => path },
      } as never,
      "disc.bin",
      { materializeBlob: false },
    );
    const error = new Error(message);
    const probe = vi.mocked(readBrowserOpfsPrefix).mockRejectedValue(error);
    const create = vi.fn();
    const signal = new AbortController().signal;
    await expect(
      createSingleFileRomSpecificOutput({
        compression: "chd",
        outputFile: file,
        options: { signal } as never,
        runtime: { compression: { create, probe } } as unknown as WorkflowRuntime,
      }),
    ).rejects.toBe(error);
    expect(probe.mock.calls[0]?.[2]).toBe(signal);
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["cd", "dvd"])("preserves explicit %s mode and codecs without probing", async (mode) => {
    const blob = new Blob([new Uint8Array(100 * 2352)]);
    const slice = vi.spyOn(blob, "slice");
    const file = await createPatchFileFromPublicOutput(
      { fileName: "disc.bin", size: blob.size, blob } as never,
      "disc.bin",
      { materializeBlob: false },
    );
    const probe = vi.mocked(readBrowserOpfsPrefix).mockReset();
    const create = vi.fn(async () => ({ output: { fileName: "disc.chd" } }));
    mockCreatePatchFileFromRuntimeOutput.mockResolvedValue(await makeFile("out", "disc.chd"));
    await createSingleFileRomSpecificOutput({
      compression: "chd",
      outputFile: file,
      options: {
        output: { container: { chdOutputMode: mode, chdCreateCdCodecs: "cdzl", chdCreateDvdCodecs: "lzma" } },
      } as never,
      runtime: { compression: { create, probe } } as unknown as WorkflowRuntime,
    });
    expect(probe).not.toHaveBeenCalled();
    expect(create.mock.calls[0]?.[0].romSpecific.chd).toMatchObject({ mode });
    expect(create.mock.calls[0]?.[0].romSpecific.chd.compressionCodecs.split(":")[0]).toBe(
      mode === "cd" ? "cdzl" : "lzma",
    );
    expect(slice).not.toHaveBeenCalled();
  });

  it.each([
    [true, undefined, "lzma"],
    [false, undefined, "cdzl"],
    [true, { mode: "cd" }, "cdzl"],
  ])("probes an unidentified lazy ISO for UDF (udf=%s, metadata=%o)", async (udf, metadata, codec) => {
    const bytes = new Uint8Array(100 * 2048);
    bytes.set([1, 67, 68, 48, 48, 49], 16 * 2048);
    if (udf) bytes.set([0, 78, 83, 82, 48, 50], 17 * 2048);
    const blob = new Blob([bytes]);
    const slice = vi.spyOn(blob, "slice");
    const file = await createPatchFileFromPublicOutput(
      { fileName: "disc.iso", size: blob.size, blob } as never,
      "disc.iso",
      { materializeBlob: false },
    );
    if (metadata) file.metadata = metadata as never;
    const create = vi.fn(async () => ({ output: { fileName: "disc.chd" } }));
    mockCreatePatchFileFromRuntimeOutput.mockResolvedValue(await makeFile("out", "disc.chd"));
    await createSingleFileRomSpecificOutput({
      compression: "chd",
      outputFile: file,
      options: { output: { container: { chdCreateCdCodecs: "cdzl", chdCreateDvdCodecs: "lzma" } } } as never,
      runtime: { compression: { create, probe: vi.fn() } } as unknown as WorkflowRuntime,
    });
    expect(create.mock.calls[0]?.[0].romSpecific.chd.compressionCodecs.split(":")[0]).toBe(codec);
    if (metadata) expect(slice).not.toHaveBeenCalled();
    else expect(slice).toHaveBeenCalledExactlyOnceWith(0, 32 * 2048);
  });

  it.each([
    ["blob", "sync", "raw"],
    ["vfs", "sync", "raw"],
    ["blob", "iso2048", "raw"],
    ["blob", "hybrid", "raw"],
    ["vfs", "hybrid", "raw"],
    ["vfs", "iso2352", "raw"],
    ["blob", "iso2352", "raw"],
    ["blob", "raw", "sync"],
    ["vfs", "raw", "sync"],
  ])("uses patched %s %s bytes instead of original %s bytes", async (storage, signature, originalSignature) => {
    const sectorSize = signature === "iso2048" || signature === "hybrid" ? 2048 : 2352;
    const bytes = new Uint8Array(100 * sectorSize);
    if (signature === "sync") bytes.set([0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0]);
    if (signature.startsWith("iso")) bytes.set([67, 68, 48, 48, 49], 16 * sectorSize + (sectorSize === 2048 ? 1 : 17));
    if (signature === "hybrid") {
      bytes.set([67, 68, 48, 48, 49], 32769);
      bytes.set([0x55, 0xaa], 510);
      bytes[450] = 0x83;
      const view = new DataView(bytes.buffer);
      view.setUint32(454, 1, true);
      view.setUint32(458, 399, true);
    }
    const originalBytes = new Uint8Array(bytes.length);
    if (originalSignature === "sync") originalBytes.set([0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0]);
    const original = await createPatchFile({ data: originalBytes, fileName: "game.bin" }, "game.bin");
    original.metadata = { format: "CD" };
    const blob = new Blob([bytes]);
    const slice = vi.spyOn(blob, "slice");
    const read = vi.fn();
    const vfs = { normalizePath: (path: string) => path, read };
    const patched = await createPatchFileFromPublicOutput(
      storage === "vfs"
        ? ({ fileName: "patched.bin", path: "/patched.bin", size: bytes.length, vfs } as never)
        : ({ fileName: "patched.bin", size: bytes.length, blob } as never),
      "patched.bin",
      { materializeBlob: false },
    );
    patched.metadata = { format: "CD" };
    const materialize = vi.spyOn(patched, "materialize");
    const probe = vi
      .mocked(readBrowserOpfsPrefix)
      .mockReset()
      .mockResolvedValue(bytes.subarray(0, 32 * 2048));
    const create = vi.fn(async () => ({ output: { fileName: "patched.chd" } }));
    mockCreatePatchFileFromRuntimeOutput.mockResolvedValue(await makeFile("out", "patched.chd"));
    await buildSessionOutputFiles(
      [makeAsset("a", "rom", original)],
      new Map([["a", patched]]),
      {
        output: { compression: "chd", container: { chdCreateCdCodecs: "cdzl", chdCreateDvdCodecs: "lzma" } },
      } as never,
      { compression: { create, probe } } as unknown as WorkflowRuntime,
    );
    expect(create.mock.calls[0]?.[0].romSpecific.chd.compressionCodecs.split(":")[0]).toBe(
      signature === "raw" || signature === "hybrid" ? "lzma" : "cdzl",
    );
    expect(create.mock.calls[0]?.[0].romSpecific.chd.mode).toBe("auto");
    expect(create.mock.calls[0]?.[0].romSpecific.chd.sourceMode).toBeUndefined();
    expect(materialize).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    if (storage === "vfs") {
      expect(probe).toHaveBeenCalledExactlyOnceWith("/patched.bin", 32 * 2048, undefined);
      expect(slice).not.toHaveBeenCalled();
    } else {
      expect(probe).not.toHaveBeenCalled();
      expect(slice).toHaveBeenCalledExactlyOnceWith(0, 32 * 2048);
    }
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

  it.each([13, 4096, 32768])("builds a raw %i-byte CHD request with generic default codecs", async (size) => {
    const outputFile = await makeFile("x".repeat(size), "game.bin");
    const cleanup = vi.fn();
    (outputFile as PatchFileInstance & { _cleanup?: () => void })._cleanup = cleanup;
    const compressed = await makeFile("chd-bytes", "game.chd");
    const create = vi.fn(async () => ({ output: { fileName: "game.chd" } }));
    const runtime = { compression: { create } } as unknown as WorkflowRuntime;
    mockCreatePatchFileFromRuntimeOutput.mockResolvedValue(compressed);

    const result = await createSingleFileRomSpecificOutput({
      compression: "chd",
      options: { output: { outputName: "game.chd", container: { profile: "min" } } } as never,
      outputFile,
      runtime,
    });

    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0]?.[0];
    expect(request.format).toBe("chd");
    expect(request.fileName).toBe("game.bin");
    expect(request.romSpecific.chd.compressionProfile).toBe("min");
    expect(request.romSpecific.chd.compressionCodecs).toContain("lzma");
    expect(request.romSpecific.chd.compressionCodecs).not.toMatch(/cd(lz|zl|fl|zs)/);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(result).toBe(compressed);
  });

  it.each([
    ["chd", "Hack v1.2", "game.iso", "Hack v1.2.chd"],
    ["rvz", "Hack v1.2", "game.iso", "Hack v1.2.rvz"],
    ["chd", "Game (USA) (v1.1)", "game.iso", "Game (USA) (v1.1).chd"],
    ["chd", "Hack.iso", "game.iso", "Hack.chd"],
    ["chd", "Hack.chd", "game.iso", "Hack.chd"],
  ])("names a typed %s output %s from %s as %s", async (compression, outputName, sourceName, expected) => {
    const outputFile = await makeFile("rom-bytes", sourceName);
    const create = vi.fn(async () => ({ output: { fileName: expected } }));
    mockCreatePatchFileFromRuntimeOutput.mockResolvedValue(await makeFile("out", expected));

    await createSingleFileRomSpecificOutput({
      compression: compression as "chd" | "rvz",
      options: { output: { outputName } } as never,
      outputFile,
      runtime: { compression: { create } } as unknown as WorkflowRuntime,
    });

    const request = create.mock.calls[0]?.[0];
    expect(request.outputName).toBe(expected);
    expect(request.fileName).toBe(outputName.endsWith(".chd") ? "Hack.iso" : `${outputName.replace(/\.iso$/, "")}.iso`);
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
