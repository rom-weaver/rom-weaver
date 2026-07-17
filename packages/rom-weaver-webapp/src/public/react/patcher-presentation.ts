import {
  CREATE_ARCHIVE_COMPRESSION_FORMATS,
  CREATE_ROM_SPECIFIC_COMPRESSION_FORMATS,
  getCompressionFormatRegistration,
} from "../../lib/compression/container-format-registry.ts";
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

type PatchTargetOption = {
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
  /** Combined wall time for every completed action (apply + compress). */
  totalTiming: string;
  downloadSummary: {
    format?: string;
    /** Input/source size - the "from" half of the from → to readout. */
    fromSize?: string;
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
  /** ROM copier-header handling on the patched output (output card "ROM header" select). */
  outputHeader?: "auto" | "keep" | "strip";
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
  decompressionTimeMs?: number;
  archiveFileName: string;
  archivePathEntries?: ArchivePathEntry[];
  detailText?: string;
  progress?: InputProgressState;
  checksumTiming?: string;
  validationState: string;
  /** Source-checksum preflight verdict ("valid"/"invalid"/"pending"/"unknown"); drives ROM verification color. */
  sourceChecksumState: string;
  validationLabel: string;
  validationValues: string[];
  validationMessage: string;
  validationActualValue: string;
  targetDisabled?: boolean;
  targetOptions?: PatchTargetOption[];
  targetValue?: string;
  /** Detected patch format (e.g. "PPF", "IPS"); drives format-specific options. */
  format?: string;
  /** Whether the header choice should be shown (the target ROM has a strippable header). */
  showHeaderOption?: boolean;
  /** Current header pin; `undefined` means Auto (the checksum-driven decision). */
  headerChoice?: "keep" | "strip";
  /** Detected copier-header size in bytes, for the header option label. */
  headerStrippedBytes?: number;
  /** What Auto resolves to when it decided (checksum-proven), for the Auto label. */
  headerAutoMode?: "keep" | "strip";
  /** Whether the checksum preflight proved the Auto mode (vs the ambiguous keep default). */
  headerAutoDecided?: boolean;
  /** User-pasted checksum (raw hex) used to validate the target input before apply. */
  validateInputChecksum?: string;
  /** User-pasted checksum (raw hex) used to validate the patched output after apply. */
  validateOutputChecksum?: string;
  /** Disables the Options inputs while the patch stack is busy/staging. */
  optionsDisabled?: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  canRemove: boolean;
};

type PatchStackState = {
  items: PatchStackItemState[];
};

const DEFAULT_OUTPUT_OPTIONS: OutputOption[] = [
  ...CREATE_ARCHIVE_COMPRESSION_FORMATS,
  ...CREATE_ROM_SPECIFIC_COMPRESSION_FORMATS,
  "none",
].map((format) => ({
  label: getCompressionFormatRegistration(format)?.label || format,
  value: format,
}));

const cloneOutputOptions = (options: OutputOption[]) => options.map((option) => ({ ...option }));

const createEmptyPatcherOutputState = ({
  applyButtonLabel = "Weave & Download",
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
  totalTiming: "",
});

export type { PatcherOutputState, PatchStackItemState, PatchStackState };
export { createEmptyPatcherOutputState, createOutputSizeSummary };
