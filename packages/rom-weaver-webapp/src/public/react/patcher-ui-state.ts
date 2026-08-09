import type { ChecksumRomProbe, ChecksumVariant, ChecksumVariantPlanEntry, RomTypeTag } from "../../types/checksum.ts";
import type { JsonValue } from "../../types/runtime.ts";

type StoreController<TState> = {
  subscribe: (listener: () => void) => () => void;
  getState: () => TState;
};

type NoticeLevel = "error" | "warning";

type NoticeState = {
  message: string;
  /** Machine error code behind the message, rendered as a small copyable tag. */
  code?: string;
  level: NoticeLevel;
  visible: boolean;
  dismissible?: boolean;
};

type PatcherSectionNoticeKey = "inputNotice" | "patchNotice" | "outputNotice";

type InputProgress = {
  label?: string;
  message?: string;
  percent?: number | null;
  visualPercent?: number | null;
  indeterminate?: boolean;
  [key: string]: JsonValue | undefined;
};

type InputProgressState = InputProgress | null;

type RomInputInfoState = {
  archiveName: string;
  fileName: string;
  crc32: string;
  md5: string;
  sha1: string;
  checksumVariants?: ChecksumVariant[];
  /** Early variant reservation from Rust's `probe-variant-plan`, present during staging before the
   * checksums land, so the checks skeleton can reserve one group per eventual variant. */
  checksumVariantPlan?: ChecksumVariantPlanEntry[];
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

type RomInputRowState = {
  id: string;
  order: number;
  groupId: string;
  kind: string;
  loading: boolean;
  progress: InputProgressState;
  patchable?: boolean;
  info: RomInputInfoState;
  archivePathEntries?: ArchivePathEntryState[];
  size?: number;
  sourceSize?: number;
  chdMode?: string;
  cueText?: string;
  gdiText?: string;
  decompressionTimeMs?: number;
};

type PatcherUiState = {
  romInputs: RomInputRowState[];
  patchInput: { loading: boolean };
  inputNotice: NoticeState;
  outputNotice: NoticeState;
  patchNotice: NoticeState;
  checksumOverride: {
    visible: boolean;
    checked: boolean;
    disabled: boolean;
    label: string;
  };
};

const createEmptyPatcherSectionNotices = () => ({
  inputNotice: createEmptyNoticeState(),
  outputNotice: createEmptyNoticeState(),
  patchNotice: createEmptyNoticeState(),
});

const createEmptyPatcherUiState = (): PatcherUiState => ({
  ...createEmptyPatcherSectionNotices(),
  checksumOverride: {
    checked: false,
    disabled: true,
    label: "Apply anyway despite patch & ROM check mismatch",
    visible: false,
  },
  patchInput: {
    loading: false,
  },
  romInputs: [],
});

const createEmptyNoticeState = (): NoticeState => ({
  dismissible: false,
  level: "error",
  message: "",
  visible: false,
});

export type {
  InputProgress,
  InputProgressState,
  NoticeState,
  PatcherSectionNoticeKey,
  PatcherUiState,
  RomInputRowState,
  StoreController,
};
export { createEmptyPatcherUiState };
