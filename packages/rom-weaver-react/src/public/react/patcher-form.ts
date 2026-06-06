import type { ApplySettings } from "../../types/settings.ts";
import type { ApplyWorkflowResult, ProgressEvent } from "../../types/workflow-runtime.ts";
import type { PatcherOutputState, PatchStackItemState, PatchStackState } from "./patcher-presentation.ts";
import type {
  DialogEntry,
  NoticeState,
  PatcherSectionNoticeKey,
  PatcherUiState,
  StoreController,
} from "./patcher-ui-state.ts";

type ApplyPatchFormSettings = ApplySettings;
type BinarySource = File | FileSystemFileHandle;
type StartupState = {
  status: "loading" | "ready" | "error";
  message: string;
};

type PatcherUiController = StoreController<PatcherUiState> & {
  clearRomInput?: () => void;
  provideRomInputFile?: (file: BinarySource | null) => void;
  provideRomInputFiles?: (files: FileList | BinarySource[] | null) => void;
  removeRomInput?: (id: string) => void;
  toggleRomInputChecksums?: (id: string) => void;
  providePatchInputFiles?: (fileList: FileList | BinarySource[] | null) => void;
  setAlterHeader?: (checked: boolean) => void;
  setChdSplitBin?: (checked: boolean) => void;
  selectEmbeddedPatch?: (value: string) => void;
  setOptionalPatch?: (id: string, checked: boolean) => void;
  setChecksumOverride?: (checked: boolean) => void;
  setOutputChecksumOverride?: (checked: boolean) => void;
  dismissNotice?: (key: PatcherSectionNoticeKey) => void;
  downloadCue?: () => void;
};

type StackPatchItem = PatchStackItemState;

type PatcherStackController = StoreController<PatchStackState> & {
  moveItem: (index: number, direction: number) => void;
  removeItem: (index: number) => void;
  setPatchTarget?: (index: number, targetInputId: string) => void;
  setPatchOption?: (
    index: number,
    option: { ppfUndo?: boolean; validateInputChecksum?: string; validateOutputChecksum?: string },
  ) => void;
};

type PatcherOutputController = StoreController<PatcherOutputState> & {
  setDisplayFileName: (value: string) => void;
  setOutputCompression: (value: string) => void;
  /** Apply a per-job compression override (settings key → value) from the output Options panel. */
  setOutputCompressOption?: (key: string, value: string) => void;
  runPrimaryAction: () => void;
};

type NoticeController = StoreController<NoticeState> & {
  dismiss?: () => void;
};

type DialogController = StoreController<{ open: boolean; title: string; entries: DialogEntry[] }> & {
  selectEntry?: (entryId: string) => void;
};

type ApplyPatchFormControllers = {
  dialog?: DialogController;
  notice?: NoticeController;
  output?: PatcherOutputController;
  patchStack?: PatcherStackController;
  ui?: PatcherUiController;
};

type ApplyPatchFormProps = {
  assetBaseUrl?: string;
  inputs?: BinarySource[];
  patches?: BinarySource[];
  settings?: ApplyPatchFormSettings;
  defaultInputs?: BinarySource[];
  defaultPatches?: BinarySource[];
  defaultSettings?: ApplyPatchFormSettings;
  disabled?: boolean;
  workerThreads?: number | string;
  containerInputsEnabled?: boolean;
  compressionOptions?: string[];
  startup?: StartupState;
  controllers?: ApplyPatchFormControllers;
  onInputsChange?: (inputs: BinarySource[]) => void;
  onPatchesChange?: (patches: BinarySource[]) => void;
  onSettingsChange?: (settings: ApplyPatchFormSettings) => void;
  onProgress?: (event: ProgressEvent) => void;
  onApplyComplete?: (result: ApplyWorkflowResult) => void;
  onError?: (error: Error) => void;
};

export type {
  ApplyPatchFormControllers,
  ApplyPatchFormProps,
  ApplyPatchFormSettings,
  BinarySource,
  DialogController,
  NoticeController,
  PatcherOutputController,
  PatcherStackController,
  PatcherUiController,
  StackPatchItem,
  StartupState,
};
