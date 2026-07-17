import { areSettingsEqual } from "./webapp-controller.ts";
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
  toolsActive?: RuntimeValue;
  patchStackState?: PendingPatchStackState;
  outputState?: PendingOutputState;
  romFilePresent?: RuntimeValue;
};

type PendingChangeState = Record<AppWorkflowView | "settings", boolean>;

const UNSAVED_SETTINGS_UNLOAD_MESSAGE = "You have unsaved settings changes. Reload and lose those changes?";
const UNSAVED_SETTINGS_DISCARD_MESSAGE = "You have unsaved settings changes. Close settings and discard them?";

const settingsDraftHasChanges = (webappState?: WebappState | null): boolean => {
  if (!(webappState?.settings && webappState.draftSettings)) return false;
  return !areSettingsEqual(webappState.settings, webappState.draftSettings);
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
  toolsActive,
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
  tools: !!toolsActive,
  trim: trimHasPendingChanges(trimState),
});

const shouldWarnBeforeUnload = (state: PendingChangeInputState): boolean => {
  const pendingChangeState = getPendingChangeState(state);
  return (
    pendingChangeState.patcher ||
    pendingChangeState.creator ||
    pendingChangeState.trim ||
    pendingChangeState.tools ||
    pendingChangeState.settings
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
  if (pendingChangeState.tools) return "You have an in-progress tools session. Reload and lose those changes?";
  if (pendingChangeState.patcher) return "You have an in-progress patching session. Reload and lose those changes?";
  return "";
};

export {
  getDiscardSettingsConfirmationMessage,
  getUnloadConfirmationMessage,
  shouldConfirmDiscardSettings,
  shouldWarnBeforeUnload,
};
