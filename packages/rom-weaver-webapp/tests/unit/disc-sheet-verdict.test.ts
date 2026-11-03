import { describe, expect, it, vi } from "vitest";
import { prepareInputAssets, prepareMultipleDirectInputAssets } from "../../src/lib/input/input-preparation-service.ts";
import { buildSessionOutputFiles } from "../../src/lib/output/output-build-service.ts";
import { findDcpDiscSheet } from "../../src/lib/workflow/apply-dcp-patch.ts";
import type { WorkflowRuntime } from "../../src/types/workflow-runtime-adapter.ts";

const cueText = 'FILE "track.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n';

describe("ingested disc sheet verdict", () => {
  for (const route of ["loose", "archive", "wrapped", "blobs"]) {
    it.each([
      { name: "unmarked GD-ROM", format: "GD-ROM", mode: "gd", platform: "Sega Dreamcast", marker: false },
      { name: "Dreamcast selfboot CD", format: "CD", mode: "cd", platform: "Sega Dreamcast", marker: false },
      { name: "CD overriding a density marker", format: "CD", mode: "cd", platform: "Sega Dreamcast", marker: true },
      { name: "Saturn CD", format: "CD", mode: "cd", platform: "Sega Saturn", marker: false },
    ])(`uses the same $name verdict for DCP and CHD through ${route}`, async ({ format, mode, platform, marker }) => {
      const sheet = new File([(marker ? "REM HIGH-DENSITY AREA\n" : "") + cueText], "disc.cue");
      const track = new File([platform], "track.bin");
      const run = vi.fn(async () => ({
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
      }));
      const create = vi.fn(async () => ({ fileName: "disc.chd", size: 3, bytes: new Uint8Array([1, 2, 3]) }));
      const runtime = { name: "browser", sidecars: {}, workerIo: {}, ingest: { run }, compression: { create } };
      const sources = [track, sheet].map((file) => {
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
