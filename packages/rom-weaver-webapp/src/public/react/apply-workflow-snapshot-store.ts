import type { ApplyWorkflow } from "../../platform/browser/browser-api.ts";

type ApplyWorkflowSnapshot = ReturnType<ApplyWorkflow["getSnapshot"]>;
type ApplyWorkflowSnapshotSource = Pick<ApplyWorkflow, "getSnapshot" | "subscribe">;

type ApplyWorkflowFormSnapshot = {
  inputReady: boolean;
  outputCompression: ApplyWorkflowSnapshot["output"]["outputFormat"] | undefined;
  outputName: string;
  outputNameRevision: number;
  outputSourceKey: string;
  patchCount: number;
  ready: boolean;
};

const EMPTY_APPLY_WORKFLOW_SNAPSHOT: ApplyWorkflowFormSnapshot = {
  inputReady: false,
  outputCompression: undefined,
  outputName: "",
  outputNameRevision: 0,
  outputSourceKey: "",
  patchCount: 0,
  ready: false,
};

const sameApplyWorkflowFormSnapshot = (left: ApplyWorkflowFormSnapshot, right: ApplyWorkflowFormSnapshot) =>
  left.inputReady === right.inputReady &&
  left.outputCompression === right.outputCompression &&
  left.outputName === right.outputName &&
  left.outputNameRevision === right.outputNameRevision &&
  left.outputSourceKey === right.outputSourceKey &&
  left.patchCount === right.patchCount &&
  left.ready === right.ready;

const createApplyWorkflowSnapshotStore = () => {
  let workflow: ApplyWorkflowSnapshotSource | null = null;
  let unsubscribeWorkflow: (() => void) | null = null;
  let snapshot = EMPTY_APPLY_WORKFLOW_SNAPSHOT;
  let outputSourceKey = "";
  let invalidatedOutputSourceKey: string | undefined;
  let outputNameRevision = 0;
  const listeners = new Set<() => void>();

  const getSnapshot = (): ApplyWorkflowFormSnapshot => {
    if (!workflow) return EMPTY_APPLY_WORKFLOW_SNAPSHOT;

    const current = workflow.getSnapshot();
    const next: ApplyWorkflowFormSnapshot = {
      inputReady: current.input?.status === "ready" && !!current.input.selectedCandidateId,
      outputCompression: current.output.outputFormat,
      outputName: invalidatedOutputSourceKey === outputSourceKey ? "" : current.output.outputName,
      outputNameRevision,
      outputSourceKey,
      patchCount: current.patches.length,
      ready: current.ready,
    };
    if (sameApplyWorkflowFormSnapshot(snapshot, next)) return snapshot;
    snapshot = next;
    return snapshot;
  };

  const notify = () => {
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot,
    invalidateOutputName: () => {
      invalidatedOutputSourceKey = outputSourceKey;
      // Each metadata edit MUST publish after the source labels update, even when the workflow name is already invalid.
      outputNameRevision += 1;
      notify();
    },
    setWorkflow: (next: ApplyWorkflowSnapshotSource | null) => {
      if (workflow === next) return;
      unsubscribeWorkflow?.();
      workflow = next;
      outputSourceKey = "";
      invalidatedOutputSourceKey = undefined;
      outputNameRevision = 0;
      unsubscribeWorkflow = workflow ? workflow.subscribe(notify) : null;
      notify();
    },
    setOutputSourceKey: (next: string) => {
      if (outputSourceKey === next) return;
      outputSourceKey = next;
      if (next && next !== invalidatedOutputSourceKey) invalidatedOutputSourceKey = undefined;
      notify();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

export { createApplyWorkflowSnapshotStore };
