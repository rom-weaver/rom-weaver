import { describe, expect, it, vi } from "vitest";
import { prepareInputAssets, prepareMultipleDirectInputAssets } from "../../src/lib/input/input-preparation-service.ts";
import { parseCueFileReferences, parseGdiFileReferences } from "../../src/lib/input/archive.ts";
import { ApplyWorkflowController } from "../../src/lib/workflow/apply-workflow-controller.ts";
import { stageArchiveInputs } from "../../src/platform/browser/workflow-runtime-archive.ts";
import type { RuntimeWorkerIo } from "../../src/types/workflow-runtime-adapter.ts";
import { buildSessionOutputFiles } from "../../src/lib/output/output-build-service.ts";
import { findDcpDiscSheet } from "../../src/lib/workflow/apply-dcp-patch.ts";
import { configureBrowserSourcePrimitives } from "../../src/storage/browser/browser-source-primitives.ts";
import type { WorkflowRuntime } from "../../src/types/workflow-runtime-adapter.ts";

configureBrowserSourcePrimitives();

const cueText = 'FILE "track.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n';

describe("ingested disc sheet verdict", () => {
  for (const route of ["loose", "archive", "wrapped", "blobs", "handle", "wrapped-handle"]) {
    it.each([
      { name: "unmarked GD-ROM", format: "GD-ROM", mode: "gd", platform: "Sega Dreamcast", marker: false },
      { name: "Dreamcast selfboot CD", format: "CD", mode: "cd", platform: "Sega Dreamcast", marker: false },
      { name: "CD overriding a density marker", format: "CD", mode: "cd", platform: "Sega Dreamcast", marker: true },
      { name: "Saturn CD", format: "CD", mode: "cd", platform: "Sega Saturn", marker: false },
    ])(`uses the same $name verdict for DCP and CHD through ${route}`, async ({ format, mode, platform, marker }) => {
      const sheet = new File([(marker ? "REM HIGH-DENSITY AREA\n" : "") + cueText], "disc.cue");
      const track = new File([platform], "track.bin");
      const run = vi.fn(async ({ source, companionFiles }) => {
        if (companionFiles?.length && !(source instanceof File))
          throw new Error("Companion ingest requires a File source");
        return {
          result: {
            assets: [
              { fileName: "disc.cue", kind: "cue", discFormat: format, chdCreateMode: mode, copiedInPlace: true },
              {
                fileName: "track.bin",
                kind: "bin",
                discFormat: format,
                chdCreateMode: mode,
                platform,
                copiedInPlace: true,
              },
            ],
            patches: [],
          },
          outputs:
            route === "archive"
              ? [
                  { fileName: "disc.cue", blob: sheet, size: sheet.size },
                  { fileName: "track.bin", blob: track, size: track.size },
                ]
              : [],
          patchOutputs: [],
        };
      });
      const create = vi.fn(async () => ({ fileName: "disc.chd", size: 3, bytes: new Uint8Array([1, 2, 3]) }));
      const runtime = { name: "browser", sidecars: {}, workerIo: {}, ingest: { run }, compression: { create } };
      const sources = [track, sheet].map((file) => {
        if ((route === "handle" || route === "wrapped-handle") && file === sheet) {
          const handle = { kind: "file", name: file.name, getFile: async () => file } as FileSystemFileHandle;
          return route === "handle" ? handle : { source: handle, fileName: file.name };
        }
        if (route === "wrapped") return { source: file, fileName: file.name };
        if (route === "blobs") return { source: new Blob([file]), fileName: file.name };
        return file;
      });
      const assets =
        route === "archive"
          ? await prepareInputAssets(
              new File(["archive"], "disc.zip"),
              undefined,
              0,
              runtime as unknown as WorkflowRuntime,
            )
          : await prepareMultipleDirectInputAssets(sources, undefined, runtime as unknown as WorkflowRuntime);
      if (route === "loose")
        expect(run).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ source: sheet, companionFiles: [track] }),
        );
      else expect(run).toHaveBeenCalledOnce();
      expect(assets?.every((asset) => asset.file.metadata?.format === format)).toBe(true);
      expect(assets?.every((asset) => asset.file.metadata?.chdCreateMode === mode)).toBe(true);
      expect(findDcpDiscSheet(assets || [])?.fileName).toBe(mode === "gd" ? "disc.cue" : undefined);
      await buildSessionOutputFiles(
        assets || [],
        new Map(),
        { output: { compression: "chd" } },
        runtime as unknown as WorkflowRuntime,
      );
      expect(create).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ romSpecific: { chd: expect.objectContaining({ mode }) } }),
      );
    });
  }
});

describe("loose sheet identity", () => {
  it.each([
    { name: "Disc.cue", returnedName: "Disc.cue", kind: "cue", text: cueText },
    { name: "Disc.gdi", returnedName: "Disc.gdi", kind: "rom", text: '1\n1 45000 4 2352 "track.bin" 0\n' },
    { name: "Disc*.gdi", returnedName: "Disc_.gdi", kind: undefined, text: '1\n1 45000 4 2352 "track.bin" 0\n' },
    { name: "日本 : Disc.cue", returnedName: "日本 : Disc.cue", kind: "cue", text: cueText },
  ])("keeps the native verdict for $name ($kind)", async ({ name, returnedName, kind, text }) => {
    const run = vi.fn(async () => ({
      result: {
        assets: [{ fileName: returnedName, kind, discFormat: "GD-ROM", chdCreateMode: "gd", copiedInPlace: true }],
        patches: [],
      },
      outputs: [],
      patchOutputs: [],
    }));
    const assets = await prepareMultipleDirectInputAssets(
      [new File([text], name), new File(["track"], "track.bin")],
      undefined,
      { name: "browser", sidecars: {}, ingest: { run } } as unknown as WorkflowRuntime,
    );
    expect(assets?.every((asset) => asset.file.metadata?.format === "GD-ROM")).toBe(true);
  });
});

describe("mixed-case GDI media consumers", () => {
  it.each([
    { format: "GD-ROM", mode: "gd" },
    { format: "CD", mode: "cd" },
  ])("retains the native $format verdict", async ({ format, mode }) => {
    const sheet = new File(['1\n1 45000 4 2352 "Track 日本 : 01.bin" 0\n'], "Disc 日本 : 01.GDI");
    const track = new File(["track"], "Track 日本 : 01.bin");
    const run = vi.fn(async () => ({
      result: {
        assets: [{ fileName: sheet.name, kind: "rom", discFormat: format, chdCreateMode: mode, copiedInPlace: true }],
        patches: [],
      },
      outputs: [],
      patchOutputs: [],
    }));
    const create = vi.fn(async () => ({ fileName: "disc.chd", size: 1, bytes: new Uint8Array([1]) }));
    const runtime = {
      name: "browser",
      sidecars: {},
      ingest: { run },
      compression: { create },
    } as unknown as WorkflowRuntime;
    const assets = await prepareMultipleDirectInputAssets([track, sheet], undefined, runtime);
    expect(findDcpDiscSheet(assets || [])?.fileName).toBe(mode === "gd" ? sheet.name : undefined);
    await buildSessionOutputFiles(assets || [], new Map(), { output: { compression: "chd" } }, runtime);
    expect(create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ romSpecific: { chd: expect.objectContaining({ mode }) } }),
    );
  });
});

describe("independent loose disc groups", () => {
  it.each([10, 100])("keeps %s disjoint groups isolated and their tracks lazy", async (count) => {
    const tracks = Array.from({ length: count }, (_, index) => new File(["track"], `Track${index}.bin`));
    const reads = tracks.map((track) => vi.spyOn(track, "arrayBuffer"));
    const sources = tracks.flatMap((track, index) => [
      new File([`FILE "${track.name}" BINARY\n TRACK 01 MODE1/2352\n INDEX 01 00:00:00`], `Disc${index}.cue`),
      track,
    ]);
    const run = vi.fn(async ({ source, companionFiles }: { source: File; companionFiles: File[] }) => ({
      result: {
        assets: [
          { fileName: source.name, kind: "cue", discFormat: "GD-ROM", chdCreateMode: "gd", copiedInPlace: true },
          ...companionFiles.map((file) => ({ fileName: file.name, kind: "bin", copiedInPlace: true })),
        ],
        patches: [],
      },
      outputs: [],
      patchOutputs: [],
    }));
    const assets = await prepareMultipleDirectInputAssets(sources, undefined, {
      name: "browser",
      sidecars: {},
      ingest: { run },
    } as unknown as WorkflowRuntime);
    expect(assets).toHaveLength(count * 2);
    expect(run).toHaveBeenCalledTimes(count);
    for (const [input] of run.mock.calls) {
      expect(input.companionFiles).toHaveLength(1);
      expect(await input.source.text()).toContain(`"${input.companionFiles[0]?.name}"`);
    }
    for (const read of reads) expect(read).not.toHaveBeenCalled();
  });
});

describe("repeated physical disc sources", () => {
  it.each([
    {
      extension: "cue",
      text: 'FILE "shared.bin" BINARY\n TRACK 01 MODE1/2352\n INDEX 01 00:00:00\nFILE "shared.bin" BINARY\n TRACK 02 MODE1/2352\n INDEX 01 00:00:01\n',
    },
    { extension: "gdi", text: '2\n1 0 4 2352 "shared.bin" 0\n2 45000 4 2352 "shared.bin" 2352\n' },
  ])(
    "stages a shared $extension track once while retaining every reference and its cache",
    async ({ extension, text }) => {
      const references =
        extension === "cue"
          ? parseCueFileReferences(text).map((reference) => reference.fileName)
          : parseGdiFileReferences(text);
      expect(references).toEqual(["shared.bin", "shared.bin"]);
      const sheet = new File([text], `disc.${extension}`);
      const track = new File([new Uint8Array(4704)], "shared.bin");
      const checksums = { crc32: "12345678", md5: "ab".repeat(16), sha1: "cd".repeat(20) };
      const checksumVariants = [{ id: "raw", label: "Raw", checksums }];
      const identification = { status: "unknown", matches: [] };
      const stageSources = vi.fn<RuntimeWorkerIo["stageSources"]>(async (requests) =>
        requests.map((request) => ({
          fileName: request.fallbackFileName,
          filePath: `/work/${request.fallbackFileName}`,
          cleanup: async () => undefined,
        })),
      );
      const workerIo = { stageSources } as unknown as RuntimeWorkerIo;
      const run = vi.fn(async ({ source, companionFiles }: { source: File; companionFiles: File[] }) => {
        await stageArchiveInputs(workerIo, { source, companionFiles });
        return {
          result: {
            isRom: true,
            assets: [
              { fileName: sheet.name, kind: extension, discFormat: "GD-ROM", chdCreateMode: "gd", copiedInPlace: true },
              {
                fileName: track.name,
                kind: "bin",
                discFormat: "GD-ROM",
                chdCreateMode: "gd",
                platform: "Sega Dreamcast",
                checksums,
                checksumVariants,
                checksumMs: 7,
                identification,
                copiedInPlace: true,
              },
            ],
            patches: [],
          },
          outputs: [],
          patchOutputs: [],
        };
      });
      const runtime = { name: "browser", sidecars: {}, workerIo, ingest: { run } } as unknown as WorkflowRuntime;
      const sources = [track, sheet];
      const assets = await prepareMultipleDirectInputAssets(sources, undefined, runtime);
      expect(assets?.map((asset) => asset.kind)).toEqual([extension, "track", "track"]);
      expect(assets?.[1]?.file).toBe(assets?.[2]?.file);
      expect(
        assets?.every(
          (asset) => asset.file.metadata?.format === "GD-ROM" && asset.file.metadata.chdCreateMode === "gd",
        ),
      ).toBe(true);
      for (const asset of assets?.filter((asset) => asset.kind === "track") || []) {
        expect(asset.file).toMatchObject({ checksums, checksumVariants, identification, _precomputedChecksumMs: 7 });
      }
      expect(run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source: sheet, companionFiles: [track] }));
      expect(stageSources).toHaveBeenCalledExactlyOnceWith([
        expect.objectContaining({ source: expect.any(File), fallbackFileName: sheet.name }),
        expect.objectContaining({ source: expect.any(File), fallbackFileName: track.name }),
      ]);
      run.mockClear();
      stageSources.mockClear();
      const controller = new ApplyWorkflowController<File, unknown>(runtime);
      try {
        await controller.setInput(sources);
        const state = controller.getInput();
        expect(state?.status).toBe("ready");
        const tracks = state?.resolvedInputs?.filter((input) => input.kind === "track");
        expect(tracks).toHaveLength(2);
        for (const resolved of tracks || [])
          expect(resolved).toMatchObject({
            checksums,
            checksumVariants,
            identification,
            checksumTimeMs: 7,
            romType: { discFormat: "GD-ROM", chdCreateMode: "gd" },
          });
        expect(run).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ source: sheet, companionFiles: [track] }),
        );
      } finally {
        await controller.dispose();
      }
    },
  );
});
