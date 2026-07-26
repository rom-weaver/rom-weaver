import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BundleApplySession } from "../../lib/bundle/bundle-session-model.ts";
import { emitTraceLog } from "../../lib/logging.ts";
import { ApplyWorkflow, type BrowserApplyResult, type WorkflowProgress } from "../../platform/browser/browser-api.ts";
import { getErrorCode } from "../../presentation/errors.ts";
import type {
  ApplyWorkflowBundleSources,
  ApplyWorkflowInputState,
  ApplyWorkflowPatchState,
} from "../../types/apply-workflow.ts";
import type { CompressionFormat } from "../../types/settings.ts";
import type { ApplyWorkflowResult, ProgressEvent } from "../../types/workflow-runtime-types.ts";
import type { PatchValidationPlan } from "../../wasm/index.ts";
import type { StagedInputInfo } from "./apply-session-types.ts";
import { ApplyWorkflowFormView } from "./apply-workflow-form-view.tsx";
import {
  type ApplyWorkflowPrepareHandlers,
  type ApplyWorkflowSessionInput,
  type ApplyWorkflowSyncState,
  createBaseApplyWorkflowSettings,
  createWorkflowOutputOverridesKey,
  createWorkflowPreparationSettingsKey,
  createWorkflowSettingsKey,
  emitApplyWorkflowTrace,
  getApplyOutputCompression,
  getAutomaticApplyOutputName,
  getOutputSourceKey,
  getWorkflowReadinessError,
  isReactBinarySource,
  normalizeApplyResult,
  type PatchStageInfo,
  type PreparedApplyWorkflow,
  type StageBatchHandlers,
  type StageBatchMember,
  summarizeApplyWorkflowSources,
  toPatchStageInfo,
  toStagedInputInfos,
} from "./apply-workflow-staging-model.ts";
import { useBundleExport } from "./bundle-export.tsx";
import { useCandidateSelection } from "./candidate-selection.tsx";
import { useInputSelectionHandler } from "./input-selection-handler.ts";
import { getBinarySourceListStableIds, sameBinarySourceLists } from "./input-session-helpers.ts";
import type { BinarySource } from "./patcher-form.ts";
import { inertDialogController, useLocalApplyPatchFormSession } from "./patcher-form-session.ts";
import type { ApplyPatchFormProps, CandidateSelectionPrompt, InternalApplyPatchFormProps } from "./public-types.ts";
import { useApplySettings, useRomWeaverAssetBaseUrl, useUiLocalizer } from "./settings-context.tsx";
import { useApplyPatchEnablement } from "./use-apply-patch-enablement.ts";
import { type BundleSessionControllers, useBundleApplySession } from "./use-bundle-apply-session.ts";
import { useUnifiedApplyDrop } from "./use-unified-apply-drop.ts";
import { createWorkflowFormError, getReactBinarySourceFileName, toReactProgressEvent } from "./workflow-adapters.ts";
import { usePageDropForwarder } from "./workflow-form-effects.ts";
import { createReactWorkflowId } from "./workflow-form-utils.ts";

// A patch parses eagerly (its extraction overlaps the ROM's), but its addPatch mutation is queued
// behind the ROM's setInput, so the staged info would otherwise only reach the card once the ROM
// finishes. Build the parsed info for a single patch straight from the workflow so the card can leave
// "Reading…" the moment the patch is read, independent of the ROM. The target label stays "None
// selected" until the ROM resolves it; the deferred dry-run fills in the verdict afterward.
const buildEagerPatchStageInfo = (
  workflow: ApplyWorkflow,
  snapshot: ApplyWorkflowSessionInput,
  order: number,
): PatchStageInfo | null => {
  const patch = workflow.getPatches()[order];
  // Only reveal once the patch is actually prepared + parsed ("ready"): its leaf name, size, format,
  // and requirements are populated. A patch still extracting or awaiting an archive-entry selection
  // has only its raw source info, so revealing it would replace the "Reading…" card with a bare,
  // wrong-looking one (raw archive name, no drawers). Leave those staging until the parse lands.
  if (!patch || patch.status !== "ready") return null;
  const patchSource = workflow.getPatchSources().filter(isReactBinarySource)[order];
  const fileName = getReactBinarySourceFileName(patchSource ?? snapshot.patches[order] ?? null, `Patch ${order + 1}`);
  const inputLabelById = new Map(
    toStagedInputInfos(workflow.getInput(), snapshot.inputs).map((entry) => [
      entry.id || "",
      entry.fileName || "Input",
    ]),
  );
  const targetName =
    patch.targetInputFileName ||
    (patch.targetInputId ? inputLabelById.get(patch.targetInputId) : undefined) ||
    "None selected";
  return toPatchStageInfo(patch, fileName, order, `Target: ${targetName}`);
};

const getApplyOutputVerification = ({
  bundleChainStatus,
  bundleOutputChecksum,
  chainPlans,
  enabledPatchCount,
  localizer,
}: {
  bundleChainStatus: string | null;
  bundleOutputChecksum: string | null;
  chainPlans: ReadonlyMap<string, PatchValidationPlan>;
  enabledPatchCount: number;
  localizer: ReturnType<typeof useUiLocalizer>;
}): { level: "warn"; message: string } | null => {
  if (enabledPatchCount <= 0) return null;
  const finalEntries: Array<{ enforceable: boolean }> = [];
  let orderIssue = false;
  let inputIssue = false;
  for (const plan of chainPlans.values()) {
    for (const entry of plan.output_verification) {
      if (entry.patch_index === plan.patch_count - 1) finalEntries.push(entry);
    }
    for (const verdict of plan.per_patch) {
      if (verdict.expected_predecessor !== undefined) orderIssue = true;
      if (verdict.input_verdict === "failed") inputIssue = true;
    }
  }
  if (finalEntries.length) {
    if (finalEntries.every((entry) => entry.enforceable)) return null;
    if (orderIssue) return { level: "warn", message: localizer.message("ui.output.outOfOrder") };
    if (inputIssue) return { level: "warn", message: localizer.message("ui.output.inputMismatch") };
    return { level: "warn", message: localizer.message("ui.output.differentChain") };
  }
  if (bundleOutputChecksum && bundleChainStatus) {
    if (bundleChainStatus === "full" || bundleChainStatus === "partial") return null;
    return { level: "warn", message: localizer.message("ui.output.bundleDiverged") };
  }
  return null;
};

const getSinglePatchReplaceIndex = ({
  forcePatchWorkflowRefresh,
  inputsChanged,
  patchesAppended,
  patchesChanged,
  preparationSettingsChanged,
  previousPatches,
  snapshotPatches,
}: {
  forcePatchWorkflowRefresh: boolean;
  inputsChanged: boolean;
  patchesAppended: boolean;
  patchesChanged: boolean;
  preparationSettingsChanged: boolean;
  previousPatches: BinarySource[];
  snapshotPatches: BinarySource[];
}) => {
  if (
    !patchesChanged ||
    patchesAppended ||
    forcePatchWorkflowRefresh ||
    preparationSettingsChanged ||
    inputsChanged ||
    !snapshotPatches.length ||
    snapshotPatches.length !== previousPatches.length
  )
    return -1;
  const previousIds = getBinarySourceListStableIds(previousPatches);
  const nextIds = getBinarySourceListStableIds(snapshotPatches);
  let replaceIndex = -1;
  for (let index = 0; index < nextIds.length; index += 1) {
    if (previousIds[index] === nextIds[index]) continue;
    if (replaceIndex !== -1) return -1;
    replaceIndex = index;
  }
  return replaceIndex;
};

const arePatchesAppended = ({
  forcePatchWorkflowRefresh,
  inputsChanged,
  patchesChanged,
  preparationSettingsChanged,
  previousPatches,
  snapshotPatches,
}: {
  forcePatchWorkflowRefresh: boolean;
  inputsChanged: boolean;
  patchesChanged: boolean;
  preparationSettingsChanged: boolean;
  previousPatches: BinarySource[];
  snapshotPatches: BinarySource[];
}) =>
  patchesChanged &&
  !forcePatchWorkflowRefresh &&
  !preparationSettingsChanged &&
  !inputsChanged &&
  snapshotPatches.length > previousPatches.length &&
  sameBinarySourceLists(previousPatches, snapshotPatches.slice(0, previousPatches.length));

const setWorkflowSettingsIfChanged = async ({
  baseSettings,
  changed,
  snapshot,
  workflow,
}: {
  baseSettings: ReturnType<typeof createBaseApplyWorkflowSettings>;
  changed: boolean;
  snapshot: ApplyWorkflowSessionInput;
  workflow: ApplyWorkflow;
}) => {
  if (!changed) return;
  emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow setSettings start");
  await workflow.setSettings(baseSettings);
  emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow setSettings finish");
};

function ApplyPatchForm(props: ApplyPatchFormProps) {
  const { onApplyComplete, onInputsChange, onPatchesChange, onProgress: onProgressChange, threads } = props;
  const providerSettings = useApplySettings();
  const providerAssetBaseUrl = useRomWeaverAssetBaseUrl();
  const resolvedAssetBaseUrl = props.assetBaseUrl || providerAssetBaseUrl;
  const internalProps = props as InternalApplyPatchFormProps;
  const { startup, controllers } = internalProps;
  const handleSelectionCancelledRef = useRef<(request: CandidateSelectionPrompt) => void>(() => undefined);
  const { candidateSelectionDialog, selectFile } = useCandidateSelection({
    onCancelSelection: (request) => handleSelectionCancelledRef.current(request),
  });
  const [applyReady, setApplyReady] = useState(false);
  const [resolvedOutputCompression, setResolvedOutputCompression] = useState<CompressionFormat | undefined>(undefined);
  const [resolvedOutputName, setResolvedOutputName] = useState("");
  const [resolvedOutputNameKey, setResolvedOutputNameKey] = useState("");
  const workflowIdRef = useRef(createReactWorkflowId("react-apply"));
  const mutationQueueRef = useRef(Promise.resolve<void>(undefined));
  const selectFileRef = useRef(selectFile);
  selectFileRef.current = selectFile;
  // id matches webapp-root's `currentView` so root routing targets the active tab.
  useInputSelectionHandler("patcher", selectFile);
  const lastInputsRef = useRef<BinarySource[]>([]);
  const forceInputWorkflowRefreshRef = useRef(false);
  const lastPatchOrderRef = useRef("");
  const forcePatchWorkflowRefreshRef = useRef(false);
  const workflowRef = useRef<ApplyWorkflow | null>(null);
  const preparedWorkflowRef = useRef<ApplyWorkflow | null>(null);
  const bundleSourcesRef = useRef<ApplyWorkflowBundleSources | null>(null);
  const workflowSyncRef = useRef<ApplyWorkflowSyncState>({
    executionSettingsKey: "",
    inputs: [],
    patches: [],
    preparationSettingsKey: "",
  });
  const workflowOutputOverridesKeyRef = useRef("");
  const prepareHandlersRef = useRef<ApplyWorkflowPrepareHandlers | null>(null);
  const propsWithSettings = {
    ...props,
    defaultSettings: props.defaultSettings || providerSettings,
    settings: props.settings,
  };
  const traceSettings = props.settings || props.defaultSettings || providerSettings;
  const [defaultBundleFormat = "", defaultBundleContents = ""] = String(
    traceSettings.output?.bundlePackage || traceSettings.bundlePackage || "",
  ).split(":");
  const emitApplyFormInputTrace = useCallback(
    (message: string, details?: Record<string, unknown>) => {
      emitTraceLog(
        {
          logLevel: traceSettings.logging?.level,
          namespace: "react:apply-form",
          onLog: traceSettings.logging?.sink,
        },
        message,
        details || {},
      );
    },
    [traceSettings],
  );

  const syncInputSelectionRefs = useCallback((inputs: BinarySource[]) => {
    if (!sameBinarySourceLists(lastInputsRef.current, inputs)) {
      if (lastInputsRef.current.length > 0 && inputs.length === 0) forceInputWorkflowRefreshRef.current = true;
      lastInputsRef.current = inputs.slice();
      bundleSourcesRef.current = null;
    }
  }, []);

  const syncPatchSelectionRefs = useCallback((patches: BinarySource[]) => {
    const patchOrder = getBinarySourceListStableIds(patches).join("|");
    const previousOrder = lastPatchOrderRef.current;
    if (previousOrder !== patchOrder) {
      // A pure append leaves the existing patches (and their staged OPFS copies + resolved
      // selections) untouched, so prepareWorkflow's patchesAppended path can addPatch just the new
      // tail. Forcing a full refresh there would clearPatches and re-stage everything - re-extracting
      // unchanged inputs and racing their still-open OPFS handles, which is what made re-uploading the
      // same archive to pick a second entry fail. Only a rearranged/shrunken prefix needs the refresh.
      const isAppend = previousOrder !== "" && patchOrder.startsWith(`${previousOrder}|`);
      if (!isAppend) forcePatchWorkflowRefreshRef.current = true;
      lastPatchOrderRef.current = patchOrder;
      bundleSourcesRef.current = null;
    }
  }, []);

  const syncSelectionRefs = useCallback(
    (snapshot: ApplyWorkflowSessionInput) => {
      syncInputSelectionRefs(snapshot.inputs);
      syncPatchSelectionRefs(snapshot.patches);
    },
    [syncInputSelectionRefs, syncPatchSelectionRefs],
  );

  const setResolvedOutputNameForSnapshot = useCallback((snapshot: ApplyWorkflowSessionInput, outputName: string) => {
    setResolvedOutputName(outputName);
    setResolvedOutputNameKey(getOutputSourceKey(snapshot.inputs, snapshot.patches));
  }, []);

  const handleLocalInputsChange = useCallback(
    (nextInputs: BinarySource[]) => {
      syncInputSelectionRefs(nextInputs);
      onInputsChange?.(nextInputs);
    },
    [onInputsChange, syncInputSelectionRefs],
  );

  // Patch enable toggles (the loom On/Off switch): disabled patches stay on
  // the bench but are excluded from the apply run. Keyed by stable patch-slot id
  // so replacements/reorders/removals keep the right patches off.
  const {
    disabledPatchIds,
    filterEnabledPatchRun,
    getDisabledPatchIndexes,
    getPatchIds,
    seedPatchEnablement,
    syncPatchTracking,
    togglePatchEnabled,
  } = useApplyPatchEnablement();

  // A `?bundle=` boot session: once the delivered patch files land, it seeds
  // enablement/output defaults exactly once and keeps the per-patch metadata.
  // Controllers are created further down, so the hook reads them through a ref.
  const [localBundleSession, setLocalBundleSession] = useState<BundleApplySession | null>(null);
  const [bundleDismissed, setBundleDismissed] = useState(false);
  const bundleSessionKey = props.bundleSession?.key;
  const previousBundleSessionKeyRef = useRef(bundleSessionKey);
  useEffect(() => {
    if (previousBundleSessionKeyRef.current === bundleSessionKey) return;
    previousBundleSessionKeyRef.current = bundleSessionKey;
    setBundleDismissed(false);
  }, [bundleSessionKey]);
  const activeBundleSession = bundleDismissed ? null : localBundleSession || props.bundleSession || null;
  const bundleControllersRef = useRef<BundleSessionControllers>({ output: null, patchStack: null });
  const { handleBundlePatchesChange, bundleMetaById, updateBundleMeta } = useBundleApplySession({
    bundleSession: activeBundleSession,
    controllersRef: bundleControllersRef,
    getPatchIds,
    seedPatchEnablement,
  });

  // Declared chain metadata (bundle/user basis + checks) per patch index, forwarded into the
  // plan-mode validation so the engine resolves each patch's basis with the same declarations
  // the apply run will enforce.
  const bundleMetaRef = useRef(bundleMetaById);
  bundleMetaRef.current = bundleMetaById;
  const buildChainMeta = useCallback(
    (patches: BinarySource[]) => {
      const toTokens = (checks?: { checksums?: Record<string, string> }): string | undefined => {
        const entries = Object.entries(checks?.checksums || {}).filter(([, hex]) => typeof hex === "string" && !!hex);
        return entries.length ? entries.map(([algorithm, hex]) => `${algorithm}=${hex}`).join(",") : undefined;
      };
      const chainMeta = new Map<
        number,
        { basis?: "auto" | "base" | "previous"; inputChecks?: string; outputChecks?: string }
      >();
      getPatchIds()
        .slice(0, patches.length)
        .forEach((id, index) => {
          const meta = bundleMetaRef.current.get(id || "");
          if (!meta) return;
          const inputChecks = toTokens(meta.inputChecks);
          const outputChecks = toTokens(meta.outputChecks);
          if (!(meta.basis || inputChecks || outputChecks)) return;
          chainMeta.set(index, {
            ...(meta.basis ? { basis: meta.basis } : {}),
            ...(inputChecks ? { inputChecks } : {}),
            ...(outputChecks ? { outputChecks } : {}),
          });
        });
      return chainMeta;
    },
    [getPatchIds],
  );

  // Latest patch list mirror for flows outside the staging pipeline (bundle export).
  const currentPatchesRef = useRef<BinarySource[]>([]);
  // Ordered patch file names as state (the refs above don't re-render): drives
  // the bundle chain-intact check for output verification + its notice.
  const [currentPatchNames, setCurrentPatchNames] = useState<readonly string[]>([]);
  // Per-target chain verification plans, snapshotted from the workflow after each deep
  // validation pass: drives the output-verification line in the action column.
  const [chainPlans, setChainPlans] = useState<ReadonlyMap<string, PatchValidationPlan>>(new Map());

  const handleLocalPatchesChange = useCallback(
    (nextPatches: BinarySource[]) => {
      if (!nextPatches.length) {
        setLocalBundleSession(null);
        setBundleDismissed(true);
        setChainPlans(new Map());
      }
      syncPatchTracking(nextPatches);
      currentPatchesRef.current = nextPatches;
      setCurrentPatchNames(
        nextPatches.map((patch, index) => getReactBinarySourceFileName(patch, `Patch ${index + 1}`)),
      );
      handleBundlePatchesChange(nextPatches);
      syncPatchSelectionRefs(nextPatches);
      onPatchesChange?.(nextPatches);
    },
    [handleBundlePatchesChange, onPatchesChange, syncPatchSelectionRefs, syncPatchTracking],
  );

  // How the current bench relates to the loaded bundle's authored chain:
  // - "full": every bundle patch enabled, in bundle order, nothing foreign -
  //   the only state the bundle's expected output describes.
  // - "partial": same chain, but at least one patch toggled off.
  // - "diverged": the patch list itself differs (append/remove/reorder/foreign).
  const bundleChainStatus = useMemo((): "full" | "partial" | "diverged" | null => {
    const session = activeBundleSession;
    if (!(session?.entries.length && bundleMetaById.size && currentPatchNames.length)) return null;
    const expected = session.entries.map((entry) => entry.fileName);
    const namesMatch =
      currentPatchNames.length === expected.length &&
      expected.every((name, index) => currentPatchNames[index] === name);
    if (!namesMatch) return "diverged";
    return disabledPatchIds.size ? "partial" : "full";
  }, [activeBundleSession, bundleMetaById, currentPatchNames, disabledPatchIds]);

  // Reactive owner of the bundle's expected-output check: engaged only while the
  // full authored chain is enabled (the bundle's output.checks describe exactly
  // that result), stood down otherwise. Runs through the same per-patch option
  // path as user edits; the carrier index is found by value so reorders and
  // clears stay aligned.
  const bundleOutputChecks = activeBundleSession?.chainEndpointChecks.output?.checksums;
  const bundleOutputChecksum = bundleOutputChecks?.sha1 || bundleOutputChecks?.md5 || bundleOutputChecks?.crc32 || "";
  useEffect(() => {
    if (!bundleOutputChecksum || bundleChainStatus === null) return;
    const desired = bundleChainStatus === "full" ? bundleOutputChecksum : "";
    const targetIndex = (activeBundleSession?.entries.length ?? 0) - 1;
    let cancelled = false;
    void (async () => {
      // Wait for the stack to settle (same readiness rule as the session seeding)
      // so the option lands on staged items instead of racing their staging.
      for (let attempt = 0; attempt < 100 && !cancelled; attempt += 1) {
        const items = bundleControllersRef.current.patchStack?.getState().items || [];
        if (items.length && items.every((item) => !(item.progress || item.optionsDisabled))) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
      if (cancelled) return;
      const stack = bundleControllersRef.current.patchStack;
      const items = stack?.getState().items || [];
      const carrierIndex = items.findIndex((item) => (item.validateOutputChecksum || "") === bundleOutputChecksum);
      if (desired) {
        if (carrierIndex === targetIndex) return;
        if (carrierIndex >= 0) await stack?.setPatchOption?.(carrierIndex, { validateOutputChecksum: "" });
        if (targetIndex >= 0 && targetIndex < items.length)
          await stack?.setPatchOption?.(targetIndex, { validateOutputChecksum: bundleOutputChecksum });
        return;
      }
      if (carrierIndex >= 0) await stack?.setPatchOption?.(carrierIndex, { validateOutputChecksum: "" });
    })();
    return () => {
      cancelled = true;
    };
  }, [activeBundleSession, bundleChainStatus, bundleOutputChecksum]);

  // The output-verification line: whether the woven FINAL result will be checked against an
  // expected output, and why not when it won't. Plan-driven when the chain plans carry a
  // final-step output expectation (declared per-patch checks or the last patch's embedded
  // target); the bundle-level expected output (seeded onto the last patch only while the full
  // authored chain is enabled in order) is the fallback source.
  const enabledPatchCount = currentPatchNames.length - disabledPatchIds.size;
  const localizer = useUiLocalizer();
  const outputVerification = useMemo(
    () =>
      getApplyOutputVerification({ bundleChainStatus, bundleOutputChecksum, chainPlans, enabledPatchCount, localizer }),
    [bundleChainStatus, bundleOutputChecksum, chainPlans, enabledPatchCount, localizer],
  );

  const queueMutation = useCallback(<TValue,>(callback: () => Promise<TValue>) => {
    const run = mutationQueueRef.current.catch(() => undefined).then(callback);
    mutationQueueRef.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }, []);

  const resetWorkflow = useCallback(() => {
    const workflow = workflowRef.current;
    workflowRef.current = null;
    preparedWorkflowRef.current = null;
    bundleSourcesRef.current = null;
    forceInputWorkflowRefreshRef.current = false;
    workflowSyncRef.current = { executionSettingsKey: "", inputs: [], patches: [], preparationSettingsKey: "" };
    workflowOutputOverridesKeyRef.current = "";
    prepareHandlersRef.current = null;
    void workflow?.dispose();
  }, []);

  const getWorkflow = useCallback(() => {
    if (workflowRef.current) return workflowRef.current;
    workflowRef.current = new ApplyWorkflow({
      ...(resolvedAssetBaseUrl ? { assetBaseUrl: resolvedAssetBaseUrl } : {}),
      id: workflowIdRef.current,
      selectFile: async (request) => {
        const handlers = prepareHandlersRef.current;
        const promptInputSelection = handlers?.selection?.promptInputSelection !== false;
        const promptPatchSelection = handlers?.selection?.promptPatchSelection !== false;
        if ((request.role === "input" && !promptInputSelection) || (request.role === "patch" && !promptPatchSelection))
          throw createWorkflowFormError("WORKFLOW_SELECTION_SKIPPED", `${request.sourceName} requires selection`);
        return selectFileRef.current(request);
      },
    });
    return workflowRef.current;
  }, [resolvedAssetBaseUrl]);

  useEffect(
    () => () => {
      resetWorkflow();
    },
    [resetWorkflow],
  );

  const emitWorkflowProgress = useCallback(
    (event: WorkflowProgress, onProgress?: (event: ProgressEvent) => void) => {
      const progressEvent = toReactProgressEvent(event);
      onProgressChange?.(progressEvent);
      onProgress?.(progressEvent);
      return { progressEvent, workflowProgress: event };
    },
    [onProgressChange],
  );

  const applyOutputOverrides = useCallback(async (workflow: ApplyWorkflow, snapshot: ApplyWorkflowSessionInput) => {
    const manualOutputName =
      typeof snapshot.options.output?.outputName === "string" && snapshot.options.output.outputName.trim()
        ? snapshot.options.output.outputName
        : "";
    if (manualOutputName) await workflow.setOutputName(manualOutputName);
    const compressionMode = snapshot.options.output?.compression || "auto";
    if (compressionMode !== "auto") await workflow.setOutputFormat(compressionMode);
  }, []);

  const syncWorkflowOutputOverrides = useCallback(
    async (
      workflow: ApplyWorkflow,
      snapshot: ApplyWorkflowSessionInput,
      baseSettings: ReturnType<typeof createBaseApplyWorkflowSettings>,
      baseSettingsChanged: boolean,
      options: { baseSettingsApplied?: boolean } = {},
    ) => {
      const outputOverridesKey = createWorkflowOutputOverridesKey(snapshot);
      const outputOverridesChanged = workflowOutputOverridesKeyRef.current !== outputOverridesKey;
      if (!(baseSettingsChanged || outputOverridesChanged)) return;
      if (!options.baseSettingsApplied) await workflow.setSettings(baseSettings);
      await applyOutputOverrides(workflow, snapshot);
      workflowOutputOverridesKeyRef.current = outputOverridesKey;
    },
    [applyOutputOverrides],
  );

  const prepareWorkflow = useCallback(
    async <TValue,>(
      snapshot: ApplyWorkflowSessionInput,
      handlers: ApplyWorkflowPrepareHandlers,
      callback: (prepared: {
        checksums: Record<string, string> | null;
        input: ApplyWorkflowInputState | null;
        patches: ApplyWorkflowPatchState[];
        workflow: ApplyWorkflow;
      }) => Promise<TValue>,
    ): Promise<TValue> => {
      syncSelectionRefs(snapshot);
      emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow start", {
        inputCount: snapshot.inputs.length,
        inputs: summarizeApplyWorkflowSources(snapshot.inputs, "Input"),
        patchCount: snapshot.patches.length,
      });
      setResolvedOutputCompression(getApplyOutputCompression(snapshot, null));
      setResolvedOutputNameForSnapshot(snapshot, getAutomaticApplyOutputName(snapshot, null, []));
      const workflow = getWorkflow();
      preparedWorkflowRef.current = workflow;
      prepareHandlersRef.current = handlers;
      const handleProgress = (event: WorkflowProgress) => handlers.onProgress?.(event);
      workflow.on("progress", handleProgress);
      try {
        const baseSettings = createBaseApplyWorkflowSettings(snapshot.options, props.threads);
        const executionSettingsKey = createWorkflowSettingsKey(baseSettings);
        const preparationSettingsKey = createWorkflowPreparationSettingsKey(baseSettings);
        const previousSync = workflowSyncRef.current;
        const executionSettingsChanged = previousSync.executionSettingsKey !== executionSettingsKey;
        const preparationSettingsChanged = previousSync.preparationSettingsKey !== preparationSettingsKey;
        const inputsChanged =
          forceInputWorkflowRefreshRef.current ||
          preparationSettingsChanged ||
          !sameBinarySourceLists(previousSync.inputs, snapshot.inputs);
        const patchesChanged =
          forcePatchWorkflowRefreshRef.current ||
          preparationSettingsChanged ||
          !sameBinarySourceLists(previousSync.patches, snapshot.patches);
        // Appending patches keeps the existing prefix staged in the workflow (and OPFS).
        // Only the new tail needs addPatch, so skip the clear-and-re-add of everything.
        const previousPatches = previousSync.patches;
        const patchesAppended = arePatchesAppended({
          forcePatchWorkflowRefresh: forcePatchWorkflowRefreshRef.current,
          inputsChanged,
          patchesChanged,
          preparationSettingsChanged,
          previousPatches,
          snapshotPatches: snapshot.patches,
        });
        // A single in-place replacement (same length, exactly one slot swapped, every other patch
        // identical): the untouched patches keep their staged state + cached verdicts, so only the
        // swapped slot re-stages and re-validates. An append is handled above; a multi-slot or
        // length change falls back to clear-and-re-add.
        const singleReplaceIndex = getSinglePatchReplaceIndex({
          forcePatchWorkflowRefresh: forcePatchWorkflowRefreshRef.current,
          inputsChanged,
          patchesAppended,
          patchesChanged,
          preparationSettingsChanged,
          previousPatches,
          snapshotPatches: snapshot.patches,
        });
        emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow diff", {
          executionSettingsChanged,
          inputsChanged,
          patchesAppended,
          patchesChanged,
          preparationSettingsChanged,
          singleReplaceIndex,
        });
        await setWorkflowSettingsIfChanged({ baseSettings, changed: executionSettingsChanged, snapshot, workflow });
        if (patchesChanged && !patchesAppended && singleReplaceIndex < 0) {
          emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow clearPatches start");
          await workflow.clearPatches();
          emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow clearPatches finish");
        }
        // Start the input operation but DON'T await it yet. addPatch fires its archive extraction
        // eagerly (outside the controller's mutation queue), so leaving setInput un-awaited lets the
        // ROM-archive extraction and the patch-archive extraction run at the same time instead of one
        // after the other. setInput is still *called* before the patches below, so its mutation body is
        // enqueued first and every patch's readiness still evaluates against a fully staged input.
        let inputPromise: Promise<void> | null = null;
        if (!inputsChanged) {
          emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow input skipped", {
            reason: "unchanged",
          });
        } else if (snapshot.inputs.length) {
          emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow setInput start", {
            inputCount: snapshot.inputs.length,
          });
          inputPromise = workflow
            // Surface the ROM row's done state (clear "checksumming" + populate checksums) the moment
            // the input is checksummed, before the patch (re)validation inside setInput runs - that
            // validation is a patch concern and reports only on the patch row.
            .setInput(snapshot.inputs, {
              onPrepared: (state) => {
                handlers.onInputPrepared?.(state);
                emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow input prepared", { input: state });
              },
              onFinalized: (state) => {
                handlers.onInputState?.(state);
                if (state?.checksums) handlers.onChecksumReady?.(state);
                emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow input finalized", { input: state });
              },
            })
            .then(() => {
              emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow setInput finish", {
                input: workflow.getInput(),
              });
            })
            .catch((error) => {
              emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow setInput failed", {
                code: getErrorCode(error),
                message: error instanceof Error ? error.message : String(error),
              });
              if (getErrorCode(error) !== "WORKFLOW_SELECTION_SKIPPED") throw error;
            });
        } else {
          emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow clearInput start");
          inputPromise = workflow.clearInput().then(() => {
            emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow clearInput finish");
          });
        }

        // Fire every addPatch synchronously (no await between iterations) so each source's staging - the
        // archive extraction inside stageSource - starts at once, overlapping the input extraction above
        // and any sibling patch. The controller still applies each patch's readiness through its
        // serialized mutation queue in call order (after setInput's), so order/state is preserved; only
        // the heavy extraction now runs concurrently. A single in-place replace swaps just its one slot
        // (replacePatchAt) so the untouched patches keep their staged state + cached verdicts.
        const settlePatchMutation = (mutation: Promise<void>) =>
          mutation
            .catch((error) => {
              if (getErrorCode(error) !== "WORKFLOW_SELECTION_SKIPPED") throw error;
            })
            .finally(() => {
              handlers.onPatchState?.(workflow.getPatches());
            });
        const buildPatchAdditions = () => {
          if (!patchesChanged) return [];
          if (singleReplaceIndex >= 0)
            return [
              settlePatchMutation(
                workflow.replacePatchAt(singleReplaceIndex, snapshot.patches[singleReplaceIndex] as BinarySource),
              ),
            ];
          const additions = patchesAppended ? snapshot.patches.slice(previousPatches.length) : snapshot.patches;
          return additions.map((patch) => settlePatchMutation(workflow.addPatch(patch)));
        };
        const patchAdditions = buildPatchAdditions();

        // Await the input first so its state is emitted before the patches', matching the previous order
        // of UI updates; the heavy extraction already overlapped above. On input failure, drain the
        // concurrently-fired patch promises before surfacing the error so none leak as unhandled.
        if (inputPromise) {
          try {
            await inputPromise;
          } catch (inputError) {
            await Promise.allSettled(patchAdditions);
            throw inputError;
          }
          handlers.onInputState?.(workflow.getInput());
          emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow input state emitted", {
            input: workflow.getInput(),
          });
        }
        if (patchAdditions.length) {
          const settled = await Promise.allSettled(patchAdditions);
          const firstFailure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
          if (firstFailure) throw firstFailure.reason;
        }

        // A clear-and-re-add rebuilt every stage with default options - replay the
        // session's per-patch user options (header/PPF-undo/checks) so a filtered
        // run doesn't silently drop them. A single in-place replace keeps every
        // untouched stage (and its options), and the swapped slot is a fresh patch,
        // so there is nothing to replay.
        if (patchesChanged && !patchesAppended && singleReplaceIndex < 0 && snapshot.patchOptions?.length) {
          const stagedCount = workflow.getPatches().length;
          for (const [index, option] of snapshot.patchOptions.entries()) {
            if (index >= stagedCount) break;
            if (!(option && Object.keys(option).length)) continue;
            await workflow.setPatchOption(index, option);
          }
        }

        await syncWorkflowOutputOverrides(workflow, snapshot, baseSettings, executionSettingsChanged, {
          baseSettingsApplied: executionSettingsChanged,
        });
        workflowSyncRef.current = {
          executionSettingsKey,
          inputs: snapshot.inputs.slice(),
          patches: snapshot.patches.slice(),
          preparationSettingsKey,
        };
        if (snapshot.inputs.length) forceInputWorkflowRefreshRef.current = false;
        forcePatchWorkflowRefreshRef.current = false;

        const input = workflow.getInput();
        const patches = workflow.getPatches();
        bundleSourcesRef.current = workflow.getBundleExportSources();
        const checksums = input?.checksums || null;
        // Post-stage, the controller's output state is the authoritative resolved name + format
        // (it owns the auto-naming, including the disc-name special-casing, and the manual overrides
        // applied above). The form keeps only the eager pre-stage estimate for instant feedback.
        const resolvedOutput = workflow.getSnapshot().output;
        setResolvedOutputCompression(resolvedOutput.outputFormat);
        setResolvedOutputNameForSnapshot(snapshot, resolvedOutput.outputName);
        handlers.onInputState?.(input);
        handlers.onPatchState?.(patches);
        if (input?.checksums) handlers.onChecksumReady?.(input);
        // The controller's snapshot is the authoritative readiness source (it mirrors run()'s
        // preconditions: input ready+selected, every patch ready, output name resolved). The form
        // adds only the UI-side gate that every *requested* patch finished staging.
        setApplyReady(
          workflow.getSnapshot().ready && (!snapshot.patches.length || patches.length === snapshot.patches.length),
        );
        emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow finish", {
          hasChecksums: !!input?.checksums,
          inputStatus: input?.status,
          patchCount: patches.length,
        });

        return await callback({
          checksums,
          input,
          patches,
          workflow,
        });
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (
          (normalized as Error & { code?: string }).code === "INVALID_INPUT" &&
          snapshot.inputs.length > 1 &&
          snapshot.patches.length > 0
        ) {
          throw createWorkflowFormError("AMBIGUOUS_SELECTION", "Patch target selection is required");
        }
        throw normalized;
      } finally {
        emitApplyWorkflowTrace(snapshot.options, "prepareWorkflow cleanup");
        prepareHandlersRef.current = null;
        workflow.off("progress", handleProgress);
      }
    },
    [getWorkflow, props.threads, setResolvedOutputNameForSnapshot, syncSelectionRefs, syncWorkflowOutputOverrides],
  );

  const withPreparedWorkflow = useCallback(
    <TValue,>(
      snapshot: ApplyWorkflowSessionInput,
      handlers: ApplyWorkflowPrepareHandlers,
      callback: (prepared: {
        checksums: Record<string, string> | null;
        input: ApplyWorkflowInputState | null;
        patches: ApplyWorkflowPatchState[];
        workflow: ApplyWorkflow;
      }) => Promise<TValue>,
    ): Promise<TValue> => {
      emitApplyWorkflowTrace(snapshot.options, "withPreparedWorkflow queued", {
        inputCount: snapshot.inputs.length,
        patchCount: snapshot.patches.length,
      });
      return queueMutation(() => prepareWorkflow(snapshot, handlers, callback));
    },
    [prepareWorkflow, queueMutation],
  );

  // The session fires ROM and patch staging in the same tick (its coalescing window). Batch those
  // calls into ONE prepareWorkflow pass so the input and every patch extract concurrently (the pass
  // fans out setInput + addPatch) while BOTH buckets keep live progress - progress is emitted once
  // and routed by role below. Each caller still resolves with its own staged infos.
  const stageBatchRef = useRef<{
    members: StageBatchMember[];
    snapshot: ApplyWorkflowSessionInput | null;
    scheduled: boolean;
  }>({ members: [], scheduled: false, snapshot: null });

  const flushStageBatch = useCallback(() => {
    const batch = stageBatchRef.current;
    const { members, snapshot } = batch;
    stageBatchRef.current = { members: [], scheduled: false, snapshot: null };
    if (!(members.length && snapshot)) return;
    const mergedHandlers: ApplyWorkflowPrepareHandlers = {
      onChecksumReady: (state) => {
        for (const member of members) member.handlers.onChecksumReady?.(state);
      },
      onInputPrepared: (state) => {
        for (const member of members) member.handlers.onInputPrepared?.(state);
      },
      onInputState: (state) => {
        for (const member of members) member.handlers.onInputState?.(state);
      },
      onProgress: (event) => {
        // Emit once, then fan the typed progress out to whichever buckets are staging, by role.
        const { progressEvent, workflowProgress } = emitWorkflowProgress(event);
        // A patch finished its eager parse while the ROM is still staging (the controller emits this
        // "awaiting input" event the moment the patch is read, before its queued addPatch mutation).
        // Reveal the parsed info now so the card leaves "Reading…" independent of the ROM, and DON'T
        // route it as progress - that would keep the card busy. The deferred dry-run flips the card to
        // "Verifying…" once the ROM lands.
        if (
          workflowProgress.role === "patch" &&
          workflowProgress.stage === "verify" &&
          workflowProgress.id.endsWith(":patch-awaiting-input")
        ) {
          const order = Number(workflowProgress.details?.order);
          const info = Number.isInteger(order) ? buildEagerPatchStageInfo(getWorkflow(), snapshot, order) : null;
          // Only reveal (and swallow this "waiting" event) once the patch is parsed. If it isn't yet,
          // fall through so the event routes as normal patch progress and the card keeps "Reading…".
          if (info) {
            for (const member of members) member.handlers.onPatchStaged?.(info, order);
            return;
          }
        }
        for (const member of members) {
          if (workflowProgress.role === "input") member.handlers.onInputProgress?.(progressEvent);
          else if (workflowProgress.role === "patch") member.handlers.onPatchProgress?.(progressEvent);
        }
      },
      selection: {
        promptInputSelection: members.some((member) => member.handlers.selection?.promptInputSelection !== false),
        promptPatchSelection: members.some((member) => member.handlers.selection?.promptPatchSelection !== false),
      },
    };
    void queueMutation(() =>
      prepareWorkflow(snapshot, mergedHandlers, async (prepared) => {
        for (const member of members) await member.run(prepared);
      }),
    ).catch((error) => {
      for (const member of members) member.fail(error);
    });
  }, [emitWorkflowProgress, getWorkflow, prepareWorkflow, queueMutation]);

  const enqueueStageBatch = useCallback(
    <TValue,>(
      snapshot: ApplyWorkflowSessionInput,
      handlers: StageBatchHandlers,
      callback: (prepared: PreparedApplyWorkflow) => Promise<TValue>,
    ): Promise<TValue> =>
      new Promise<TValue>((resolve, reject) => {
        const batch = stageBatchRef.current;
        batch.members.push({
          fail: reject,
          handlers,
          run: async (prepared) => {
            try {
              resolve(await callback(prepared));
            } catch (error) {
              reject(error);
            }
          },
        });
        // Members coalesced in one tick share the same render's snapshot; keep the latest.
        batch.snapshot = snapshot;
        if (!batch.scheduled) {
          batch.scheduled = true;
          queueMicrotask(flushStageBatch);
        }
      }),
    [flushStageBatch],
  );

  const applyPatches = useCallback(
    async (rawInput: ApplyWorkflowSessionInput) => {
      // Disabled patches never reach the workflow; the bench keeps their cards.
      // Their index-aligned run options travel with the kept patches so the
      // filtered re-stage can replay them onto its fresh stages.
      const filteredRun = filterEnabledPatchRun(rawInput.patches, rawInput.patchOptions);
      const input: ApplyWorkflowSessionInput = { ...rawInput, ...filteredRun };
      const runPreparedWorkflow = async ({
        input: stagedInput,
        patches,
        workflow,
      }: {
        input: ApplyWorkflowInputState | null;
        patches: ApplyWorkflowPatchState[];
        workflow: ApplyWorkflow;
      }) => {
        const readinessError = getWorkflowReadinessError(stagedInput, patches);
        if (readinessError) throw readinessError;
        const abortSignal = input.options.signal;
        const abortWorkflow = () => workflow.abort(abortSignal?.reason);
        if (abortSignal?.aborted) abortWorkflow();
        else abortSignal?.addEventListener("abort", abortWorkflow, { once: true });
        try {
          const result = (await workflow.run()) as BrowserApplyResult;
          onApplyComplete?.(result);
          return normalizeApplyResult(result);
        } finally {
          abortSignal?.removeEventListener("abort", abortWorkflow);
        }
      };

      return queueMutation(async () => {
        syncSelectionRefs(input);
        const baseSettings = createBaseApplyWorkflowSettings(input.options, threads);
        const executionSettingsKey = createWorkflowSettingsKey(baseSettings);
        const preparationSettingsKey = createWorkflowPreparationSettingsKey(baseSettings);
        const previousSync = workflowSyncRef.current;
        const workflow = workflowRef.current;
        const workflowPrepared =
          !!workflow &&
          previousSync.preparationSettingsKey === preparationSettingsKey &&
          sameBinarySourceLists(previousSync.inputs, input.inputs) &&
          sameBinarySourceLists(previousSync.patches, input.patches) &&
          !forcePatchWorkflowRefreshRef.current;
        if (!(workflowPrepared && workflow)) {
          return prepareWorkflow(
            input,
            {
              onProgress: (event) => {
                emitWorkflowProgress(event, input.options.onProgress);
              },
            },
            runPreparedWorkflow,
          );
        }

        prepareHandlersRef.current = {
          onProgress: (event) => {
            emitWorkflowProgress(event, input.options.onProgress);
          },
        };
        const handleProgress = (event: WorkflowProgress) => prepareHandlersRef.current?.onProgress?.(event);
        workflow.on("progress", handleProgress);
        try {
          const executionSettingsChanged = previousSync.executionSettingsKey !== executionSettingsKey;
          await syncWorkflowOutputOverrides(workflow, input, baseSettings, executionSettingsChanged);
          if (executionSettingsChanged) {
            workflowSyncRef.current = {
              ...previousSync,
              executionSettingsKey,
            };
          }
          return await runPreparedWorkflow({
            input: workflow.getInput(),
            patches: workflow.getPatches(),
            workflow,
          });
        } finally {
          prepareHandlersRef.current = null;
          workflow.off("progress", handleProgress);
        }
      });
    },
    [
      emitWorkflowProgress,
      onApplyComplete,
      threads,
      queueMutation,
      syncSelectionRefs,
      syncWorkflowOutputOverrides,
      prepareWorkflow,
      filterEnabledPatchRun,
    ],
  );

  const downloadOutput = useCallback(
    (result: ApplyWorkflowResult, fileName?: string, options?: { interactive?: boolean }) => {
      if (typeof window === "undefined") return undefined;
      const destination =
        fileName || options?.interactive ? { fileName, interactive: options?.interactive } : undefined;
      return result.output.saveAs?.(destination);
    },
    [],
  );

  const stageInput = useCallback(
    async (
      input: ApplyWorkflowSessionInput,
      handlers: {
        onChecksum: (info: {
          archiveName?: string;
          checksums?: Record<string, string>;
          checksumVariants?: ApplyWorkflowInputState["checksumVariants"];
          decompressionTimeMs?: number;
          fileName?: string;
          romProbe?: ApplyWorkflowInputState["romProbe"];
          size?: number;
          sourceSize?: number;
          wasDecompressed?: boolean;
        }) => void;
        onImplicitPatches?: (patches: BinarySource[], infos?: Array<StagedInputInfo | null | undefined>) => void;
        onPrepared?: (infos: StagedInputInfo[]) => void;
        onProgress: (event: ProgressEvent) => void;
        onState: (info: {
          archiveName?: string;
          checksums?: Record<string, string>;
          checksumVariants?: ApplyWorkflowInputState["checksumVariants"];
          decompressionTimeMs?: number;
          fileName?: string;
          romProbe?: ApplyWorkflowInputState["romProbe"];
          size?: number;
          sourceSize?: number;
          wasDecompressed?: boolean;
        }) => void;
      },
    ) => {
      emitApplyWorkflowTrace(input.options, "stageInput callback start", {
        inputCount: input.inputs.length,
        inputs: summarizeApplyWorkflowSources(input.inputs, "Input"),
      });
      return enqueueStageBatch(
        input,
        {
          onChecksumReady: (state) => {
            for (const info of toStagedInputInfos(state, input.inputs)) {
              if (info) handlers.onChecksum(info);
            }
          },
          onInputPrepared: (state) => {
            handlers.onPrepared?.(toStagedInputInfos(state, input.inputs));
          },
          onInputProgress: handlers.onProgress,
          onInputState: (state) => {
            for (const info of toStagedInputInfos(state, input.inputs)) {
              if (info) handlers.onState(info);
            }
          },
        },
        async ({ input: stagedInput, workflow }) => {
          preparedWorkflowRef.current = workflow;
          bundleSourcesRef.current = workflow.getBundleExportSources();
          const infos = toStagedInputInfos(stagedInput, input.inputs);
          if (!input.patches.length) {
            const implicitPatchSources = workflow.getPatchSources().filter(isReactBinarySource);
            if (implicitPatchSources.length) {
              const inputLabelById = new Map(infos.map((entry) => [entry.id || "", entry.fileName || "Input"]));
              const implicitPatchInfos = workflow.getPatches().map((patch, index) => {
                const targetName =
                  patch?.targetInputFileName ||
                  (patch?.targetInputId ? inputLabelById.get(patch.targetInputId) : undefined) ||
                  "None selected";
                return toPatchStageInfo(
                  patch,
                  getReactBinarySourceFileName(implicitPatchSources[index] || null, `Patch ${index + 1}`),
                  index,
                  `Target: ${targetName}`,
                );
              });
              handlers.onImplicitPatches?.(implicitPatchSources, implicitPatchInfos);
            }
          }
          emitApplyWorkflowTrace(input.options, "stageInput callback finish", {
            infoCount: infos.length,
            infos,
            inputStatus: stagedInput?.status,
          });
          return infos;
        },
      );
    },
    [enqueueStageBatch],
  );

  const stagePatches = useCallback(
    async (
      input: ApplyWorkflowSessionInput,
      handlers: {
        onImplicitPatches?: (patches: BinarySource[], infos: PatchStageInfo[]) => void;
        onPatchStaged?: (info: PatchStageInfo, order: number) => void;
        onProgress: (event: ProgressEvent) => void;
      },
    ) => {
      const originalNames = input.patches.map((patch, index) =>
        getReactBinarySourceFileName(patch, `Patch ${index + 1}`),
      );
      return enqueueStageBatch(
        input,
        {
          onPatchProgress: handlers.onProgress,
          onPatchStaged: handlers.onPatchStaged,
          selection: {
            promptInputSelection: false,
            promptPatchSelection: true,
          },
        },
        async ({ input: stagedInput, patches, workflow }) => {
          preparedWorkflowRef.current = workflow;
          bundleSourcesRef.current = workflow.getBundleExportSources();
          const inputLabelById = new Map(
            toStagedInputInfos(stagedInput, input.inputs).map((entry) => [entry.id || "", entry.fileName || "Input"]),
          );
          const buildInfo = (patch: (typeof patches)[number], index: number, fileName: string): PatchStageInfo => {
            const targetName =
              patch?.targetInputFileName ||
              (patch?.targetInputId ? inputLabelById.get(patch.targetInputId) : undefined) ||
              "None selected";
            return toPatchStageInfo(patch, fileName, index, `Target: ${targetName}`);
          };
          // A nested patch archive with several patches fans out into N independent leaf sources;
          // surface them so React grows its patch stack instead of showing only the dropped archive.
          const fannedPatchSources = workflow.getPatchSources().filter(isReactBinarySource);
          if (fannedPatchSources.length > input.patches.length && handlers.onImplicitPatches) {
            // The workflow already owns these selected leaf stages. Adopt their sources in the sync
            // snapshot before React renders the expanded stack, so that render reuses the stages
            // instead of clearing them and extracting every selected archive entry a second time.
            workflowSyncRef.current = {
              ...workflowSyncRef.current,
              patches: fannedPatchSources.slice(),
            };
            const fannedInfos = patches.map((patch, index) =>
              buildInfo(
                patch,
                index,
                getReactBinarySourceFileName(fannedPatchSources[index] || null, `Patch ${index + 1}`),
              ),
            );
            handlers.onImplicitPatches(fannedPatchSources, fannedInfos);
            return fannedInfos;
          }
          return patches.map((patch, index) => buildInfo(patch, index, originalNames[index] || `Patch ${index + 1}`));
        },
      );
    },
    [enqueueStageBatch],
  );

  // The deep dry-run validation is deferred out of staging so the patch card can render its info +
  // cheap preflight verdict instantly; this pass runs it afterward (silently - no progress) and
  // resolves with the refreshed infos now carrying the dry-run verdict.
  const validatePatches = useCallback(
    async (
      input: ApplyWorkflowSessionInput,
      // Fires once with the pre-validation infos (target resolved, verdict pending → the card reads
      // "Verifying…") before the deep dry-run runs - so a patch dropped before its ROM shows the
      // verifying state the moment the ROM lands, not only the final verdict.
      onVerifying?: (infos: Array<ReturnType<typeof toPatchStageInfo>>) => void,
    ) => {
      const originalNames = input.patches.map((patch, index) =>
        getReactBinarySourceFileName(patch, `Patch ${index + 1}`),
      );
      return withPreparedWorkflow(
        input,
        {
          // Fully silent: the deep dry-run must not surface any progress (patch-row *or* the global
          // workflow bar via `props.onProgress`) - the card already reads as settled and only its
          // verdict should change when validation lands.
          onProgress: () => undefined,
          selection: {
            promptInputSelection: false,
            promptPatchSelection: false,
          },
        },
        async ({ input: stagedInput, workflow }) => {
          const inputLabelById = new Map(
            toStagedInputInfos(stagedInput, input.inputs).map((entry) => [entry.id || "", entry.fileName || "Input"]),
          );
          const buildInfos = () => {
            const patchSources = workflow.getPatchSources().filter(isReactBinarySource);
            return workflow.getPatches().map((patch, index) => {
              const fileName = getReactBinarySourceFileName(
                patchSources[index] || null,
                originalNames[index] || `Patch ${index + 1}`,
              );
              const targetName =
                patch?.targetInputFileName ||
                (patch?.targetInputId ? inputLabelById.get(patch.targetInputId) : undefined) ||
                "None selected";
              return toPatchStageInfo(patch, fileName, index, `Target: ${targetName}`);
            });
          };
          onVerifying?.(buildInfos());
          // Toggled-off patches are excluded from the run, so skip their deep dry-run too; the
          // enablement-change pass revalidates a patch when it is toggled back on.
          await workflow.validatePatches({
            chainMeta: buildChainMeta(input.patches),
            disabledIndexes: getDisabledPatchIndexes(input.patches),
          });
          setChainPlans(new Map(workflow.latestChainPlans));
          return buildInfos();
        },
      );
    },
    [buildChainMeta, getDisabledPatchIndexes, withPreparedWorkflow],
  );

  const setPatchTarget = useCallback(
    async (input: ApplyWorkflowSessionInput, patchIndex: number, targetInputId: string) => {
      const originalNames = input.patches.map((patch, index) =>
        getReactBinarySourceFileName(patch, `Patch ${index + 1}`),
      );
      return withPreparedWorkflow(
        input,
        {
          selection: {
            promptInputSelection: false,
            promptPatchSelection: false,
          },
        },
        async ({ input: stagedInput, workflow }) => {
          await workflow.setPatchTarget(patchIndex, targetInputId || "auto");
          const refreshedInput = workflow.getInput();
          const refreshedPatches = workflow.getPatches();
          setApplyReady(workflow.getSnapshot().ready && refreshedPatches.length === input.patches.length);
          const inputLabelById = new Map(
            toStagedInputInfos(refreshedInput || stagedInput, input.inputs).map((entry) => [
              entry.id || "",
              entry.fileName || "Input",
            ]),
          );
          return refreshedPatches.map((patch, index) => {
            const targetName =
              patch?.targetInputFileName ||
              (patch?.targetInputId ? inputLabelById.get(patch.targetInputId) : undefined) ||
              "None selected";
            return toPatchStageInfo(
              patch,
              originalNames[index] || `Patch ${index + 1}`,
              index,
              `Target: ${targetName}`,
            );
          });
        },
      );
    },
    [withPreparedWorkflow],
  );

  const setPatchOption = useCallback(
    async (
      input: ApplyWorkflowSessionInput,
      patchIndex: number,
      option: {
        validateInputChecksum?: string;
        validateOutputChecksum?: string;
        header?: "keep" | "strip";
        n64ByteOrder?: "keep" | "big-endian" | "little-endian" | "byte-swapped";
        revalidate?: boolean;
      },
    ) => {
      const originalNames = input.patches.map((patch, index) =>
        getReactBinarySourceFileName(patch, `Patch ${index + 1}`),
      );
      const { revalidate, ...patchOption } = option;
      return withPreparedWorkflow(
        input,
        {
          selection: {
            promptInputSelection: false,
            promptPatchSelection: false,
          },
        },
        async ({ input: stagedInput, workflow }) => {
          await workflow.setPatchOption(patchIndex, patchOption);
          // A user edit changed what the run verifies (header bytes / expected
          // checks): rerun the deep validation - patches whose validation key is
          // unchanged short-circuit, the affected one re-verifies. Programmatic
          // seeding (bundle sessions) skips this; the staging-completion pass
          // validates those on its own schedule.
          if (revalidate) {
            await workflow.validatePatches({
              chainMeta: buildChainMeta(input.patches),
              disabledIndexes: getDisabledPatchIndexes(input.patches),
            });
            setChainPlans(new Map(workflow.latestChainPlans));
          }
          const refreshedInput = workflow.getInput();
          const refreshedPatches = workflow.getPatches();
          const inputLabelById = new Map(
            toStagedInputInfos(refreshedInput || stagedInput, input.inputs).map((entry) => [
              entry.id || "",
              entry.fileName || "Input",
            ]),
          );
          return refreshedPatches.map((patch, index) => {
            const targetName =
              patch?.targetInputFileName ||
              (patch?.targetInputId ? inputLabelById.get(patch.targetInputId) : undefined) ||
              "None selected";
            return toPatchStageInfo(
              patch,
              originalNames[index] || `Patch ${index + 1}`,
              index,
              `Target: ${targetName}`,
            );
          });
        },
      );
    },
    [buildChainMeta, getDisabledPatchIndexes, withPreparedWorkflow],
  );

  const { localUiController, localStackController, localOutputController, localNoticeController } =
    useLocalApplyPatchFormSession({
      ...propsWithSettings,
      applyPatches,
      applyReady,
      disabledPatchIds,
      downloadOutput,
      onApplyComplete: () => undefined,
      onInputsChange: handleLocalInputsChange,
      onPatchesChange: handleLocalPatchesChange,
      resolvedOutputCompression,
      resolvedOutputName,
      resolvedOutputNameKey,
      setPatchOption,
      setPatchTarget,
      stageInput,
      stagePatches,
      validatePatches,
    });
  const resolvedUiController = controllers?.ui || localUiController;
  const resolvedStackController = controllers?.patchStack || localStackController;
  const resolvedOutputController = controllers?.output || localOutputController;
  bundleControllersRef.current = { output: resolvedOutputController, patchStack: resolvedStackController };

  // "Export bundle…" (output card secondary action): snapshots the current
  // session's files + enablement into a rom-weaver-bundle.json (or everything-bundle .zip).
  const stagedBundleSources = (preparedWorkflowRef.current || workflowRef.current)?.getBundleExportSources();
  const bundleExportReady =
    (!!stagedBundleSources?.rom && stagedBundleSources.patches.length > 0) ||
    (!!bundleSourcesRef.current?.rom && bundleSourcesRef.current.patches.length > 0);
  const bundleExport = useBundleExport({
    bundleMetaById,
    disabledPatchIds,
    getPatchIds,
    getName: () => resolvedOutputController.getState().displayFileName,
    getOutputHeader: () => resolvedOutputController.getState().outputHeader,
    getSessionSources: (): ApplyWorkflowBundleSources => {
      const workflowSources = (preparedWorkflowRef.current || workflowRef.current)?.getBundleExportSources();
      if (workflowSources?.rom || workflowSources?.patches.length) return workflowSources;
      if (bundleSourcesRef.current?.rom || bundleSourcesRef.current?.patches.length) return bundleSourcesRef.current;
      return {
        patches: currentPatchesRef.current.map((source, index) => ({
          fileName: getReactBinarySourceFileName(source, `patch-${index + 1}.bin`),
          originalSource: source,
          source,
        })),
        rom: lastInputsRef.current[0]
          ? {
              fileName: getReactBinarySourceFileName(lastInputsRef.current[0], "rom.bin"),
              originalSource: lastInputsRef.current[0],
              source: lastInputsRef.current[0],
            }
          : null,
      };
    },
    getStackItems: () => resolvedStackController.getState().items,
    initialBundleRom: defaultBundleContents === "rom",
    initialFormat: defaultBundleFormat,
    ready: bundleExportReady,
    ...(props.onBundleExportComplete ? { onComplete: props.onBundleExportComplete } : {}),
  });

  // The bundle package dropdown lives permanently in Output options and mirrors
  // the persisted "Bundle" user setting: a format arms the create/download
  // action, "" hides it. The selection drives visibility - no separate reveal.
  const {
    format: bundleExportFormat,
    setBundleRom: setBundleExportRom,
    setFormat: setBundleExportFormat,
  } = bundleExport;
  const bundleExportVisible = !!bundleExportFormat && bundleExportFormat !== "bundle";
  const { onBundlePackageChange } = props;
  const changeBundlePackage = useCallback(
    (value: string) => {
      const [format = "", contents = ""] = value.split(":");
      setBundleExportFormat(format);
      setBundleExportRom(contents === "rom");
      onBundlePackageChange?.(value);
    },
    [onBundlePackageChange, setBundleExportFormat, setBundleExportRom],
  );

  // Unified drop orchestration shared by the in-tab dropzone and the page-wide
  // forwarder: bare files stage immediately, archives show an instant placeholder
  // until their ROM-vs-patch bucket is classified.
  const { onDrop: handleUnifiedDrop, pendingDrops } = useUnifiedApplyDrop(
    resolvedUiController,
    setLocalBundleSession,
    props.onError,
  );

  // Forward a page-level drop (dragging anywhere on the page) to the same unified
  // drop handler so the whole tab is a drop target, not just the dropzone box.
  const handledPageDropIdRef = useRef<number | null>(null);
  usePageDropForwarder(props.pageDrop, (files) => handleUnifiedDrop(files), handledPageDropIdRef);

  handleSelectionCancelledRef.current = (request) => {
    const normalizedSourceName = request.sourceName.trim().toLowerCase();
    if (request.role === "patch") {
      const items = resolvedStackController.getState().items;
      const matchingIndex = items.findIndex((item) =>
        [item.fileName, item.archiveFileName].some((value) => value.trim().toLowerCase() === normalizedSourceName),
      );
      const removeIndex = matchingIndex >= 0 ? matchingIndex : items.length - 1;
      if (removeIndex >= 0) resolvedStackController.removeItem(removeIndex);
      return;
    }
    if (request.role !== "input") return;
    const romInputs = resolvedUiController.getState().romInputs;
    // A "which one?" prompt over several separately-provided ROMs spans every pending row, so
    // cancelling it abandons the whole pending input. Clear them all - removing a single row would
    // leave the other ROM(s) to auto-stage as if one had been chosen.
    if (romInputs.length > 1) {
      resolvedUiController.provideRomInputFile?.(null);
      return;
    }
    const matchingInput = romInputs.find((entry) =>
      [entry.info.fileName, entry.info.archiveName].some(
        (value) => value.trim().toLowerCase() === normalizedSourceName,
      ),
    );
    const fallbackInput = romInputs.at(-1);
    const removeId = matchingInput?.id || fallbackInput?.id;
    if (removeId) resolvedUiController.removeRomInput?.(removeId);
  };

  return (
    <>
      <ApplyWorkflowFormView
        bundleExport={bundleExport}
        bundleMetaById={bundleMetaById}
        controllers={{
          dialog: controllers?.dialog || inertDialogController,
          notice: controllers?.notice || localNoticeController,
          output: resolvedOutputController,
          patchStack: resolvedStackController,
          ui: resolvedUiController,
        }}
        {...(activeBundleSession?.chainEndpointChecks.input
          ? { bundleExpectedRomChecks: activeBundleSession.chainEndpointChecks.input }
          : {})}
        {...(activeBundleSession?.romExpectation ? { bundleRomExpectation: activeBundleSession.romExpectation } : {})}
        bundleTools={{
          exportVisible: bundleExportVisible,
          hasOptionalEntries:
            !!activeBundleSession?.entries.some((entry) => entry.optional) || disabledPatchIds.size > 0,
          outputVerification,
          setBundlePackage: changeBundlePackage,
        }}
        onBundleMetaChange={updateBundleMeta}
        onTrace={emitApplyFormInputTrace}
        onUnifiedDrop={handleUnifiedDrop}
        patchEnablement={{
          disabledIds: disabledPatchIds,
          getPatchIds,
          onToggle: togglePatchEnabled,
        }}
        pendingDrops={pendingDrops}
        startup={startup}
      />
      {candidateSelectionDialog}
    </>
  );
}

export { ApplyPatchForm };
