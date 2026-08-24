import { Database, Download, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { IdentifyDatabaseEntry, IdentifyDatabaseManager } from "../../lib/identify/identify-database-manager.ts";
import { createIdentifyDatabaseManager } from "../../lib/identify/identify-database-manager.ts";
import {
  readIdentifyDatabaseSettings,
  subscribeIdentifyDatabaseSettings,
  writeIdentifyDatabaseSettings,
} from "../../lib/identify/identify-database-settings.ts";
import { identifySourceLabel } from "../../presentation/identify-status.ts";
import { formatByteSize } from "../../presentation/workflow-presentation.ts";
import { Notice } from "../../public/react/components/ds/feedback.tsx";

let sharedManager: IdentifyDatabaseManager | undefined;

/** One manager per page, wired to the live index/catalog loaders. */
const getSharedIdentifyDatabaseManager = (): IdentifyDatabaseManager => {
  if (!sharedManager) {
    sharedManager = createIdentifyDatabaseManager({
      loadCatalogIndex: async () => {
        const { loadIdentifyCatalogIndex } = await import("../../platform/browser/identify-packs.ts");
        return loadIdentifyCatalogIndex();
      },
    });
  }
  return sharedManager;
};

/** Test hook: replace the shared manager (pass `undefined` to restore the default). */
const setSharedIdentifyDatabaseManagerForTests = (manager: IdentifyDatabaseManager | undefined) => {
  sharedManager = manager;
};

const STATE_LABEL: Record<IdentifyDatabaseEntry["state"], string> = {
  cached: "Downloaded",
  downloading: "Downloading…",
  error: "Failed",
  "not-downloaded": "Not downloaded",
  stale: "Update available",
};

const useIdentifyDatabaseSettings = () => {
  const [settings, setSettings] = useState(readIdentifyDatabaseSettings);
  useEffect(() => subscribeIdentifyDatabaseSettings(setSettings), []);
  return settings;
};

/**
 * The consent statement MUST make three facts explicit before the first
 * network fetch of a Hasheous pack: ROM bytes never leave the browser, only
 * database files are downloaded, and where those files come from.
 */
const ConsentPrompt = ({
  onAllow,
  onDismiss,
  origin,
}: {
  onAllow: () => void;
  onDismiss: () => void;
  origin: string;
}) => (
  <Notice level="warn">
    <p>
      Hasheous identification databases are downloaded over the network. Your ROMs and their bytes never leave this
      browser - only database files are downloaded, from{" "}
      <span className="mono">{origin || "this site's own assets"}</span>.
    </p>
    <div className="identify-db-consent-actions">
      <button aria-label="Allow database downloads" className="rb" onClick={onAllow} type="button">
        Allow downloads
      </button>
      <button aria-label="Do not allow database downloads" className="rb" onClick={onDismiss} type="button">
        Not now
      </button>
    </div>
  </Notice>
);

const EntryRow = ({
  entry,
  onDownload,
  onRemove,
}: {
  entry: IdentifyDatabaseEntry;
  onDownload: (entry: IdentifyDatabaseEntry) => void;
  onRemove: (entry: IdentifyDatabaseEntry) => void;
}) => {
  const busy = entry.state === "downloading";
  const downloaded = entry.state === "cached" || entry.state === "stale";
  // A failed update keeps the verified older copy in the store, so Remove
  // stays available while the row shows the error.
  const removable = downloaded || entry.cachedCopy === true;
  const actionLabel = entry.state === "error" ? "Retry" : entry.state === "stale" ? "Update" : "Download";
  return (
    <li className="identify-db-row">
      <div className="identify-db-row-main">
        <span className="identify-db-platform">{entry.platform}</span>
        <span className="rb mono muted">
          {[identifySourceLabel(entry.source), entry.packFormat, entry.sizeBytes ? formatByteSize(entry.sizeBytes) : ""]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <span className="rb mono identify-db-state" data-state={entry.state}>
          {STATE_LABEL[entry.state]}
        </span>
      </div>
      {entry.error ? <p className="pdesc identify-db-error">{entry.error}</p> : null}
      <div className="identify-db-row-actions">
        {downloaded && entry.state !== "stale" ? null : (
          <button
            aria-label={`${actionLabel} the ${entry.platform} identification database`}
            className="rb"
            disabled={busy}
            onClick={() => onDownload(entry)}
            type="button"
          >
            {entry.state === "error" ? <RefreshCw aria-hidden="true" /> : <Download aria-hidden="true" />}
            {actionLabel}
          </button>
        )}
        {removable ? (
          <button
            aria-label={`Remove the ${entry.platform} identification database`}
            className="rb"
            disabled={busy}
            onClick={() => onRemove(entry)}
            type="button"
          >
            <Trash2 aria-hidden="true" />
            Remove
          </button>
        ) : null}
      </div>
    </li>
  );
};

/**
 * Lists every catalog platform with its database state and owns the download /
 * update / remove / retry actions. Hasheous downloads are gated behind the
 * persisted consent; the consent prompt appears on the first download attempt.
 */
const IdentifyDatabaseManagerPanel = () => {
  const manager = getSharedIdentifyDatabaseManager();
  const snapshot = useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
  const settings = useIdentifyDatabaseSettings();
  const [consentFor, setConsentFor] = useState<IdentifyDatabaseEntry | null>(null);
  const [originDraft, setOriginDraft] = useState(settings.identifyDatabaseOrigin);

  useEffect(() => {
    void manager.refresh();
  }, [manager]);

  const download = useCallback(
    (entry: IdentifyDatabaseEntry) => {
      if (entry.source === "hasheous" && !readIdentifyDatabaseSettings().hasheousConsent) {
        setConsentFor(entry);
        return;
      }
      void manager.download(entry.slug).catch(() => undefined);
    },
    [manager],
  );

  const remove = useCallback(
    (entry: IdentifyDatabaseEntry) => {
      void manager.remove(entry.slug).catch(() => undefined);
    },
    [manager],
  );

  return (
    <div className="identify-db-manager" id="identify-database-manager">
      <p className="pdesc">
        Identification databases are downloaded per platform and cached in this browser. Your ROMs never leave this
        browser; only database files are downloaded.
      </p>
      {snapshot.generatedLabel ? <p className="pdesc mono muted">Data: {snapshot.generatedLabel}</p> : null}
      {snapshot.loadError ? (
        <Notice level="warn">
          The database catalog could not be loaded: {snapshot.loadError}
          <button
            aria-label="Retry loading the database catalog"
            className="rb"
            onClick={() => void manager.refresh()}
            type="button"
          >
            Retry
          </button>
        </Notice>
      ) : null}
      {consentFor ? (
        <ConsentPrompt
          onAllow={() => {
            writeIdentifyDatabaseSettings({ hasheousConsent: true });
            const entry = consentFor;
            setConsentFor(null);
            void manager.download(entry.slug).catch(() => undefined);
          }}
          onDismiss={() => setConsentFor(null)}
          origin={settings.identifyDatabaseOrigin}
        />
      ) : null}
      {snapshot.loading && !snapshot.entries.length ? (
        <p className="pdesc muted">Loading the database catalog…</p>
      ) : null}
      {snapshot.loading || snapshot.loadError || snapshot.entries.length ? null : (
        <p className="pdesc muted">This deployment ships no database catalog, so there is nothing to manage here.</p>
      )}
      {snapshot.entries.length ? (
        <ul className="identify-db-list">
          {snapshot.entries.map((entry) => (
            <EntryRow entry={entry} key={entry.slug} onDownload={download} onRemove={remove} />
          ))}
        </ul>
      ) : null}
      <div className="identify-db-origin">
        <label className="pdesc" htmlFor="identify-database-origin">
          Hasheous database origin (empty uses this site&rsquo;s own assets; a self-hosted origin must send CORS
          headers)
        </label>
        <div className="identify-db-origin-row">
          <input
            aria-label="Hasheous database origin"
            className="mono"
            id="identify-database-origin"
            onChange={(event) => setOriginDraft(event.target.value)}
            placeholder="https://example.com/identify"
            type="text"
            value={originDraft}
          />
          <button
            aria-label="Save the Hasheous database origin"
            className="rb"
            disabled={originDraft.trim() === settings.identifyDatabaseOrigin}
            onClick={() => writeIdentifyDatabaseSettings({ identifyDatabaseOrigin: originDraft.trim() })}
            type="button"
          >
            Save
          </button>
        </div>
      </div>
      {settings.hasheousConsent ? (
        <button
          aria-label="Withdraw consent for database downloads"
          className="rb identify-db-consent-withdraw"
          onClick={() => writeIdentifyDatabaseSettings({ hasheousConsent: false })}
          type="button"
        >
          <Database aria-hidden="true" />
          Stop allowing database downloads
        </button>
      ) : null}
    </div>
  );
};

export { getSharedIdentifyDatabaseManager, IdentifyDatabaseManagerPanel, setSharedIdentifyDatabaseManagerForTests };
