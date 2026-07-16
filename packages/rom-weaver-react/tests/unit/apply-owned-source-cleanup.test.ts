import { describe, expect, it, vi } from "vitest";

import { ApplyWorkflowController } from "../../src/lib/workflow/apply-workflow-controller.ts";

const flushPendingRelease = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ApplyWorkflowController owned source replacement", () => {
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
