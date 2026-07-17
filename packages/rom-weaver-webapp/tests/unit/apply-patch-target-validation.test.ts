import { describe, expect, it, vi } from "vitest";
import { RomWeaverError } from "../../src/lib/errors.ts";
import type { InputAsset } from "../../src/lib/input/input-assets.ts";
import { validateApplyPatchTarget } from "../../src/lib/workflow/apply-patch-target-validation.ts";
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

const createAdapters = (validatePatch: (...args: unknown[]) => Promise<unknown>, signal?: AbortSignal) =>
  ({
    emitProgress: () => undefined,
    runtime: { patch: { validatePatch } },
    settings: {},
    signal: signal || new AbortController().signal,
    workflowId: "wf",
  }) as unknown as Parameters<typeof validateApplyPatchTarget>[3];

describe("validateApplyPatchTarget transient-failure handling", () => {
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
