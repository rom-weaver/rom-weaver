import { describe, expect, it, vi } from "vitest";
import type { ApplyWorkflow } from "../../src/platform/browser/browser-api.ts";
import { createApplyWorkflowSnapshotStore } from "../../src/public/react/apply-workflow-snapshot-store.ts";

type Snapshot = ReturnType<ApplyWorkflow["getSnapshot"]>;

const createWorkflow = (initial: Partial<Snapshot> = {}) => {
  let snapshot = {
    busy: false,
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
});
