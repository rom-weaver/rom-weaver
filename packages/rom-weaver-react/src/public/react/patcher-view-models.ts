import type { CompressionFormat } from "../../types/settings.ts";
import { createInertState } from "./apply-session-controllers.ts";
import type { StagedInputInfo } from "./apply-session-types.ts";
import { buildCompressPanel } from "./compress-options.ts";
import { getBinarySourceFileName, getBinarySourceSize, toApplyButtonProgress } from "./input-session-helpers.ts";
import type { OutputOption } from "./output-view-model.ts";
import type { ApplyPatchFormSettings, BinarySource, StackPatchItem } from "./patcher-form.ts";
import { formatDownloadCompressionRatio } from "./patcher-form-session-utils.ts";
import type { createOutputSizeSummary } from "./patcher-presentation.ts";
import type { InputProgress, NoticeState, RomInputRowState } from "./patcher-ui-state.ts";
import { createWaitingWorkflowProgress } from "./workflow-run-hooks.ts";

type SectionTimings = { checksum: string; input: string; output: string; patch: string };
type OutputSizeSummary = ReturnType<typeof createOutputSizeSummary>;

interface UiViewStateInput {
  activePatches: BinarySource[];
  activeSettings: ApplyPatchFormSettings;
  busy: boolean;
  checksumOverrideChecked: boolean;
  disabled: boolean;
  effectiveInputs: BinarySource[];
  effectiveOutputNoticeMessage: string;
  hasStrictInputChecksumMismatch: boolean;
  inputNoticeMessage: string;
  inputStaging: boolean;
  outputRuntimeNoticeMessage: string;
  patchNoticeMessage: string;
  patchProgress: InputProgress | null;
  patchProgressByKey: Record<string, InputProgress>;
  patchStaging: boolean;
  primaryRomInput: RomInputRowState | null;
  romInputs: RomInputRowState[];
  sectionTimings: SectionTimings;
}

// Pure projection of the apply session into the ROM-input / notice / checksum UI store state.
const buildUiViewState = ({
  activePatches,
  activeSettings,
  busy,
  checksumOverrideChecked,
  disabled,
  effectiveInputs,
  effectiveOutputNoticeMessage,
  hasStrictInputChecksumMismatch,
  inputNoticeMessage,
  inputStaging,
  outputRuntimeNoticeMessage,
  patchNoticeMessage,
  patchProgress,
  patchProgressByKey,
  patchStaging,
  primaryRomInput,
  romInputs,
  sectionTimings,
}: UiViewStateInput) => ({
  ...createInertState(),
  checksumOverride: {
    checked: checksumOverrideChecked,
    disabled: disabled || busy || inputStaging || patchStaging,
    label: createInertState().checksumOverride.label,
    visible: hasStrictInputChecksumMismatch,
  },
  inputNotice: {
    dismissible: true,
    level: "error" as const,
    message: inputNoticeMessage,
    visible: !!inputNoticeMessage,
  },
  outputNotice: {
    dismissible: !!outputRuntimeNoticeMessage,
    level: "error" as const,
    message: effectiveOutputNoticeMessage,
    visible: !!effectiveOutputNoticeMessage,
  },
  patchInput: {
    ...createInertState().patchInput,
    disabled: disabled || busy || patchStaging,
    loading: patchStaging || !!patchProgress || Object.keys(patchProgressByKey).length > 0,
    progress: null,
    valid: activePatches.length > 0,
  },
  patchNotice: {
    dismissible: true,
    level: "error" as const,
    message: patchNoticeMessage,
    visible: !!patchNoticeMessage,
  },
  romInfo: {
    ...createInertState().romInfo,
    alterHeaderChecked: activeSettings.compatibility?.fixChecksum === true,
    alterHeaderDisabled: disabled || busy || inputStaging,
    alterHeaderLabel: "Fix internal checksum",
    alterHeaderVisible: true,
    archiveName: primaryRomInput?.info.archiveName ?? (effectiveInputs.length ? "-" : ""),
    crc32: primaryRomInput?.info.crc32 || "",
    fileName:
      primaryRomInput?.info.fileName ||
      effectiveInputs.map((input, index) => getBinarySourceFileName(input, `Input ${index + 1}`)).join(", "),
    md5: primaryRomInput?.info.md5 || "",
    sha1: primaryRomInput?.info.sha1 || "",
    validationPhase: primaryRomInput?.info.validationPhase || "idle",
  },
  romInput: {
    disabled: disabled || busy || inputStaging,
    invalid: false,
    loading: inputStaging || romInputs.some((entry) => !!entry.progress),
    progress: primaryRomInput?.progress || null,
    valid: effectiveInputs.length > 0,
  },
  romInputs,
  sectionTimings,
});

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
        value: input.id,
      }));
    return {
      archiveFileName: patchInfo?.archiveName || "",
      archivePathEntries: patchInfo?.parentCompressions,
      canMoveDown: index < activePatches.length - 1 && !(busy || disabled),
      canMoveUp: index > 0 && !(busy || disabled),
      canRemove: !(busy || disabled),
      checksumTiming: patchInfo?.checksumTiming || "",
      decompressionTimeMs: patchInfo?.decompressionTimeMs,
      detailText: patchInfo?.targetLabel || "",
      fileName: patchInfo?.fileName || getBinarySourceFileName(patch, `Patch ${index + 1}`),
      fileSize: patchInfo?.size ?? patchInfo?.sourceSize ?? getBinarySourceSize(patch) ?? undefined,
      format: patchInfo?.format,
      index: index + 1,
      key,
      optionsDisabled: disabled || busy || patchStaging,
      ppfUndo: patchInfo?.ppfUndo,
      progress: patchProgressByKey[key] || null,
      showPpfUndo: patchInfo?.format === "PPF",
      sourceChecksumState: patchInfo?.sourceChecksumState || "",
      targetDisabled: disabled || busy || patchStaging || targetOptions.length < 2,
      targetOptions,
      targetValue: patchInfo?.targetInputId || (targetOptions.length === 1 ? targetOptions[0]?.value : ""),
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
    label: hasPendingDownload ? "Download output" : "Apply & download",
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

export { buildNoticeViewState, buildOutputViewState, buildStackViewState, buildUiViewState };
