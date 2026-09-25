import { useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "../lib/logging.ts";
import type { LogDialogTab, SettingsFocusHint } from "./components/log-dialog.tsx";
import type { WebappRootProps } from "./webapp-root-types.ts";

const logger = createLogger("webapp-root");

const loadLogDialog = () => import("./components/log-dialog.tsx").then((module) => ({ default: module.LogDialog }));
const loadSettingsPanel = () => import("./webapp-settings.tsx").then((module) => ({ default: module.SettingsPanel }));

/** Open state, active tab, and settings-draft close flow of the unified log/settings dialog. */
const useUnifiedDialog = (actions: WebappRootProps["actions"], state: WebappRootProps["state"]) => {
  const [logOpen, setLogOpen] = useState(false);
  const [logTab, setLogTab] = useState<LogDialogTab>("status");
  const [settingsFocusHint, setSettingsFocusHint] = useState<SettingsFocusHint | null>(null);
  // The settings tab owns a draft, so closing it runs the controller's
  // discard-confirmation flow first; the dialog itself only closes once that
  // flow actually clears `settingsDialogOpen`.
  const settingsCloseArmedRef = useRef(false);
  const preloadSettingsPanel = useCallback(() => {
    void loadSettingsPanel().catch(() => undefined);
  }, []);
  // The panel is lazy, but the dialog opens immediately: its tab rail is the
  // header, so a still-loading panel shows a usable frame rather than a bare
  // one. Hover/focus/idle preloads mean it is almost always already resident.
  const openSettingsTab = useCallback(
    (fieldId?: string) => {
      preloadSettingsPanel();
      settingsCloseArmedRef.current = false;
      setSettingsFocusHint(fieldId ? { fieldId, token: Date.now() } : null);
      setLogTab("settings");
      setLogOpen(true);
      actions.onOpenSettings();
    },
    [actions, preloadSettingsPanel],
  );
  const handleDialogTabChange = useCallback(
    (tab: LogDialogTab) => {
      setLogTab(tab);
      // Reaching Settings from inside the dialog must stage a draft exactly the
      // way the gear does, or the panel would edit a stale one.
      if (tab === "settings") {
        preloadSettingsPanel();
        actions.onOpenSettings();
      }
    },
    [actions, preloadSettingsPanel],
  );
  const closeDialog = useCallback(() => {
    if (!state.settingsDialogOpen) {
      setLogOpen(false);
      return;
    }
    settingsCloseArmedRef.current = true;
    actions.onCloseSettings();
  }, [actions, state.settingsDialogOpen]);
  const saveSettings = useCallback(() => {
    settingsCloseArmedRef.current = true;
    actions.onSaveClose();
  }, [actions]);
  useEffect(() => {
    if (state.settingsDialogOpen || !settingsCloseArmedRef.current) return;
    settingsCloseArmedRef.current = false;
    logger.trace("unified dialog closing after the settings draft settled");
    setLogOpen(false);
  }, [state.settingsDialogOpen]);
  const preloadLogDialog = useCallback(() => {
    void loadLogDialog().catch(() => undefined);
  }, []);
  const openStatusTab = useCallback(() => {
    preloadLogDialog();
    setLogTab("status");
    setLogOpen(true);
  }, [preloadLogDialog]);
  const openStorageTab = useCallback(() => {
    preloadLogDialog();
    setLogTab("storage");
    setLogOpen(true);
  }, [preloadLogDialog]);
  return {
    closeDialog,
    handleDialogTabChange,
    logOpen,
    logTab,
    openSettingsTab,
    openStatusTab,
    openStorageTab,
    preloadLogDialog,
    preloadSettingsPanel,
    saveSettings,
    setLogOpen,
    setLogTab,
    settingsFocusHint,
  };
};

export { loadLogDialog, loadSettingsPanel, useUnifiedDialog };
