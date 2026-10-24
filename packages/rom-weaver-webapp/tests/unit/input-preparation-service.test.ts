import { describe, expect, it, vi } from "vitest";

import {
  getBinarySourceSize,
  prepareInput,
  prepareInputAssets,
  prepareInputFile,
  prepareMultipleDirectInputAssets,
} from "../../src/lib/input/input-preparation-service.ts";
import { getProgressStagedInputInfo } from "../../src/public/react/apply-session-inputs.ts";
import { buildCompressPanel } from "../../src/public/react/compress-options.ts";
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
    // The direct-drop path tags this sibling GDI as cue through makeCueAsset.
    // The archive path uses makeGdiAsset, so the same descriptor receives a different kind there.
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

  // Byte-level inference lives in Rust; the early `probe-identity` manifest and the ingest asset carry
  // its verdict (`chd_create_mode` / `chdCreateMode`), which the webapp turns into the UI codec hint.
  const manifestEvent = (probeManifest: Record<string, unknown>) =>
    ({ details: { probe_manifest: probeManifest }, stage: "probe-identity" }) as never;

  it("publishes a UI-only generic codec hint for the Rust hard-disk verdict", () => {
    const staged = getProgressStagedInputInfo(manifestEvent({ chd_create_mode: "hd", disc_format: "CD" }));
    expect(staged.chdCodecMode).toBe("dvd");
    expect(staged.chdMode).toBeUndefined();
    expect(staged.romType?.chdCreateMode).toBe("hd");
    const panel = buildCompressPanel(
      "chd",
      { chdCreateCdCodecs: "cdlz", chdCreateDvdCodecs: "zstd" },
      {
        fileName: "hybrid.bin",
        size: 204800,
        chdCodecMode: staged.chdCodecMode,
        metadata: { format: "CD" },
      },
    );
    expect(panel?.fields[0]?.key).toBe("chdCreateDvdCodecs");
    expect(panel?.fields[0]?.value).toBe("zstd");
    expect(panel?.note).toBeUndefined();
  });

  it.each([
    ["dvd", "chdCreateDvdCodecs"],
    ["cd", "chdCreateCdCodecs"],
  ])("shows the codec field for the Rust create-mode verdict %s of an unidentified ISO", (verdict, key) => {
    const bytes = new Uint8Array(100 * 2048);
    const staged = getProgressStagedInputInfo(manifestEvent({ chd_create_mode: verdict }));
    expect(staged.chdCodecMode).toBe(verdict === "dvd" ? "dvd" : undefined);
    const panel = buildCompressPanel(
      "chd",
      { chdCreateCdCodecs: "cdlz", chdCreateDvdCodecs: "zstd" },
      {
        fileName: "disc.iso",
        size: bytes.length,
        chdCodecMode: staged.chdCodecMode,
        metadata: { chdCreateMode: verdict },
      },
    );
    expect(panel?.fields[0]?.key).toBe(key);
  });

  it.each([
    ["DVD", "DVD"],
    ["CD", undefined],
  ])("keeps a %s identity note only when it agrees with the staged DVD hint", (format, note) => {
    const panel = buildCompressPanel(
      "chd",
      { chdCreateCdCodecs: "cdlz", chdCreateDvdCodecs: "zstd" },
      { fileName: "game.iso", chdCodecMode: "dvd", metadata: { format } },
    );
    expect(panel?.fields[0]?.key).toBe("chdCreateDvdCodecs");
    expect(panel?.note).toBe(note);
  });

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

  // The path-backed CUE reaches a synchronous byte read before sidecar resolution, which the browser source cannot provide.
  // This case records that failure; the multi-file path above handles CUE and track grouping.
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
