import type { BundleApplySession } from "../../lib/bundle/bundle-session-model.ts";
import type { ParsedBundleCreateResult } from "../../types/bundle.ts";
import type { ApplySettings } from "../../types/settings.ts";
import type { ApplyWorkflowResult, ProgressEvent } from "../../types/workflow-runtime-types.ts";
import type { PatcherOutputState, PatchStackItemState, PatchStackState } from "./patcher-presentation.ts";
import type { NoticeState, PatcherSectionNoticeKey, PatcherUiState, StoreController } from "./patcher-ui-state.ts";

type ApplySessionAdvisory = {
  key: string;
  kind: "bundle" | "url";
  warnings: readonly string[];
};

type ApplySessionSource = "manual" | "url-session";

type ApplyPatchFormSettings = ApplySettings;
type BinarySource = File | FileSystemFileHandle;
type PageFileDrop = {
  files: File[];
  id: number;
  source?: ApplySessionSource;
};
type StartupState = {
  status: "loading" | "ready" | "error";
  message: string;
};

type PatcherUiController = StoreController<PatcherUiState> & {
  clearRomInput?: () => void;
  /** Retire a finished run's pending download as soon as new files are accepted for routing. */
  discardCompletedOutput?: () => void;
  provideRomInputFile?: (file: BinarySource | null) => void;
  provideRomInputFiles?: (files: FileList | BinarySource[] | null) => void;
  removeRomInput?: (id: string) => void;
  setDropSource?: (source: ApplySessionSource) => void;
  toggleRomInputChecksums?: (id: string) => void;
  providePatchInputFiles?: (fileList: FileList | BinarySource[] | null) => void;
  setChecksumOverride?: (checked: boolean) => void;
  dismissNotice?: (key: PatcherSectionNoticeKey) => void;
};

type StackPatchItem = PatchStackItemState;

type PatcherStackController = StoreController<PatchStackState> & {
  reorder: (from: number, to: number) => void;
  removeItem: (index: number) => void;
  /** Swap one staged patch for a new file in place, keeping its slot metadata. */
  replaceItem: (index: number, source: BinarySource) => void;
  setPatchTarget?: (index: number, targetInputId: string) => void;
  setPatchOption?: (
    index: number,
    option: {
      basis?: "base" | "previous";
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
  showError?: (error: Error, fallbackMessage?: string) => void;
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
  threads?: number | string;
  containerInputsEnabled?: boolean;
  compressionOptions?: string[];
  startup?: StartupState;
  /** Warnings from a successfully delivered URL session, shown in Apply. */
  sessionAdvisory?: ApplySessionAdvisory | null;
  /** A `?bundle=` boot session: seeds enablement/output defaults once its files land. */
  bundleSession?: BundleApplySession | null;
  onInputsChange?: (inputs: BinarySource[], source?: ApplySessionSource) => void;
  onManualSessionStart?: () => void;
  onPatchesChange?: (patches: BinarySource[], source?: ApplySessionSource) => void;
  onSelectView?: (view: "test") => void;
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
  NoticeController,
  ApplySessionAdvisory,
  ApplySessionSource,
  PageFileDrop,
  PatcherOutputController,
  PatcherStackController,
  PatcherUiController,
  StackPatchItem,
  StartupState,
};
