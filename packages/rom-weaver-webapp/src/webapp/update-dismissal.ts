import { createLogger } from "../lib/logging.ts";
import { APP_BUILD_VERSION } from "./build-version.ts";

const logger = createLogger("webapp-root");

// Dismissing the update banner is remembered per running build: the same
// pending update never re-prompts on reload, while an actual update changes
// APP_BUILD_VERSION and re-arms the banner for the next one.
const UPDATE_DISMISSED_STORAGE_KEY = "rom-weaver-update-dismissed-build";

const readUpdateDismissed = () => {
  if (typeof localStorage === "undefined") return false;
  try {
    return localStorage.getItem(UPDATE_DISMISSED_STORAGE_KEY) === APP_BUILD_VERSION;
  } catch (error) {
    logger.trace("Unable to read update banner dismissal", {
      message: error instanceof Error ? error.message : String(error || ""),
    });
    return false;
  }
};

const writeUpdateDismissed = () => {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(UPDATE_DISMISSED_STORAGE_KEY, APP_BUILD_VERSION);
    logger.debug("Update banner dismissed", { build: APP_BUILD_VERSION });
  } catch (error) {
    logger.trace("Unable to persist update banner dismissal", {
      message: error instanceof Error ? error.message : String(error || ""),
    });
  }
};

export { readUpdateDismissed, writeUpdateDismissed };
