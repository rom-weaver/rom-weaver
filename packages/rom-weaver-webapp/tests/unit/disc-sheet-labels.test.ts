import { describe, expect, it, vi } from "vitest";
import { createPatchFile } from "../../src/lib/input/binary-service.ts";
import { getDiscFormatLabel } from "../../src/lib/input/rom-specific-file-utils.ts";
import { ApplyWorkflowController } from "../../src/lib/workflow/apply-workflow-controller.ts";
import { getPatchFilePrecomputedRomType } from "../../src/lib/workflow/staged-source-checksums.ts";
import { toStagedInputInfos } from "../../src/public/react/apply-workflow-staging-model.ts";
import type { WorkflowRuntime } from "../../src/types/workflow-runtime-adapter.ts";

const checksums = { crc32: "12345678", md5: "ab".repeat(16), sha1: "cd".repeat(20) };

describe("disc labels through input staging", () => {
  for (const route of ["loose", "archive"] as const) {
    it.each([
      { name: "unmarked GD-ROM", format: "GD-ROM", probeFormat: "CD", platform: "Sega Dreamcast" },
      { name: "selfboot CD", format: "CD", probeFormat: "GD-ROM", platform: "Sega Dreamcast" },
      { name: "Saturn CD", format: "CD", probeFormat: "GD-ROM", platform: "Sega Saturn" },
    ])(`preserves the $name sheet verdict through ${route} staging`, async ({ format, probeFormat, platform }) => {
      const sheet = new File(['FILE "track.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n'], "disc.cue");
      const track = new File([platform], "track.bin");
      const trackType = { platform, discFormat: probeFormat, recommendedFormat: "chd" };
      const run = vi.fn(async ({ fileName }: { fileName?: string }) => {
        const grouped = fileName === "disc.cue" || fileName === "disc.zip";
        return {
          result: {
            isRom: true,
            assets: grouped
              ? [
                  { fileName: sheet.name, kind: "cue", discFormat: format, copiedInPlace: true },
                  { fileName: track.name, kind: "bin", discFormat: format, platform, copiedInPlace: true },
                ]
              : [{ fileName: track.name, kind: "rom", ...trackType, checksums, copiedInPlace: true }],
            patches: [],
          },
          outputs:
            grouped && route === "archive"
              ? [
                  { fileName: sheet.name, blob: sheet, size: sheet.size, dispose: vi.fn(async () => undefined) },
                  {
                    fileName: track.name,
                    blob: track,
                    size: track.size,
                    checksums,
                    romType: trackType,
                    dispose: vi.fn(async () => undefined),
                  },
                ]
              : [],
          patchOutputs: [],
        };
      });
      const runtime = { name: "browser", sidecars: {}, workerIo: {}, ingest: { run } } as unknown as WorkflowRuntime;
      const controller = new ApplyWorkflowController<File, unknown>(runtime);
      const inputs = route === "archive" ? [new File(["archive"], "disc.zip")] : [track, sheet];
      try {
        await controller.setInput(inputs);
        const state = controller.getInput();
        expect(state?.status).toBe("ready");
        const row = toStagedInputInfos(state, inputs).find((input) => input.kind === "track");
        expect(row?.romType).toEqual({ ...trackType, discFormat: format });
        expect(state?.romType).toEqual({ ...trackType, discFormat: format });
        expect(getDiscFormatLabel(row?.romType?.discFormat)).toBe(format === "CD" ? "CD-ROM" : "GD-ROM");
        expect(run).toHaveBeenCalledTimes(route === "archive" ? 1 : 2);
      } finally {
        await controller.dispose();
      }
    });
  }
});

describe("prepared optical metadata", () => {
  it.each([undefined, "", "zip", "rvz"])("preserves the probe type for non-optical format %s", async (format) => {
    const file = await createPatchFile(new Uint8Array([1]), "track.bin");
    const romType = { platform: "Sega Dreamcast", discFormat: "GD-ROM", recommendedFormat: "chd", chdCreateMode: "gd" };
    Object.assign(file, { romType });
    file.metadata = { format };
    expect(getPatchFilePrecomputedRomType(file)).toEqual(romType);
    expect(getPatchFilePrecomputedRomType(file)).not.toBe(romType);
  });

  it.each(["CD", "GD-ROM", "DVD"])("retains the %s verdict without a platform probe", async (format) => {
    const file = await createPatchFile(new Uint8Array([1]), "track.bin");
    file.metadata = { format };
    expect(getPatchFilePrecomputedRomType(file)).toEqual({ discFormat: format });
  });

  it("keeps an absent type unknown without optical metadata", () => {
    expect(getPatchFilePrecomputedRomType(undefined)).toBeUndefined();
  });
});
