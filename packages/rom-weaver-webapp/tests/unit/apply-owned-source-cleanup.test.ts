import { describe, expect, it, vi } from "vitest";

import { ApplyWorkflowController } from "../../src/lib/workflow/apply-workflow-controller.ts";

const flushPendingRelease = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ApplyWorkflowController owned source replacement", () => {
  it("reacquires a managed source after its previous workflow ownership is released", async () => {
    const retainOwnedSources = vi.fn();
    const releaseOwnedSources = vi.fn(async () => undefined);
    const controller = new ApplyWorkflowController<unknown, unknown>(
      { workerIo: { retainOwnedSources, releaseOwnedSources } } as never,
      {},
    ) as never as {
      releaseOwnedSources: (sources: unknown[]) => Promise<void>;
      retainOwnedSources: (sources: unknown[]) => void;
    };
    const source = { name: "alternate.ips" };

    controller.retainOwnedSources([source]);
    await controller.releaseOwnedSources([source]);
    controller.retainOwnedSources([source]);

    expect(retainOwnedSources).not.toHaveBeenCalled();
    expect(releaseOwnedSources).not.toHaveBeenCalled();

    await controller.releaseOwnedSources([source]);
    await flushPendingRelease();
    controller.retainOwnedSources([source]);

    expect(retainOwnedSources).toHaveBeenCalledTimes(1);
    expect(releaseOwnedSources).toHaveBeenCalledTimes(1);
  });

  it("releases the original archive and the replacement leaf after patches are cleared", async () => {
    const releaseOwnedSources = vi.fn(async () => undefined);
    const controller = new ApplyWorkflowController<unknown, unknown>(
      { workerIo: { releaseOwnedSources } } as never,
      {},
    ) as never as {
      clearPatches: () => Promise<void>;
      patches: unknown[];
      replaceOwnedStageSource: (stage: { source: unknown }, replacement: unknown) => Promise<void>;
      retainOwnedSources: (sources: unknown[]) => void;
    };
    const archive = { name: "patches.zip" };
    const leaf = { name: "selected.ips" };
    const stage = { source: archive, state: {} };
    controller.retainOwnedSources([archive]);
    controller.patches = [stage];

    await controller.replaceOwnedStageSource(stage, leaf);
    await flushPendingRelease();

    expect(releaseOwnedSources).toHaveBeenCalledWith([archive]);
    await controller.clearPatches();
    await flushPendingRelease();

    expect(releaseOwnedSources).toHaveBeenCalledWith([leaf]);
    expect(releaseOwnedSources).toHaveBeenCalledTimes(2);
  });
});
