import type { CompressionFormat } from "../../types/settings.ts";
import { isCompressedInputFileName } from "./apply-session-inputs.ts";
import type { StagedInputInfo } from "./apply-session-types.ts";
import { buildCompressPanel } from "./compress-options.ts";
import { getBinarySourceFileName, getBinarySourceSize, toApplyButtonProgress } from "./input-session-helpers.ts";
import type { OutputOption } from "./output-view-model.ts";
import type { ApplyPatchFormSettings, BinarySource, StackPatchItem } from "./patcher-form.ts";
import { formatDownloadCompressionRatio } from "./patcher-form-session-utils.ts";
import type { createOutputSizeSummary } from "./patcher-presentation.ts";
import {
  createEmptyPatcherUiState,
  type InputProgress,
  type NoticeState,
  type RomInputRowState,
} from "./patcher-ui-state.ts";
import { createWaitingWorkflowProgress } from "./workflow-run-hooks.ts";

type OutputSizeSummary = ReturnType<typeof createOutputSizeSummary>;

interface UiViewStateInput {
  busy: boolean;
  checksumOverrideChecked: boolean;
  disabled: boolean;
  effectiveOutputNoticeMessage: string;
  hasStrictInputChecksumMismatch: boolean;
  inputNoticeCode: string;
  inputNoticeMessage: string;
  inputStaging: boolean;
  outputNoticeCode: string;
  outputRuntimeNoticeMessage: string;
  patchNoticeCode: string;
  patchNoticeMessage: string;
  patchProgress: InputProgress | null;
  patchProgressByKey: Record<string, InputProgress>;
  patchStaging: boolean;
  romInputs: RomInputRowState[];
}

// Pure projection of the apply session into the ROM-input / notice / checksum UI store state.
const buildUiViewState = ({
  busy,
  checksumOverrideChecked,
  disabled,
  effectiveOutputNoticeMessage,
  hasStrictInputChecksumMismatch,
  inputNoticeCode,
  inputNoticeMessage,
  inputStaging,
  outputNoticeCode,
  outputRuntimeNoticeMessage,
  patchNoticeCode,
  patchNoticeMessage,
  patchProgress,
  patchProgressByKey,
  patchStaging,
  romInputs,
}: UiViewStateInput) => {
  const emptyState = createEmptyPatcherUiState();
  return {
    ...emptyState,
    checksumOverride: {
      checked: checksumOverrideChecked,
      disabled: disabled || busy || inputStaging || patchStaging,
      label: emptyState.checksumOverride.label,
      visible: hasStrictInputChecksumMismatch,
    },
    inputNotice: {
      code: inputNoticeCode,
      dismissible: true,
      level: "error" as const,
      message: inputNoticeMessage,
      visible: !!inputNoticeMessage,
    },
    outputNotice: {
      code: outputNoticeCode,
      dismissible: !!outputRuntimeNoticeMessage,
      level: "error" as const,
      message: effectiveOutputNoticeMessage,
      visible: !!effectiveOutputNoticeMessage,
    },
    patchInput: {
      loading: patchStaging || !!patchProgress || Object.keys(patchProgressByKey).length > 0,
    },
    patchNotice: {
      code: patchNoticeCode,
      dismissible: true,
      level: "error" as const,
      message: patchNoticeMessage,
      visible: !!patchNoticeMessage,
    },
    romInputs,
  };
};

interface StackViewStateInput {
  activePatches: BinarySource[];
  busy: boolean;
  disabled: boolean;
  getPatchKey: (source: BinarySource, sources?: BinarySource[]) => string;
  patchInfoByKey: Record<string, StagedInputInfo>;
  patchProgressByKey: Record<string, InputProgress>;
  patchStaging: boolean;
  romInputs: RomInputRowState[];
}

// Pure projection of the patch stack (ordering, targets, validation, progress) into store items.
const buildStackViewState = ({
  activePatches,
  busy,
  disabled,
  getPatchKey,
  patchInfoByKey,
  patchProgressByKey,
  patchStaging,
  romInputs,
}: StackViewStateInput) => ({
  items: activePatches.map<StackPatchItem>((patch, index) => {
    const key = getPatchKey(patch);
    const patchInfo = patchInfoByKey[key];
    const targetOptions = romInputs
      .filter((input) => input.patchable !== false && input.kind !== "cue" && input.kind !== "gdi")
      .map((input) => ({
        label: input.info.fileName || `Input ${input.order + 1}`,
        // A disc's primary track row carries the top-level source id (e.g.
        // `input-1`) instead of its per-asset id, so it cannot be resolved
        // against the patchable assets by id. Target disc tracks by file name
        // (which both the select and apply sides resolve); other input kinds
        // keep their already-resolvable row id.
        value: input.kind === "track" ? input.info.fileName || input.id : input.id,
      }));
    return {
      archiveFileName: patchInfo?.archiveName || "",
      archivePathEntries: patchInfo?.parentCompressions,
      canMoveDown: index < activePatches.length - 1 && !(busy || disabled),
      canMoveUp: index > 0 && !(busy || disabled),
      canRemove: !(busy || disabled),
      chainVerdict: patchInfo?.chainVerdict,
      checksumTiming: patchInfo?.checksumTiming || "",
      decompressionTimeMs: patchInfo?.decompressionTimeMs,
      detailText: patchInfo?.targetLabel || "",
      // Mirror the ROM row: while a compressed patch source is still staging (no resolved leaf info
      // yet), hide its archive name - the descended leaf name (e.g. `levelA.ips`) replaces it once the
      // patch enumeration resolves, so surfacing the container name first would flash the wrong label.
      fileName:
        patchInfo?.fileName ||
        (() => {
          const pendingFileName = getBinarySourceFileName(patch, `Patch ${index + 1}`);
          return isCompressedInputFileName(pendingFileName) ? "" : pendingFileName;
        })(),
      fileSize: patchInfo?.size ?? patchInfo?.sourceSize ?? getBinarySourceSize(patch) ?? undefined,
      format: patchInfo?.format,
      headerAutoDecided: patchInfo?.headerAutoDecided === true,
      headerAutoMode: patchInfo?.headerAutoMode,
      headerChoice: patchInfo?.headerChoice,
      headerStrippedBytes: patchInfo?.headerStrippedBytes,
      n64AutoDecided: patchInfo?.n64AutoDecided === true,
      n64AutoMode: patchInfo?.n64AutoMode,
      n64ByteOrderChoice: patchInfo?.n64ByteOrderChoice,
      n64SourceOrder: patchInfo?.n64SourceOrder,
      index: index + 1,
      key,
      optionsDisabled: disabled || busy || patchStaging,
      progress: patchProgressByKey[key] || null,
      showHeaderOption: patchInfo?.showHeaderOption === true,
      showN64ByteOrderOption: patchInfo?.showN64ByteOrderOption === true,
      sourceChecksumState: patchInfo?.sourceChecksumState || "",
      targetDisabled: disabled || busy || patchStaging || targetOptions.length < 2,
      targetOptions,
      targetValue:
        targetOptions.find(
          (option) => option.value === patchInfo?.targetInputFileName || option.value === patchInfo?.targetInputId,
        )?.value || (targetOptions.length === 1 ? targetOptions[0]?.value : ""),
      validateInputChecksum: patchInfo?.validateInputChecksum || "",
      validateOutputChecksum: patchInfo?.validateOutputChecksum || "",
      validationActualValue: patchInfo?.validationActualValue || "",
      validationLabel: patchInfo?.validationLabel || "",
      validationMessage: patchInfo?.validationMessage || "",
      validationState: patchInfo?.validationState || "",
      validationValues: patchInfo?.validationValues || [],
    };
  }),
});

interface OutputViewStateInput {
  activeSettings: ApplyPatchFormSettings;
  applyQueued: boolean;
  applyTimingText: string;
  busy: boolean;
  canQueueApply: boolean;
  completedSizeSummary: OutputSizeSummary;
  compressTimingText: string;
  disabled: boolean;
  displayedCompression: CompressionFormat;
  effectiveResolvedOutputName: string;
  hasPendingDownload: boolean;
  outputName: string;
  outputNameEdited: boolean;
  outputOptions: OutputOption[];
  pendingDownloadFileName: string | null;
  progress: InputProgress | null;
  selectedOutputOptionLabel: string | undefined;
  totalTimingText: string;
  z3dsLabelSource: BinarySource | undefined;
}

// Pure projection of output/apply-button/download state into the output panel store state.
const buildOutputViewState = ({
  activeSettings,
  applyQueued,
  applyTimingText,
  busy,
  canQueueApply,
  completedSizeSummary,
  compressTimingText,
  disabled,
  displayedCompression,
  effectiveResolvedOutputName,
  hasPendingDownload,
  outputName,
  outputNameEdited,
  outputOptions,
  pendingDownloadFileName,
  progress,
  selectedOutputOptionLabel,
  totalTimingText,
  z3dsLabelSource,
}: OutputViewStateInput) => ({
  applyButton: {
    disabled: disabled || !(busy || hasPendingDownload || canQueueApply),
    label: hasPendingDownload ? `Download ${pendingDownloadFileName || "output"}` : "Apply & download",
    loading: busy || applyQueued,
    progress: hasPendingDownload
      ? null
      : applyQueued
        ? toApplyButtonProgress({ stage: "apply", ...createWaitingWorkflowProgress() })
        : progress
          ? toApplyButtonProgress({ stage: "apply", ...progress })
          : null,
    title: hasPendingDownload ? `Download ${pendingDownloadFileName}` : "",
  },
  applyTiming: applyTimingText,
  compress: buildCompressPanel(displayedCompression, activeSettings as Record<string, unknown>, z3dsLabelSource),
  compressionFormat: displayedCompression,
  compressTiming: compressTimingText,
  disabled: disabled || busy,
  displayFileName: outputNameEdited ? outputName : effectiveResolvedOutputName,
  downloadSummary: hasPendingDownload
    ? {
        format: selectedOutputOptionLabel || displayedCompression?.toUpperCase() || undefined,
        fromSize: completedSizeSummary.inputLabel || undefined,
        ratio:
          formatDownloadCompressionRatio(completedSizeSummary.inputBytes, completedSizeSummary.outputBytes) ||
          undefined,
        size: completedSizeSummary.outputLabel || undefined,
      }
    : null,
  options: outputOptions,
  outputHeader: activeSettings.output?.header || "auto",
  pendingDownloadFileName,
  resolvedOutputName: effectiveResolvedOutputName,
  sizeSummary: completedSizeSummary,
  totalTiming: totalTimingText,
});

interface ApplyBlockedReasonInput {
  bundleVerificationError: string;
  /** Patches left ticked on. Zero with a non-empty stack means every one is off. */
  enabledPatchCount: number;
  /** The run is already in flight or an output is waiting - nothing is blocked. */
  busy: boolean;
  hasPendingDownload: boolean;
  patchCount: number;
  /** A strict input-checksum mismatch the user has not overridden. */
  checksumPreflightBlocked: boolean;
  romCount: number;
}

/**
 * Why "Apply & download" is unavailable, in plain words, or "" when it is not
 * blocked. A disabled button with no reason forces the user to guess which of
 * four preconditions they missed, so the first unmet one is named.
 */
const getApplyBlockedReason = ({
  bundleVerificationError,
  busy,
  checksumPreflightBlocked,
  enabledPatchCount,
  hasPendingDownload,
  patchCount,
  romCount,
}: ApplyBlockedReasonInput): string => {
  if (busy || hasPendingDownload) return "";
  if (romCount === 0) return "Add a ROM first - the patch needs something to apply to.";
  if (patchCount === 0) return "Add at least one patch file.";
  if (enabledPatchCount === 0) return "Every patch is switched off - tick at least one to include it.";
  if (checksumPreflightBlocked)
    return "This ROM does not match what a patch expects. Tick “Apply anyway” above, or swap in the ROM the patch was built for.";
  if (bundleVerificationError) return bundleVerificationError;
  return "";
};

interface NoticeViewStateInput {
  failureCode: string;
  failureMessage: string;
  failurePlacement: "input" | "output" | "patch" | null;
}

// Pure projection of the top-level (unplaced) failure notice.
const buildNoticeViewState = ({
  failureCode,
  failureMessage,
  failurePlacement,
}: NoticeViewStateInput): NoticeState => ({
  code: failureCode,
  dismissible: true,
  level: "error",
  message: failureMessage,
  visible: !!failureMessage && !failurePlacement,
});

export { buildNoticeViewState, buildOutputViewState, buildStackViewState, buildUiViewState, getApplyBlockedReason };
