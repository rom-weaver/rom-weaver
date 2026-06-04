import { createProgressViewModelFromEvent } from "../../presentation/workflow-presentation.ts";
import type { JsonValue } from "../../types/runtime.ts";

type StoreController<TState> = {
  subscribe: (listener: () => void) => () => void;
  getState: () => TState;
};

type DialogSelectionType = "rom" | "patch";

type DialogEntry = {
  id: string;
  label: string;
};

type DialogState = {
  open: boolean;
  title: string;
  entries: DialogEntry[];
  selectionType: DialogSelectionType;
};

type NoticeLevel = "error" | "warning";

type NoticeState = {
  message: string;
  level: NoticeLevel;
  visible: boolean;
};

type PatcherSectionNoticeKey = "inputNotice" | "patchNotice" | "checksumNotice" | "outputNotice";

type InputProgress = {
  label?: string;
  message?: string;
  percent?: number | null;
  visualPercent?: number | null;
  indeterminate?: boolean;
  [key: string]: JsonValue | undefined;
};

type InputProgressState = InputProgress | null;

type InputUiState = {
  disabled: boolean;
  loading: boolean;
  valid: boolean;
  invalid: boolean;
  progress: InputProgressState;
};

type RomInputInfoState = {
  archiveName: string;
  fileName: string;
  crc32: string;
  md5: string;
  sha1: string;
  romInfo: string;
  validationPhase: string;
  checksumsExpanded: boolean;
  checksumTiming: string;
};

type ArchivePathEntryState = {
  fileName: string;
  kind?: string;
  sourceSize?: number;
  outputSize?: number;
  decompressionTimeMs?: number;
};

type RomInputRowState = InputUiState & {
  id: string;
  order: number;
  groupId: string;
  kind: string;
  patchable?: boolean;
  info: RomInputInfoState;
  archivePathEntries?: ArchivePathEntryState[];
  size?: number;
  sourceSize?: number;
  splitBinAvailable?: boolean;
  decompressionTimeMs?: number;
  wasDecompressed?: boolean;
};

type EmbeddedPatchSelectOption = {
  value: string;
  label: string;
};

type EmbeddedPatchOptionState = {
  id?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  label?: string;
  description?: string;
  [key: string]: JsonValue | undefined;
};

type OptionalPatchItem = {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
};

type PatcherUiState = {
  checksumNotice: NoticeState;
  romInputs: RomInputRowState[];
  romInput: InputUiState;
  patchInput: InputUiState & {
    embeddedPatchLoadingMessage: string;
    embeddedPatchLoadingVisible: boolean;
    embeddedPatchOptions: EmbeddedPatchSelectOption[];
    embeddedPatchValue: string;
    embeddedPatchDisabled: boolean;
    embeddedPatchMode: "" | "single" | "multiple";
    optionalPatches: OptionalPatchItem[];
  };
  romInfo: {
    archiveName: string;
    fileName: string;
    crc32: string;
    md5: string;
    sha1: string;
    romInfo: string;
    validationPhase: string;
    alterHeaderVisible: boolean;
    alterHeaderLabel: string;
    alterHeaderChecked: boolean;
    alterHeaderDisabled: boolean;
  };
  patchDetails: {
    description: string;
    requirementsLabel: string;
    requirementsValue: string;
  };
  inputNotice: NoticeState;
  outputNotice: NoticeState;
  patchNotice: NoticeState;
  checksumOverride: {
    visible: boolean;
    checked: boolean;
    disabled: boolean;
    label: string;
  };
  chdSplitBin: {
    visible: boolean;
    checked: boolean;
    disabled: boolean;
    label: string;
  };
  outputChecksumWarning: {
    visible: boolean;
    message: string;
    checked: boolean;
    disabled: boolean;
    label: string;
  };
  cueDownload: {
    visible: boolean;
    disabled: boolean;
    title: string;
    label: string;
  };
  sectionTimings: {
    checksum: string;
    input: string;
    patch: string;
    output: string;
  };
};

type EmbeddedPatchUiState = {
  loadingMessage: string;
  loadingVisible: boolean;
  options: EmbeddedPatchSelectOption[];
  value: string;
  disabled: boolean;
  mode: "" | "single" | "multiple";
  optionalPatches: OptionalPatchItem[];
};

type PendingCueDownload = {
  fileName: string;
  text: string;
} | null;

type PatcherUiSessionState = PatcherUiState & Pick<DialogState, "open" | "title" | "entries"> & NoticeState;

const isRecord = (
  value: JsonValue | object | null | undefined,
): value is Record<string, JsonValue | object | undefined> => typeof value === "object" && value !== null;

const createEmptyPatcherSectionNotices = () => ({
  checksumNotice: createEmptyNoticeState(),
  inputNotice: createEmptyNoticeState(),
  outputNotice: createEmptyNoticeState(),
  patchNotice: createEmptyNoticeState(),
});

const createEmptyPatcherUiState = (): PatcherUiState => ({
  ...createEmptyPatcherSectionNotices(),
  chdSplitBin: {
    checked: false,
    disabled: true,
    label: "Split BIN tracks",
    visible: false,
  },
  checksumOverride: {
    checked: false,
    disabled: true,
    label: "Apply anyway despite checksum mismatch",
    visible: false,
  },
  cueDownload: {
    disabled: true,
    label: "Download CUE",
    title: "",
    visible: false,
  },
  outputChecksumWarning: {
    checked: false,
    disabled: true,
    label: "Continue anyway despite output checksum mismatch",
    message: "",
    visible: false,
  },
  patchDetails: {
    description: "",
    requirementsLabel: "ROM requirements",
    requirementsValue: "",
  },
  patchInput: {
    disabled: true,
    embeddedPatchDisabled: true,
    embeddedPatchLoadingMessage: "",
    embeddedPatchLoadingVisible: false,
    embeddedPatchMode: "",
    embeddedPatchOptions: [],
    embeddedPatchValue: "",
    invalid: false,
    loading: false,
    optionalPatches: [],
    progress: null,
    valid: false,
  },
  romInfo: {
    alterHeaderChecked: false,
    alterHeaderDisabled: true,
    alterHeaderLabel: "",
    alterHeaderVisible: false,
    archiveName: "",
    crc32: "",
    fileName: "",
    md5: "",
    romInfo: "",
    sha1: "",
    validationPhase: "idle",
  },
  romInput: {
    disabled: true,
    invalid: false,
    loading: false,
    progress: null,
    valid: false,
  },
  romInputs: [],
  sectionTimings: {
    checksum: "",
    input: "",
    output: "",
    patch: "",
  },
});

const createEmptyEmbeddedPatchUiState = (): EmbeddedPatchUiState => ({
  disabled: true,
  loadingMessage: "",
  loadingVisible: false,
  mode: "",
  optionalPatches: [],
  options: [],
  value: "",
});

const createInitialDialogState = (selectionType: DialogSelectionType = "rom"): DialogState => ({
  entries: [],
  open: false,
  selectionType,
  title: "",
});

const createEmptyDialogState = createInitialDialogState;

const createInitialNoticeState = (): NoticeState => ({
  level: "error",
  message: "",
  visible: false,
});

const createEmptyNoticeState = createInitialNoticeState;

const createInertPatcherUiSessionState = (): PatcherUiSessionState => ({
  ...createInitialNoticeState(),
  ...createInitialDialogState(),
  ...createEmptyPatcherUiState(),
});

const cloneInputProgressState = (progress: InputProgressState): InputProgressState =>
  progress ? { ...progress } : null;

const normalizeInputProgress = (progress: JsonValue | object | null | undefined): InputProgress | null => {
  if (!isRecord(progress)) return null;
  return createProgressViewModelFromEvent(progress, { stage: "input" });
};

const normalizeEmbeddedPatchOptions = (options: JsonValue | object | null | undefined): EmbeddedPatchSelectOption[] =>
  Array.isArray(options)
    ? options.map((option, index) => {
        const item = isRecord(option) ? option : {};
        return {
          label: typeof item.label === "string" ? item.label : "",
          value: typeof item.value === "string" ? item.value : String(index),
        };
      })
    : [];

const normalizeOptionalPatchItems = (patches: JsonValue | object | null | undefined): OptionalPatchItem[] =>
  Array.isArray(patches)
    ? patches.map((patch, index) => {
        const item = isRecord(patch) ? patch : {};
        return {
          checked: !!item.checked,
          description: typeof item.description === "string" ? item.description : "",
          disabled: !!item.disabled,
          id: typeof item.id === "string" ? item.id : String(index),
          label: typeof item.label === "string" ? item.label : "",
        };
      })
    : [];

const normalizeDialogEntries = (entries: JsonValue | object | null | undefined): DialogEntry[] =>
  Array.isArray(entries)
    ? entries.map((entry, index) => {
        const item = isRecord(entry) ? entry : {};
        return {
          id: typeof item.id === "string" ? item.id : String(index),
          label: typeof item.label === "string" ? item.label : "",
        };
      })
    : [];

const normalizeDialogState = (
  state: DialogState | Record<string, JsonValue | object | undefined> | null | undefined,
): DialogState => {
  const source = isRecord(state) ? state : {};
  return {
    entries: normalizeDialogEntries(source.entries),
    open: !!source.open,
    selectionType: source.selectionType === "patch" ? "patch" : "rom",
    title: typeof source.title === "string" ? source.title : "",
  };
};

const normalizeNoticeState = (
  state: NoticeState | Record<string, JsonValue | object | undefined> | null | undefined,
): NoticeState => {
  const source = isRecord(state) ? state : {};
  const message = typeof source.message === "string" ? source.message : "";
  return {
    level: source.level === "warning" ? "warning" : "error",
    message,
    visible: !!source.visible && message.length > 0,
  };
};

const normalizePatcherUiState = (
  state: PatcherUiState | Record<string, JsonValue | object | undefined> | null | undefined,
): PatcherUiState => {
  const nextState = isRecord(state) ? state : {};
  const romInput = isRecord(nextState.romInput) ? nextState.romInput : {};
  const romInputs = Array.isArray(nextState.romInputs) ? nextState.romInputs : [];
  const patchInput = isRecord(nextState.patchInput) ? nextState.patchInput : {};
  const romInfo = isRecord(nextState.romInfo) ? nextState.romInfo : {};
  const patchDetails = isRecord(nextState.patchDetails) ? nextState.patchDetails : {};
  const checksumOverride = isRecord(nextState.checksumOverride) ? nextState.checksumOverride : {};
  const chdSplitBin = isRecord(nextState.chdSplitBin) ? nextState.chdSplitBin : {};
  const outputChecksumWarning = isRecord(nextState.outputChecksumWarning) ? nextState.outputChecksumWarning : {};
  const cueDownload = isRecord(nextState.cueDownload) ? nextState.cueDownload : {};
  const sectionTimings = isRecord(nextState.sectionTimings) ? nextState.sectionTimings : {};
  const normalizeRomInputInfo = (
    info: JsonValue | object | null | undefined,
    fallbackChecksumTiming = "",
  ): RomInputInfoState => {
    const source = isRecord(info) ? info : {};
    return {
      archiveName: typeof source.archiveName === "string" ? source.archiveName : "",
      checksumsExpanded: source.checksumsExpanded !== false,
      checksumTiming: typeof source.checksumTiming === "string" ? source.checksumTiming : fallbackChecksumTiming,
      crc32: typeof source.crc32 === "string" ? source.crc32 : "",
      fileName: typeof source.fileName === "string" ? source.fileName : "",
      md5: typeof source.md5 === "string" ? source.md5 : "",
      romInfo: typeof source.romInfo === "string" ? source.romInfo : "",
      sha1: typeof source.sha1 === "string" ? source.sha1 : "",
      validationPhase: typeof source.validationPhase === "string" ? source.validationPhase : "idle",
    };
  };
  const normalizeRomInputRow = (
    row: JsonValue | object | null | undefined,
    index: number,
    fallback: { input: typeof romInput; info: typeof nextState.romInfo; checksumTiming: string } | null = null,
  ): RomInputRowState => {
    const source = isRecord(row) ? row : {};
    const rowInput = isRecord(source) ? source : {};
    const info = normalizeRomInputInfo(isRecord(source.info) ? source.info : source, fallback?.checksumTiming || "");
    const archivePathEntries = Array.isArray(rowInput.archivePathEntries)
      ? rowInput.archivePathEntries
          .map((entry) => (isRecord(entry) ? entry : {}))
          .map((entry) => ({
            decompressionTimeMs: typeof entry.decompressionTimeMs === "number" ? entry.decompressionTimeMs : undefined,
            fileName: typeof entry.fileName === "string" ? entry.fileName : "",
            outputSize: typeof entry.outputSize === "number" ? entry.outputSize : undefined,
            sourceSize: typeof entry.sourceSize === "number" ? entry.sourceSize : undefined,
          }))
          .filter((entry) => !!entry.fileName)
      : undefined;
    return {
      archivePathEntries,
      decompressionTimeMs: typeof rowInput.decompressionTimeMs === "number" ? rowInput.decompressionTimeMs : undefined,
      disabled: !!rowInput.disabled,
      groupId: typeof rowInput.groupId === "string" ? rowInput.groupId : "",
      id: typeof rowInput.id === "string" ? rowInput.id : `rom-input-${index + 1}`,
      info,
      invalid: !!rowInput.invalid,
      kind: typeof rowInput.kind === "string" ? rowInput.kind : "",
      loading: !!rowInput.loading,
      order: typeof rowInput.order === "number" ? rowInput.order : index,
      progress: normalizeInputProgress(rowInput.progress),
      size: typeof rowInput.size === "number" ? rowInput.size : undefined,
      sourceSize: typeof rowInput.sourceSize === "number" ? rowInput.sourceSize : undefined,
      splitBinAvailable: rowInput.splitBinAvailable === true,
      valid: !!rowInput.valid,
      wasDecompressed: rowInput.wasDecompressed === true,
    };
  };
  const normalizedRomInputs = romInputs.map((row, index) => normalizeRomInputRow(row, index));
  const shouldFallbackLegacyRomInput =
    !normalizedRomInputs.length &&
    (!!normalizeInputProgress(romInput.progress) ||
      !!romInput.loading ||
      !!romInput.valid ||
      !!romInput.invalid ||
      !!romInfo.fileName);
  const embeddedPatchModeSource = typeof patchInput.embeddedPatchMode === "string" ? patchInput.embeddedPatchMode : "";
  return {
    chdSplitBin: {
      checked: !!chdSplitBin.checked,
      disabled: !!chdSplitBin.disabled,
      label: typeof chdSplitBin.label === "string" ? chdSplitBin.label : "Split BIN tracks",
      visible: !!chdSplitBin.visible,
    },
    checksumNotice: normalizeNoticeState(isRecord(nextState.checksumNotice) ? nextState.checksumNotice : null),
    checksumOverride: {
      checked: !!checksumOverride.checked,
      disabled: !!checksumOverride.disabled,
      label:
        typeof checksumOverride.label === "string" ? checksumOverride.label : "Apply anyway despite checksum mismatch",
      visible: !!checksumOverride.visible,
    },
    cueDownload: {
      disabled: !!cueDownload.disabled,
      label: typeof cueDownload.label === "string" ? cueDownload.label : "Download CUE",
      title: typeof cueDownload.title === "string" ? cueDownload.title : "",
      visible: !!cueDownload.visible,
    },
    inputNotice: normalizeNoticeState(isRecord(nextState.inputNotice) ? nextState.inputNotice : null),
    outputChecksumWarning: {
      checked: !!outputChecksumWarning.checked,
      disabled: !!outputChecksumWarning.disabled,
      label:
        typeof outputChecksumWarning.label === "string"
          ? outputChecksumWarning.label
          : "Continue anyway despite output checksum mismatch",
      message: typeof outputChecksumWarning.message === "string" ? outputChecksumWarning.message : "",
      visible: !!outputChecksumWarning.visible,
    },
    outputNotice: normalizeNoticeState(isRecord(nextState.outputNotice) ? nextState.outputNotice : null),
    patchDetails: {
      description: typeof patchDetails.description === "string" ? patchDetails.description : "",
      requirementsLabel:
        typeof patchDetails.requirementsLabel === "string" ? patchDetails.requirementsLabel : "ROM requirements",
      requirementsValue: typeof patchDetails.requirementsValue === "string" ? patchDetails.requirementsValue : "",
    },
    patchInput: {
      disabled: !!patchInput.disabled,
      embeddedPatchDisabled: !!patchInput.embeddedPatchDisabled,
      embeddedPatchLoadingMessage:
        typeof patchInput.embeddedPatchLoadingMessage === "string" ? patchInput.embeddedPatchLoadingMessage : "",
      embeddedPatchLoadingVisible: !!patchInput.embeddedPatchLoadingVisible,
      embeddedPatchMode:
        embeddedPatchModeSource === "multiple"
          ? "multiple"
          : (() => {
              if (embeddedPatchModeSource === "single") {
                return "single";
              }
              return "";
            })(),
      embeddedPatchOptions: normalizeEmbeddedPatchOptions(patchInput.embeddedPatchOptions),
      embeddedPatchValue: typeof patchInput.embeddedPatchValue === "string" ? patchInput.embeddedPatchValue : "",
      invalid: !!patchInput.invalid,
      loading: !!patchInput.loading,
      optionalPatches: normalizeOptionalPatchItems(patchInput.optionalPatches),
      progress: normalizeInputProgress(patchInput.progress),
      valid: !!patchInput.valid,
    },
    patchNotice: normalizeNoticeState(isRecord(nextState.patchNotice) ? nextState.patchNotice : null),
    romInfo: {
      alterHeaderChecked: !!romInfo.alterHeaderChecked,
      alterHeaderDisabled: !!romInfo.alterHeaderDisabled,
      alterHeaderLabel: typeof romInfo.alterHeaderLabel === "string" ? romInfo.alterHeaderLabel : "",
      alterHeaderVisible: !!romInfo.alterHeaderVisible,
      archiveName: typeof romInfo.archiveName === "string" ? romInfo.archiveName : "",
      crc32: typeof romInfo.crc32 === "string" ? romInfo.crc32 : "",
      fileName: typeof romInfo.fileName === "string" ? romInfo.fileName : "",
      md5: typeof romInfo.md5 === "string" ? romInfo.md5 : "",
      romInfo: typeof romInfo.romInfo === "string" ? romInfo.romInfo : "",
      sha1: typeof romInfo.sha1 === "string" ? romInfo.sha1 : "",
      validationPhase: typeof romInfo.validationPhase === "string" ? romInfo.validationPhase : "idle",
    },
    romInput: {
      disabled: !!romInput.disabled,
      invalid: !!romInput.invalid,
      loading: !!romInput.loading,
      progress: normalizeInputProgress(romInput.progress),
      valid: !!romInput.valid,
    },
    romInputs: shouldFallbackLegacyRomInput
      ? [
          normalizeRomInputRow({ ...romInput, id: "input", info: romInfo }, 0, {
            checksumTiming: typeof sectionTimings.checksum === "string" ? sectionTimings.checksum : "",
            info: romInfo,
            input: romInput,
          }),
        ]
      : normalizedRomInputs,
    sectionTimings: {
      checksum: typeof sectionTimings.checksum === "string" ? sectionTimings.checksum : "",
      input: typeof sectionTimings.input === "string" ? sectionTimings.input : "",
      output: typeof sectionTimings.output === "string" ? sectionTimings.output : "",
      patch: typeof sectionTimings.patch === "string" ? sectionTimings.patch : "",
    },
  };
};

const clonePatcherUiState = ({
  patcherUiState,
  embeddedPatchUiState,
  pendingCueDownload,
  translate,
}: {
  patcherUiState: PatcherUiState;
  embeddedPatchUiState: EmbeddedPatchUiState;
  pendingCueDownload: PendingCueDownload;
  translate: (value: string) => string;
}) => ({
  chdSplitBin: {
    ...patcherUiState.chdSplitBin,
    label: translate("Split BIN tracks"),
  },
  checksumNotice: { ...patcherUiState.checksumNotice },
  checksumOverride: {
    ...patcherUiState.checksumOverride,
    label: translate("Apply anyway despite checksum mismatch"),
  },
  cueDownload: {
    ...patcherUiState.cueDownload,
    label: translate("Download CUE"),
    title: pendingCueDownload?.fileName || "",
    visible: !!pendingCueDownload,
  },
  inputNotice: { ...patcherUiState.inputNotice },
  outputChecksumWarning: {
    ...patcherUiState.outputChecksumWarning,
    label: translate("Continue anyway despite output checksum mismatch"),
  },
  outputNotice: { ...patcherUiState.outputNotice },
  patchDetails: { ...patcherUiState.patchDetails },
  patchInput: {
    ...patcherUiState.patchInput,
    embeddedPatchDisabled: !!embeddedPatchUiState.disabled,
    embeddedPatchLoadingMessage: embeddedPatchUiState.loadingMessage || "",
    embeddedPatchLoadingVisible: !!embeddedPatchUiState.loadingVisible,
    embeddedPatchMode: embeddedPatchUiState.mode || "",
    embeddedPatchOptions: embeddedPatchUiState.options.map((option) => ({ ...option })),
    embeddedPatchValue: embeddedPatchUiState.value || "",
    optionalPatches: embeddedPatchUiState.optionalPatches.map((patch) => ({ ...patch })),
    progress: cloneInputProgressState(patcherUiState.patchInput.progress),
  },
  patchNotice: { ...patcherUiState.patchNotice },
  romInfo: { ...patcherUiState.romInfo },
  romInput: {
    ...patcherUiState.romInput,
    progress: cloneInputProgressState(patcherUiState.romInput.progress),
  },
  romInputs: patcherUiState.romInputs.map((entry) => ({
    ...entry,
    archivePathEntries: entry.archivePathEntries?.map((pathEntry) => ({ ...pathEntry })),
    info: { ...entry.info },
    progress: cloneInputProgressState(entry.progress),
  })),
  sectionTimings: { ...patcherUiState.sectionTimings },
});

export type {
  DialogEntry,
  DialogState,
  EmbeddedPatchOptionState,
  EmbeddedPatchUiState,
  InputProgress,
  InputProgressState,
  InputUiState,
  NoticeState,
  PatcherSectionNoticeKey,
  PatcherUiSessionState,
  PatcherUiState,
  PendingCueDownload,
  RomInputInfoState,
  RomInputRowState,
  StoreController,
};
export {
  clonePatcherUiState,
  createEmptyDialogState,
  createEmptyEmbeddedPatchUiState,
  createEmptyNoticeState,
  createEmptyPatcherSectionNotices,
  createEmptyPatcherUiState,
  createInertPatcherUiSessionState,
  createInitialDialogState,
  createInitialNoticeState,
  normalizeDialogState,
  normalizeNoticeState,
  normalizePatcherUiState,
};
