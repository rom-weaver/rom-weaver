import { describe, expect, it, vi } from "vitest";

import { ApplyWorkflowController } from "../../src/lib/workflow/apply-workflow-controller.ts";
import { createBrowserRuntimeVfsIo } from "../../src/platform/browser/browser-runtime-vfs.ts";
import {
  registerBrowserSourceCleanup,
  releaseBrowserSource,
  retainBrowserSource,
} from "../../src/storage/browser/browser-source-primitives.ts";

const flushPendingRelease = () => new Promise((resolve) => setTimeout(resolve, 0));

type ManagedSourceStep = "formRelease" | "registrantRelease" | "workflowRelease" | "workflowRetain";

describe("ApplyWorkflowController managed source lifetime", () => {
  it.each<{ name: string; steps: ManagedSourceStep[] }>([
    { name: "the registrant never releases", steps: ["workflowRetain", "formRelease"] },
    { name: "the form releases before the registrant", steps: ["workflowRetain", "formRelease", "registrantRelease"] },
    { name: "the registrant releases before the form", steps: ["workflowRetain", "registrantRelease", "formRelease"] },
    {
      name: "the registrant releases before the workflow takes the file",
      steps: ["registrantRelease", "workflowRetain", "formRelease"],
    },
    {
      name: "the workflow takes the file again after releasing it",
      steps: ["workflowRetain", "workflowRelease", "workflowRetain", "registrantRelease", "formRelease"],
    },
  ])("keeps a weave-extracted file until the workflow is disposed when $name", async ({ steps }) => {
    const source = new File(["patch"], "change.ips");
    const removeSource = vi.fn();
    const releaseRegistration = registerBrowserSourceCleanup(source, removeSource);
    const controller = new ApplyWorkflowController<unknown, unknown>(
      { workerIo: createBrowserRuntimeVfsIo({ vfs: {} as never }) } as never,
      {},
    ) as never as {
      dispose: () => Promise<void>;
      releaseOwnedSources: (sources: unknown[]) => Promise<void>;
      retainOwnedSources: (sources: unknown[]) => void;
    };
    const runStep: Record<ManagedSourceStep, () => Promise<void>> = {
      formRelease: () => releaseBrowserSource(source),
      registrantRelease: releaseRegistration,
      workflowRelease: async () => {
        await controller.releaseOwnedSources([source]);
        await flushPendingRelease();
      },
      workflowRetain: async () => controller.retainOwnedSources([source]),
    };
    retainBrowserSource(source);

    for (const step of steps) await runStep[step]();
    expect(removeSource).not.toHaveBeenCalled();

    await controller.dispose();
    expect(removeSource).toHaveBeenCalledTimes(1);
  });
});

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

    expect(retainOwnedSources).toHaveBeenCalledTimes(1);
    expect(releaseOwnedSources).not.toHaveBeenCalled();

    await controller.releaseOwnedSources([source]);
    await flushPendingRelease();
    controller.retainOwnedSources([source]);

    expect(retainOwnedSources).toHaveBeenCalledTimes(2);
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
