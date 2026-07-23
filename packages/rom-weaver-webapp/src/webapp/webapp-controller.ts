import { applyAccent } from "./accent.ts";
import {
  buildSettingsForWebapp,
  copySettings,
  getCompressionProfileFromIndex,
  getDefaultSettings,
  isSettingsDraftFieldNumeric,
  LOCAL_STORAGE_SETTINGS_ID,
  loadSettings,
  SETTINGS_FIELD_METADATA,
  SETTINGS_VALID_COMPRESSION_PROFILES,
  type SettingsDraftState,
  type SettingsState,
  serializeSettingsForStorage,
  validateSettingsDraft,
} from "./settings/settings-state.ts";
import { createStore } from "./vanilla-store.ts";
import {
  type CreatorSessionState,
  createEmptyCreatorSessionState,
  createEmptyPatcherSessionState,
  createEmptyToolsSessionState,
  createEmptyTrimSessionState,
  createEmptyValidationState,
  type PatcherSessionState,
  type StartupState,
  type ToolsSessionState,
  type TrimSessionState,
  type ValidationState,
  type WorkflowView,
} from "./webapp-state-types.ts";

const DEFAULT_WORKFLOW_VIEW: WorkflowView = "patcher";
const VALID_WORKFLOW_VIEWS: readonly WorkflowView[] = ["patcher", "creator", "trim", "tools"];
const ACTIVE_VIEW_STORAGE_KEY = "rom-weaver-active-view";

const normalizeWorkflowView = (value: unknown): WorkflowView | null => {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return VALID_WORKFLOW_VIEWS.includes(normalized as WorkflowView) ? (normalized as WorkflowView) : null;
};

const isBetaWorkflowView = (view: WorkflowView): boolean => view === "trim" || view === "tools";

const normalizeWorkflowViewForSettings = (view: WorkflowView, settings: SettingsState): WorkflowView =>
  !settings.betaToolsEnabled && isBetaWorkflowView(view) ? DEFAULT_WORKFLOW_VIEW : view;

/** Restore the last-used workflow tab so a reload returns to the same tab. */
const loadPersistedWorkflowView = (storage?: ControllerOptions["storage"]): WorkflowView => {
  try {
    const stored = storage && typeof storage.getItem === "function" ? storage.getItem(ACTIVE_VIEW_STORAGE_KEY) : null;
    return normalizeWorkflowView(stored) || DEFAULT_WORKFLOW_VIEW;
  } catch {
    return DEFAULT_WORKFLOW_VIEW;
  }
};

const persistWorkflowView = (storage: ControllerOptions["storage"] | undefined, view: WorkflowView): void => {
  try {
    if (storage && typeof storage.setItem === "function") storage.setItem(ACTIVE_VIEW_STORAGE_KEY, view);
  } catch {
    // Ignore storage write failures (private mode, quota, etc.).
  }
};

const VIEW_TO_ROUTE_SLUG: Record<WorkflowView, string> = {
  creator: "create",
  patcher: "weave",
  tools: "tools",
  trim: "trim",
};
const ROUTE_SLUG_TO_VIEW: Record<string, WorkflowView> = {
  create: "creator",
  "create.html": "creator",
  tools: "tools",
  trim: "trim",
  weave: "patcher",
};

const readRouteSegments = (): string[] => {
  if (typeof window === "undefined") return [];
  const segments = window.location.pathname.trim().toLowerCase().split("/").filter(Boolean);
  if (segments.at(-1) === "index.html") segments.pop();
  return segments;
};

const readWorkflowViewFromPath = (): WorkflowView | null => {
  const segments = readRouteSegments();
  const slug = segments.at(-1) || "";
  return ROUTE_SLUG_TO_VIEW[slug] || null;
};

type RouteHistoryMode = "none" | "push" | "replace";

const writeWorkflowViewToPath = (view: WorkflowView, historyMode: RouteHistoryMode): void => {
  if (typeof window === "undefined") return;
  if (historyMode === "none") return;
  const baseUrl = new URL(window.location.href);
  const pathSegments = baseUrl.pathname.split("/");
  while (pathSegments.at(-1) === "") pathSegments.pop();
  if (pathSegments.at(-1) === "index.html") pathSegments.pop();
  const currentSlug = pathSegments.at(-1) || "";
  if (ROUTE_SLUG_TO_VIEW[currentSlug]) pathSegments.pop();
  baseUrl.pathname = `${pathSegments.join("/")}/`;
  const nextUrl = new URL(VIEW_TO_ROUTE_SLUG[view], baseUrl);
  nextUrl.search = window.location.search;
  if (nextUrl.href === window.location.href) return;
  window.history[historyMode === "push" ? "pushState" : "replaceState"](window.history.state, "", nextUrl);
};

type WebappState = {
  creatorSession: CreatorSessionState;
  currentView: WorkflowView;
  patcherSession: PatcherSessionState;
  toolsSession: ToolsSessionState;
  trimSession: TrimSessionState;
  settingsDialogOpen: boolean;
  settings: SettingsState;
  draftSettings: SettingsDraftState;
  validation: ValidationState;
  startup: StartupState;
};

type ControllerOptions = {
  onApplySettings: (settings: ReturnType<typeof loadSettings>) => void;
  onLocalizationChange: (language: string) => void;
  onFocusField: (fieldId: string) => void;
  onCreatorViewRequested: (options?: { fallbackOnError?: boolean }) => boolean;
  onConfirmViewLeave?: (context: { currentView: WorkflowView; nextView: WorkflowView }) => boolean;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
};

const emptyValidation = (): ValidationState => createEmptyValidationState();

type DraftSettingsField = Extract<keyof SettingsDraftState, string>;

const areSettingsEqual = (left: Record<string, unknown>, right: Record<string, unknown>) => {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!areDraftFieldValuesEqual(key as DraftSettingsField, left[key], right[key])) return false;
  }
  return true;
};

const areDraftFieldValuesEqual = (field: DraftSettingsField, left: unknown, right: unknown) => {
  if (left === right) return true;
  if (!isSettingsDraftFieldNumeric(field)) return false;
  if (left === "" || right === "") return left === right;
  const leftParsed = Number.parseInt(String(left), 10);
  const rightParsed = Number.parseInt(String(right), 10);
  return Number.isFinite(leftParsed) && Number.isFinite(rightParsed) && leftParsed === rightParsed;
};

const getOutputSettings = (settings: unknown): Record<string, unknown> => {
  if (!(settings && typeof settings === "object")) return {};
  const output = (settings as { output?: unknown }).output;
  return output && typeof output === "object" ? (output as Record<string, unknown>) : {};
};

const getOutputName = (settings: unknown): string => {
  const outputName = getOutputSettings(settings).outputName;
  return typeof outputName === "string" ? outputName : "";
};

const getOutputCompression = (settings: unknown): string => {
  const compression = getOutputSettings(settings).compression;
  return typeof compression === "string" ? compression : "none";
};

const mergeDraftSettings = (
  draftSettings: SettingsDraftState,
  previousSettings: SettingsState,
  nextSettings: SettingsState,
): SettingsDraftState => {
  const mergedDraft = copySettings(nextSettings) as SettingsDraftState;
  const keys = new Set<DraftSettingsField>([
    ...Object.keys(draftSettings),
    ...Object.keys(previousSettings),
    ...Object.keys(nextSettings),
  ] as DraftSettingsField[]);
  for (const key of keys) {
    if (areDraftFieldValuesEqual(key, draftSettings[key], previousSettings[key as keyof SettingsState])) continue;
    (mergedDraft as Record<string, unknown>)[key] = draftSettings[key];
  }
  return mergedDraft;
};

const createWebappRootController = (options: ControllerOptions) => {
  const settings = loadSettings(options.storage);
  // Before the React tree renders, so the accent tokens resolve on first paint.
  applyAccent(settings.accent);
  // The URL path wins (deep links / reload), then the last persisted tab, then the default.
  const initialView = normalizeWorkflowViewForSettings(
    readWorkflowViewFromPath() || loadPersistedWorkflowView(options.storage),
    settings,
  );
  writeWorkflowViewToPath(initialView, "replace");
  const store = createStore<WebappState>(() => ({
    creatorSession: createEmptyCreatorSessionState(),
    currentView: initialView,
    draftSettings: copySettings(settings),
    patcherSession: createEmptyPatcherSessionState(),
    settings,
    settingsDialogOpen: false,
    startup: {
      message: "",
      status: "loading",
    },
    toolsSession: createEmptyToolsSessionState(),
    trimSession: createEmptyTrimSessionState(),
    validation: emptyValidation(),
  }));

  const setState = (nextState: Partial<WebappState>) => {
    store.setState(nextState);
  };

  const persistSettings = (settingsToPersist: SettingsState = store.getState().settings) => {
    if (options.storage) {
      const serializedSettings = serializeSettingsForStorage(settingsToPersist);
      if (serializedSettings && typeof options.storage.setItem === "function")
        options.storage.setItem(LOCAL_STORAGE_SETTINGS_ID, serializedSettings);
      else if (!serializedSettings && typeof options.storage.removeItem === "function")
        options.storage.removeItem(LOCAL_STORAGE_SETTINGS_ID);
    }
  };

  const emitCommittedSettings = () => {
    options.onApplySettings(store.getState().settings);
  };

  const buildDraftValidation = (draftSettings: SettingsDraftState, committedSettings: SettingsState) => {
    const validation = validateSettingsDraft(draftSettings, committedSettings);
    return validation.messages.length ? validation : emptyValidation();
  };

  const applyCommittedSettings = (
    nextSettings: SettingsState,
    optionsForApply?: {
      draftSettings?: SettingsDraftState;
      syncDraftSettings?: boolean;
      validation?: ValidationState;
    },
  ) => {
    const currentView = store.getState().currentView;
    const nextCurrentView = normalizeWorkflowViewForSettings(currentView, nextSettings);
    const nextState: Partial<WebappState> = {
      settings: copySettings(nextSettings),
    };
    if (nextCurrentView !== currentView) nextState.currentView = nextCurrentView;
    if (optionsForApply?.draftSettings) nextState.draftSettings = optionsForApply.draftSettings;
    if (optionsForApply?.syncDraftSettings) nextState.draftSettings = copySettings(nextSettings);
    if (optionsForApply?.validation) nextState.validation = optionsForApply.validation;
    setState(nextState);
    if (nextCurrentView !== currentView) {
      persistWorkflowView(options.storage, nextCurrentView);
      writeWorkflowViewToPath(nextCurrentView, "replace");
    }
    emitCommittedSettings();
    applyAccent(nextSettings.accent);
    options.onLocalizationChange(nextSettings.language);
  };

  const commitMode = (mode: WorkflowView, historyMode: RouteHistoryMode = "push") => {
    setState({ currentView: mode });
    persistWorkflowView(options.storage, mode);
    writeWorkflowViewToPath(mode, historyMode);
  };

  const updatePatcherSession = (nextPatcherSession: Partial<PatcherSessionState>) => {
    setState({
      patcherSession: {
        ...store.getState().patcherSession,
        ...nextPatcherSession,
      },
    });
  };

  const updateCreatorSession = (nextCreatorSession: Partial<CreatorSessionState>) => {
    setState({
      creatorSession: {
        ...store.getState().creatorSession,
        ...nextCreatorSession,
      },
    });
  };

  const updateTrimSession = (nextTrimSession: Partial<TrimSessionState>) => {
    setState({
      trimSession: {
        ...store.getState().trimSession,
        ...nextTrimSession,
      },
    });
  };

  return {
    activateInitialView(
      mode: string,
      optionsForSelection?: { fallbackOnError?: boolean; historyMode?: RouteHistoryMode },
    ) {
      return this.selectView(mode, optionsForSelection);
    },
    buildSettingsForRuntime(overrides?: { allowDropFiles?: boolean; ondropfiles?: () => void }) {
      return buildSettingsForWebapp(store.getState().settings, overrides);
    },
    closeSettings() {
      if (!store.getState().settingsDialogOpen) return;
      setState({ settingsDialogOpen: false });
    },
    discardDraftSettings() {
      const state = store.getState();
      setState({
        draftSettings: copySettings(state.settings),
        settingsDialogOpen: false,
        validation: emptyValidation(),
      });
    },
    getState() {
      return store.getState();
    },
    hasDraftSettingsChanges() {
      const state = store.getState();
      return !areSettingsEqual(state.draftSettings, state.settings);
    },
    openSettings() {
      const state = store.getState();
      const hasUnsavedDraftChanges = !areSettingsEqual(state.draftSettings, state.settings);
      setState({
        draftSettings: hasUnsavedDraftChanges ? state.draftSettings : copySettings(state.settings),
        settingsDialogOpen: true,
        validation: hasUnsavedDraftChanges ? state.validation : emptyValidation(),
      });
    },
    reloadPersistedSettings() {
      const state = store.getState();
      const previousSettings = copySettings(state.settings);
      const nextSettings = loadSettings(options.storage);
      const hasUnsavedDraftChanges = !areSettingsEqual(state.draftSettings, previousSettings);
      const settingsChanged = !areSettingsEqual(previousSettings, nextSettings);
      if (!settingsChanged) return state.settings;
      const nextDraftSettings = hasUnsavedDraftChanges
        ? mergeDraftSettings(state.draftSettings, previousSettings, nextSettings)
        : copySettings(nextSettings);
      const nextValidation = buildDraftValidation(nextDraftSettings, nextSettings);
      applyCommittedSettings(nextSettings, {
        draftSettings: nextDraftSettings,
        validation: nextValidation,
      });
      return store.getState().settings;
    },
    restoreDefaults() {
      setState({
        draftSettings: getDefaultSettings(),
        validation: {
          invalidFields: [],
          messages: ["Defaults staged. Save and close to apply them."],
        },
      });
    },
    saveDraftSettings() {
      const state = store.getState();
      const validation = validateSettingsDraft(state.draftSettings, state.settings);
      if (validation.messages.length) {
        setState({ validation });
        if (validation.invalidFields[0]) options.onFocusField(validation.invalidFields[0]);
        return false;
      }
      persistSettings(validation.settings);
      applyCommittedSettings(validation.settings, {
        syncDraftSettings: true,
        validation: emptyValidation(),
      });
      setState({ settingsDialogOpen: false });
      return true;
    },
    selectView(mode: string, optionsForSelection?: { fallbackOnError?: boolean; historyMode?: RouteHistoryMode }) {
      const state = store.getState();
      let nextView = normalizeWorkflowView(mode) || DEFAULT_WORKFLOW_VIEW;
      nextView = normalizeWorkflowViewForSettings(nextView, state.settings);
      if (
        nextView !== state.currentView &&
        typeof options.onConfirmViewLeave === "function" &&
        !options.onConfirmViewLeave({
          currentView: state.currentView,
          nextView: nextView,
        })
      )
        return state.currentView;
      if (nextView === "creator") {
        const opened = options.onCreatorViewRequested(optionsForSelection);
        if (!opened) nextView = DEFAULT_WORKFLOW_VIEW;
      }
      commitMode(nextView, optionsForSelection?.historyMode);
      return nextView;
    },
    setBundlePackage(value: string) {
      const state = store.getState();
      if (state.settings.bundlePackage === value) return;
      const validValues = new Set(SETTINGS_FIELD_METADATA.bundlePackage.validValues || []);
      if (!validValues.has(value)) return;
      const nextSettings = { ...copySettings(state.settings), bundlePackage: value };
      persistSettings(nextSettings);
      applyCommittedSettings(nextSettings, {
        draftSettings: { ...state.draftSettings, bundlePackage: value },
      });
    },
    setCreatorModifiedState(file: unknown) {
      updateCreatorSession({ modifiedFilePresent: !!file });
    },
    setCreatorOriginalState(file: unknown) {
      updateCreatorSession({ originalFilePresent: !!file });
    },
    setCreatorPatchType(patchType: unknown) {
      updateCreatorSession({ patchType: typeof patchType === "string" ? patchType : "bps" });
    },
    setCreatorSettingsState(settings: unknown) {
      updateCreatorSession({ outputName: getOutputName(settings) });
    },
    setLanguage(language: string) {
      const state = store.getState();
      if (state.settings.language === language) return;
      const validLanguages = new Set((SETTINGS_FIELD_METADATA.language.options || []).map((option) => option.value));
      if (!validLanguages.has(language)) return;
      const nextSettings = { ...copySettings(state.settings), language };
      persistSettings(nextSettings);
      applyCommittedSettings(nextSettings, {
        draftSettings: { ...state.draftSettings, language },
      });
    },
    setLogLevel(level: string) {
      const state = store.getState();
      if (state.settings.logLevel === level) return;
      const nextSettings = { ...copySettings(state.settings), logLevel: level };
      persistSettings(nextSettings);
      // Commit + persist + re-apply (configureLogger and the per-run logLevel
      // both read this), while preserving any unsaved settings-panel draft.
      applyCommittedSettings(nextSettings, {
        draftSettings: { ...state.draftSettings, logLevel: level },
      });
    },
    setPatcherInputState(inputs: readonly unknown[]) {
      updatePatcherSession({ romFilePresent: inputs.length > 0 });
    },
    setPatcherPatchState(patches: readonly unknown[]) {
      updatePatcherSession({ patchCount: patches.length });
    },
    setPatcherSettingsState(settings: unknown) {
      updatePatcherSession({
        outputCompression: getOutputCompression(settings),
        outputName: getOutputName(settings),
      });
    },
    setStartupState(status: StartupState["status"], message?: string) {
      setState({
        startup: {
          message: typeof message === "string" ? message : "",
          status,
        },
      });
    },
    setToolsSessionState(active: unknown) {
      const nextActive = !!active;
      if (store.getState().toolsSession.active === nextActive) return;
      setState({ toolsSession: { active: nextActive } });
    },
    setTrimOutputFormat(format: unknown) {
      updateTrimSession({ outputFormat: typeof format === "string" ? format : "" });
    },
    setTrimSettingsState(settings: unknown) {
      updateTrimSession({ outputName: getOutputName(settings) });
    },
    setTrimSourceState(file: unknown) {
      updateTrimSession({ sourceFilePresent: !!file });
    },
    subscribe(listener: () => void) {
      return store.subscribe(listener);
    },
    updateDraftSetting(field: keyof WebappState["draftSettings"], value: string | boolean) {
      const state = store.getState();
      const currentDraft = state.draftSettings;
      const nextDraft =
        field === "compressionProfile"
          ? {
              ...currentDraft,
              compressionProfile: getCompressionProfileFromIndex(
                SETTINGS_VALID_COMPRESSION_PROFILES,
                typeof value === "boolean" ? undefined : value,
                currentDraft.compressionProfile,
              ),
            }
          : { ...currentDraft, [field]: value };
      const validation = validateSettingsDraft(nextDraft, state.settings);
      setState({
        draftSettings: nextDraft,
        validation: validation.messages.length ? validation : emptyValidation(),
      });
    },
  };
};

export { areSettingsEqual, createWebappRootController, readWorkflowViewFromPath };
