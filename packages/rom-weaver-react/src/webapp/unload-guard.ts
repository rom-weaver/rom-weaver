import type { WorkflowView as AppWorkflowView } from "./webapp-state-types.ts";

type UnknownRecord = Record<string, RuntimeValue>;

type WebappState = {
  settings?: UnknownRecord | null;
  draftSettings?: UnknownRecord | null;
};

type CreatorState =
  | {
      modifiedFilePresent?: RuntimeValue;
      originalFileName?: RuntimeValue;
      originalFilePresent?: RuntimeValue;
      modifiedFileName?: RuntimeValue;
      outputName?: RuntimeValue;
      patchType?: RuntimeValue;
      settingsEdited?: RuntimeValue;
      metadataValues?: UnknownRecord | null;
    }
  | null
  | undefined;

type PendingPatchStackState = { items?: unknown[] } | null | undefined;
type PendingOutputState = { pendingDownloadFileName?: RuntimeValue } | null | undefined;

type TrimState =
  | {
      outputName?: RuntimeValue;
      sourceFilePresent?: RuntimeValue;
    }
  | null
  | undefined;

type PendingChangeInputState = {
  patcherFormEdited?: RuntimeValue;
  webappState?: WebappState | null;
  creatorState?: CreatorState;
  trimState?: TrimState;
  patchStackState?: PendingPatchStackState;
  outputState?: PendingOutputState;
  romFilePresent?: RuntimeValue;
};

type PendingChangeState = Record<AppWorkflowView | "settings", boolean>;

type WorkflowViewSwitchInput = {
  currentView?: AppWorkflowView | null;
  nextView?: AppWorkflowView | null;
  pendingChangeState?: Partial<PendingChangeState> | null;
};

type BeforeUnloadEventTarget = Pick<Window, "addEventListener" | "removeEventListener">;
const BEFORE_UNLOAD_BYPASS_TIMEOUT_MS = 5000;
const UNSAVED_SETTINGS_UNLOAD_MESSAGE = "You have unsaved settings changes. Reload and lose those changes?";
const UNSAVED_SETTINGS_DISCARD_MESSAGE = "You have unsaved settings changes. Close settings and discard them?";

const settingsDraftHasChanges = (webappState?: WebappState | null): boolean => {
  if (!(webappState?.settings && webappState.draftSettings)) return false;
  const settings = webappState.settings;
  const draftSettings = webappState.draftSettings;
  const keys = new Set([...Object.keys(settings), ...Object.keys(draftSettings)]);
  for (const key of keys) {
    if (settings[key] !== draftSettings[key]) return true;
  }
  return false;
};

const creatorHasPendingChanges = (creatorState: CreatorState): boolean => {
  if (!creatorState) return false;
  if (
    creatorState.originalFileName ||
    creatorState.modifiedFileName ||
    creatorState.originalFilePresent ||
    creatorState.modifiedFilePresent
  )
    return true;
  if (String(creatorState.outputName || "").trim()) return true;
  if (creatorState.settingsEdited) return true;
  if (creatorState.patchType && creatorState.patchType !== "bps") return true;
  if (creatorState.metadataValues && typeof creatorState.metadataValues === "object") {
    for (const value of Object.values(creatorState.metadataValues)) {
      if (String(value || "").trim()) return true;
    }
  }
  return false;
};

const trimHasPendingChanges = (trimState: TrimState): boolean => {
  if (!trimState) return false;
  if (trimState.sourceFilePresent) return true;
  if (String(trimState.outputName || "").trim()) return true;
  return false;
};

const patcherHasPendingChanges = ({
  patcherFormEdited,
  patchStackState,
  outputState,
  romFilePresent,
}: Pick<
  PendingChangeInputState,
  "outputState" | "patchStackState" | "patcherFormEdited" | "romFilePresent"
>): boolean => {
  if (patcherFormEdited) return true;
  if (romFilePresent) return true;
  if ((patchStackState?.items?.length || 0) > 0) return true;
  if (outputState?.pendingDownloadFileName) return true;
  return false;
};

const getPendingChangeState = ({
  webappState,
  creatorState,
  trimState,
  patcherFormEdited,
  patchStackState,
  outputState,
  romFilePresent,
}: PendingChangeInputState): PendingChangeState => ({
  creator: creatorHasPendingChanges(creatorState),
  patcher: patcherHasPendingChanges({
    outputState,
    patcherFormEdited,
    patchStackState,
    romFilePresent,
  }),
  settings: settingsDraftHasChanges(webappState),
  trim: trimHasPendingChanges(trimState),
});

const shouldWarnBeforeUnload = (state: PendingChangeInputState): boolean => {
  const pendingChangeState = getPendingChangeState(state);
  return (
    pendingChangeState.patcher || pendingChangeState.creator || pendingChangeState.trim || pendingChangeState.settings
  );
};

const shouldConfirmDiscardSettings = (webappState?: WebappState | null): boolean =>
  settingsDraftHasChanges(webappState);

const getDiscardSettingsConfirmationMessage = (): string => UNSAVED_SETTINGS_DISCARD_MESSAGE;

const getUnloadConfirmationMessage = (state: PendingChangeInputState): string => {
  const pendingChangeState = getPendingChangeState(state);
  if (pendingChangeState.settings) return UNSAVED_SETTINGS_UNLOAD_MESSAGE;
  if (pendingChangeState.creator) return "You have unsaved patch creator inputs. Reload and lose those changes?";
  if (pendingChangeState.trim) return "You have an in-progress trim session. Reload and lose those changes?";
  if (pendingChangeState.patcher) return "You have an in-progress patching session. Reload and lose those changes?";
  return "";
};

const confirmReloadWithPendingChanges = (
  state: PendingChangeInputState,
  confirmAction?: ((message: string) => RuntimeValue) | null,
): boolean => {
  if (!shouldWarnBeforeUnload(state)) return true;
  if (typeof confirmAction !== "function") return false;
  return !!confirmAction(getUnloadConfirmationMessage(state));
};

const shouldConfirmWorkflowViewSwitch = ({
  currentView,
  nextView,
  pendingChangeState,
}: WorkflowViewSwitchInput): boolean => {
  if (!(currentView && nextView) || currentView === nextView) return false;
  return !!pendingChangeState?.[currentView];
};

const formatWorkflowViewLabel = (mode: RuntimeValue): string =>
  String(mode || "")
    .charAt(0)
    .toUpperCase() + String(mode || "").slice(1);

const getWorkflowViewSwitchConfirmationMessage = ({
  currentView,
  nextView,
}: Pick<WorkflowViewSwitchInput, "currentView" | "nextView">): string => {
  const nextViewLabel = formatWorkflowViewLabel(nextView);
  if (currentView === "creator")
    return `You have unsaved patch creator inputs. Leave Creator and switch to ${nextViewLabel}?`;
  if (currentView === "trim") return `You have an in-progress trim session. Leave Trim and switch to ${nextViewLabel}?`;
  return `You have an in-progress patching session. Leave Patcher and switch to ${nextViewLabel}?`;
};

const createBeforeUnloadGuard = ({ target }: { target?: BeforeUnloadEventTarget | null } = {}) => {
  const eventTarget = target || (typeof window === "undefined" ? null : window);
  let enabled = false;
  let bypassNextBeforeUnload = false;
  let bypassResetTimer: ReturnType<typeof setTimeout> | null = null;

  const clearBypassResetTimer = () => {
    if (bypassResetTimer === null) return;
    clearTimeout(bypassResetTimer);
    bypassResetTimer = null;
  };

  const scheduleBypassReset = () => {
    clearBypassResetTimer();
    bypassResetTimer = setTimeout(() => {
      bypassNextBeforeUnload = false;
      bypassResetTimer = null;
    }, BEFORE_UNLOAD_BYPASS_TIMEOUT_MS);
  };

  const handleBeforeUnload = (event: BeforeUnloadEvent): string | undefined => {
    if (!(enabled && event)) return undefined;
    if (bypassNextBeforeUnload) {
      bypassNextBeforeUnload = false;
      clearBypassResetTimer();
      return undefined;
    }
    event.preventDefault();
    event.returnValue = "";
    return "";
  };

  if (eventTarget && typeof eventTarget.addEventListener === "function")
    eventTarget.addEventListener("beforeunload", handleBeforeUnload);

  return {
    bypassNextBeforeUnload() {
      bypassNextBeforeUnload = true;
      scheduleBypassReset();
    },
    dispose() {
      if (eventTarget && typeof eventTarget.removeEventListener === "function")
        eventTarget.removeEventListener("beforeunload", handleBeforeUnload);
      clearBypassResetTimer();
      bypassNextBeforeUnload = false;
      enabled = false;
    },
    isEnabled() {
      return enabled;
    },
    update(nextEnabled: RuntimeValue) {
      enabled = !!nextEnabled;
    },
  };
};

export {
  confirmReloadWithPendingChanges,
  createBeforeUnloadGuard,
  creatorHasPendingChanges,
  getDiscardSettingsConfirmationMessage,
  getPendingChangeState,
  getUnloadConfirmationMessage,
  getWorkflowViewSwitchConfirmationMessage,
  patcherHasPendingChanges,
  settingsDraftHasChanges,
  shouldConfirmDiscardSettings,
  shouldConfirmWorkflowViewSwitch,
  shouldWarnBeforeUnload,
  trimHasPendingChanges,
};
