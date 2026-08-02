import { useEffect, useState } from "react";
import { createLogger } from "../../lib/logging.ts";
import { Modal } from "../../public/react/components/ds/index.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { APP_BUILD_VERSION, APP_VERSION, COMMIT_HASH } from "../build-version.ts";
import {
  type ChangelogEntry,
  commitGroups,
  EntryGroups,
  fetchChangelog,
  type ReleaseChangelog,
  type ReleaseNote,
  releaseTagUrl,
  REPOSITORY_URL,
} from "./changelog-source.tsx";

/**
 * The "What's new" dialog behind the update banner's version affordance. Fetches
 * the deploy-root `changelog.json` (emitted by the build from `git log`) with
 * cache: "no-store" so a pending update surfaces the INCOMING deploy's commits,
 * not the stale copy the running bundle shipped with. The list is sliced to the
 * commits newer than the running build so it reads as "what you're about to get".
 * Release builds replace that list with their embedded, user-facing release notes.
 *
 * Both views render the same CHANGELOG.md shape - a header, then `### type`
 * groups of `**scope:** summary #ref` lines - so a nightly update and a release
 * update read alike. The only difference is where the entries come from: a
 * release parses them at build time out of CHANGELOG.md, a nightly parses the
 * raw commit subjects here.
 */

const logger = createLogger("changelog-dialog");

const DEFAULT_BRANCH = "main";

type FetchState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "loaded"; entries: ChangelogEntry[]; release?: ReleaseChangelog; truncated: boolean };

// Commits newer than the running build are everything before its hash in the
// (newest-first) log. If the running hash isn't in the window the client is more
// than one changelog-length behind, so show the whole window and flag the tail.
const commitsSinceCurrent = (entries: ChangelogEntry[]): { entries: ChangelogEntry[]; truncated: boolean } => {
  const index = entries.findIndex((entry) => entry.hash === COMMIT_HASH);
  if (index === -1) return { entries, truncated: true };
  return { entries: entries.slice(0, index), truncated: false };
};

// Sections between the running version and the incoming one - everything the
// client actually missed. A running version outside the window means it is
// further behind than the build embedded (or is a dev build), so show the whole
// window and point at the full changelog for the rest.
const releaseNotesSince = (release: ReleaseChangelog): { notes: ReleaseNote[]; truncated: boolean } => {
  const index = release.notes.findIndex((note) => note.version === APP_VERSION);
  if (index === -1) return { notes: release.notes, truncated: Boolean(release.truncated) || release.notes.length > 1 };
  return { notes: release.notes.slice(0, index), truncated: false };
};

// One side of the transition. `href` is absent only for the build-id fallback,
// which names a local build no page on GitHub describes.
type TransitionRef = { href?: string; label: string; text: string };
type HeaderMeta = { from: TransitionRef; moreUrl: string; to?: TransitionRef };

// What you're moving from and to, plus the escape hatch to everything this
// dialog could not fit. Both views share it, and it rides in the modal's title
// bar next to "What's new" rather than at the top of the body.
//
// Each side links to whatever describes it on GitHub - the release for a
// version, the commit for a build - and "more" follows the same logic: a
// release shows CHANGELOG.md entries, so it links CHANGELOG.md; a nightly shows
// raw commits, which never reach that file, so it links the commit log.
const headerMeta = (state: FetchState): HeaderMeta | undefined => {
  if (state.status !== "loaded") return undefined;
  const repositoryUrl = state.release?.repositoryUrl ?? REPOSITORY_URL;
  if (state.release && state.release.version !== APP_VERSION) {
    const incoming = state.release.version;
    return {
      from: {
        href: releaseTagUrl(repositoryUrl, APP_VERSION),
        label: `currently running version ${APP_VERSION}`,
        text: `v${APP_VERSION}`,
      },
      moreUrl: state.release.changelogUrl,
      to: {
        href: releaseTagUrl(repositoryUrl, incoming),
        label: `updating to version ${incoming}`,
        text: `v${incoming}`,
      },
    };
  }
  const moreUrl = `${repositoryUrl}/commits/${DEFAULT_BRANCH}`;
  // No version bump, so the transition is between builds of the same version.
  // With nothing newer at all there is no transition either - fall back to the
  // build id, the one thing that differs between same-commit rebuilds.
  const incoming = state.entries[0]?.hash;
  if (!incoming) {
    return { from: { label: `version ${APP_VERSION}, build ${APP_BUILD_VERSION}`, text: APP_BUILD_VERSION }, moreUrl };
  }
  return {
    from: {
      href: `${repositoryUrl}/commit/${COMMIT_HASH}`,
      label: `currently running build ${COMMIT_HASH}`,
      text: COMMIT_HASH,
    },
    moreUrl,
    to: { href: `${repositoryUrl}/commit/${incoming}`, label: `updating to build ${incoming}`, text: incoming },
  };
};

// The tail the dialog could not fit - the same escape hatch as the header's, put
// where you run out of entries.
const TruncatedNote = ({ moreUrl }: { moreUrl: string }) => (
  <div className="changelog-note">
    <a className="changelog-more" href={moreUrl} rel="noreferrer" target="_blank">
      Full changelog
    </a>
  </div>
);

const TransitionSide = ({ side }: { side: TransitionRef }) =>
  side.href ? (
    <a aria-label={side.label} href={side.href} rel="noreferrer" target="_blank">
      {side.text}
    </a>
  ) : (
    // role="img" so the bare build id is announced as what it names rather than
    // read out character by character. A plain span cannot carry aria-label.
    <span aria-label={side.label} role="img">
      {side.text}
    </span>
  );

const ChangelogHeader = ({ meta }: { meta: HeaderMeta }) => (
  <div className="changelog-head-meta">
    <span className="changelog-head-transition mono">
      <TransitionSide side={meta.from} />
      {/* Hidden because each side already says which end it is; announcing the
          glyph would only add "rightwards arrow" between them. */}
      {meta.to ? <span aria-hidden="true"> → </span> : null}
      {meta.to ? <TransitionSide side={meta.to} /> : null}
    </span>
    <a className="changelog-head-link" href={meta.moreUrl} rel="noreferrer" target="_blank">
      Full changelog
    </a>
  </div>
);

const ReleaseNotes = ({ moreUrl, release }: { moreUrl: string; release: ReleaseChangelog }) => {
  const { notes, truncated } = releaseNotesSince(release);
  return (
    <>
      {notes.map((note) => (
        <section className="release-changelog-section" key={note.version}>
          {/* Always shown, even for a single section: it is what the entries
              under it belong to, and it is the way to that release on GitHub. */}
          <h3 className="release-changelog-heading">
            <a href={releaseTagUrl(release.repositoryUrl, note.version)} rel="noreferrer" target="_blank">
              v{note.version}
            </a>
          </h3>
          <EntryGroups groups={note.groups} keyPrefix={note.version} repositoryUrl={release.repositoryUrl} />
        </section>
      ))}
      {truncated ? <TruncatedNote moreUrl={moreUrl} /> : null}
    </>
  );
};

// Same-version update - a nightly or a rebuild.
const CommitNotes = ({
  entries,
  moreUrl,
  repositoryUrl,
  truncated,
}: {
  entries: ChangelogEntry[];
  moreUrl: string;
  repositoryUrl: string;
  truncated: boolean;
}) => {
  return (
    <>
      <EntryGroups groups={commitGroups(entries)} keyPrefix="commits" repositoryUrl={repositoryUrl} />
      {truncated ? <TruncatedNote moreUrl={moreUrl} /> : null}
    </>
  );
};

const ChangelogDialog = ({ open, onClose, onReload }: { open: boolean; onClose: () => void; onReload: () => void }) => {
  const localizer = useUiLocalizer();
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [_attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Reload attempts intentionally trigger a fresh changelog request.
  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    setState({ status: "loading" });
    fetchChangelog()
      .then(({ entries: all, release }) => {
        if (!active) return;
        // A version bump renders the release notes and ignores the commits; the
        // slice only matters for the same-version commit view.
        const { entries, truncated } = commitsSinceCurrent(all);
        setState({ entries, release, status: "loaded", truncated });
      })
      .catch((error) => {
        if (!active) return;
        logger.warn("Changelog load failed", { message: String(error) });
        setState({ status: "error" });
      });
    return () => {
      active = false;
    };
  }, [open]);

  const meta = headerMeta(state);

  return (
    <Modal
      headerActions={meta ? <ChangelogHeader meta={meta} /> : undefined}
      onClose={onClose}
      open={open}
      showCloseButton={false}
      title={localizer.message("ui.update.whatsNew")}
      variant="changelog-modal"
    >
      {state.status === "loading" ? <div className="changelog-note">…</div> : null}
      {state.status === "error" ? (
        <div className="changelog-note">
          <button className="btn slim ghost" onClick={() => setAttempt((n) => n + 1)} type="button">
            {localizer.message("ui.common.retry")}
          </button>
        </div>
      ) : null}
      {state.status === "loaded" && meta ? (
        state.release && state.release.version !== APP_VERSION ? (
          <ReleaseNotes moreUrl={meta.moreUrl} release={state.release} />
        ) : (
          // A dev build has no embedded release payload, so fall back to the
          // constants baked in here.
          <CommitNotes
            entries={state.entries}
            moreUrl={meta.moreUrl}
            repositoryUrl={state.release?.repositoryUrl ?? REPOSITORY_URL}
            truncated={state.truncated}
          />
        )
      ) : null}
      <div className="changelog-actions">
        <button className="btn ghost" onClick={onClose} type="button">
          {localizer.message("ui.update.later")}
        </button>
        <button className="btn primary" onClick={onReload} type="button">
          {localizer.message("ui.update.reloadNow")}
        </button>
      </div>
    </Modal>
  );
};

export { ChangelogDialog };
