import { useSyncExternalStore } from "react";
import { createLogger } from "../lib/logging.ts";

const logger = createLogger("advanced-settings");

// A view preference, not a setting: it only decides which controls the console
// shows, so it applies at once instead of waiting in the settings draft.
const ADVANCED_SETTINGS_STORAGE_KEY = "rom-weaver-advanced-settings";

const readStoredAdvanced = () => {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(ADVANCED_SETTINGS_STORAGE_KEY) === "on";
  } catch (error) {
    logger.trace("Unable to read the advanced settings preference", {
      message: error instanceof Error ? error.message : String(error || ""),
    });
    return false;
  }
};

let advanced: boolean | null = null;
const listeners = new Set<() => void>();

const getAdvancedSettings = () => {
  if (advanced === null) advanced = readStoredAdvanced();
  return advanced;
};

const setAdvancedSettings = (next: boolean) => {
  if (getAdvancedSettings() === next) return;
  advanced = next;
  logger.debug("Advanced settings toggled", { advanced: next });
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(ADVANCED_SETTINGS_STORAGE_KEY, next ? "on" : "off");
  } catch (error) {
    logger.trace("Unable to persist the advanced settings preference", {
      message: error instanceof Error ? error.message : String(error || ""),
    });
  }
  for (const listener of listeners) listener();
};

const subscribeAdvancedSettings = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getServerAdvancedSettings = () => false;

const useAdvancedSettings = () =>
  useSyncExternalStore(subscribeAdvancedSettings, getAdvancedSettings, getServerAdvancedSettings);

export { setAdvancedSettings, useAdvancedSettings };
