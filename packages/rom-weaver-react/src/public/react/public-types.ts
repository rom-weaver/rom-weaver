import type { ReactNode } from "react";
import type {
  ApplySettings,
  BrowserApplyResult,
  CandidateSelectionRequest,
} from "../../platform/browser/browser-api.ts";
import type { BinarySource, ApplyPatchFormProps as InternalApplyPatchFormProps, StartupState } from "./patcher-form.ts";

type RomWeaverReactSettings = ApplySettings;
type ApplyWorkflowSettings = ApplySettings;
type CandidateSelectionPrompt = CandidateSelectionRequest;
type CandidateSelectionChoice = { id: string };
type ApplyPatchFormSettings = ApplySettings;

type ApplyPatchFormProps = Omit<InternalApplyPatchFormProps, "controllers" | "onApplyComplete"> & {
  onApplyComplete?: (result: BrowserApplyResult) => void;
};

type RomWeaverSettingsProviderProps = {
  assetBaseUrl?: string;
  children: ReactNode;
  settings?: Partial<RomWeaverReactSettings>;
};

export type {
  ApplyPatchFormProps,
  ApplyPatchFormSettings,
  ApplyWorkflowSettings,
  BinarySource,
  CandidateSelectionChoice,
  CandidateSelectionPrompt,
  InternalApplyPatchFormProps,
  RomWeaverReactSettings,
  RomWeaverSettingsProviderProps,
  StartupState,
};
