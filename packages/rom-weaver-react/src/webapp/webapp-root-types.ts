import type { PageUpdateState } from "./page-update-state.ts";
import type { UrlSessionParseResult } from "./url-session/url-session-request.ts";
import type {
  CreatorSessionState,
  PatcherSessionState,
  StartupState,
  TrimSessionState,
  ValidationState,
  WorkflowView,
} from "./webapp-state-types.ts";

type ConfirmationDialogState = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  level: "error" | "warning";
};

const createEmptyConfirmationDialogState = (): ConfirmationDialogState => ({
  cancelLabel: "Cancel",
  confirmLabel: "Continue",
  level: "warning",
  message: "",
  open: false,
  title: "",
});

type WebappRootProps = {
  state: {
    creatorSession: CreatorSessionState;
    currentView: WorkflowView;
    patcherSession: PatcherSessionState;
    toolsSession: { active: boolean };
    trimSession: TrimSessionState;
    settingsDialogOpen: boolean;
    settings: {
      [key: string]: RuntimeValue;
    };
    draftSettings: Record<string, RuntimeValue>;
    validation: ValidationState;
    startup: StartupState;
  };
  serviceWorkerCache: {
    label: string;
    title: string;
    updateLabel: string;
    updateReady: boolean;
    updateTitle: string;
  };
  pageUpdate: PageUpdateState;
  confirmationDialog: ConfirmationDialogState;
  /** Boot-time `?bundle=` / `?rom=&patch=` session request, when present. */
  urlSession?: UrlSessionParseResult | null;
  actions: {
    onSelectView: (view: WorkflowView) => void;
    onDraftChange: (field: string, value: string | boolean) => void;
    onLogLevelChange: (level: string) => void;
    onLanguageChange: (language: string) => void;
    onOpenSettings: () => void;
    onReset: () => void;
    onCloseSettings: () => void;
    onReloadUpdate: () => void;
    onRestoreDefaults: () => void;
    onSaveClose: () => void;
    onCancelConfirmation: () => void;
    onConfirmConfirmation: () => void;
    /** Resolves false to block an external link (footer GitHub/donate) when staged work would be lost. */
    onConfirmExternalNavigation: (href: string) => Promise<boolean>;
    onCreatorModifiedChange: (file: unknown) => void;
    onCreatorOriginalChange: (file: unknown) => void;
    onCreatorPatchTypeChange: (patchType: string) => void;
    onCreatorSettingsChange: (settings: unknown) => void;
    onPatcherInputsChange: (inputs: readonly unknown[]) => void;
    onPatcherPatchesChange: (patches: readonly unknown[]) => void;
    onPatcherSettingsChange: (settings: unknown) => void;
    onTrimSourceChange: (file: unknown) => void;
    onTrimOutputFormatChange: (format: string) => void;
    onTrimSettingsChange: (settings: unknown) => void;
    onToolsSessionChange: (active: boolean) => void;
  };
};

export type { ConfirmationDialogState, WebappRootProps };
export { createEmptyConfirmationDialogState };
