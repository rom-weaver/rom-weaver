/**
 * Persisted identify-database preferences: the one-time consent to download
 * Hasheous-derived packs over the network, and the origin those packs come
 * from. Stored under a dedicated localStorage key (the same lightweight
 * pattern the update-banner dismissal uses) so the versioned settings payload
 * is untouched.
 */
const IDENTIFY_DATABASE_SETTINGS_KEY = "rom-weaver-identify-database-v1";

type IdentifyDatabaseSettings = {
  /** Explicit user consent to fetch Hasheous packs over the network. */
  hasheousConsent: boolean;
  /**
   * Origin (base URL) Hasheous packs are downloaded from. Empty means the
   * same-origin `assets/identify-` path the OpenGood packs use. A self-hosted
   * cross-origin value MUST serve CORS headers (`Access-Control-Allow-Origin`)
   * or every download fails; the manager surfaces that failure explicitly.
   */
  identifyDatabaseOrigin: string;
};

const DEFAULT_SETTINGS: IdentifyDatabaseSettings = { hasheousConsent: false, identifyDatabaseOrigin: "" };

type Listener = (settings: IdentifyDatabaseSettings) => void;
const listeners = new Set<Listener>();

const readIdentifyDatabaseSettings = (): IdentifyDatabaseSettings => {
  try {
    if (typeof localStorage === "undefined") return { ...DEFAULT_SETTINGS };
    const raw = localStorage.getItem(IDENTIFY_DATABASE_SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<IdentifyDatabaseSettings> | null;
    return {
      hasheousConsent: parsed?.hasheousConsent === true,
      identifyDatabaseOrigin:
        typeof parsed?.identifyDatabaseOrigin === "string" ? parsed.identifyDatabaseOrigin.trim() : "",
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
};

const writeIdentifyDatabaseSettings = (update: Partial<IdentifyDatabaseSettings>): IdentifyDatabaseSettings => {
  const next = { ...readIdentifyDatabaseSettings(), ...update };
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(IDENTIFY_DATABASE_SETTINGS_KEY, JSON.stringify(next));
    }
  } catch {
    // Private-mode storage failures degrade to session-only settings.
  }
  for (const listener of listeners) listener(next);
  return next;
};

const subscribeIdentifyDatabaseSettings = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export { readIdentifyDatabaseSettings, subscribeIdentifyDatabaseSettings, writeIdentifyDatabaseSettings };
