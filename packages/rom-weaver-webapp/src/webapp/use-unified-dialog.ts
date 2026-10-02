import { useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "../lib/logging.ts";
import type { LogDialogTab, SettingsFocusHint } from "./components/log-dialog.tsx";
import type { WebappRootProps } from "./webapp-root-types.ts";

const logger = createLogger("webapp-root");

const loadLogDialog = () => import("./components/log-dialog.tsx").then((module) => ({ default: module.LogDialog }));
const loadSettingsPanel = () => import("./webapp-settings.tsx").then((module) => ({ default: module.SettingsPanel }));

/**
 * Each console section the user visits is a history entry, so the browser's
 * Back walks back through them and then closes the console. The hash, not
 * `history.state`, says which section an entry shows: route changes copy
 * `history.state` onto the next page's entry, but never the hash.
 */
const CONSOLE_HASH_PREFIX = "#console-";
const CONSOLE_TABS: readonly LogDialogTab[] = ["settings", "offline", "storage", "logs", "about"];
/** How many console entries sit on top of the page the console opened over. */
const CONSOLE_DEPTH_KEY = "romWeaverConsoleDepth";

const readConsoleHashTab = (): LogDialogTab | null => {
  if (typeof window === "undefined" || !window.location.hash.startsWith(CONSOLE_HASH_PREFIX)) return null;
  const tab = window.location.hash.slice(CONSOLE_HASH_PREFIX.length) as LogDialogTab;
  return CONSOLE_TABS.includes(tab) ? tab : null;
};

const readConsoleDepth = () => {
  const depth = (window.history.state as Record<string, unknown> | null)?.[CONSOLE_DEPTH_KEY];
  return typeof depth === "number" && depth > 0 ? depth : 0;
};

const pushConsoleEntry = (tab: LogDialogTab) => {
  if (typeof window === "undefined") return;
  const current = readConsoleHashTab();
  if (current === tab) return;
  const depth = current ? readConsoleDepth() + 1 : 1;
  const url = new URL(window.location.href);
  url.hash = `${CONSOLE_HASH_PREFIX}${tab}`;
  window.history.pushState({ ...(window.history.state as object | null), [CONSOLE_DEPTH_KEY]: depth }, "", url);
  logger.trace("console history entry", { depth, tab });
};

/** Pops every console entry, or strips the hash when the depth is unknown (a reload). */
const leaveConsoleHistory = () => {
  if (typeof window === "undefined" || !readConsoleHashTab()) return;
  const depth = readConsoleDepth();
  if (depth > 0) {
    window.history.go(-depth);
    return;
  }
  const url = new URL(window.location.href);
  url.hash = "";
  window.history.replaceState(window.history.state, "", url);
};

/** Open state, active section, and settings-draft close flow of the settings console. */
const useUnifiedDialog = (actions: WebappRootProps["actions"], state: WebappRootProps["state"]) => {
  const [logOpen, setLogOpen] = useState(false);
  const [logTab, setLogTab] = useState<LogDialogTab>("offline");
  const [settingsFocusHint, setSettingsFocusHint] = useState<SettingsFocusHint | null>(null);
  // The settings tab owns a draft, so closing it runs the controller's
  // discard-confirmation flow first; the dialog itself only closes once that
  // flow actually clears `settingsDialogOpen`.
  const settingsCloseArmedRef = useRef(false);
  const preloadSettingsPanel = useCallback(() => {
    void loadSettingsPanel().catch(() => undefined);
  }, []);
  const preloadLogDialog = useCallback(() => {
    void loadLogDialog().catch(() => undefined);
  }, []);
  /** Shows a section; `fromHistory` means the browser already moved, so nothing is pushed. */
  const showTab = useCallback(
    (tab: LogDialogTab, fromHistory = false) => {
      preloadLogDialog();
      // Reaching Settings MUST stage a draft exactly the way the gear does, or
      // the panel would edit a stale one.
      if (tab === "settings") {
        preloadSettingsPanel();
        settingsCloseArmedRef.current = false;
        actions.onOpenSettings();
      }
      setLogTab(tab);
      setLogOpen(true);
      if (!fromHistory) pushConsoleEntry(tab);
    },
    [actions, preloadLogDialog, preloadSettingsPanel],
  );
  // The panel is lazy, but the dialog opens immediately: its section list is
  // there at once, so a still-loading panel shows a usable frame rather than a
  // bare one. Hover/focus/idle preloads mean it is almost always resident.
  const openSettingsTab = useCallback(
    (fieldId?: string) => {
      setSettingsFocusHint(fieldId ? { fieldId, token: Date.now() } : null);
      showTab("settings");
    },
    [showTab],
  );
  const handleDialogTabChange = useCallback((tab: LogDialogTab) => showTab(tab), [showTab]);
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
  // However the console closed, its entries leave the history with it, so Back
  // from the page goes where it went before the console opened. A close that
  // navigates on (About's What's new) keeps them, so Back returns to About.
  const wasOpenRef = useRef(false);
  const keepHistoryRef = useRef(false);
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = logOpen;
    if (logOpen || !wasOpen) return;
    if (keepHistoryRef.current) {
      keepHistoryRef.current = false;
      return;
    }
    leaveConsoleHistory();
  }, [logOpen]);
  const closeDialogForNavigation = useCallback(() => {
    keepHistoryRef.current = true;
    closeDialog();
  }, [closeDialog]);
  // Back and Forward move between sections; leaving the last one closes the
  // console. A reload on a console entry opens it on that section.
  const closeDialogRef = useRef(closeDialog);
  closeDialogRef.current = closeDialog;
  const showTabRef = useRef(showTab);
  showTabRef.current = showTab;
  const logOpenRef = useRef(logOpen);
  logOpenRef.current = logOpen;
  useEffect(() => {
    const sync = () => {
      const tab = readConsoleHashTab();
      if (tab) showTabRef.current(tab, true);
      else if (logOpenRef.current) closeDialogRef.current();
    };
    if (readConsoleHashTab()) sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const openStatusTab = useCallback(() => showTab("offline"), [showTab]);
  const openStorageTab = useCallback(() => showTab("storage"), [showTab]);
  const openLogsTab = useCallback(() => showTab("logs"), [showTab]);
  return {
    closeDialog,
    closeDialogForNavigation,
    handleDialogTabChange,
    logOpen,
    logTab,
    openLogsTab,
    openSettingsTab,
    openStatusTab,
    openStorageTab,
    preloadLogDialog,
    preloadSettingsPanel,
    saveSettings,
    settingsFocusHint,
  };
};

export { loadLogDialog, loadSettingsPanel, useUnifiedDialog };
