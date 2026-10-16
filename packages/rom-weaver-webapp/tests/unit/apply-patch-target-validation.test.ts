import { describe, expect, it, vi } from "vitest";
import { RomWeaverError } from "../../src/lib/errors.ts";
import type { InputAsset } from "../../src/lib/input/input-assets.ts";
import {
  validateApplyPatchTarget,
  validateApplyPatchTargets,
} from "../../src/lib/workflow/apply-patch-target-validation.ts";
import type { InternalPatchChecksumPreflight, StagedSource } from "../../src/lib/workflow/apply-workflow-state.ts";

// A patch/target whose `filePath` makes getPatchFileExternalSource resolve a (non-null) external
// source, so validateApplyPatchTarget reaches the validatePatch call rather than short-circuiting on
// an unavailable source.
const createStage = (): StagedSource<unknown> =>
  ({
    parsedPatch: { format: "BPS" },
    preparedPatchFile: { fileName: "hack.bps", filePath: "/work/hack.bps", fileSize: 2048 },
    state: {
      candidates: [],
      fileName: "hack.bps",
      id: "patch-1",
      order: 0,
      requirements: undefined,
      role: "patch",
      size: 2048,
      status: "ready",
      warnings: [],
    },
  }) as unknown as StagedSource<unknown>;

const createTarget = (): InputAsset =>
  ({
    file: { fileName: "game.rom", filePath: "/work/game.rom", fileSize: 4096 },
    fileName: "game.rom",
    id: "input-1",
    kind: "rom",
    patchable: true,
    size: 4096,
  }) as unknown as InputAsset;

const preflight: InternalPatchChecksumPreflight = { status: "unknown" } as InternalPatchChecksumPreflight;

const createAdapters = (
  validatePatch: (...args: unknown[]) => Promise<unknown>,
  signal?: AbortSignal,
  defaultPatchBasis?: "auto" | "base" | "previous",
) =>
  ({
    defaultPatchBasis,
    emitProgress: () => undefined,
    runtime: { patch: { validatePatch } },
    settings: {},
    signal: signal || new AbortController().signal,
    workflowId: "wf",
  }) as unknown as Parameters<typeof validateApplyPatchTarget>[3];

describe("validateApplyPatchTarget transient-failure handling", () => {
  it("forwards the shared patch input rule to plan validation", async () => {
    const validatePatch = vi.fn().mockResolvedValue({ message: "passed" });
    await validateApplyPatchTarget(
      createStage(),
      createTarget(),
      preflight,
      createAdapters(validatePatch, undefined, "auto"),
    );
    expect(validatePatch).toHaveBeenCalledWith(
      expect.objectContaining({ options: expect.objectContaining({ defaultPatchBasis: "auto" }) }),
    );
  });

  // The target's own checksums are those of the file as supplied (game.rom, 4096 bytes).
  const createCheckedTarget = () =>
    ({ ...createTarget(), checksums: { crc32: "3e30b9b3", sha1: "22f5" } }) as InputAsset;

  it("compares the weave's expected ROM with the supplied file and never sends it to the engine", async () => {
    const stage = createStage();
    const validatePatch = vi.fn().mockResolvedValue({ message: "passed" });
    await validateApplyPatchTargets(
      [
        {
          chain: { basis: "base", expectedRomChecks: "crc32=3e30b9b3,size=4096" },
          preflight,
          stage,
          target: createCheckedTarget(),
        },
      ],
      createAdapters(validatePatch),
    );
    const options = validatePatch.mock.calls[0]?.[0]?.options;
    expect(options).not.toHaveProperty("validateWithChecksums");
    expect(options).not.toHaveProperty("patchInputChecks");
    expect(stage.state.patchValidation?.status).toBe("valid");
  });

  it("fails every grouped patch as a checksum mismatch without a worker call when the ROM differs", async () => {
    const stages = [createStage(), createStage()];
    const validatePatch = vi.fn().mockResolvedValue({ message: "passed" });
    await validateApplyPatchTargets(
      stages.map((stage, index) => ({
        chain: index === 0 ? { expectedRomChecks: "crc32=a1cecd74,size=4096" } : {},
        preflight,
        stage,
        target: createCheckedTarget(),
      })),
      createAdapters(validatePatch),
    );
    expect(validatePatch).not.toHaveBeenCalled();
    expect(stages.map((stage) => stage.state.patchValidation?.status)).toEqual(["invalid", "invalid"]);
    expect(stages[0]?.state.patchValidation?.message).toBe(
      "Input checksum mismatch for crc32; expected a1cecd74, actual 3e30b9b3",
    );
  });

  it("records a non-terminal 'unknown' verdict when validation is cancelled", async () => {
    const stage = createStage();
    const validatePatch = vi.fn().mockRejectedValue(new RomWeaverError("CANCELLED", "Workflow was cancelled"));
    await validateApplyPatchTarget(stage, createTarget(), preflight, createAdapters(validatePatch));
    expect(stage.state.patchValidation?.status).toBe("unknown");
  });

  it("records 'unknown' when the worker fails transiently", async () => {
    const stage = createStage();
    const validatePatch = vi.fn().mockRejectedValue(new RomWeaverError("WORKER_FAILED", "worker crashed"));
    await validateApplyPatchTarget(stage, createTarget(), preflight, createAdapters(validatePatch));
    expect(stage.state.patchValidation?.status).toBe("unknown");
  });

  it("records 'unknown' when the abort signal already fired (even for a generic worker error)", async () => {
    const stage = createStage();
    const controller = new AbortController();
    controller.abort();
    const validatePatch = vi.fn().mockRejectedValue(new Error("boom"));
    await validateApplyPatchTarget(stage, createTarget(), preflight, createAdapters(validatePatch, controller.signal));
    expect(stage.state.patchValidation?.status).toBe("unknown");
  });

  it("records a terminal 'invalid' verdict for a genuine patch-apply failure", async () => {
    const stage = createStage();
    const validatePatch = vi.fn().mockRejectedValue(new RomWeaverError("PATCH_APPLY_FAILED", "does not apply"));
    await validateApplyPatchTarget(stage, createTarget(), preflight, createAdapters(validatePatch));
    expect(stage.state.patchValidation?.status).toBe("invalid");
  });

  it("re-validates a cached 'unknown' verdict instead of short-circuiting on it", async () => {
    const stage = createStage();
    const target = createTarget();
    const validatePatch = vi
      .fn()
      .mockRejectedValueOnce(new RomWeaverError("CANCELLED", "Workflow was cancelled"))
      .mockResolvedValueOnce({ message: "passed" });
    await validateApplyPatchTarget(stage, target, preflight, createAdapters(validatePatch));
    expect(stage.state.patchValidation?.status).toBe("unknown");
    await validateApplyPatchTarget(stage, target, preflight, createAdapters(validatePatch));
    expect(validatePatch).toHaveBeenCalledTimes(2);
    expect(stage.state.patchValidation?.status).toBe("valid");
  });

  it("short-circuits a cached terminal 'invalid' verdict (no re-validation)", async () => {
    const stage = createStage();
    const target = createTarget();
    const validatePatch = vi
      .fn()
      .mockRejectedValueOnce(new RomWeaverError("PATCH_APPLY_FAILED", "does not apply"))
      .mockResolvedValueOnce({ message: "passed" });
    await validateApplyPatchTarget(stage, target, preflight, createAdapters(validatePatch));
    expect(stage.state.patchValidation?.status).toBe("invalid");
    await validateApplyPatchTarget(stage, target, preflight, createAdapters(validatePatch));
    expect(validatePatch).toHaveBeenCalledTimes(1);
    expect(stage.state.patchValidation?.status).toBe("invalid");
  });
});
