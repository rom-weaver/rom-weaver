import type { PageUpdateState } from "./page-update-state.ts";
import type { GuidedSample } from "../public/react/guided-sample-start.ts";
import type { ApplySessionAdvisory, ApplySessionSource } from "../public/react/patcher-form.ts";
import type { ServiceWorkerStatus } from "./pwa/service-worker-cache-state.ts";
import type { UrlSessionParseResult } from "./url-session/url-session-request.ts";
import type {
  CreatorSessionState,
  PatcherSessionState,
  StartupState,
  TrimSessionState,
  ValidationState,
  WebappView,
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
  docsSlug?: string;
  /** Render the normal app chrome with a not-found workbench. */
  notFound?: boolean;
  state: {
    creatorSession: CreatorSessionState;
    currentView: WebappView;
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
    serviceWorkerStatus: ServiceWorkerStatus | null;
    title: string;
    updateLabel: string;
    updateReady: boolean;
    updateTitle: string;
  };
  pageUpdate: PageUpdateState;
  confirmationDialog: ConfirmationDialogState;
  /** Boot-time `?bundle=` / `?rom=&patch=` session request, when present. */
  urlSession?: UrlSessionParseResult | null;
  /** Warnings retained until the URL session has delivered its files to Apply. */
  urlSessionAdvisory?: ApplySessionAdvisory | null;
  actions: {
    onStartGuide: (guide: GuidedSample) => void;
    onSelectView: (view: WebappView) => void;
    /** Masthead quick pickers commit straight to settings - no draft, no Save. */
    onAccentChange: (accent: string) => void;
    onLanguageChange: (language: string) => void;
    onDraftChange: (field: string, value: string | boolean) => void;
    onLogLevelChange: (level: string) => void;
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
    onPatcherBundlePackageChange: (value: string) => void;
    onPatcherInputsChange: (inputs: readonly unknown[], source?: ApplySessionSource) => void;
    onPatcherPatchesChange: (patches: readonly unknown[], source?: ApplySessionSource) => void;
    onPatcherSettingsChange: (settings: unknown) => void;
    onTrimSourceChange: (file: unknown) => void;
    onTrimOutputFormatChange: (format: string) => void;
    onTrimSettingsChange: (settings: unknown) => void;
    onToolsSessionChange: (active: boolean) => void;
  };
};

export type { ConfirmationDialogState, WebappRootProps };
export { createEmptyConfirmationDialogState };
