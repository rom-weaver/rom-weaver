import { useSyncExternalStore } from "react";
import { createLogger } from "../lib/logging.ts";

/**
 * Theme store for the redesigned UI. Persists the user's explicit choice to
 * localStorage and otherwise follows the OS `prefers-color-scheme`. The active
 * theme is reflected on `<html data-theme>` so the `:root[data-theme]` token
 * blocks in design-system/tokens.css resolve. Framework-agnostic core + a React hook.
 */

type Theme = "dark" | "light";
type ThemePreference = Theme | "auto";

const logger = createLogger("theme");

const STORAGE_KEY = "rom-weaver-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

const listeners = new Set<() => void>();
let current: Theme = "dark";
let userPreference: ThemePreference = "auto";
let initialized = false;

const isThemePreference = (value: unknown): value is ThemePreference =>
  value === "auto" || value === "dark" || value === "light";

const readStoredPreference = (): ThemePreference | null => {
  if (typeof localStorage === "undefined") return null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isThemePreference(stored) ? stored : null;
  } catch (error) {
    logger.trace("Unable to read stored theme preference", {
      message: error instanceof Error ? error.message : String(error || ""),
    });
    return null;
  }
};

const writeStoredPreference = (preference: ThemePreference) => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch (error) {
    logger.trace("Unable to persist theme preference", {
      message: error instanceof Error ? error.message : String(error || ""),
    });
  }
};

const getSystemTheme = (): Theme => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "dark";
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
};

// Browser chrome (address bar / PWA title bar) follows the loom chassis color.
const THEME_COLORS: Record<Theme, string> = { dark: "#0c0f13", light: "#eaedf1" };

const applyTheme = (theme: Theme) => {
  current = theme;
  if (typeof document !== "undefined" && document.documentElement) {
    document.documentElement.setAttribute("data-theme", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[theme]);
  }
  logger.trace("Applied theme", { theme, userPreference });
};

const notify = () => {
  for (const listener of listeners) listener();
};

const setTheme = (theme: Theme): boolean => {
  if (theme === current && initialized) return false;
  applyTheme(theme);
  notify();
  return true;
};

const setPreference = (preference: ThemePreference) => {
  userPreference = preference;
  writeStoredPreference(preference);
  const changed = setTheme(preference === "auto" ? getSystemTheme() : preference);
  if (!changed) notify();
};

/**
 * Resolve and apply the initial theme. Safe to call multiple times; only the
 * first call wires up the system-preference listener.
 */
const initTheme = () => {
  if (initialized) return;
  initialized = true;
  userPreference = readStoredPreference() ?? "auto";
  applyTheme(userPreference === "auto" ? getSystemTheme() : userPreference);
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const media = window.matchMedia(DARK_QUERY);
    const handleSystemChange = () => {
      // System changes only drive the UI while the user hasn't picked a theme.
      if (userPreference !== "auto") return;
      setTheme(getSystemTheme());
    };
    if (typeof media.addEventListener === "function") media.addEventListener("change", handleSystemChange);
    else if (typeof media.addListener === "function") media.addListener(handleSystemChange);
  }
  logger.debug("Theme initialized", { theme: current, userPreference });
};

const getTheme = (): Theme => current;
const getPreference = (): ThemePreference => userPreference;
const getServerTheme = (): Theme => "dark";
const getServerPreference = (): ThemePreference => "auto";

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

// Apply the initial theme as a side effect on import so the attribute is set
// before the React tree renders (avoids a theme flash on first paint).
initTheme();

const useTheme = (): {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  toggleTheme: () => void;
} => {
  const theme = useSyncExternalStore(subscribe, getTheme, getServerTheme);
  const preference = useSyncExternalStore(subscribe, getPreference, getServerPreference);
  const toggleTheme = () => setPreference(theme === "dark" ? "light" : "dark");
  return { theme, preference, setPreference, toggleTheme };
};

export { useTheme };
export type { ThemePreference };
