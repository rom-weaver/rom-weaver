import { describe, expect, it, vi } from "vitest";
import { createPatchFile } from "../../src/lib/input/binary-service.ts";
import { prepareMultipleDirectInputAssets } from "../../src/lib/input/input-preparation-service.ts";
import { getPatchFilePrecomputedIdentifyRetry } from "../../src/lib/workflow/staged-source-checksums.ts";
import { skipSourceIdentification } from "../../src/lib/input/input-identification-policy.ts";
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

describe("loose disc ingest metadata reuse", () => {
  it.each([false, true])("uses one complete ingest with identity policy declined=%s", async (declined) => {
    const sheet = new File(['FILE "track.bin" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n'], "disc.cue");
    const track = new File(["track"], "track.bin");
    if (declined) {
      skipSourceIdentification(sheet);
      skipSourceIdentification(track);
    }
    const identification = { status: "unknown", matches: [] } as const;
    const checksumVariants = [{ id: "raw", label: "Raw", checksums }];
    const run = vi.fn(async () => ({
      result: {
        isRom: true,
        assets: [
          { fileName: sheet.name, kind: "cue", discFormat: "GD-ROM", chdCreateMode: "gd", copiedInPlace: true },
          {
            fileName: track.name,
            kind: "bin",
            discFormat: "GD-ROM",
            chdCreateMode: "gd",
            platform: "Sega Dreamcast",
            recommendedFormat: "chd",
            checksums,
            checksumVariants,
            checksumMs: 17,
            identification: declined ? undefined : identification,
            copiedInPlace: true,
          },
        ],
        patches: [],
      },
      outputs: [],
      patchOutputs: [],
    }));
    const runtime = { name: "browser", sidecars: {}, workerIo: {}, ingest: { run } } as unknown as WorkflowRuntime;
    const controller = new ApplyWorkflowController<File, unknown>(runtime);
    try {
      await controller.setInput([track, sheet]);
      const state = controller.getInput();
      expect(state?.status).toBe("ready");
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith(expect.objectContaining({ identify: !declined }));
      const row = toStagedInputInfos(state, [track, sheet]).find((input) => input.kind === "track");
      expect(row?.checksums).toEqual(checksums);
      expect(row?.checksumVariants).toEqual(checksumVariants);
      expect(state?.resolvedInputs?.find((input) => input.kind === "track")?.checksumTimeMs).toBe(17);
      expect(row?.identification).toEqual(declined ? undefined : identification);
      expect(row?.romType).toEqual({
        platform: "Sega Dreamcast",
        discFormat: "GD-ROM",
        chdCreateMode: "gd",
        recommendedFormat: "chd",
      });
    } finally {
      await controller.dispose();
    }
  });
});

describe("group ingest identification recovery", () => {
  it("retains unavailable identification and the pending retry with complete hashes", async () => {
    const sheet = new File(['FILE "Track*.bin" BINARY\n TRACK 01 MODE1/2352\n INDEX 01 00:00:00'], "Disc*.cue");
    const track = new File(["track"], "Track*.bin");
    const identifyRetry = Promise.resolve(false);
    const run = vi.fn(async () => ({
      identifyRetry,
      identifyUnavailable: "Database is still loading",
      result: {
        isRom: true,
        assets: [
          { fileName: "Disc_.cue", kind: "cue", discFormat: "GD-ROM", copiedInPlace: true },
          { fileName: "Track_.bin", kind: "bin", checksums, checksumMs: 12, copiedInPlace: true },
        ],
        patches: [],
      },
      outputs: [],
      patchOutputs: [],
    }));
    const assets = await prepareMultipleDirectInputAssets([track, sheet], undefined, {
      name: "browser",
      sidecars: {},
      ingest: { run },
    } as unknown as WorkflowRuntime);
    const file = assets?.find((asset) => asset.kind === "track")?.file;
    expect(getPatchFilePrecomputedIdentifyRetry(file)).toBe(identifyRetry);
    expect(file).toMatchObject({
      checksums,
      _precomputedChecksumMs: 12,
      identification: { status: "unavailable", matches: [], unavailableReason: "Database is still loading" },
    });
  });

  it("preserves later automatic identification when one group member declines", async () => {
    const sheet = new File(
      [
        'FILE "first.bin" BINARY\n TRACK 01 MODE1/2352\n INDEX 01 00:00:00\nFILE "second.bin" BINARY\n TRACK 02 MODE1/2352\n INDEX 01 00:00:00',
      ],
      "disc.cue",
    );
    const first = new File(["first"], "first.bin");
    const second = new File(["second"], "second.bin");
    skipSourceIdentification(first);
    const run = vi.fn(async ({ fileName }: { fileName?: string }) => ({
      result: {
        isRom: true,
        assets:
          fileName === sheet.name
            ? [
                { fileName: sheet.name, kind: "cue", discFormat: "GD-ROM", copiedInPlace: true },
                ...[first, second].map((file) => ({
                  fileName: file.name,
                  kind: "bin",
                  checksums,
                  copiedInPlace: true,
                })),
              ]
            : [
                {
                  fileName: second.name,
                  kind: "bin",
                  checksums,
                  identification: { status: "unknown", matches: [] },
                  copiedInPlace: true,
                },
              ],
        patches: [],
      },
      outputs: [],
      patchOutputs: [],
    }));
    const controller = new ApplyWorkflowController<File, unknown>({
      name: "browser",
      sidecars: {},
      workerIo: {},
      ingest: { run },
    } as unknown as WorkflowRuntime);
    try {
      await controller.setInput([sheet, first, second]);
      expect(controller.getInput()?.status).toBe("ready");
      expect(run).toHaveBeenCalledTimes(2);
      expect(run.mock.calls.map(([input]) => input)).toEqual([
        expect.objectContaining({ fileName: sheet.name, identify: false }),
        expect.objectContaining({ fileName: second.name, identify: true }),
      ]);
      expect(
        controller.getInput()?.resolvedInputs?.find((input) => input.fileName === second.name)?.identification,
      ).toEqual({ status: "unknown", matches: [] });
    } finally {
      await controller.dispose();
    }
  });
});
