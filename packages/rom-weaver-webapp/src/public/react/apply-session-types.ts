import type { ChecksumVariant } from "../../types/checksum.ts";
import type { CompressionFormat } from "../../types/settings.ts";
import type { ApplyWorkflowResult, ProgressEvent } from "../../types/workflow-runtime-types.ts";
import type { ApplyPatchFormProps, ApplyPatchFormSettings, BinarySource } from "./patcher-form.ts";
import type { createOutputSizeSummary } from "./patcher-presentation.ts";
import type { InputProgress, RomInputRowState } from "./patcher-ui-state.ts";

type ArchivePathEntry = {
  fileName: string;
  kind?: string;
  sourceSize?: number;
  outputSize?: number;
  decompressionTimeMs?: number;
};

type StagedInputInfo = {
  id?: string;
  order?: number;
  groupId?: string;
  kind?: string;
  archiveName?: string;
  parentCompressions?: ArchivePathEntry[];
  patchable?: boolean;
  targetInputId?: string;
  targetInputFileName?: string;
  targetLabel?: string;
  checksums?: Record<string, string>;
  checksumVariants?: ChecksumVariant[];
  checksumTiming?: string;
  romProbe?: RomInputRowState["info"]["romProbe"];
  romType?: RomInputRowState["info"]["romType"];
  /** Rust's probe-manifest verdict (`is_rom`): false marks an archive that holds only patches, so the
   * unified drop can reclassify it from the ROM bucket to the patch bucket. Undefined for inputs that
   * never produce a probe manifest (bare ROMs). */
  isRom?: boolean;
  decompressionTimeMs?: number;
  fileName?: string;
  size?: number;
  sourceSize?: number;
  chdMode?: string;
  splitBinAvailable?: boolean;
  cueText?: string;
  gdiText?: string;
  wasDecompressed?: boolean;
  validationActualValue?: string;
  validationLabel?: string;
  validationMessage?: string;
  validationState?: string;
  validationValues?: string[];
  checksumPreflightMismatch?: boolean;
  sourceChecksumState?: string;
  format?: string;
  validateInputChecksum?: string;
  validateOutputChecksum?: string;
  /** User header pin from the Checks drawer (`undefined` = Auto). */
  headerChoice?: "keep" | "strip";
  /** Detected copier-header size in bytes, for labeling the header option. */
  headerStrippedBytes?: number;
  /** What Auto resolves to when it decided (checksum-proven), for the Auto label. */
  headerAutoMode?: "keep" | "strip";
  /** Whether the checksum preflight proved the Auto mode (vs the ambiguous keep default). */
  headerAutoDecided?: boolean;
  /** Show the header choice: the target ROM has a strippable header. */
  showHeaderOption?: boolean;
};

type ApplyWorkflowStageSnapshot = {
  inputs: BinarySource[];
  patches: BinarySource[];
  options: ApplyPatchFormSettings & {
    output: NonNullable<ApplyPatchFormSettings["output"]> & {
      compression: "auto" | CompressionFormat;
    };
    workerThreads?: number | string;
    containerInputsEnabled?: boolean;
  };
};

type ApplyExecutionTimingTracker = {
  applyStartedAt: number | null;
  compressionStartedAt: number | null;
};

type LocalPatcherSessionState = {
  busy: boolean;
  completedApplyTimeMs: number | null;
  completedCompressionTimeMs: number | null;
  completedSizeSummary: ReturnType<typeof createOutputSizeSummary>;
  failureMessage: string;
  inputStaging: boolean;
  outputErrorMessage: string;
  outputName: string;
  outputNameEdited: boolean;
  patchInfoByKey: Record<string, StagedInputInfo>;
  patchProgress: InputProgress | null;
  patchProgressByKey: Record<string, InputProgress>;
  patchStaging: boolean;
  pendingDownloadFileName: string | null;
  progress: InputProgress | null;
  romInputs: RomInputRowState[];
};

type LocalPatcherSessionStatePatch =
  | Partial<LocalPatcherSessionState>
  | ((state: LocalPatcherSessionState) => Partial<LocalPatcherSessionState>);

type LocalApplyPatchFormSessionOptions = Pick<
  ApplyPatchFormProps,
  | "inputs"
  | "patches"
  | "settings"
  | "defaultInputs"
  | "defaultPatches"
  | "defaultSettings"
  | "disabled"
  | "workerThreads"
  | "containerInputsEnabled"
  | "compressionOptions"
  | "onInputsChange"
  | "onPatchesChange"
  | "onSettingsChange"
  | "onProgress"
  | "onApplyComplete"
  | "onError"
> & {
  applyPatches: (input: {
    inputs: BinarySource[];
    patches: BinarySource[];
    /** Index-aligned per-patch run options (header/PPF-undo/checks) replayed onto re-staged runs. */
    patchOptions?: Array<{
      header?: "keep" | "strip";
      ppfUndo?: boolean;
      validateInputChecksum?: string;
      validateOutputChecksum?: string;
    }>;
    options: ApplyPatchFormSettings & {
      output: NonNullable<ApplyPatchFormSettings["output"]> & {
        compression: "auto" | CompressionFormat;
      };
      signal?: AbortSignal;
      workerThreads?: number | string;
      containerInputsEnabled?: boolean;
      onProgress: (event: ProgressEvent) => void;
    };
  }) => Promise<ApplyWorkflowResult>;
  downloadOutput: (
    result: ApplyWorkflowResult,
    fileName?: string,
    options?: { interactive?: boolean },
  ) => void | Promise<void>;
  applyReady?: boolean;
  resolvedOutputCompression?: CompressionFormat;
  resolvedOutputName?: string;
  resolvedOutputNameKey?: string;
  disabledPatchIds?: ReadonlySet<string>;
  stageInput?: (
    input: ApplyWorkflowStageSnapshot,
    handlers: {
      onChecksum: (info: StagedInputInfo) => void;
      onImplicitPatches?: (patches: BinarySource[], infos?: Array<StagedInputInfo | null | undefined>) => void;
      onProgress: (event: ProgressEvent) => void;
      onState: (info: StagedInputInfo) => void;
    },
  ) => Promise<StagedInputInfo[]>;
  stagePatches?: (
    input: ApplyWorkflowStageSnapshot,
    handlers: {
      onImplicitPatches?: (patches: BinarySource[], infos: Array<StagedInputInfo | null | undefined>) => void;
      /** Fires the moment a patch finishes its eager parse (before the ROM finishes staging) so the
       * card can show the parsed info immediately instead of holding its "Reading…" state. */
      onPatchStaged?: (info: StagedInputInfo | null | undefined, order: number) => void;
      onProgress: (event: ProgressEvent) => void;
    },
  ) => Promise<Array<StagedInputInfo | null | undefined>>;
  /** Run the deferred deep dry-run patch validation (it runs silently after the patch cards already
   * show their info + cheap preflight verdict) and resolve with the refreshed patch infos carrying
   * the validation result. */
  validatePatches?: (
    input: ApplyWorkflowStageSnapshot,
    onVerifying?: (infos: Array<StagedInputInfo | null | undefined>) => void,
  ) => Promise<Array<StagedInputInfo | null | undefined>>;
  setPatchTarget?: (
    input: ApplyWorkflowStageSnapshot,
    patchIndex: number,
    targetInputId: string,
  ) => Promise<Array<StagedInputInfo | null | undefined>>;
  setPatchOption?: (
    input: ApplyWorkflowStageSnapshot,
    patchIndex: number,
    option: {
      validateInputChecksum?: string;
      validateOutputChecksum?: string;
      header?: "keep" | "strip";
      /** A user edit: rerun the deep validation so the card verdict reflects the change. */
      revalidate?: boolean;
    },
  ) => Promise<Array<StagedInputInfo | null | undefined>>;
};

export type {
  ApplyExecutionTimingTracker,
  ApplyWorkflowStageSnapshot,
  ArchivePathEntry,
  LocalApplyPatchFormSessionOptions,
  LocalPatcherSessionState,
  LocalPatcherSessionStatePatch,
  StagedInputInfo,
};
