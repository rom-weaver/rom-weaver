import { describe, expect, it, vi } from "vitest";
import { getSelectableCreatePatchFormats } from "../../src/lib/create/patch-format-limits.ts";
import type { ApplyWorkflow } from "../../src/platform/browser/browser-api.ts";
import type { PatchValidationPlan } from "../../src/wasm/index.ts";
import {
  createApplyWorkflowSnapshotStore,
  getEnabledPatchTargetSizes,
} from "../../src/public/react/apply-workflow-snapshot-store.ts";

type Snapshot = ReturnType<ApplyWorkflow["getSnapshot"]>;

const createWorkflow = (initial: Partial<Snapshot> = {}) => {
  let snapshot = {
    busy: false,
    chainPlans: new Map(),
    id: "test-workflow",
    input: null,
    output: {
      manualOutputFormat: false,
      manualOutputName: false,
      outputFormat: "zip",
      outputName: "",
    },
    patches: [],
    ready: false,
    ...initial,
  } as Snapshot;
  const changeListeners = new Set<() => void>();
  const progressListeners = new Set<() => void>();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    onProgress(listener: () => void) {
      progressListeners.add(listener);
      return () => progressListeners.delete(listener);
    },
    change(next: Partial<Snapshot>) {
      snapshot = { ...snapshot, ...next };
      for (const listener of changeListeners) listener();
    },
    progress() {
      for (const listener of progressListeners) listener();
    },
  };
};

describe("Apply workflow snapshot store", () => {
  it("publishes chain plans without changing the snapshot for unrelated state", () => {
    const store = createApplyWorkflowSnapshotStore();
    const workflow = createWorkflow();
    store.setWorkflow(workflow);
    const initial = store.getSnapshot();
    const chainPlans: Snapshot["chainPlans"] = new Map([["input-1", { status: "valid" } as PatchValidationPlan]]);
    workflow.change({ chainPlans });
    const validated = store.getSnapshot();
    expect(validated).not.toBe(initial);
    expect(validated.chainPlans).toBe(chainPlans);
    workflow.change({ busy: true });
    expect(store.getSnapshot()).toBe(validated);
    workflow.change({ chainPlans: new Map() });
    expect(store.getSnapshot().chainPlans).toBe(initial.chainPlans);
    expect(validated.chainPlans.size).toBe(1);
  });
  it("selects stable readiness and output values without subscribing to progress", () => {
    const store = createApplyWorkflowSnapshotStore();
    const workflow = createWorkflow();
    const onChange = vi.fn();
    store.subscribe(onChange);
    store.setWorkflow(workflow);

    const initial = store.getSnapshot();
    expect(initial).toMatchObject({
      inputReady: false,
      outputCompression: "zip",
      outputName: "",
      outputSourceKey: "",
      patchCount: 0,
      ready: false,
    });

    workflow.change({ busy: true });
    expect(store.getSnapshot()).toBe(initial);

    const onProgress = vi.fn();
    workflow.onProgress(onProgress);
    const beforeProgress = onChange.mock.calls.length;
    workflow.progress();
    expect(onProgress).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledTimes(beforeProgress);

    workflow.change({
      input: { selectedCandidateId: "input-1", status: "ready" } as Snapshot["input"],
      output: {
        manualOutputFormat: false,
        manualOutputName: false,
        outputFormat: "chd",
        outputName: "game-patched.chd",
      },
      patches: [{}] as Snapshot["patches"],
      ready: true,
    });
    const ready = store.getSnapshot();
    expect(ready).not.toBe(initial);
    expect(ready).toMatchObject({
      inputReady: true,
      outputCompression: "chd",
      outputName: "game-patched.chd",
      outputSourceKey: "",
      patchCount: 1,
      ready: true,
    });

    store.setOutputSourceKey("source-key");
    const mapped = store.getSnapshot();
    expect(mapped).not.toBe(ready);
    expect(mapped.outputSourceKey).toBe("source-key");
  });

  it("disconnects replaced workflows and returns the empty snapshot on reset", () => {
    const store = createApplyWorkflowSnapshotStore();
    const first = createWorkflow({
      ready: true,
      output: { manualOutputFormat: false, manualOutputName: false, outputFormat: "zip", outputName: "first.zip" },
    });
    const replacement = createWorkflow({
      ready: true,
      output: { manualOutputFormat: false, manualOutputName: false, outputFormat: "zip", outputName: "first.zip" },
    });
    const onChange = vi.fn();
    store.subscribe(onChange);
    store.setWorkflow(first);
    const selected = store.getSnapshot();

    store.setWorkflow(replacement);
    expect(store.getSnapshot()).toBe(selected);
    const changesAfterReplacement = onChange.mock.calls.length;
    first.change({
      ready: false,
      output: { manualOutputFormat: false, manualOutputName: false, outputFormat: "none", outputName: "stale.zip" },
    });
    expect(onChange).toHaveBeenCalledTimes(changesAfterReplacement);
    expect(store.getSnapshot()).toBe(selected);

    store.setWorkflow(null);
    expect(store.getSnapshot()).toMatchObject({
      inputReady: false,
      outputCompression: undefined,
      outputName: "",
      outputSourceKey: "",
      patchCount: 0,
      ready: false,
    });
    const changesAfterReset = onChange.mock.calls.length;
    replacement.change({ ready: false });
    expect(onChange).toHaveBeenCalledTimes(changesAfterReset);
  });

  it("keeps names invalidated across preparation of the same sources", () => {
    const store = createApplyWorkflowSnapshotStore();
    const workflow = createWorkflow({
      input: { selectedCandidateId: "input-1", status: "ready" } as Snapshot["input"],
      output: { manualOutputFormat: false, manualOutputName: false, outputFormat: "chd", outputName: "old.chd" },
      ready: true,
    });
    store.setWorkflow(workflow);
    store.setOutputSourceKey("source-key");
    const prepared = store.getSnapshot();
    store.invalidateOutputName();
    expect(store.getSnapshot()).toEqual({ ...prepared, outputName: "", outputNameRevision: 1 });

    const invalidated = store.getSnapshot();
    workflow.change({ busy: true });
    expect(store.getSnapshot()).toBe(invalidated);
    store.invalidateOutputName();
    expect(store.getSnapshot()).toEqual({ ...invalidated, outputNameRevision: 2 });

    workflow.change({
      output: { manualOutputFormat: false, manualOutputName: false, outputFormat: "chd", outputName: "new.chd" },
    });
    store.setOutputSourceKey("");
    store.setOutputSourceKey("source-key");
    expect(store.getSnapshot().outputName).toBe("");
    store.setOutputSourceKey("replacement-source-key");
    expect(store.getSnapshot().outputName).toBe("new.chd");
  });

  it("publishes the ready ROM size and each declared patch output size", () => {
    const store = createApplyWorkflowSnapshotStore();
    const workflow = createWorkflow();
    store.setWorkflow(workflow);
    expect(store.getSnapshot()).toMatchObject({ patchTargetSizes: [], romSize: 0 });

    // A loading input reports the dropped file's size, such as a ZIP's, not the ROM's.
    workflow.change({ input: { size: 9_000_000, status: "loading" } as Snapshot["input"] });
    expect(store.getSnapshot().romSize).toBe(0);

    workflow.change({
      input: { selectedCandidateId: "input-1", size: 20_000_000, status: "ready" } as Snapshot["input"],
      patches: [
        { requirements: { targetSize: 24_000_000 } },
        {},
        { requirements: { targetSize: 22_000_000 } },
      ] as Snapshot["patches"],
    });
    const sized = store.getSnapshot();
    expect(sized).toMatchObject({ patchTargetSizes: [24_000_000, undefined, 22_000_000], romSize: 20_000_000 });
    workflow.change({ busy: true, patches: [...workflow.getSnapshot().patches] });
    expect(store.getSnapshot()).toBe(sized);
  });

  it("skips disabled patches only while the staged patches line up with the slots", () => {
    const sizes = [64_000_000, 8_000_000];
    expect(getEnabledPatchTargetSizes(sizes, ["slot-1", "slot-2"], new Set())).toEqual({
      lastDeclaredTargetSize: 8_000_000,
      maxKnownTargetSize: 64_000_000,
      patchTargetSize: 8_000_000,
    });
    expect(getEnabledPatchTargetSizes(sizes, ["slot-1", "slot-2"], new Set(["slot-1"])).patchTargetSize).toBe(
      8_000_000,
    );
    // A filtered run stages only the enabled patches, so none of them is skipped.
    expect(getEnabledPatchTargetSizes([64_000_000], ["slot-1", "slot-2"], new Set(["slot-2"])).patchTargetSize).toBe(
      64_000_000,
    );
    expect(getEnabledPatchTargetSizes([], [], new Set()).patchTargetSize).toBeUndefined();
    // An undeclared tail keeps the last declared target as its starting size.
    expect(getEnabledPatchTargetSizes([64_000_000, undefined], ["slot-1", "slot-2"], new Set())).toEqual({
      lastDeclaredTargetSize: 64_000_000,
      maxKnownTargetSize: 64_000_000,
      patchTargetSize: undefined,
    });
    expect(
      getEnabledPatchTargetSizes([64_000_000, 8_000_000], ["slot-1", "slot-2"], new Set(["slot-2"])),
    ).toMatchObject({ lastDeclaredTargetSize: 64_000_000 });
  });
  it("preserves unknown enabled sizes without confusing an empty target with unknown", () => {
    const store = createApplyWorkflowSnapshotStore();
    const workflow = createWorkflow({
      patches: [{}, { requirements: { targetSize: 0 } }] as Snapshot["patches"],
    });
    store.setWorkflow(workflow);
    const sizes = store.getSnapshot().patchTargetSizes;
    expect(sizes).toEqual([undefined, 0]);
    const formats = (disabled: ReadonlySet<string>) =>
      getSelectableCreatePatchFormats({
        originalSize: 4096,
        modifiedSize: getEnabledPatchTargetSizes(sizes, ["ips", "empty"], disabled).patchTargetSize,
      });
    expect(formats(new Set())).not.toContain("ebp");
    expect(formats(new Set())).not.toContain("ppf");
    expect(formats(new Set(["ips"]))).not.toContain("ebp");
    expect(formats(new Set(["ips"]))).not.toContain("ppf");
    expect(getEnabledPatchTargetSizes(sizes, ["ips", "empty"], new Set()).patchTargetSize).toBe(0);
    expect(getEnabledPatchTargetSizes(sizes, ["ips", "empty"], new Set(["ips"])).patchTargetSize).toBe(0);
    expect(getEnabledPatchTargetSizes(sizes, ["ips", "empty"], new Set(["empty"])).patchTargetSize).toBeUndefined();
    expect(formats(new Set(["empty"]))).toEqual(expect.arrayContaining(["ebp", "ppf"]));
    expect(getEnabledPatchTargetSizes([4096, undefined], ["bps", "ips"], new Set()).patchTargetSize).toBeUndefined();
    expect(getEnabledPatchTargetSizes([undefined], ["bps", "ips"], new Set(["ips"])).patchTargetSize).toBeUndefined();
    expect(getEnabledPatchTargetSizes([0], ["empty"], new Set(["empty"])).patchTargetSize).toBeUndefined();
  });
});
