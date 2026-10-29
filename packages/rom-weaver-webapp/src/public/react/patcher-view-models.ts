import { createLocalizer, type Localizer } from "../../presentation/localization/index.ts";
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

/**
 * Label for the "auto" choice in the header control.
 *
 * Only a checksum match lets the page predict the outcome. Without one the
 * engine decides during the apply, from where the patch's records land, so
 * naming an outcome here would be a guess the run can contradict.
 */
const formatHeaderAutoLabel = (
  decided: boolean | undefined,
  mode: string | undefined,
  localizer: Localizer = createLocalizer("en"),
): string => {
  if (!decided) return localizer.message("ui.patch.headerAuto");
  const resolvedMode = mode || "keep";
  const label =
    resolvedMode === "keep" || resolvedMode === "strip"
      ? localizer.message(`ui.patch.headerMode.${resolvedMode}`)
      : resolvedMode;
  return localizer.message("ui.patch.headerAutoResolved", { mode: label });
};

interface UiViewStateInput {
  busy: boolean;
  checksumOverrideChecked: boolean;
  checksumOverrideNamesDamagedPatch: boolean;
  disabled: boolean;
  effectiveOutputNoticeMessage: string;
  hasStrictInputChecksumMismatch: boolean;
  inputNoticeMessage: string;
  inputStaging: boolean;
  outputRuntimeNoticeMessage: string;
  outputWarningMessage: string;
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
  checksumOverrideNamesDamagedPatch,
  disabled,
  effectiveOutputNoticeMessage,
  hasStrictInputChecksumMismatch,
  inputNoticeMessage,
  inputStaging,
  outputRuntimeNoticeMessage,
  outputWarningMessage,
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
      namesDamagedPatch: checksumOverrideNamesDamagedPatch,
      visible: hasStrictInputChecksumMismatch,
    },
    inputNotice: {
      dismissible: true,
      level: "error" as const,
      message: inputNoticeMessage,
      visible: !!inputNoticeMessage,
    },
    // A run error wins; otherwise the finished output's handler warnings show as a warning.
    outputNotice: effectiveOutputNoticeMessage
      ? {
          dismissible: !!outputRuntimeNoticeMessage,
          level: "error" as const,
          message: effectiveOutputNoticeMessage,
          visible: true,
        }
      : {
          dismissible: false,
          level: "warning" as const,
          message: outputWarningMessage,
          visible: !!outputWarningMessage,
        },
    patchInput: {
      loading: patchStaging || !!patchProgress || Object.keys(patchProgressByKey).length > 0,
    },
    patchNotice: {
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
      checksumCompared: patchInfo?.checksumCompared === true,
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
      sourceTitles: patchInfo?.sourceTitles,
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
      validationUnreadable: !!patchInfo?.validationUnreadable,
      validationValues: patchInfo?.validationValues || [],
    };
  }),
});

/** Whether the apply button can start a run: not disabled, not blocked by a failed validation. */
const isApplyButtonActionable = (button: { blocked: boolean; disabled: boolean }) =>
  !(button.disabled || button.blocked);

interface OutputViewStateInput {
  activeSettings: ApplyPatchFormSettings;
  applyQueued: boolean;
  applyTimingText: string;
  busy: boolean;
  applyBlocked: boolean;
  /** The only blocker is a damaged patch file, so the reason text must not blame the ROM. */
  applyBlockedByDamagedPatch: boolean;
  canQueueApply: boolean;
  completedSizeSummary: OutputSizeSummary;
  compressTimingText: string;
  disabled: boolean;
  displayedCompression: CompressionFormat;
  effectiveResolvedOutputName: string;
  /** The default output format is still waiting on the engine's header evidence for a `.bin`. */
  formatPending: boolean;
  hasPendingDownload: boolean;
  /** The ROM's identified title, or null when it has no single confident match. */
  identifiedTitle: string | null;
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
  applyBlocked,
  applyBlockedByDamagedPatch,
  applyTimingText,
  busy,
  canQueueApply,
  completedSizeSummary,
  compressTimingText,
  disabled,
  displayedCompression,
  effectiveResolvedOutputName,
  formatPending,
  hasPendingDownload,
  identifiedTitle,
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
    blocked: applyBlocked && !hasPendingDownload,
    blockedByDamagedPatch: applyBlockedByDamagedPatch,
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
  formatPending,
  compressTiming: compressTimingText,
  disabled: disabled || busy,
  displayFileName: outputNameEdited ? outputName : effectiveResolvedOutputName,
  identifiedName: identifiedTitle
    ? { name: identifiedTitle, on: activeSettings.output?.identifiedName !== false }
    : null,
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

interface NoticeViewStateInput {
  failureMessage: string;
  failurePlacement: "input" | "output" | "patch" | null;
}

// Pure projection of the top-level (unplaced) failure notice.
const buildNoticeViewState = ({ failureMessage, failurePlacement }: NoticeViewStateInput): NoticeState => ({
  dismissible: true,
  level: "error",
  message: failureMessage,
  visible: !!failureMessage && !failurePlacement,
});

export {
  buildNoticeViewState,
  buildOutputViewState,
  buildStackViewState,
  buildUiViewState,
  formatHeaderAutoLabel,
  isApplyButtonActionable,
};
