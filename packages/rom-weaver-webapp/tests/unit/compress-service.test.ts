import { describe, expect, it, vi } from "vitest";
import type { WorkflowRuntime } from "../../src/types/workflow-runtime-adapter.ts";
import type { ApplyWorkflowOptions, PublicOutput } from "../../src/types/workflow-runtime-types.ts";
import {
  compressFiles,
  getCompressFormats,
  getCompressSource,
  extractCompressEntries,
  isOpenableCompressInput,
  listCompressInput,
} from "../../src/webapp/compress-service.ts";

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

  describe("archive inputs", () => {
    const extracted = (path: string, stored: File | null) =>
      ({
        dispose: vi.fn(async () => undefined),
        fileName: path.split("/").pop(),
        path: `/extract/${path}`,
        size: stored?.size ?? 0,
        vfs: { getFile: vi.fn(async () => stored) },
      }) as unknown as PublicOutput;
    // Serves one stored entry per extract call, keyed by the requested entry path.
    const extractRuntime = (stored: Record<string, File | null>) => {
      const outputs: PublicOutput[] = [];
      const extract = vi.fn(async ({ entries }: { entries: string[] }) => {
        const path = entries[0] ?? "";
        const output = extracted(path, stored[path] ?? null);
        outputs.push(output);
        return { entries: [], output, outputs: [output] };
      });
      return { extract, outputs, runtime: { compression: { extract } } as unknown as WorkflowRuntime };
    };

    it("opens archives and compressed disc images but not plain files", () => {
      expect(
        ["game.zip", "disc.chd", "disc.RVZ", "game.7z"].map((name) => isOpenableCompressInput(file(name))),
      ).toEqual([true, true, true, true]);
      expect(["game.iso", "fix.bps", "track.bin"].map((name) => isOpenableCompressInput(file(name)))).toEqual([
        false,
        false,
        false,
      ]);
    });

    it("lists entries without extracting and leaves out directories", async () => {
      const probe = vi.fn(async () => ({
        entries: [
          { filename: "Game/", fileType: "directory" },
          { filename: "Game/game.iso", size: 4096 },
          { filename: "Game/game.cue" },
        ],
      }));
      const extract = vi.fn();
      const runtime = { compression: { extract, probe } } as unknown as WorkflowRuntime;

      await expect(listCompressInput(file("game.zip"), runtime)).resolves.toEqual([
        { path: "Game/game.iso", size: 4096 },
        { path: "Game/game.cue" },
      ]);
      expect(extract).not.toHaveBeenCalled();
    });

    it("extracts only the named entries, one at a time, into stored files", async () => {
      const { extract, outputs, runtime } = extractRuntime({
        "disc/disc.cue": file("x", "cue"),
        "disc/track.bin": file("y", "bin!"),
      });
      const signal = new AbortController().signal;
      const progress: Array<number | null | undefined> = [];
      extract.mockImplementationOnce(async ({ entries, options }) => {
        options.onProgress?.({ label: "", percent: 50, stage: "input" });
        const output = extracted(entries[0] ?? "", file("x", "cue"));
        outputs.push(output);
        return { entries: [], output, outputs: [output] };
      });
      const entries = await extractCompressEntries(file("disc.zip"), ["disc/disc.cue", "disc/track.bin"], runtime, {
        onProgress: (event) => progress.push(event.percent),
        signal,
      });

      expect(extract.mock.calls.map(([request]) => [request.entries, request.options.directExtract])).toEqual([
        [["disc/disc.cue"], true],
        [["disc/track.bin"], true],
      ]);
      expect(progress).toEqual([25]);
      expect(entries.map((entry) => [entry.path, entry.file.name, entry.file.size])).toEqual([
        ["disc/disc.cue", "disc.cue", 3],
        ["disc/track.bin", "track.bin", 4],
      ]);
      expect(await entries[1]?.file.text()).toBe("bin!");
      expect(outputs.every((output) => vi.mocked(output.dispose).mock.calls.length === 0)).toBe(true);
    });

    it("names entries that share a base name after their folders so they compress together", async () => {
      const { runtime } = extractRuntime({
        "Disc 1/readme.txt": file("a", "one"),
        "Disc 2/readme.txt": file("b", "two"),
        "Disc 1/game.cue": file("c", "cue"),
      });
      const entries = await extractCompressEntries(
        file("set.zip"),
        ["Disc 1/readme.txt", "Disc 2/readme.txt", "Disc 1/game.cue"],
        runtime,
      );

      expect(entries.map((entry) => entry.file.name)).toEqual([
        "Disc 1 - readme.txt",
        "Disc 2 - readme.txt",
        "game.cue",
      ]);
      await expect(getCompressFormats(entries.slice(0, 2).map((entry) => entry.file))).resolves.toEqual(["zip", "7z"]);
    });

    it("disposes every extracted file when one cannot be read", async () => {
      const { outputs, runtime } = extractRuntime({ "a.bin": file("a", "a"), "b.bin": null });

      await expect(extractCompressEntries(file("pair.zip"), ["a.bin", "b.bin"], runtime)).rejects.toThrow(
        "Extracted file is not available: b.bin",
      );
      expect(outputs).toHaveLength(2);
      for (const output of outputs) expect(output.dispose).toHaveBeenCalledOnce();
    });

    it("stops and disposes the extracted files when the signal aborts", async () => {
      const abort = new AbortController();
      const { extract, outputs, runtime } = extractRuntime({ "a.bin": file("a", "a"), "b.bin": file("b", "b") });
      extract.mockImplementationOnce(async ({ entries }) => {
        abort.abort();
        const output = extracted(entries[0] ?? "", file("a", "a"));
        outputs.push(output);
        return { entries: [], output, outputs: [output] };
      });

      await expect(
        extractCompressEntries(file("a.zip"), ["a.bin", "b.bin"], runtime, { signal: abort.signal }),
      ).rejects.toThrow("Opening cancelled");
      expect(extract).toHaveBeenCalledOnce();
      expect(outputs[0]?.dispose).toHaveBeenCalledOnce();
    });
  });
});
