import { createLogger } from "../lib/logging.ts";
import { APP_VERSION } from "./build-version.ts";

const logger = createLogger("last-seen-version");

// The newest release a visitor has been told about, so the first load of a newer
// one can tell them it changed.
const LAST_SEEN_VERSION_STORAGE_KEY = "rom-weaver-last-seen-version";

/** What this load updated a returning visitor from; `from` is absent when no earlier version was recorded. */
type UpdatedSince = { from?: string };

const versionParts = (version: string) => version.split(/[.+-]/, 3).map((part) => Number.parseInt(part, 10) || 0);

/** Compares major.minor.patch numerically; prerelease and build suffixes do not count. */
const isNewerVersion = (version: string, than: string): boolean => {
  const next = versionParts(version);
  const previous = versionParts(than);
  for (let index = 0; index < 3; index += 1) {
    const difference = (next[index] ?? 0) - (previous[index] ?? 0);
    if (difference) return difference > 0;
  }
  return false;
};

/** Whether a release arrived with this update. Without a recorded version only the running release counts. */
const isNewRelease = (version: string, since: UpdatedSince): boolean => {
  if (isNewerVersion(version, APP_VERSION)) return false;
  if (since.from) return isNewerVersion(version, since.from);
  return !isNewerVersion(APP_VERSION, version);
};

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error || ""));

// A service worker only controls a page loaded before, so a controlled page
// without a record is a visitor from a build that predates it, not a first visit.
const isControlledByServiceWorker = () =>
  typeof navigator !== "undefined" && Boolean(navigator.serviceWorker?.controller);

/**
 * Records the running version on a first visit, so the next release has something to compare with.
 * Boot calls it before rendering can wait on a service worker: once one controls the page, as it
 * does after the reload that adds cross-origin isolation headers, a first visit looks like a return.
 */
const recordFirstVisit = () => {
  try {
    if (localStorage.getItem(LAST_SEEN_VERSION_STORAGE_KEY) !== null || isControlledByServiceWorker()) return;
    localStorage.setItem(LAST_SEEN_VERSION_STORAGE_KEY, APP_VERSION);
    logger.debug("Recorded first seen version", { version: APP_VERSION });
  } catch (error) {
    logger.trace("Unable to record first seen version", { message: describeError(error) });
  }
};

/** Reads what this load updated the visitor from, or null when there is nothing to announce. */
const resolveUpdatedSince = (): UpdatedSince | null => {
  try {
    const lastSeen = localStorage.getItem(LAST_SEEN_VERSION_STORAGE_KEY);
    if (lastSeen !== null) return isNewerVersion(APP_VERSION, lastSeen) ? { from: lastSeen } : null;
    if (isControlledByServiceWorker()) return {};
  } catch (error) {
    // Without storage there is no telling what the visitor saw last, so nothing is announced.
    logger.trace("Unable to read last seen version", { message: describeError(error) });
    return null;
  }
  recordFirstVisit();
  return null;
};

/**
 * Records a release as seen. The record only moves forward, so acknowledging the running release
 * never undoes a newer one the visitor already read about before reloading into it.
 */
const writeLastSeenVersion = (version = APP_VERSION) => {
  try {
    const lastSeen = localStorage.getItem(LAST_SEEN_VERSION_STORAGE_KEY);
    if (lastSeen !== null && !isNewerVersion(version, lastSeen)) return;
    localStorage.setItem(LAST_SEEN_VERSION_STORAGE_KEY, version);
    logger.debug("Recorded last seen version", { version });
  } catch (error) {
    logger.trace("Unable to persist last seen version", { message: describeError(error) });
  }
};

export { isNewerVersion, isNewRelease, recordFirstVisit, resolveUpdatedSince, writeLastSeenVersion };
export type { UpdatedSince };
