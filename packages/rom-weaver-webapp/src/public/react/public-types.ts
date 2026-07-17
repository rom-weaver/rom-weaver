import type { ReactNode } from "react";
import type {
  ApplySettings,
  BrowserApplyResult,
  BrowserCreateResult,
  BrowserTrimResult,
  CandidateSelectionRequest,
  CreateSettings,
} from "../../platform/browser/browser-api.ts";
import type { ProgressEvent } from "../../types/workflow-runtime-types.ts";
import type {
  BinarySource,
  ApplyPatchFormProps as InternalApplyPatchFormProps,
  PageFileDrop,
  StartupState,
} from "./patcher-form.ts";

type RomWeaverReactSettings = ApplySettings & CreateSettings;
type ApplyWorkflowSettings = ApplySettings;
type CreateWorkflowSettings = CreateSettings;
type CandidateSelectionPrompt = CandidateSelectionRequest;
/** `id` is the primary pick; `ids` carries the full ordered set for a multi-select prompt. */
type CandidateSelectionChoice = { id: string; ids?: string[] };
type ApplyPatchFormSettings = ApplySettings;

type ApplyPatchFormProps = Omit<InternalApplyPatchFormProps, "controllers" | "onApplyComplete"> & {
  onApplyComplete?: (result: BrowserApplyResult) => void;
};

type RomWeaverSettingsProviderProps = {
  assetBaseUrl?: string;
  children: ReactNode;
  settings?: Partial<RomWeaverReactSettings>;
};

type CreatePatchFormSettings = CreateSettings;

type CreatePatchFormProps = {
  assetBaseUrl?: string;
  original?: BinarySource | null;
  modified?: BinarySource | null;
  defaultOriginal?: BinarySource | null;
  defaultModified?: BinarySource | null;
  settings?: CreatePatchFormSettings;
  defaultSettings?: CreatePatchFormSettings;
  pageDrop?: PageFileDrop | null;
  patchType?: string;
  defaultPatchType?: string;
  disabled?: boolean;
  workerThreads?: number | string;
  onOriginalChange?: (file: BinarySource | null) => void;
  onModifiedChange?: (file: BinarySource | null) => void;
  onSettingsChange?: (settings: CreatePatchFormSettings) => void;
  onPatchTypeChange?: (patchType: string) => void;
  onProgress?: (event: ProgressEvent) => void;
  onCreateComplete?: (result: BrowserCreateResult) => void;
  onError?: (error: Error) => void;
};

type TrimPatchFormSettings = CreateSettings;

type TrimPatchFormProps = {
  assetBaseUrl?: string;
  source?: BinarySource | null;
  defaultSource?: BinarySource | null;
  settings?: TrimPatchFormSettings;
  defaultSettings?: TrimPatchFormSettings;
  pageDrop?: PageFileDrop | null;
  outputFormat?: string;
  defaultOutputFormat?: string;
  disabled?: boolean;
  workerThreads?: number | string;
  onSourceChange?: (file: BinarySource | null) => void;
  onSettingsChange?: (settings: TrimPatchFormSettings) => void;
  onOutputFormatChange?: (format: string) => void;
  onProgress?: (event: ProgressEvent) => void;
  onTrimComplete?: (result: BrowserTrimResult) => void;
  onError?: (error: Error) => void;
};

export type {
  ApplyPatchFormProps,
  ApplyPatchFormSettings,
  ApplyWorkflowSettings,
  CandidateSelectionChoice,
  CandidateSelectionPrompt,
  CreatePatchFormProps,
  CreatePatchFormSettings,
  CreateWorkflowSettings,
  InternalApplyPatchFormProps,
  PageFileDrop,
  RomWeaverReactSettings,
  RomWeaverSettingsProviderProps,
  StartupState,
  TrimPatchFormProps,
  TrimPatchFormSettings,
};
