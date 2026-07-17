import { type Dispatch, type MutableRefObject, type SetStateAction, useMemo } from "react";
import { formatCodedErrorForDisplay, getErrorCode } from "../../presentation/errors.ts";
import { createBrowserLocalizer } from "../../presentation/localization/index.ts";
import type { CompressionFormat } from "../../types/settings.ts";
import type { ApplyWorkflowResult } from "../../types/workflow-runtime-types.ts";
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
  resolvedWorkerThreads: number | string | undefined;
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
}

// Long-lived run/output refs owned by the parent session.
interface ApplyRunRefs {
  activeAbortControllerRef: MutableRefObject<AbortController | null>;
  applyExecutionTimingRef: MutableRefObject<ApplyExecutionTimingTracker>;
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

// Owns the apply-and-download workflow for the patcher session: queueing/cancellation gating, the
// AbortController lifecycle, per-stage progress fan-out, completion timing/size summary, and the
// download hand-off. Returns the primary-action handlers consumed by the output controller. The live
// context is read through a ref so the returned handlers stay stable and always see the latest session.
const useApplyDownloadOrchestration = (context: ApplyDownloadOrchestrationContext) => {
  const contextRef = useLatestRef(context);
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
          resolvedWorkerThreads,
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
        } = lifecycle;
        const { applyPatches, downloadOutput, onApplyComplete, onError, onProgress } = workflow;
        const {
          activeAbortControllerRef,
          applyExecutionTimingRef,
          pendingDownloadFileNameRef,
          pendingDownloadResultRef,
        } = refs;
        if (busy) {
          setApplyQueued(false);
          cancelActiveOperation();
          clearActiveApplyProgress();
          return;
        }
        const pendingDownloadResult = pendingDownloadResultRef.current;
        if (pendingDownloadResult && hasPendingDownload) {
          try {
            await Promise.resolve(
              downloadOutput(
                pendingDownloadResult,
                pendingDownloadFileNameRef.current ||
                  pendingDownloadFileName ||
                  effectiveResolvedOutputName ||
                  "output",
                { interactive: true },
              ),
            );
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
          return;
        }
        if (applyQueueBlocked) {
          setApplyQueued(false);
          return;
        }
        if (canQueueApply && !canStartApply) {
          setApplyQueued(true);
          return;
        }
        if (!canStartApply) return;
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
        setProgress(createIndeterminateWorkflowProgress({ label: "Weaving patch...", stage: "apply" }));
        try {
          await waitForNextUiPaint();
          let clearedPatchRowProgress = false;
          const result = await applyPatches({
            inputs: effectiveInputs,
            options: {
              ...activeSettings,
              input: {
                ...activeSettings.input,
                containerInputsEnabled,
              },
              onProgress: (event) => {
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
                    setPatchProgressByKey((current) => ({
                      ...current,
                      [key]: toInputProgress(event),
                    }));
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
              },
              output: {
                ...activeSettings.output,
                compression: requestedCompression,
                outputName: requestedOutputName,
              },
              signal: abortController.signal,
              validation: runtimeValidationSettings,
              workers: {
                ...activeSettings.workers,
                threads: resolvedWorkerThreads,
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
                  await Promise.all(result.outputs.map((output) => output.cleanup?.()));
                }
              : result.output.cleanup || null,
          );
          pendingDownloadResultRef.current = result;
          // Warm the output's download snapshot now so a later "Download output" tap reaches
          // navigator.share before its user activation expires (iOS PWA share path).
          void result.output.prepareDownload?.().catch(() => undefined);
          const initialDownloadFileName = result.output.fileName || effectiveResolvedOutputName || "output";
          setPendingDownloadReadyFileName(initialDownloadFileName);
          try {
            await Promise.resolve(downloadOutput(result, initialDownloadFileName));
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
    [contextRef],
  );
};

export { deriveApplyCompletion, useApplyDownloadOrchestration };
