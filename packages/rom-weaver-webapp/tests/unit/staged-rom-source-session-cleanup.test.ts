import { describe, expect, it, vi } from "vitest";
import { RomWeaverError } from "../../src/lib/errors.ts";
import { StagedRomSourceController } from "../../src/lib/workflow/staged-rom-source.ts";
import type { SharedRomSourceState, SharedRomStagedSource } from "../../src/lib/workflow/staged-source-types.ts";

// Force the multi-source concurrent staging path: prepareMultipleDirectInputAssets must return falsy
// so stageSession falls through to the per-source Promise.allSettled fan-out under test.
vi.mock("../../src/lib/input/input-preparation-service.ts", () => ({
  getBinarySourceSize: () => 0,
  prepareInputAssets: vi.fn(),
  prepareMultipleDirectInputAssets: vi.fn(async () => undefined),
}));

type SharedState = SharedRomSourceState;
type Stage = SharedRomStagedSource<string, SharedState>;

describe("StagedRomSourceController.stageSession partial-failure cleanup", () => {
  it("releases every fulfilled sibling's prepared assets when one source rejects, then rethrows", async () => {
    const cleanupSpies = [vi.fn(async () => undefined), vi.fn(async () => undefined), vi.fn(async () => undefined)];
    let releasedRuntimeSources: unknown[] | undefined;
    const releaseSources = vi.fn(async (sources: unknown[]) => {
      releasedRuntimeSources = sources;
    });
    const rejection = new RomWeaverError("INVALID_INPUT", "sibling failed");

    class TestController extends StagedRomSourceController<string, SharedState> {
      // Resolve sources 0 and 2 with prepared OPFS-scratch assets; reject source 1. A bare Promise.all
      // would drop the resolved siblings' assets on the floor here.
      override async stageSource(stage: Stage): Promise<Stage> {
        if (stage.index === 1) throw rejection;
        stage.preparedInputAssets = [{ file: { _cleanup: cleanupSpies[stage.index] }, size: 0 } as never];
        stage.state.status = "ready";
        return stage;
      }
    }

    const controller = new TestController({
      emitProgress: () => undefined,
      getExecutionOptions: () => ({}),
      getSourceId: (role, index) => `${role}-${index}`,
      id: "wf",
      runtime: { workerIo: { releaseSources } } as never,
      workflow: "apply",
    });

    await expect(controller.stageSession("input", ["a", "b", "c"])).rejects.toBe(rejection);

    // Fulfilled siblings (0 and 2) had their scratch copies released; the rejected one (1) never
    // produced any.
    expect(cleanupSpies[0]).toHaveBeenCalledTimes(1);
    expect(cleanupSpies[2]).toHaveBeenCalledTimes(1);
    expect(cleanupSpies[1]).not.toHaveBeenCalled();
    // The fulfilled siblings' runtime sources were handed back to the worker for release.
    expect(releaseSources).toHaveBeenCalledTimes(1);
    expect(releasedRuntimeSources).toHaveLength(2);
  });
});
