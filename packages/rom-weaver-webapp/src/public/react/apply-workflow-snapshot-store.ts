import type { ApplyWorkflow } from "../../platform/browser/browser-api.ts";

type ApplyWorkflowSnapshot = ReturnType<ApplyWorkflow["getSnapshot"]>;
type ApplyWorkflowSnapshotSource = Pick<ApplyWorkflow, "getSnapshot" | "subscribe">;

type ApplyWorkflowFormSnapshot = {
  chainPlans: ApplyWorkflowSnapshot["chainPlans"];
  inputReady: boolean;
  outputCompression: ApplyWorkflowSnapshot["output"]["outputFormat"] | undefined;
  outputName: string;
  outputNameRevision: number;
  outputSourceKey: string;
  patchCount: number;
  /** Unknown declared output sizes MUST remain distinct from zero-length targets. */
  patchTargetSizes: readonly (number | undefined)[];
  ready: boolean;
  /** Staged ROM size, or 0 before the input is ready. */
  romSize: number;
};

const EMPTY_APPLY_WORKFLOW_SNAPSHOT: ApplyWorkflowFormSnapshot = {
  chainPlans: new Map(),
  inputReady: false,
  outputCompression: undefined,
  outputName: "",
  outputNameRevision: 0,
  outputSourceKey: "",
  patchCount: 0,
  patchTargetSizes: [],
  ready: false,
  romSize: 0,
};

const sameApplyWorkflowFormSnapshot = (left: ApplyWorkflowFormSnapshot, right: ApplyWorkflowFormSnapshot) =>
  left.chainPlans === right.chainPlans &&
  left.inputReady === right.inputReady &&
  left.outputCompression === right.outputCompression &&
  left.outputName === right.outputName &&
  left.outputNameRevision === right.outputNameRevision &&
  left.outputSourceKey === right.outputSourceKey &&
  left.patchCount === right.patchCount &&
  left.patchTargetSizes.length === right.patchTargetSizes.length &&
  left.patchTargetSizes.every((size, index) => size === right.patchTargetSizes[index]) &&
  left.ready === right.ready &&
  left.romSize === right.romSize;

/**
 * The final enabled patch determines the target size; an unknown intermediate MUST NOT erase it.
 * The largest known target independently constrains format size limits, and the last declared target
 * is the size an undeclared tail of the chain starts from. Outside a run the workflow
 * stages disabled patches too, lined up with the slots; a filtered run stages
 * only enabled ones, so a list of another length has nothing to skip.
 */
const getEnabledPatchTargetSizes = (
  sizes: readonly (number | undefined)[],
  slotIds: readonly string[],
  disabled: ReadonlySet<string>,
) => {
  const aligned = sizes.length === slotIds.length;
  let maxKnownTargetSize: number | undefined;
  let lastDeclaredTargetSize: number | undefined;
  let patchTargetSize: number | undefined;
  for (const [index, size] of sizes.entries()) {
    if (aligned && disabled.has(slotIds[index] || "")) continue;
    patchTargetSize = size;
    if (size === undefined) continue;
    lastDeclaredTargetSize = size;
    maxKnownTargetSize = Math.max(maxKnownTargetSize ?? 0, size);
  }
  return { lastDeclaredTargetSize, maxKnownTargetSize, patchTargetSize };
};

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
    const inputReady = current.input?.status === "ready" && !!current.input.selectedCandidateId;
    const next: ApplyWorkflowFormSnapshot = {
      chainPlans: current.chainPlans.size ? current.chainPlans : EMPTY_APPLY_WORKFLOW_SNAPSHOT.chainPlans,
      inputReady,
      outputCompression: current.output.outputFormat,
      outputName: invalidatedOutputSourceKey === outputSourceKey ? "" : current.output.outputName,
      outputNameRevision,
      outputSourceKey,
      patchCount: current.patches.length,
      patchTargetSizes: current.patches.map((patch) => patch.requirements?.targetSize),
      ready: current.ready,
      // A loading input still reports the dropped file's size, such as a ZIP's.
      romSize: inputReady ? current.input?.size || 0 : 0,
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

export { createApplyWorkflowSnapshotStore, getEnabledPatchTargetSizes };
