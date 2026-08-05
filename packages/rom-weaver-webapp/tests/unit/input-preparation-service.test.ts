import { describe, expect, it, vi } from "vitest";

import {
  getBinarySourceSize,
  prepareInput,
  prepareInputAssets,
  prepareInputFile,
  prepareMultipleDirectInputAssets,
} from "../../src/lib/input/input-preparation-service.ts";
import type { SourceRef } from "../../src/types/source.ts";

const makeFile = (contents: string, fileName: string, type = "application/octet-stream") =>
  new File([contents], fileName, { type });

const CUE_TEXT = ['FILE "track01.bin" BINARY', "  TRACK 01 MODE1/2352", "    INDEX 01 00:00:00"].join("\n");

const GDI_TEXT = ["1", '1 0 4 2352 "track01.bin" 0'].join("\n");

const NO_CONTAINER_OPTIONS = { input: { containerInputsEnabled: false } } as const;

describe("getBinarySourceSize", () => {
  it("reads the size off a plain File source", () => {
    const file = makeFile("hello world", "rom.bin");
    expect(getBinarySourceSize(file as unknown as Parameters<typeof getBinarySourceSize>[0])).toBe(11);
  });
});

describe("prepareMultipleDirectInputAssets", () => {
  it("returns null when no source is a CUE sheet", async () => {
    const sources: SourceRef[] = [makeFile("bytes", "rom.bin")];
    await expect(prepareMultipleDirectInputAssets(sources, undefined)).resolves.toBeNull();
  });

  it("groups a CUE and its referenced track into cue + track assets", async () => {
    const sources: SourceRef[] = [makeFile(CUE_TEXT, "game.cue"), makeFile("track-bytes", "track01.bin")];

    const assets = await prepareMultipleDirectInputAssets(sources, undefined);

    expect(assets).not.toBeNull();
    expect(assets?.map((asset) => asset.kind)).toEqual(["cue", "track"]);
    const cueAsset = assets?.find((asset) => asset.kind === "cue");
    const trackAsset = assets?.find((asset) => asset.kind === "track");
    expect(cueAsset?.fileName).toBe("game.cue");
    expect(trackAsset?.fileName).toBe("track01.bin");
    expect(trackAsset?.groupId).toBe(cueAsset?.groupId);
    expect(trackAsset?.patchable).toBe(true);
  });

  it("merges a sibling GDI referencing the same tracks into the disc group instead of a separate ROM", async () => {
    const sources: SourceRef[] = [
      makeFile(CUE_TEXT, "game.cue"),
      makeFile(GDI_TEXT, "game.gdi"),
      makeFile("track-bytes", "track01.bin"),
    ];

    const assets = await prepareMultipleDirectInputAssets(sources, undefined);

    expect(assets).not.toBeNull();
    expect(assets).toHaveLength(3);
    expect(assets?.some((asset) => asset.kind === "rom")).toBe(false);
    const gdiAsset = assets?.find((asset) => asset.fileName === "game.gdi");
    expect(gdiAsset).toBeDefined();
    // NOTE: the archive-extraction merge path (input-preparation-archive.ts) tags the sibling GDI
    // asset with kind "gdi" via makeGdiAsset, but this direct multi-file-drop path tags it "cue" via
    // makeCueAsset instead (input-preparation-service.ts line ~543). That looks like an inconsistency/bug -
    // a directly-dropped CUE+GDI+track set would render in the UI's CUE panel instead of the GDI panel,
    // unlike the same disc supplied inside an archive. Asserting today's actual behavior here so a fix
    // shows up as an intentional test change rather than a silent regression.
    expect(gdiAsset?.kind).toBe("cue");
  });

  it("leaves an unrelated file as a standalone ROM asset alongside the CUE group", async () => {
    const sources: SourceRef[] = [
      makeFile(CUE_TEXT, "game.cue"),
      makeFile("track-bytes", "track01.bin"),
      makeFile("unrelated-bytes", "readme.bin"),
    ];

    const assets = await prepareMultipleDirectInputAssets(sources, undefined);

    expect(assets?.map((asset) => asset.kind).sort()).toEqual(["cue", "rom", "track"]);
    expect(assets?.find((asset) => asset.kind === "rom")?.fileName).toBe("readme.bin");
  });

  it("throws with the missing reference names when a CUE references a file that was not provided", async () => {
    const sources: SourceRef[] = [makeFile(CUE_TEXT, "game.cue")];

    await expect(prepareMultipleDirectInputAssets(sources, undefined)).rejects.toThrow(
      "CUE file references missing file(s): track01.bin",
    );
  });

  it("reports candidates via onCandidatesFound including the missing-reference warning", async () => {
    const onCandidatesFound = vi.fn();
    const sources: SourceRef[] = [makeFile(CUE_TEXT, "game.cue")];

    await expect(prepareMultipleDirectInputAssets(sources, { onCandidatesFound } as never)).rejects.toThrow();

    expect(onCandidatesFound).toHaveBeenCalledTimes(1);
    const request = onCandidatesFound.mock.calls[0]?.[0];
    expect(request.sourceName).toBe("game.cue");
    expect(request.warnings).toEqual(["game.cue references missing file(s): track01.bin"]);
  });
});

describe("prepareInputAssets", () => {
  const runtime = { name: "browser" as const, sidecars: {} };

  it("throws a descriptive error when the source is not path/blob backed", async () => {
    const source = { fileName: "orphan.bin", source: new Uint8Array([1, 2, 3]) } as unknown as SourceRef;

    await expect(prepareInputAssets(source, undefined, 0, runtime)).rejects.toThrow(
      "orphan.bin must be OPFS/VFS path-backed in browser workflows",
    );
  });

  it("resolves a bare (non-container) ROM file into a single rom asset", async () => {
    const source = makeFile("rom-bytes", "game.bin");

    const assets = await prepareInputAssets(source, NO_CONTAINER_OPTIONS as never, 0, runtime);

    expect(assets).toHaveLength(1);
    expect(assets[0]?.kind).toBe("rom");
    expect(assets[0]?.fileName).toBe("game.bin");
    expect(assets[0]?.preparation?.wasDecompressed).toBe(false);
  });

  // A CUE source is always forced onto the path-backed (lazy/OPFS) branch of
  // createInputPreparationPatchFile - getLazyBrowserSource explicitly refuses to hand back an
  // in-memory blob for a `.cue` name (see "cue-input" rejection in input-preparation-service.ts).
  // But the resulting lazy-external PatchFile's bytes can only be read from a worker
  // (getPatchFileBytes throws "Browser-backed file cannot be read synchronously" for it), and
  // resolveCueInputAssets calls decodeUtf8(getPatchFileBytes(cueFile)) synchronously right away.
  // That means a *directly dropped* top-level `.cue` source can never reach the sidecar-track
  // resolution logic this function otherwise implements - it always fails here first, before any
  // `runtime.sidecars.read` call happens. This is a known bug in prepareInputAssets's single-source
  // CUE path, not intended behavior; prepareMultipleDirectInputAssets (tested above) is the one path
  // that actually reaches CUE+track grouping. This test deliberately pins the current (buggy)
  // behavior - when the bug is fixed, it must be updated to assert the real sidecar-track resolution
  // instead of this early throw.
  it("throws when handed a path-backed CUE source directly, before any sidecar resolution runs", async () => {
    const cueSource = { fileName: "game.cue", source: "/vfs/staged/game.cue" } as unknown as SourceRef;
    const sidecarRead = vi.fn(async () => makeFile("track-bytes", "track01.bin") as unknown as SourceRef);
    const sidecarRuntime = { name: "browser" as const, sidecars: { read: sidecarRead } };

    await expect(prepareInputAssets(cueSource, undefined, 0, sidecarRuntime)).rejects.toThrow(
      "Browser-backed file cannot be read synchronously",
    );
    expect(sidecarRead).not.toHaveBeenCalled();
  });
});

describe("prepareInputFile / prepareInput", () => {
  const runtime = { name: "browser" as const, sidecars: {} };

  it("prepareInputFile returns the prepared file plus metrics for a bare ROM", async () => {
    const source = makeFile("rom-bytes", "game.bin");

    const result = await prepareInputFile(source, "rom", NO_CONTAINER_OPTIONS as never, runtime);

    expect(result.file.fileName).toBe("game.bin");
    expect(result.wasDecompressed).toBe(false);
    expect(result.sourceSize).toBe(result.file.fileSize);
  });

  it("prepareInput is a thin wrapper returning only the file", async () => {
    const source = makeFile("patch-bytes", "patch.ips");

    const file = await prepareInput(source, "patch", NO_CONTAINER_OPTIONS as never, runtime);

    expect(file.fileName).toBe("patch.ips");
  });
});
