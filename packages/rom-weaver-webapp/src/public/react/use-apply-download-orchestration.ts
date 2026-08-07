import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { formatCodedErrorForDisplay, getErrorCode } from "../../presentation/errors.ts";
import { createBrowserLocalizer } from "../../presentation/localization/index.ts";
import type { CompressionFormat, PostApplyRomBehavior } from "../../types/settings.ts";
import type { ApplyWorkflowResult, ProgressEvent } from "../../types/workflow-runtime-types.ts";
import {
  getChecksumProgressInfoPatch,
  getProgressDetails,
  getProgressStagedInputInfo,
} from "./apply-session-inputs.ts";
import { logUiError } from "./apply-session-logging.ts";
import type { useLocalPatcherSessionState } from "./apply-session-state.ts";
import type {
  ApplyExecutionTimingTracker,
  LocalApplyPatchFormSessionOptions,
  StagedInputInfo,
} from "./apply-session-types.ts";
import type { ApplyPatchRunOptions } from "./apply-workflow-staging-model.ts";
import { toInputProgress } from "./input-session-helpers.ts";
import type { ApplyPatchFormSettings, BinarySource } from "./patcher-form.ts";
import { getPublicOutputSize, toError, waitForNextUiPaint } from "./patcher-form-session-utils.ts";
import { createOutputSizeSummary } from "./patcher-presentation.ts";
import type { RomInputRowState } from "./patcher-ui-state.ts";
import { addEntry, getApplyEntry, setCurrentGame, type EmulatorSessionEntry } from "./emulator-session-store.ts";
import { getEmulatorJsCore } from "./components/emulatorjs.ts";
import { loadEmulatorRom, renameRomToOutput } from "./components/emulator-load-rom.ts";
import { useRomWeaverSettings } from "./settings-context.tsx";
import { useLatestRef } from "./use-latest-ref.ts";
import { createIndeterminateWorkflowProgress } from "./workflow-run-hooks.ts";
import { deriveWorkflowRunTiming } from "./workflow-run-lifecycle.ts";

type SessionState = ReturnType<typeof useLocalPatcherSessionState>;

type ApplyRunWorkflow = Pick<
  LocalApplyPatchFormSessionOptions,
  "applyPatches" | "downloadOutput" | "onApplyComplete" | "onError" | "onProgress"
>;

type RomInputPatch = Omit<Partial<RomInputRowState>, "info"> & { info?: Partial<RomInputRowState["info"]> };

interface ApplyCompletion {
  applyTimeMs: number | null;
  compressionTimeMs: number | null;
  sizeSummary: ReturnType<typeof createOutputSizeSummary>;
}

// Pure reduction of a finished apply workflow result + the run's timing tracker into the apply/compress
// durations and the output size summary the UI renders. Extracted from the imperative run so the timing
// fallback math (reported value vs. measured-from-tracker) is unit-testable in isolation.
const deriveApplyCompletion = (
  result: ApplyWorkflowResult,
  timing: ApplyExecutionTimingTracker,
  completedAt: number,
): ApplyCompletion => {
  const { applyStartedAt, compressionStartedAt } = timing;
  const { compressionTimeMs, operationTimeMs: applyTimeMs } = deriveWorkflowRunTiming({
    completedAt,
    compressionStartedAt,
    operationStartedAt: applyStartedAt,
    reportedCompressionTimeMs: result.sizeSummary?.compressionTimeMs,
    reportedOperationTimeMs: result.sizeSummary?.applyTimeMs,
  });
  const sizeSummary = createOutputSizeSummary({
    inputBytes: result.sizeSummary?.inputSize ?? result.rom.size,
    inputCompressedBytes: result.sizeSummary?.inputCompressedSize,
    inputDecompressionTimeMs: result.sizeSummary?.inputDecompressionTimeMs,
    outputBytes: result.sizeSummary?.outputSize ?? getPublicOutputSize(result.output),
    patchBytes: result.sizeSummary?.patchSize,
    patchCompressedBytes: result.sizeSummary?.patchCompressedSize,
    rawBytes: result.sizeSummary?.rawSize ?? getPublicOutputSize(result.output),
    showRatio:
      (result.sizeSummary?.rawSize ?? getPublicOutputSize(result.output)) !==
      (result.sizeSummary?.outputSize ?? getPublicOutputSize(result.output)),
  });
  return { applyTimeMs, compressionTimeMs, sizeSummary };
};

// What to apply and whether a run/download is currently permitted - a snapshot of the session.
interface ApplyRunRequest {
  activePatches: BinarySource[];
  /** Index-aligned per-patch run options (header/PPF-undo/checks) replayed by the run. */
  activePatchOptions?: ApplyPatchRunOptions[];
  activeSettings: ApplyPatchFormSettings;
  applyQueueBlocked: boolean;
  busy: boolean;
  canQueueApply: boolean;
  canStartApply: boolean;
  checksumOverrideChecked: boolean;
  containerInputsEnabled?: boolean;
  effectiveInputs: BinarySource[];
  effectiveResolvedOutputName: string;
  hasPendingDownload: boolean;
  hasStrictInputChecksumMismatch: boolean;
  pendingDownloadFileName: string | null;
  requestedCompression: "auto" | CompressionFormat;
  requestedOutputName: string | undefined;
  resolvedThreads: number | string | undefined;
}

// Side-effecting collaborators the orchestration drives back in the parent session.
interface ApplyRunLifecycle {
  cancelActiveOperation: () => void;
  clearActiveApplyProgress: () => void;
  clearDismissibleErrors: () => void;
  disposeActiveOutput: () => void;
  getPatchKey: (source: BinarySource, sources?: BinarySource[]) => string;
  getStableInputInfo: (info: StagedInputInfo, sources: BinarySource[]) => StagedInputInfo;
  invalidateCompletedOutputState: () => void;
  mergeRomInput: (info: StagedInputInfo, patch?: RomInputPatch) => void;
  rememberAbortController: (controller: AbortController | null) => void;
  rememberActiveOutputCleanup: (cleanup: (() => Promise<void> | void) | null | undefined) => void;
  resetCompletedOutputState: () => void;
  setApplyQueued: Dispatch<SetStateAction<boolean>>;
  setChecksumOverrideChecked: Dispatch<SetStateAction<boolean>>;
  setPendingDownloadReadyFileName: (fileName: string) => void;
  selectTestView?: () => void;
}

// Long-lived run/output refs owned by the parent session.
interface ApplyRunRefs {
  activeAbortControllerRef: MutableRefObject<AbortController | null>;
  applyExecutionTimingRef: MutableRefObject<ApplyExecutionTimingTracker>;
  patchChangePendingRef: MutableRefObject<boolean>;
  pendingDownloadFileNameRef: MutableRefObject<string | null>;
  pendingDownloadResultRef: MutableRefObject<ApplyWorkflowResult | null>;
}

interface ApplyDownloadOrchestrationContext {
  lifecycle: ApplyRunLifecycle;
  refs: ApplyRunRefs;
  request: ApplyRunRequest;
  session: SessionState;
  workflow: ApplyRunWorkflow;
}

const createApplyProgressHandler = ({
  abortController,
  activePatches,
  applyExecutionTimingRef,
  effectiveInputs,
  getPatchKey,
  getStableInputInfo,
  mergeRomInput,
  onProgress,
  setCompletedApplyTimeMs,
  setPatchProgress,
  setPatchProgressByKey,
  setProgress,
}: {
  abortController: AbortController;
  activePatches: BinarySource[];
  applyExecutionTimingRef: MutableRefObject<ApplyExecutionTimingTracker>;
  effectiveInputs: BinarySource[];
  getPatchKey: ApplyRunLifecycle["getPatchKey"];
  getStableInputInfo: ApplyRunLifecycle["getStableInputInfo"];
  mergeRomInput: ApplyRunLifecycle["mergeRomInput"];
  onProgress?: ApplyRunWorkflow["onProgress"];
  setCompletedApplyTimeMs: SessionState["setCompletedApplyTimeMs"];
  setPatchProgress: SessionState["setPatchProgress"];
  setPatchProgressByKey: SessionState["setPatchProgressByKey"];
  setProgress: SessionState["setProgress"];
}) => {
  let clearedPatchRowProgress = false;
  return (event: ProgressEvent) => {
    if (abortController.signal.aborted) return;
    const details = getProgressDetails(event);
    if (details.stage === "compress" && applyExecutionTimingRef.current.compressionStartedAt === null) {
      const now = Date.now();
      applyExecutionTimingRef.current.compressionStartedAt = now;
      if (typeof applyExecutionTimingRef.current.applyStartedAt === "number") {
        setCompletedApplyTimeMs(Math.max(0, now - applyExecutionTimingRef.current.applyStartedAt));
      }
    }
    if (details.role === "input" && details.stage !== "apply") {
      const info = getStableInputInfo(getProgressStagedInputInfo(event), effectiveInputs);
      if (info.id) {
        mergeRomInput(info, {
          ...getChecksumProgressInfoPatch(details),
          progress: toInputProgress(event),
        });
      }
    } else if (details.role === "patch" && details.stage !== "apply") {
      const order = typeof details.order === "number" ? details.order : -1;
      const patch = (order >= 0 ? activePatches[order] : undefined) || activePatches[0] || null;
      if (patch) {
        const key = getPatchKey(patch);
        setPatchProgressByKey((current) => ({ ...current, [key]: toInputProgress(event) }));
        setPatchProgress(null);
      } else {
        setPatchProgress(toInputProgress(event));
      }
    } else {
      if (!clearedPatchRowProgress) {
        setPatchProgressByKey({});
        clearedPatchRowProgress = true;
      }
      setPatchProgress(null);
      setProgress(toInputProgress(event));
    }
    onProgress?.(event);
  };
};

const downloadPendingOutput = async ({
  activeSettings,
  downloadOutput,
  fileName,
  onError,
  output,
  setOutputErrorMessage,
}: {
  activeSettings: ApplyPatchFormSettings;
  downloadOutput: NonNullable<ApplyRunWorkflow["downloadOutput"]>;
  fileName: string;
  onError?: ApplyRunWorkflow["onError"];
  output: ApplyWorkflowResult;
  setOutputErrorMessage: SessionState["setOutputErrorMessage"];
}) => {
  try {
    await Promise.resolve(downloadOutput(output, fileName, { interactive: true }));
  } catch (downloadError) {
    const normalizedDownloadError = toError(downloadError);
    logUiError("Output download failed", normalizedDownloadError);
    setOutputErrorMessage(
      formatCodedErrorForDisplay(
        normalizedDownloadError,
        createBrowserLocalizer((activeSettings as { language?: string }).language),
      ),
    );
    onError?.(normalizedDownloadError);
  }
};

const normalizePostApplyRomBehavior = (value: unknown): PostApplyRomBehavior => {
  if (value === "none" || value === "auto-test" || value === "auto-test-download") return value;
  // Auto-download is the default: it preserves the pre-setting behavior of
  // downloading the output as soon as an apply completes.
  return "auto-download";
};

/**
 * Session-local override for `postApplyRomBehavior`: the public form has no
 * write path back into the host app's persisted settings (`settings-context`
 * is read-only), so the Apply step's "After applying" select overrides the
 * behavior for this session only, without touching the stored setting. Null
 * means "follow the setting". Module-level (not React state) so the setter is
 * reachable from any renderer of the Apply view without threading a prop
 * through the session hooks that don't otherwise need it.
 */
let postApplyRomBehaviorOverride: PostApplyRomBehavior | null = null;
const postApplyRomBehaviorOverrideListeners = new Set<() => void>();

const getPostApplyRomBehaviorOverride = (): PostApplyRomBehavior | null => postApplyRomBehaviorOverride;

const setPostApplyRomBehaviorOverride = (value: PostApplyRomBehavior | null): void => {
  if (postApplyRomBehaviorOverride === value) return;
  postApplyRomBehaviorOverride = value;
  for (const listener of postApplyRomBehaviorOverrideListeners) listener();
};

const subscribePostApplyRomBehaviorOverride = (listener: () => void): (() => void) => {
  postApplyRomBehaviorOverrideListeners.add(listener);
  return () => postApplyRomBehaviorOverrideListeners.delete(listener);
};

// Saving a different value in Settings supersedes the session override:
// without this, the persisted setting would stay dead for the rest of the
// session once the Apply select had been touched.
let postApplyRomBehaviorSettingSnapshot: PostApplyRomBehavior | null = null;
const syncPostApplyRomBehaviorSetting = (settingValue: unknown): void => {
  const normalized = normalizePostApplyRomBehavior(settingValue);
  if (postApplyRomBehaviorSettingSnapshot === normalized) return;
  const isFirstObservation = postApplyRomBehaviorSettingSnapshot === null;
  postApplyRomBehaviorSettingSnapshot = normalized;
  if (!isFirstObservation) setPostApplyRomBehaviorOverride(null);
};

/** The "After applying" select's controlled value: the override once set, else the live setting. */
const usePostApplyRomBehaviorValue = (settingValue: unknown): PostApplyRomBehavior => {
  const override = useSyncExternalStore(
    subscribePostApplyRomBehaviorOverride,
    getPostApplyRomBehaviorOverride,
    getPostApplyRomBehaviorOverride,
  );
  useEffect(() => {
    syncPostApplyRomBehaviorSetting(settingValue);
  }, [settingValue]);
  return normalizePostApplyRomBehavior(override ?? settingValue);
};

type PostApplyRomBehaviorOptions = {
  addSessionEntry: (entry: EmulatorSessionEntry) => void;
  behavior: PostApplyRomBehavior;
  core?: string;
  download: () => void | Promise<void>;
  fileName: string;
  focusDownload: () => void;
  loadRom?: typeof loadEmulatorRom;
  onSelectTestView?: () => void;
  output: ApplyWorkflowResult;
  platform?: string;
  retainedEntry?: EmulatorSessionEntry | null;
  setCurrentGame: (id: string) => void;
};

type EmulatorPlayableOutput = ApplyWorkflowResult["output"] & {
  getBlob?: () => Promise<Blob>;
  id?: string;
};

type PostApplyRomBehaviorResult = {
  downloaded: boolean;
  tested: boolean;
};

const claimPostApplyRun = (
  handledResultRef: MutableRefObject<ApplyWorkflowResult | null>,
  result: ApplyWorkflowResult,
): boolean => {
  if (handledResultRef.current === result) return false;
  handledResultRef.current = result;
  return true;
};

const runPostApplyRomBehavior = async ({
  addSessionEntry,
  behavior,
  core,
  download,
  fileName,
  focusDownload,
  loadRom = loadEmulatorRom,
  onSelectTestView,
  output,
  platform,
  retainedEntry,
  setCurrentGame: selectCurrentGame,
}: PostApplyRomBehaviorOptions): Promise<PostApplyRomBehaviorResult> => {
  const shouldDownload = behavior === "auto-download" || behavior === "auto-test-download";
  const shouldTest = behavior === "auto-test" || behavior === "auto-test-download";
  let downloaded = false;

  if (shouldDownload) {
    try {
      await Promise.resolve(download());
      downloaded = true;
    } catch {
      // Browsers can reject a download started after the Run gesture expired. The pending
      // button remains available, and focusing it gives the user a direct recovery path.
      focusDownload();
    }
  }

  if (!(shouldTest && core)) return { downloaded, tested: false };

  let entry = retainedEntry || null;
  if (!entry) {
    try {
      const playableOutput = output.output as EmulatorPlayableOutput;
      const blob = await playableOutput.getBlob?.();
      if (!blob) return { downloaded, tested: false };
      const outputFileName = playableOutput.fileName || fileName;
      const loaded = await loadRom(blob, outputFileName);
      entry = {
        blob: loaded.blob,
        core,
        fileName: renameRomToOutput(outputFileName, loaded.fileName),
        id: playableOutput.id || `apply-${fileName}`,
        platform,
        sizeBytes: loaded.blob.size,
        source: "apply",
      };
      addSessionEntry(entry);
    } catch {
      return { downloaded, tested: false };
    }
  }

  selectCurrentGame(entry.id);
  if (behavior === "auto-test") onSelectTestView?.();
  return { downloaded, tested: true };
};

const focusPendingDownload = () => {
  const focus = () => {
    if (typeof document === "undefined") return;
    const button = document.getElementById("rom-weaver-button-apply");
    if (button instanceof HTMLElement) button.focus();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(focus);
  else queueMicrotask(focus);
};

const handleApplyPrimaryGate = async ({
  activeSettings,
  applyQueueBlocked,
  busy,
  canQueueApply,
  canStartApply,
  cancelActiveOperation,
  clearActiveApplyProgress,
  downloadOutput,
  effectiveResolvedOutputName,
  hasPendingDownload,
  lifecycle,
  onError,
  pendingDownloadFileName,
  pendingDownloadFileNameRef,
  pendingDownloadResult,
  setOutputErrorMessage,
}: {
  activeSettings: ApplyPatchFormSettings;
  applyQueueBlocked: boolean;
  busy: boolean;
  canQueueApply: boolean;
  canStartApply: boolean;
  cancelActiveOperation: () => void;
  clearActiveApplyProgress: () => void;
  downloadOutput: ApplyRunWorkflow["downloadOutput"];
  effectiveResolvedOutputName: string;
  hasPendingDownload: boolean;
  lifecycle: ApplyRunLifecycle;
  onError?: (error: Error) => void;
  pendingDownloadFileName: string | null;
  pendingDownloadFileNameRef: MutableRefObject<string | null>;
  pendingDownloadResult: ApplyWorkflowResult | null;
  setOutputErrorMessage: SessionState["setOutputErrorMessage"];
}) => {
  if (busy) {
    lifecycle.setApplyQueued(false);
    cancelActiveOperation();
    clearActiveApplyProgress();
    return true;
  }
  if (pendingDownloadResult && hasPendingDownload) {
    await downloadPendingOutput({
      activeSettings,
      downloadOutput,
      fileName:
        pendingDownloadFileNameRef.current || pendingDownloadFileName || effectiveResolvedOutputName || "output",
      onError,
      output: pendingDownloadResult,
      setOutputErrorMessage,
    });
    return true;
  }
  if (applyQueueBlocked) {
    lifecycle.setApplyQueued(false);
    return true;
  }
  if (canQueueApply && !canStartApply) {
    lifecycle.setApplyQueued(true);
    return true;
  }
  return !canStartApply;
};

// Owns the apply-and-download workflow for the patcher session: queueing/cancellation gating, the
// AbortController lifecycle, per-stage progress fan-out, completion timing/size summary, and the
// download hand-off. Returns the primary-action handlers consumed by the output controller. The live
// context is read through a ref so the returned handlers stay stable and always see the latest session.
const useApplyDownloadOrchestration = (context: ApplyDownloadOrchestrationContext) => {
  const contextRef = useLatestRef(context);
  const settings = useRomWeaverSettings();
  const postApplyRomBehaviorRef = useLatestRef(usePostApplyRomBehaviorValue(settings.postApplyRomBehavior));
  const postApplyResultRef = useRef<ApplyWorkflowResult | null>(null);
  return useMemo(
    () => ({
      cancelPrimaryAction: () => {
        const { lifecycle, request } = contextRef.current;
        lifecycle.setApplyQueued(false);
        if (request.busy) {
          lifecycle.cancelActiveOperation();
          lifecycle.clearActiveApplyProgress();
          lifecycle.disposeActiveOutput();
          return;
        }
        lifecycle.clearActiveApplyProgress();
      },
      runPrimaryAction: async () => {
        const { lifecycle, refs, request, session, workflow } = contextRef.current;
        const {
          setBusy,
          setCompletedApplyTimeMs,
          setCompletedCompressionTimeMs,
          setCompletedSizeSummary,
          setOutputErrorMessage,
          setPatchProgress,
          setPatchProgressByKey,
          setProgress,
        } = session;
        const {
          activePatches,
          activePatchOptions,
          activeSettings,
          applyQueueBlocked,
          busy,
          canQueueApply,
          canStartApply,
          checksumOverrideChecked,
          containerInputsEnabled,
          effectiveInputs,
          effectiveResolvedOutputName,
          hasPendingDownload,
          hasStrictInputChecksumMismatch,
          pendingDownloadFileName,
          requestedCompression,
          requestedOutputName,
          resolvedThreads,
        } = request;
        const {
          cancelActiveOperation,
          clearActiveApplyProgress,
          clearDismissibleErrors,
          getPatchKey,
          getStableInputInfo,
          invalidateCompletedOutputState,
          mergeRomInput,
          rememberAbortController,
          rememberActiveOutputCleanup,
          resetCompletedOutputState,
          setApplyQueued,
          setChecksumOverrideChecked,
          setPendingDownloadReadyFileName,
          selectTestView,
        } = lifecycle;
        const { applyPatches, downloadOutput, onApplyComplete, onError, onProgress } = workflow;
        const {
          activeAbortControllerRef,
          applyExecutionTimingRef,
          pendingDownloadFileNameRef,
          pendingDownloadResultRef,
          patchChangePendingRef,
        } = refs;
        const pendingDownloadResult = pendingDownloadResultRef.current;
        if (patchChangePendingRef.current && !busy) {
          setApplyQueued(true);
          return;
        }
        if (
          await handleApplyPrimaryGate({
            activeSettings,
            applyQueueBlocked,
            busy,
            canQueueApply,
            canStartApply,
            cancelActiveOperation,
            clearActiveApplyProgress,
            downloadOutput,
            effectiveResolvedOutputName,
            hasPendingDownload,
            lifecycle,
            onError,
            pendingDownloadFileName,
            pendingDownloadFileNameRef,
            pendingDownloadResult,
            setOutputErrorMessage,
          })
        )
          return;
        // React state does not turn the button busy synchronously. Use the run's existing controller
        // as the immediate lock so a queued effect or rapid second click cannot start another apply.
        if (activeAbortControllerRef.current) return;
        setApplyQueued(false);
        const useChecksumOverride = hasStrictInputChecksumMismatch && checksumOverrideChecked;
        if (useChecksumOverride) setChecksumOverrideChecked(false);
        const runtimeValidationSettings = useChecksumOverride
          ? {
              ...activeSettings.validation,
              requireInputChecksumMatch: false,
            }
          : activeSettings.validation;
        const abortController = new AbortController();
        rememberAbortController(abortController);
        setBusy(true);
        clearDismissibleErrors();
        invalidateCompletedOutputState();
        applyExecutionTimingRef.current = {
          applyStartedAt: Date.now(),
          compressionStartedAt: null,
        };
        setProgress(createIndeterminateWorkflowProgress({ label: "Applying patch...", stage: "apply" }));
        try {
          await waitForNextUiPaint();
          const result = await applyPatches({
            inputs: effectiveInputs,
            options: {
              ...activeSettings,
              input: {
                ...activeSettings.input,
                containerInputsEnabled,
              },
              onProgress: createApplyProgressHandler({
                abortController,
                activePatches,
                applyExecutionTimingRef,
                effectiveInputs,
                getPatchKey,
                getStableInputInfo,
                mergeRomInput,
                onProgress,
                setCompletedApplyTimeMs,
                setPatchProgress,
                setPatchProgressByKey,
                setProgress,
              }),
              output: {
                ...activeSettings.output,
                compression: requestedCompression,
                outputName: requestedOutputName,
              },
              signal: abortController.signal,
              validation: runtimeValidationSettings,
              workers: {
                ...activeSettings.workers,
                threads: resolvedThreads,
              },
            },
            patches: activePatches,
            ...(activePatchOptions ? { patchOptions: activePatchOptions } : {}),
          });
          const completedAt = Date.now();
          const { applyTimeMs, compressionTimeMs, sizeSummary } = deriveApplyCompletion(
            result,
            applyExecutionTimingRef.current,
            completedAt,
          );
          setCompletedApplyTimeMs(applyTimeMs);
          setCompletedCompressionTimeMs(compressionTimeMs);
          setProgress({
            indeterminate: false,
            label: `Created ${result.output.fileName}`,
            message: `Created ${result.output.fileName}`,
            percent: 100,
          });
          setCompletedSizeSummary(sizeSummary);
          rememberActiveOutputCleanup(
            result.outputs.length > 0
              ? async () => {
                  await Promise.all(result.outputs.map((output) => Promise.resolve(output.cleanup?.())));
                }
              : result.output.cleanup || null,
          );
          pendingDownloadResultRef.current = result;
          // Warm the output's download snapshot now so a later "Download output" tap reaches
          // navigator.share before its user activation expires (iOS PWA share path).
          void result.output.prepareDownload?.().catch(() => undefined);
          const initialDownloadFileName = result.output.fileName || effectiveResolvedOutputName || "output";
          setPendingDownloadReadyFileName(initialDownloadFileName);
          if (claimPostApplyRun(postApplyResultRef, result)) {
            const romInput = session.localState.romInputs[0];
            const emulatorFileName =
              romInput?.info.fileName ||
              romInput?.info.archiveName ||
              initialDownloadFileName ||
              result.output.fileName;
            const platform = romInput?.info.romType?.platform;
            const core = getEmulatorJsCore(platform, emulatorFileName);
            await runPostApplyRomBehavior({
              addSessionEntry: addEntry,
              behavior: postApplyRomBehaviorRef.current,
              core,
              download: () => downloadOutput(result, initialDownloadFileName, { interactive: false }),
              fileName: emulatorFileName,
              focusDownload: focusPendingDownload,
              onSelectTestView: selectTestView,
              output: result,
              platform,
              retainedEntry: core ? getApplyEntry(emulatorFileName) || getApplyEntry() : null,
              setCurrentGame,
            });
          }
          onApplyComplete?.(result);
        } catch (error) {
          const normalizedError = toError(error);
          if (abortController.signal.aborted && getErrorCode(normalizedError) === "CANCELLED") {
            resetCompletedOutputState();
            clearActiveApplyProgress();
            return;
          }
          logUiError("Apply workflow failed", normalizedError);
          setOutputErrorMessage(
            formatCodedErrorForDisplay(
              normalizedError,
              createBrowserLocalizer((activeSettings as { language?: string }).language),
            ),
          );
          resetCompletedOutputState();
          onError?.(normalizedError);
        } finally {
          if (activeAbortControllerRef.current === abortController) rememberAbortController(null);
          applyExecutionTimingRef.current = {
            applyStartedAt: null,
            compressionStartedAt: null,
          };
          clearActiveApplyProgress();
          setBusy(false);
        }
      },
    }),
    [contextRef, postApplyRomBehaviorRef],
  );
};

export {
  claimPostApplyRun,
  deriveApplyCompletion,
  getPostApplyRomBehaviorOverride,
  runPostApplyRomBehavior,
  setPostApplyRomBehaviorOverride,
  subscribePostApplyRomBehaviorOverride,
  syncPostApplyRomBehaviorSetting,
  useApplyDownloadOrchestration,
  usePostApplyRomBehaviorValue,
};
