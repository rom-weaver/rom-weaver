import type { BundleApplySession } from "../../lib/bundle/bundle-session-model.ts";
import type { ParsedBundleCreateResult } from "../../types/bundle.ts";
import type { ApplySettings } from "../../types/settings.ts";
import type { ApplyWorkflowResult, ProgressEvent } from "../../types/workflow-runtime-types.ts";
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
type PageFileDrop = {
  files: File[];
  id: number;
};
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
  selectEmbeddedPatch?: (value: string) => void;
  setOptionalPatch?: (id: string, checked: boolean) => void;
  setChecksumOverride?: (checked: boolean) => void;
  setOutputChecksumOverride?: (checked: boolean) => void;
  dismissNotice?: (key: PatcherSectionNoticeKey) => void;
};

type StackPatchItem = PatchStackItemState;

type PatcherStackController = StoreController<PatchStackState> & {
  reorder: (from: number, to: number) => void;
  removeItem: (index: number) => void;
  replaceItem: (index: number, source: BinarySource) => void;
  setPatchTarget?: (index: number, targetInputId: string) => void;
  setPatchOption?: (
    index: number,
    option: {
      validateInputChecksum?: string;
      validateOutputChecksum?: string;
      header?: "keep" | "strip";
      n64ByteOrder?: "keep" | "big-endian" | "little-endian" | "byte-swapped";
      /** A user edit: rerun the deep validation so the card verdict reflects the change. */
      revalidate?: boolean;
    },
  ) => void;
};

type PatcherOutputController = StoreController<PatcherOutputState> & {
  cancelPrimaryAction?: () => void;
  setDisplayFileName: (value: string) => void;
  setOutputCompression: (value: string) => void;
  /** ROM copier-header handling on the patched output (auto|keep|strip). */
  setOutputHeader?: (value: "auto" | "keep" | "strip") => void;
  /** Apply a per-job compression override (settings key → value) from the output Options panel. */
  setOutputCompressOption?: (key: string, value: string, updates?: Record<string, string>) => void;
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
  pageDrop?: PageFileDrop | null;
  disabled?: boolean;
  workerThreads?: number | string;
  containerInputsEnabled?: boolean;
  compressionOptions?: string[];
  startup?: StartupState;
  controllers?: ApplyPatchFormControllers;
  /** A `?bundle=` boot session: seeds enablement/output defaults once its files land. */
  bundleSession?: BundleApplySession | null;
  onInputsChange?: (inputs: BinarySource[]) => void;
  onPatchesChange?: (patches: BinarySource[]) => void;
  onSettingsChange?: (settings: ApplyPatchFormSettings) => void;
  /** Fires when the output-card bundle dropdown changes, to persist the "Bundle" setting ("" hides it). */
  onBundlePackageChange?: (value: string) => void;
  onProgress?: (event: ProgressEvent) => void;
  onApplyComplete?: (result: ApplyWorkflowResult) => void;
  /** Fires after an "Export bundle…" run with the parsed create result (before the download). */
  onBundleExportComplete?: (result: ParsedBundleCreateResult) => void;
  onError?: (error: Error) => void;
};

export type {
  ApplyPatchFormProps,
  ApplyPatchFormSettings,
  BinarySource,
  DialogController,
  NoticeController,
  PageFileDrop,
  PatcherOutputController,
  PatcherStackController,
  PatcherUiController,
  StackPatchItem,
  StartupState,
};
