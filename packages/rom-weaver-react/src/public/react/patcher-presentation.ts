import {
  createOutputSizeSummary,
  type OutputSizeSummaryViewModel,
  type ProgressViewModel,
} from "../../presentation/workflow-presentation.ts";
import type { CompressPanelModel } from "./compress-options.ts";
import type { InputProgressState } from "./patcher-ui-state.ts";

type OutputOption = {
  value: string;
  label: string;
};

type OutputApplyButtonState = {
  label: string;
  title: string;
  disabled: boolean;
  loading: boolean;
  progress: ProgressViewModel | null;
};

type PatcherOutputState = {
  displayFileName: string;
  resolvedOutputName: string;
  compressionFormat: string;
  applyTiming: string;
  compressTiming: string;
  downloadSummary: {
    format?: string;
    size?: string;
    ratio?: string;
  } | null;
  /** Editable compress panel (codec/level/codec-lists) for the selected format, or null when uncompressed. */
  compress?: CompressPanelModel | null;
  pendingDownloadFileName: string | null;
  sizeSummary: OutputSizeSummaryViewModel;
  disabled: boolean;
  applyButton: OutputApplyButtonState;
  options: OutputOption[];
};

type ArchivePathEntry = {
  fileName: string;
  sourceSize?: number;
  outputSize?: number;
  decompressionTimeMs?: number;
};

type PatchStackItemState = {
  key?: string;
  index: number;
  fileName: string;
  fileSize?: number;
  archiveFileName: string;
  archivePathEntries?: ArchivePathEntry[];
  detailText?: string;
  progress?: InputProgressState;
  checksumTiming?: string;
  validationState: string;
  validationLabel: string;
  validationValues: string[];
  validationMessage: string;
  validationActualValue: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canRemove: boolean;
};

type PatchStackState = {
  items: PatchStackItemState[];
};

const DEFAULT_OUTPUT_OPTIONS: OutputOption[] = [
  { label: "7z", value: "7z" },
  { label: "CHD", value: "chd" },
  { label: "RVZ", value: "rvz" },
  { label: "Z3DS", value: "z3ds" },
  { label: "ZIP", value: "zip" },
  { label: "None", value: "none" },
];

const cloneOutputOptions = (options: OutputOption[]) => options.map((option) => ({ ...option }));

const createEmptyPatcherOutputState = ({
  applyButtonLabel = "Apply & Download",
  options = DEFAULT_OUTPUT_OPTIONS,
}: {
  applyButtonLabel?: string;
  options?: OutputOption[];
} = {}): PatcherOutputState => ({
  applyButton: {
    disabled: true,
    label: applyButtonLabel,
    loading: false,
    progress: null,
    title: "",
  },
  applyTiming: "",
  compressionFormat: "zip",
  compressTiming: "",
  disabled: true,
  displayFileName: "",
  downloadSummary: null,
  options: cloneOutputOptions(options),
  pendingDownloadFileName: null,
  resolvedOutputName: "",
  sizeSummary: createOutputSizeSummary(),
});

const createEmptyPatchStackState = (): PatchStackState => ({
  items: [],
});

export type {
  ArchivePathEntry,
  OutputApplyButtonState,
  OutputOption,
  PatcherOutputState,
  PatchStackItemState,
  PatchStackState,
};
export {
  cloneOutputOptions,
  createEmptyPatcherOutputState,
  createEmptyPatchStackState,
  createOutputSizeSummary,
  DEFAULT_OUTPUT_OPTIONS,
};
