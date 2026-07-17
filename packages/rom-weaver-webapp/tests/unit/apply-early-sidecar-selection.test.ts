import { describe, expect, it, vi } from "vitest";
import type { PreparedSidecarPatch } from "../../src/lib/input/input-assets.ts";
import { ApplyWorkflowController } from "../../src/lib/workflow/apply-workflow-controller.ts";
import type { CandidateSelectionRequest, SelectionChoice } from "../../src/types/selection.ts";

// Exercise the streamed `patch-manifest` early-surface path the apply controller adds: when the
// ingest streams a mixed archive's sidecar patches before the ROM is hashed, the multi-select dialog
// opens immediately (off the progress event) and the pick is reconciled later. These tests drive that
// logic directly through the controller's protected/private surface (runtime cast - no real wasm).

type SelectFileSpy = (request: CandidateSelectionRequest) => SelectionChoice | Promise<SelectionChoice>;

const makeController = (selectFile?: SelectFileSpy) =>
  new ApplyWorkflowController<unknown, unknown>({} as never, { selectFile: selectFile as never });

const manifestEvent = (sourceId: string, fileNames: string[]) => ({
  details: { patch_manifest: { patches: fileNames.map((file_name) => ({ file_name })) }, sourceId },
});

const sidecar = (fileName: string): PreparedSidecarPatch => ({ file: { fileName }, parentCompressions: [] }) as never;

describe("apply controller streamed sidecar early-surface", () => {
  it("opens the multi-select dialog for 2+ streamed sidecars and captures the pick", async () => {
    const selectFile = vi.fn<SelectFileSpy>((request) => {
      const id = request.candidates[1]?.id as string;
      return { id, ids: [id] };
    });
    const controller = makeController(selectFile) as never as {
      maybeSurfaceEarlySidecarPatches: (event: unknown) => void;
      earlySidecarSelectionInFlight: Map<string, Promise<void>>;
      earlySidecarSelections: Map<string, string[]>;
    };

    controller.maybeSurfaceEarlySidecarPatches(manifestEvent("input-1", ["game.bps", "game-alt.bps"]));
    await controller.earlySidecarSelectionInFlight.get("input-1");

    expect(selectFile).toHaveBeenCalledTimes(1);
    const request = selectFile.mock.calls[0]?.[0] as CandidateSelectionRequest;
    expect(request.multiSelect).toBe(true);
    expect(request.role).toBe("patch");
    expect(request.candidates.map((candidate) => candidate.id)).toEqual(["game.bps", "game-alt.bps"]);
    // The user's pick is stashed for discoverImplicitPatches to apply later.
    expect(controller.earlySidecarSelections.get("input-1")).toEqual(["game-alt.bps"]);
  });

  it("never opens a second dialog for a repeated manifest event", async () => {
    const selectFile = vi.fn<SelectFileSpy>((request) => ({ id: request.candidates[0]?.id as string }));
    const controller = makeController(selectFile) as never as {
      maybeSurfaceEarlySidecarPatches: (event: unknown) => void;
      earlySidecarSelectionInFlight: Map<string, Promise<void>>;
    };

    const event = manifestEvent("input-1", ["a.bps", "b.bps"]);
    controller.maybeSurfaceEarlySidecarPatches(event);
    await controller.earlySidecarSelectionInFlight.get("input-1");
    controller.maybeSurfaceEarlySidecarPatches(event);

    expect(selectFile).toHaveBeenCalledTimes(1);
  });

  it("does not prompt for a lone streamed sidecar (the auto-add path handles it)", () => {
    const selectFile = vi.fn<SelectFileSpy>(() => ({ id: "x" }));
    const controller = makeController(selectFile) as never as {
      maybeSurfaceEarlySidecarPatches: (event: unknown) => void;
    };

    controller.maybeSurfaceEarlySidecarPatches(manifestEvent("input-1", ["only.bps"]));

    expect(selectFile).not.toHaveBeenCalled();
  });

  it("never prompts without a selection handler (headless soft-patching)", () => {
    const controller = makeController() as never as {
      maybeSurfaceEarlySidecarPatches: (event: unknown) => void;
      earlySidecarSelectionInFlight: Map<string, Promise<void>>;
    };

    controller.maybeSurfaceEarlySidecarPatches(manifestEvent("input-1", ["a.bps", "b.bps"]));

    expect(controller.earlySidecarSelectionInFlight.size).toBe(0);
  });
});

describe("apply controller early-sidecar reconcile", () => {
  it("fans out only the picked sidecars in pick order, consuming duplicate names once", async () => {
    const controller = makeController(() => ({ id: "x" })) as never as {
      earlySidecarSelections: Map<string, string[]>;
      applyEarlySidecarSelection: (stage: unknown, sidecars: PreparedSidecarPatch[]) => Promise<boolean>;
      addFannedOutPatch: (file: { fileName: string }, parents: unknown) => Promise<void>;
    };
    const fanned: string[] = [];
    controller.addFannedOutPatch = async (file) => {
      fanned.push(file.fileName);
    };
    // The user kept the second and (one of the) duplicate-named patch, dropping the first.
    controller.earlySidecarSelections.set("input-9", ["b.bps", "dup.bps"]);
    const sidecars = [sidecar("a.bps"), sidecar("b.bps"), sidecar("dup.bps"), sidecar("dup.bps")];

    const handled = await controller.applyEarlySidecarSelection({ state: { id: "input-9" } }, sidecars);

    expect(handled).toBe(true);
    expect(fanned).toEqual(["b.bps", "dup.bps"]);
  });

  it("returns false when no early pick was captured for the stage (fall back to the normal flow)", async () => {
    const controller = makeController(() => ({ id: "x" })) as never as {
      applyEarlySidecarSelection: (stage: unknown, sidecars: PreparedSidecarPatch[]) => Promise<boolean>;
      addFannedOutPatch: (file: { fileName: string }, parents: unknown) => Promise<void>;
    };
    const fanned: string[] = [];
    controller.addFannedOutPatch = async (file) => {
      fanned.push(file.fileName);
    };

    const handled = await controller.applyEarlySidecarSelection({ state: { id: "input-unknown" } }, [sidecar("a.bps")]);

    expect(handled).toBe(false);
    expect(fanned).toEqual([]);
  });
});
