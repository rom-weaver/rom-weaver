import type { ChecksumVariant } from "../../types/checksum.ts";
import type { CompressionFormat } from "../../types/settings.ts";
import type { ApplyWorkflowResult, ProgressEvent } from "../../types/workflow-runtime.ts";
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
  ppfUndo?: boolean;
  validateInputChecksum?: string;
  validateOutputChecksum?: string;
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
  downloadOutput: (result: ApplyWorkflowResult, fileName?: string) => void | Promise<void>;
  applyReady?: boolean;
  resolvedOutputCompression?: CompressionFormat;
  resolvedOutputName?: string;
  resolvedOutputNameKey?: string;
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
      onProgress: (event: ProgressEvent) => void;
    },
  ) => Promise<Array<StagedInputInfo | null | undefined>>;
  setPatchTarget?: (
    input: ApplyWorkflowStageSnapshot,
    patchIndex: number,
    targetInputId: string,
  ) => Promise<Array<StagedInputInfo | null | undefined>>;
  setPatchOption?: (
    input: ApplyWorkflowStageSnapshot,
    patchIndex: number,
    option: { ppfUndo?: boolean; validateInputChecksum?: string; validateOutputChecksum?: string },
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
