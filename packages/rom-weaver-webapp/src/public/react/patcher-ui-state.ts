import { createProgressViewModelFromEvent } from "../../presentation/workflow-presentation.ts";
import type { ChecksumRomProbe, ChecksumVariant, RomTypeTag } from "../../types/checksum.ts";
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
  dismissible?: boolean;
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
  checksumVariants?: ChecksumVariant[];
  romInfo: string;
  romProbe?: ChecksumRomProbe;
  romType?: RomTypeTag;
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
  chdMode?: string;
  splitBinAvailable?: boolean;
  cueText?: string;
  gdiText?: string;
  decompressionTimeMs?: number;
  wasDecompressed?: boolean;
};

type EmbeddedPatchSelectOption = {
  value: string;
  label: string;
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
    checksumVariants?: ChecksumVariant[];
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
  outputChecksumWarning: {
    visible: boolean;
    message: string;
    checked: boolean;
    disabled: boolean;
    label: string;
  };
  sectionTimings: {
    checksum: string;
    input: string;
    patch: string;
    output: string;
  };
};

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
  checksumOverride: {
    checked: false,
    disabled: true,
    label: "Weave anyway despite patch & ROM check mismatch",
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
    checksumVariants: undefined,
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

const createInitialDialogState = (selectionType: DialogSelectionType = "rom"): DialogState => ({
  entries: [],
  open: false,
  selectionType,
  title: "",
});

const createInitialNoticeState = (): NoticeState => ({
  dismissible: false,
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
    dismissible: source.dismissible === true,
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
  const outputChecksumWarning = isRecord(nextState.outputChecksumWarning) ? nextState.outputChecksumWarning : {};
  const sectionTimings = isRecord(nextState.sectionTimings) ? nextState.sectionTimings : {};
  const normalizeRomInputInfo = (
    info: JsonValue | object | null | undefined,
    fallbackChecksumTiming = "",
  ): RomInputInfoState => {
    const source = isRecord(info) ? info : {};
    const romProbe = isRecord(source.romProbe) ? source.romProbe : {};
    const trim = isRecord(romProbe.trim) ? romProbe.trim : {};
    const checksumVariants = Array.isArray(source.checksumVariants)
      ? source.checksumVariants.filter(
          (entry): entry is ChecksumVariant => isRecord(entry) && typeof entry.id === "string",
        )
      : undefined;
    return {
      archiveName: typeof source.archiveName === "string" ? source.archiveName : "",
      checksumsExpanded: source.checksumsExpanded !== false,
      checksumTiming: typeof source.checksumTiming === "string" ? source.checksumTiming : fallbackChecksumTiming,
      checksumVariants,
      crc32: typeof source.crc32 === "string" ? source.crc32 : "",
      fileName: typeof source.fileName === "string" ? source.fileName : "",
      md5: typeof source.md5 === "string" ? source.md5 : "",
      romInfo: typeof source.romInfo === "string" ? source.romInfo : "",
      romProbe: isRecord(source.romProbe)
        ? {
            trim: {
              detected: trim.detected === true,
              mode: typeof trim.mode === "string" ? trim.mode : undefined,
              preservedDownloadPlayCert:
                typeof trim.preservedDownloadPlayCert === "boolean" ? trim.preservedDownloadPlayCert : undefined,
              trimmedInputBytes: typeof trim.trimmedInputBytes === "number" ? trim.trimmedInputBytes : undefined,
            },
          }
        : undefined,
      romType: isRecord(source.romType)
        ? {
            discFormat: typeof source.romType.discFormat === "string" ? source.romType.discFormat : undefined,
            platform: typeof source.romType.platform === "string" ? source.romType.platform : undefined,
            recommendedFormat:
              typeof source.romType.recommendedFormat === "string" ? source.romType.recommendedFormat : undefined,
          }
        : undefined,
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
      chdMode: typeof rowInput.chdMode === "string" ? rowInput.chdMode : undefined,
      cueText: typeof rowInput.cueText === "string" ? rowInput.cueText : undefined,
      decompressionTimeMs: typeof rowInput.decompressionTimeMs === "number" ? rowInput.decompressionTimeMs : undefined,
      disabled: !!rowInput.disabled,
      gdiText: typeof rowInput.gdiText === "string" ? rowInput.gdiText : undefined,
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
  const shouldUseSingleRomInputFallback =
    !normalizedRomInputs.length &&
    (!!normalizeInputProgress(romInput.progress) ||
      !!romInput.loading ||
      !!romInput.valid ||
      !!romInput.invalid ||
      !!romInfo.fileName);
  const embeddedPatchModeSource = typeof patchInput.embeddedPatchMode === "string" ? patchInput.embeddedPatchMode : "";
  return {
    checksumNotice: normalizeNoticeState(isRecord(nextState.checksumNotice) ? nextState.checksumNotice : null),
    checksumOverride: {
      checked: !!checksumOverride.checked,
      disabled: !!checksumOverride.disabled,
      label:
        typeof checksumOverride.label === "string"
          ? checksumOverride.label
          : "Weave anyway despite patch & ROM check mismatch",
      visible: !!checksumOverride.visible,
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
      checksumVariants: Array.isArray(romInfo.checksumVariants)
        ? romInfo.checksumVariants.filter(
            (entry): entry is ChecksumVariant => isRecord(entry) && typeof entry.id === "string",
          )
        : undefined,
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
    romInputs: shouldUseSingleRomInputFallback
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

export type {
  DialogEntry,
  InputProgress,
  InputProgressState,
  NoticeState,
  PatcherSectionNoticeKey,
  PatcherUiSessionState,
  PatcherUiState,
  RomInputRowState,
  StoreController,
};
export {
  createEmptyPatcherUiState,
  createInertPatcherUiSessionState,
  createInitialDialogState,
  normalizeDialogState,
  normalizeNoticeState,
  normalizePatcherUiState,
};
