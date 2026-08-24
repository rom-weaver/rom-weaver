/**
 * State machine behind the identify database manager UI. It lists every
 * catalog platform with its pack state, and owns the download / update /
 * remove / retry actions. Hard rules it enforces:
 *
 * - A Hasheous pack is fetched over the network only after explicit user
 *   consent ({@link IdentifyConsentRequiredError} otherwise).
 * - Downloaded bytes MUST match the expected SHA-256 (and size, when known)
 *   before they are stored; a failed download or verification never evicts a
 *   previously good cached pack.
 */
import { createLogger } from "../logging.ts";
import type { IdentifyCatalog, IdentifyCatalogSource } from "./identify-catalog.ts";
import { readIdentifyDatabaseSettings } from "./identify-database-settings.ts";
import { deleteIdentifyPackFromRuntimeCaches, getDefaultIdentifyPackStore } from "./identify-pack-store.ts";
import type { IdentifyPackStore } from "./identify-pack-store.ts";
import { sha256Hex } from "./sha256-hex.ts";

const logger = createLogger("identify-database");

type IdentifyDatabaseEntryState = "cached" | "downloading" | "error" | "not-downloaded" | "stale";

type IdentifyDatabaseErrorKind = "consent" | "http" | "integrity" | "network";

type IdentifyDatabaseEntry = {
  /** A verified copy is in the store, even when a later update attempt failed. */
  cachedCopy?: boolean;
  error?: string;
  errorKind?: IdentifyDatabaseErrorKind;
  fileName: string;
  packFormat: string;
  platform: string;
  /** Compressed transfer size is unknown here; this is the raw pack size when the index lists it. */
  sizeBytes?: number;
  sha256: string;
  slug: string;
  source: IdentifyCatalogSource;
  state: IdentifyDatabaseEntryState;
};

type IdentifyDatabaseSnapshot = {
  entries: IdentifyDatabaseEntry[];
  /** Human-readable data revision per source, from the catalog's `generated` block. */
  generatedLabel?: string;
  loadError?: string;
  loading: boolean;
};

/** Raised when a Hasheous download is requested without stored consent. */
class IdentifyConsentRequiredError extends Error {
  constructor() {
    super("Hasheous database downloads need your consent first.");
    this.name = "IdentifyConsentRequiredError";
  }
}

type IndexSystemInfo = { file: string; rawBytes?: number; sha256?: string; slug: string };

type ManagerDeps = {
  fetchImpl?: typeof fetch;
  /** Loads index.json + catalog.json. The default lives in the browser platform layer. */
  loadCatalogIndex: () => Promise<{ catalog?: IdentifyCatalog; systems: IndexSystemInfo[] }>;
  readConsent?: () => boolean;
  resolvePackUrl?: (entry: IdentifyDatabaseEntry) => string;
  store?: IdentifyPackStore;
};

type IdentifyDatabaseManager = {
  download: (slug: string) => Promise<void>;
  getSnapshot: () => IdentifyDatabaseSnapshot;
  refresh: () => Promise<IdentifyDatabaseSnapshot>;
  remove: (slug: string) => Promise<void>;
  subscribe: (listener: () => void) => () => void;
};

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const createIdentifyDatabaseManager = (deps: ManagerDeps): IdentifyDatabaseManager => {
  const store = deps.store ?? getDefaultIdentifyPackStore();
  const fetchImpl = deps.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const readConsent = deps.readConsent ?? (() => readIdentifyDatabaseSettings().hasheousConsent);
  const listeners = new Set<() => void>();
  let snapshot: IdentifyDatabaseSnapshot = { entries: [], loading: false };
  let catalogPromise: Promise<{ catalog?: IdentifyCatalog; systems: IndexSystemInfo[] }> | undefined;

  const emit = (next: IdentifyDatabaseSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };

  const patchEntry = (slug: string, patch: Partial<IdentifyDatabaseEntry>) => {
    emit({
      ...snapshot,
      entries: snapshot.entries.map((entry) => (entry.slug === slug ? { ...entry, ...patch } : entry)),
    });
  };

  const loadCatalogIndexOnce = () => {
    if (!catalogPromise) {
      catalogPromise = deps.loadCatalogIndex().catch((error) => {
        catalogPromise = undefined;
        throw error;
      });
    }
    return catalogPromise;
  };

  const refresh = async (): Promise<IdentifyDatabaseSnapshot> => {
    emit({ ...snapshot, loadError: undefined, loading: true });
    try {
      const { catalog, systems } = await loadCatalogIndexOnce();
      const stored = new Map((await store.keys()).map((key) => [key.fileName, key.sha256]));
      const bySlug = new Map(systems.map((system) => [system.slug, system]));
      const entries: IdentifyDatabaseEntry[] = (catalog?.platforms ?? []).map((platform) => {
        const system = bySlug.get(platform.packSlug);
        const fileName = system?.file || `${platform.packSlug}.pack`;
        const sha256 = platform.packSha256 || system?.sha256 || "";
        const storedSha = stored.get(fileName);
        const previous = snapshot.entries.find((entry) => entry.slug === platform.packSlug);
        const state: IdentifyDatabaseEntryState =
          previous?.state === "downloading"
            ? "downloading"
            : storedSha === undefined
              ? "not-downloaded"
              : sha256 && storedSha !== sha256
                ? "stale"
                : "cached";
        return {
          ...(storedSha === undefined ? {} : { cachedCopy: true }),
          ...(previous?.error ? { error: previous.error, errorKind: previous.errorKind } : {}),
          fileName,
          packFormat: platform.packFormat,
          platform: platform.canonicalPlatform,
          sha256,
          ...(system?.rawBytes ? { sizeBytes: system.rawBytes } : {}),
          slug: platform.packSlug,
          source: platform.source,
          state: previous?.error ? "error" : state,
        };
      });
      const generatedParts: string[] = [];
      if (catalog?.generated?.opengoodRevision) {
        generatedParts.push(`OpenGood revision ${catalog.generated.opengoodRevision.slice(0, 12)}`);
      }
      if (catalog?.generated?.hasheousDump?.fileName) {
        generatedParts.push(`Hasheous dump ${catalog.generated.hasheousDump.fileName}`);
      }
      emit({
        entries,
        ...(generatedParts.length ? { generatedLabel: generatedParts.join(" · ") } : {}),
        loading: false,
      });
    } catch (error) {
      logger.warn("identify database catalog load failed", { error: describe(error) });
      emit({ ...snapshot, loadError: describe(error), loading: false });
    }
    return snapshot;
  };

  const resolvePackUrl = (entry: IdentifyDatabaseEntry): string => {
    if (deps.resolvePackUrl) return deps.resolvePackUrl(entry);
    const origin = readIdentifyDatabaseSettings().identifyDatabaseOrigin;
    const base =
      entry.source === "hasheous" && origin
        ? new URL(`${origin.replace(/\/+$/u, "")}/${entry.fileName}`)
        : new URL(`assets/identify-${entry.fileName}`, document.baseURI);
    if (entry.sha256) base.searchParams.set("sha256", entry.sha256);
    return base.href;
  };

  const download = async (slug: string): Promise<void> => {
    const entry = snapshot.entries.find((candidate) => candidate.slug === slug);
    if (!entry) throw new Error(`Unknown identify database: ${slug}`);
    if (entry.source === "hasheous" && !readConsent()) throw new IdentifyConsentRequiredError();
    patchEntry(slug, { error: undefined, errorKind: undefined, state: "downloading" });
    const fail = (message: string, errorKind: IdentifyDatabaseErrorKind) => {
      logger.warn("identify database download failed", { errorKind, message, slug });
      patchEntry(slug, { error: message, errorKind, state: "error" });
      throw new Error(message);
    };
    let url: string;
    try {
      url = resolvePackUrl(entry);
    } catch (cause) {
      return fail(`The configured database origin is not a valid URL: ${describe(cause)}`, "network");
    }
    let response: Response;
    try {
      response = await fetchImpl(url);
    } catch (cause) {
      // A cross-origin fetch rejected by a missing CORS header lands here as a
      // TypeError, indistinguishable from a network outage - name both causes.
      return fail(
        `The database download failed (network error or missing CORS headers on ${new URL(url).origin}): ${describe(cause)}`,
        "network",
      );
    }
    if (!response.ok) return fail(`The database download failed with HTTP ${response.status}.`, "http");
    // Every step below MUST route through fail(): an exception that escapes
    // would leave the row stuck in "downloading" with its actions disabled.
    let bytes: ArrayBuffer;
    try {
      bytes = await response.arrayBuffer();
    } catch (cause) {
      return fail(`The database download failed while reading the response: ${describe(cause)}`, "network");
    }
    if (entry.sizeBytes !== undefined && bytes.byteLength !== entry.sizeBytes) {
      return fail("The downloaded database has the wrong size. The cached copy, if any, is unchanged.", "integrity");
    }
    let digest = "";
    try {
      digest = entry.sha256 ? await sha256Hex(bytes) : "";
    } catch (cause) {
      return fail(`The downloaded database could not be verified: ${describe(cause)}`, "integrity");
    }
    if (entry.sha256 && digest !== entry.sha256) {
      return fail(
        "The downloaded database failed its checksum check. The cached copy, if any, is unchanged.",
        "integrity",
      );
    }
    try {
      await store.put(entry.fileName, entry.sha256, bytes);
    } catch (cause) {
      return fail(`The verified database could not be stored: ${describe(cause)}`, "integrity");
    }
    logger.info("identify database stored", { bytes: bytes.byteLength, slug });
    patchEntry(slug, { cachedCopy: true, error: undefined, errorKind: undefined, state: "cached" });
  };

  const remove = async (slug: string): Promise<void> => {
    const entry = snapshot.entries.find((candidate) => candidate.slug === slug);
    if (!entry) return;
    await store.delete(entry.fileName);
    await deleteIdentifyPackFromRuntimeCaches(entry.fileName).catch(() => undefined);
    logger.info("identify database removed", { slug });
    patchEntry(slug, { error: undefined, errorKind: undefined, state: "not-downloaded" });
  };

  return {
    download,
    getSnapshot: () => snapshot,
    refresh,
    remove,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

export { createIdentifyDatabaseManager, IdentifyConsentRequiredError };
export type { IdentifyDatabaseEntry, IdentifyDatabaseManager };
