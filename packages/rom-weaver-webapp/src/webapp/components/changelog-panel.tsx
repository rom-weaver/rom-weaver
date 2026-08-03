import { useCallback, useEffect, useRef, useState } from "react";
import { createLogger } from "../../lib/logging.ts";
import type { Localizer } from "../../presentation/localization/index.ts";
import { APP_VERSION, COMMITS_SINCE_VERSION } from "../build-version.ts";
import {
  type ChangelogEntry,
  commitGroups,
  EntryGroups,
  fetchChangelog,
  type ReleaseChangelog,
  releaseTagUrl,
  REPOSITORY_URL,
} from "./changelog-source.tsx";
import { ChangelogUpdate } from "./changelog-update.tsx";

/**
 * The Changelog tab: what has shipped, newest first, from `changelog.json`.
 * When a deploy is waiting, {@link ChangelogUpdate} leads the tab with the
 * other question the same file answers - "what am I about to get" - so the
 * update notification and the version chip both land here rather than on a
 * dialog of their own. This half never slices against the running build.
 *
 * Releases are collapsed sections with the newest open, because the reason to
 * open this tab is almost always the newest one. Ahead of the last release
 * comes "Unreleased", carrying the commits the build tag's `+N` counts. Builds
 * with no release payload at all - nightly, PR previews, local - have only
 * those commits, so Unreleased is the whole tab and stays open.
 */

const logger = createLogger("changelog-panel");

type FetchState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; entries: ChangelogEntry[]; release?: ReleaseChangelog };

// The build tag's `+N`: commits made after the version this build claims. They
// are the newest N in the log, since the log is newest-first and the release
// commit sits directly under them. The count comes from the build rather than
// from the log's length, which is only where the emitter capped it.
const AHEAD_COUNT = typeof COMMITS_SINCE_VERSION === "number" && COMMITS_SINCE_VERSION > 0 ? COMMITS_SINCE_VERSION : 0;

const ReleaseSection = ({
  defaultOpen,
  groups,
  note,
  repositoryUrl,
  title,
  versionHref,
}: {
  defaultOpen: boolean;
  groups: ReturnType<typeof commitGroups>;
  /** Trails the title where it says something the title does not. */
  note?: string;
  repositoryUrl: string;
  title: string;
  versionHref?: string;
}) => (
  <details className="rel" open={defaultOpen}>
    <summary className="rel-summary">
      <b className="mono">{title}</b>
      {note ? <span className="rel-summary-count">{note}</span> : null}
    </summary>
    <div className="rel-body">
      <EntryGroups groups={groups} keyPrefix={title} repositoryUrl={repositoryUrl} />
      {versionHref ? (
        <a className="rel-link" href={versionHref} rel="noreferrer" target="_blank">
          View release ↗
        </a>
      ) : null}
    </div>
  </details>
);

const ChangelogPanel = ({
  active,
  localizer,
  onReload,
  updateReady = false,
}: {
  active: boolean;
  localizer: Localizer;
  /** Reloads into the waiting deploy; only offered while one is waiting. */
  onReload?: () => void;
  updateReady?: boolean;
}) => {
  const [state, setState] = useState<FetchState>({ status: "loading" });
  // Retry and re-open share one loader, so the newest request is the only one
  // allowed to land - a slow first fetch cannot overwrite a fast retry.
  const requestRef = useRef(0);

  const load = useCallback(() => {
    requestRef.current += 1;
    const request = requestRef.current;
    setState({ status: "loading" });
    fetchChangelog()
      .then(({ entries, release }) => {
        if (request !== requestRef.current) return;
        logger.trace("changelog tab loaded", { entries: entries.length, releases: release?.notes.length ?? 0 });
        setState({ entries, release, status: "loaded" });
      })
      .catch((error) => {
        if (request !== requestRef.current) return;
        logger.warn("Changelog tab load failed", { message: String(error) });
        setState({ status: "error" });
      });
  }, []);

  useEffect(() => {
    if (active) load();
  }, [active, load]);

  if (state.status === "loading") return <div className="changelog-note">…</div>;
  if (state.status === "error") {
    return (
      <div className="changelog-note">
        <button className="btn slim ghost" onClick={load} type="button">
          {localizer.message("ui.common.retry")}
        </button>
      </div>
    );
  }

  const repositoryUrl = state.release?.repositoryUrl ?? REPOSITORY_URL;
  const unreleased = state.entries.slice(0, AHEAD_COUNT);
  // Commits older than the ahead window belong to versions already released. A
  // release build describes those properly in its notes; a build without them
  // would otherwise drop the rest of the fetched log on the floor, so it keeps
  // them under one honest heading instead.
  const earlier = state.release ? [] : state.entries.slice(AHEAD_COUNT);
  const notes = state.release?.notes ?? [];
  const moreUrl = state.release?.changelogUrl ?? `${repositoryUrl}/commits/main`;

  return (
    <div className="changelog-list">
      {updateReady ? (
        <ChangelogUpdate entries={state.entries} localizer={localizer} onReload={onReload} release={state.release} />
      ) : null}
      {unreleased.length ? (
        <ReleaseSection
          defaultOpen
          groups={commitGroups(unreleased)}
          note={`since v${APP_VERSION}`}
          repositoryUrl={repositoryUrl}
          title={`Unreleased · +${AHEAD_COUNT}`}
        />
      ) : null}
      {notes.map((note, index) => (
        <ReleaseSection
          defaultOpen={!unreleased.length && index === 0}
          groups={note.groups}
          key={note.version}
          note={note.version === APP_VERSION ? "running" : undefined}
          repositoryUrl={repositoryUrl}
          title={`v${note.version}`}
          versionHref={releaseTagUrl(repositoryUrl, note.version)}
        />
      ))}
      {earlier.length ? (
        <ReleaseSection
          defaultOpen={false}
          groups={commitGroups(earlier)}
          note="already released"
          repositoryUrl={repositoryUrl}
          title="Earlier"
        />
      ) : null}
      {unreleased.length || notes.length || earlier.length ? null : (
        <div className="changelog-note">No changes recorded.</div>
      )}
      <div className="changelog-note">
        <a className="changelog-more" href={moreUrl} rel="noreferrer" target="_blank">
          Full changelog ↗
        </a>
      </div>
    </div>
  );
};

export { ChangelogPanel };
