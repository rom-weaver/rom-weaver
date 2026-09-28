import { describe, expect, it, vi } from "vitest";
import type { WorkflowRuntime } from "../../src/types/workflow-runtime-adapter.ts";
import type { ApplyWorkflowOptions, PublicOutput } from "../../src/types/workflow-runtime-types.ts";
import { compressFiles, getCompressFormats, getCompressSource } from "../../src/webapp/compress-service.ts";

const file = (name: string, contents: string | Uint8Array = "rom") => new File([contents], name);
const options = (compression: "zip" | "7z" | "chd" | "rvz" | "z3ds"): ApplyWorkflowOptions => ({
  output: { compression, container: { profile: "low", zipCodec: "deflate" }, outputName: "release" },
  signal: new AbortController().signal,
  workers: { threads: 3 },
});
const makeRuntime = () => {
  const cleanup = vi.fn(async () => undefined);
  const output = {
    cleanup,
    dispose: vi.fn(async () => undefined),
    fileName: "release.chd",
    path: "/output/release.chd",
    saveAs: vi.fn(async () => undefined),
    size: 4,
    vfs: { normalizePath: (path: string) => path },
  } as unknown as PublicOutput;
  const create = vi.fn<NonNullable<WorkflowRuntime["compression"]["create"]>>(async () => ({ output }));
  const createSource = vi.fn(async () => ({ ...output }));
  const runtime = { compression: { create }, output: { createSource } } as unknown as WorkflowRuntime;
  return { cleanup, create, createSource, output, runtime };
};

describe("compress service", () => {
  it.each(["zip", "7z"] as const)(
    "preserves every %s entry name and byte source with a renamed output",
    async (format) => {
      const inputs = [
        file("game.zip", "archive"),
        file("fix.bps", "patch"),
        file("disc.cue", 'FILE "track.bin" BINARY\r\n'),
      ];
      const { create, output, runtime } = makeRuntime();
      const requested = options(format);
      const input = inputs[0];
      if (!input) throw new Error("Compression input fixture is missing");
      const read = vi.spyOn(input, "arrayBuffer");

      await expect(compressFiles(inputs, requested, runtime)).resolves.toBe(output);

      const request = create.mock.calls[0]?.[0] as unknown as Parameters<
        NonNullable<WorkflowRuntime["compression"]["create"]>
      >[0];
      expect(request.entries?.map((entry) => entry.filename)).toEqual(inputs.map(({ name }) => name));
      expect(request.entries?.map((entry) => entry.file)).toEqual(inputs);
      expect(request.options).toMatchObject({
        outputName: `release.${format}`,
        signal: requested.signal,
        threads: 3,
        zipCodec: "deflate",
        compressionProfile: "low",
      });
      expect(read).not.toHaveBeenCalled();
      expect(output.dispose).not.toHaveBeenCalled();
    },
  );

  it("preserves a single archive member's name when the archive has another name", async () => {
    const source = file("fix.bps");
    const { create, runtime } = makeRuntime();
    await compressFiles([source], options("zip"), runtime);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [expect.objectContaining({ file: source, filename: "fix.bps" })],
        options: expect.objectContaining({ outputName: "release.zip" }),
      }),
    );
  });

  it("filters formats for raw inputs, compressed inputs, and multi-file sets", async () => {
    expect(await getCompressFormats([file("game.iso", new Uint8Array(2048))])).toEqual(["zip", "7z", "chd", "rvz"]);
    expect(await getCompressFormats([file("game.iso", "not-sector-aligned")])).toEqual(["zip", "7z", "rvz"]);
    expect(await getCompressFormats([file("game.3ds")])).toEqual(["zip", "7z", "z3ds"]);
    for (const name of ["game.gba", "disc.chd", "game.rvz", "disc.gdi", "game.z3ds"]) {
      expect(await getCompressFormats([file(name)])).toEqual(["zip", "7z"]);
    }
    expect(await getCompressFormats([file("a.bin"), file("b.ips")])).toEqual(["zip", "7z"]);
  });

  it("keeps CD codecs, output metadata, and lazy bytes consistent for a small ISO", async () => {
    const source = file("disc.iso", new Uint8Array(2048));
    const read = vi.spyOn(source, "arrayBuffer");
    const { create, cleanup, runtime } = makeRuntime();
    expect((await getCompressSource([source]))?.metadata).toMatchObject({ mode: "cd" });
    const output = await compressFiles([source], options("chd"), runtime);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        source,
        format: "chd",
        outputName: "release.chd",
        romSpecific: { chd: expect.objectContaining({ mode: "cd", compressionCodecs: expect.stringContaining("cd") }) },
      }),
    );
    expect(read).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    await output.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("compresses only a complete CUE group and supplies each track unchanged", async () => {
    const cue = file("disc.cue", 'FILE "track.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n');
    const track = file("track.bin", new Uint8Array(2352));
    const { create, runtime } = makeRuntime();
    expect(await getCompressFormats([cue])).toEqual(["zip", "7z"]);
    expect(await getCompressFormats([cue, track, file("extra.bin")])).toEqual(["zip", "7z"]);
    await expect(compressFiles([cue], options("chd"), runtime)).rejects.toThrow("missing track: track.bin");
    await expect(compressFiles([cue, track, file("extra.bin")], options("chd"), runtime)).rejects.toThrow(
      "unreferenced file",
    );
    expect(await getCompressFormats([cue, track])).toEqual(["zip", "7z", "chd"]);
    await compressFiles([cue, track], options("chd"), runtime);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: cue,
        romSpecific: {
          chd: expect.objectContaining({ imageFiles: [{ fileName: "track.bin", source: track }], mode: "cd" }),
        },
      }),
    );
  });

  it("rejects duplicate paths and cancellation before starting compression", async () => {
    const { create, runtime } = makeRuntime();
    await expect(compressFiles([file("same.bin"), file("same.bin")], options("zip"), runtime)).rejects.toThrow(
      "Duplicate archive entry path",
    );
    const abort = new AbortController();
    abort.abort();
    await expect(
      compressFiles([file("game.bin")], { ...options("zip"), signal: abort.signal }, runtime),
    ).rejects.toThrow("cancelled");
    expect(create).not.toHaveBeenCalled();
  });

  it("matches CUE track references without folders or letter case", async () => {
    const cue = file(
      "disc.cue",
      'FILE "tracks/TRACK1.BIN" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n' +
        'FILE "tracks\\\\TRACK2.BIN" BINARY\n  TRACK 02 AUDIO\n    INDEX 01 00:00:00\n',
    );
    const track1 = file("track1.bin", new Uint8Array(2352));
    const track2 = file("track2.bin", new Uint8Array(2352));
    const { create, runtime } = makeRuntime();
    expect(await getCompressFormats([cue, track2, track1])).toEqual(["zip", "7z", "chd"]);
    await compressFiles([cue, track2, track1], options("chd"), runtime);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        source: cue,
        romSpecific: {
          chd: expect.objectContaining({
            imageFiles: [
              { fileName: "track2.bin", source: track2 },
              { fileName: "track1.bin", source: track1 },
            ],
          }),
        },
      }),
    );
  });

  it("rejects ambiguous CUE track names while allowing the files in an archive", async () => {
    const cue = file("disc.cue", 'FILE "track.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n');
    const lower = file("track.bin");
    const upper = file("TRACK.BIN");
    const { runtime } = makeRuntime();
    expect(await getCompressFormats([cue, lower, upper])).toEqual(["zip", "7z"]);
    await expect(compressFiles([cue, lower, upper], options("chd"), runtime)).rejects.toThrow("ambiguous track names");
    await expect(compressFiles([cue, lower, upper], options("zip"), runtime)).resolves.toBeDefined();
    const repeated = file("disc.cue", 'FILE "a/track.bin" BINARY\nFILE "b/TRACK.BIN" BINARY\n');
    await expect(compressFiles([repeated, lower], options("chd"), runtime)).rejects.toThrow("ambiguous track names");
  });

  it("cleans the built disc output if conversion to a public output fails", async () => {
    const { cleanup, createSource, runtime } = makeRuntime();
    createSource.mockRejectedValue(new Error("conversion failed"));
    await expect(compressFiles([file("game.iso", new Uint8Array(2048))], options("chd"), runtime)).rejects.toThrow(
      "conversion failed",
    );
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
