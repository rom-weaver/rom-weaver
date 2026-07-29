import { useEffect, useState } from "react";
import { createLogger } from "../../lib/logging.ts";
import { Modal } from "../../public/react/components/ds/index.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { APP_BUILD_VERSION, APP_VERSION, COMMIT_HASH } from "../build-version.ts";

/**
 * The "What's new" dialog behind the update banner's version affordance. Fetches
 * the deploy-root `changelog.json` (emitted by the build from `git log`) with
 * cache: "no-store" so a pending update surfaces the INCOMING deploy's commits,
 * not the stale copy the running bundle shipped with. The list is sliced to the
 * commits newer than the running build so it reads as "what you're about to get".
 * Release builds replace that list with their embedded, user-facing release notes.
 */

const logger = createLogger("changelog-dialog");

type ReleaseEntry = { commit?: string; pr?: string; scope?: string; summary: string };
type ReleaseGroup = { entries: ReleaseEntry[]; title: string };
type ReleaseNote = { groups: ReleaseGroup[]; version: string };
type ReleaseChangelog = {
  changelogUrl: string;
  notes: ReleaseNote[];
  repositoryUrl: string;
  truncated: boolean;
  version: string;
};
type ChangelogEntry = { hash: string; subject: string; date: string; release?: unknown };

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

const isReleaseGroup = (value: unknown): value is ReleaseGroup => {
  if (!value || typeof value !== "object") return false;
  const group = value as ReleaseGroup;
  if (typeof group.title !== "string" || !Array.isArray(group.entries)) return false;
  return group.entries.every((entry) => entry && typeof entry.summary === "string");
};

const isReleaseNote = (value: unknown): value is ReleaseNote => {
  if (!value || typeof value !== "object") return false;
  const note = value as ReleaseNote;
  return typeof note.version === "string" && Array.isArray(note.groups) && note.groups.every(isReleaseGroup);
};

const readReleaseChangelog = (value: unknown): ReleaseChangelog | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const release = value as ReleaseChangelog;
  const hasNotes = Array.isArray(release.notes) && release.notes.length > 0 && release.notes.every(isReleaseNote);
  const hasMeta = [release.version, release.changelogUrl, release.repositoryUrl].every(
    (field) => typeof field === "string",
  );
  return hasNotes && hasMeta ? release : undefined;
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

const fetchChangelog = async (): Promise<{ entries: ChangelogEntry[]; release?: ReleaseChangelog }> => {
  const response = await fetch(`./changelog.json?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`changelog fetch failed: ${response.status}`);
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Error("changelog is not an array");
  const entries = data.filter(
    (entry): entry is ChangelogEntry =>
      typeof entry === "object" && entry !== null && typeof (entry as ChangelogEntry).hash === "string",
  );
  // A subject-less entry is the placeholder a git-less build uses to carry the
  // release notes; it is not a commit, so keep it out of the commit list.
  return { entries: entries.filter((entry) => entry.subject), release: readReleaseChangelog(entries[0]?.release) };
};

const formatDate = (iso: string) => iso.split("T")[0] || "";

const entryRef = (entry: ReleaseEntry, repositoryUrl: string) => {
  const ref = entry.pr
    ? { href: `${repositoryUrl}/pull/${entry.pr}`, label: `#${entry.pr}` }
    : entry.commit && { href: `${repositoryUrl}/commit/${entry.commit}`, label: entry.commit.slice(0, 7) };
  if (!ref) return null;
  return (
    <>
      {" "}
      <a className="release-changelog-ref mono" href={ref.href} rel="noreferrer" target="_blank">
        {ref.label}
      </a>
    </>
  );
};

const ReleaseNotes = ({ release }: { release: ReleaseChangelog }) => {
  const { notes, truncated } = releaseNotesSince(release);
  return (
    <>
      <div className="release-changelog-version">
        {/* role="img" so the arrow is announced as the transition it means rather
            than by its glyph name. */}
        <span
          aria-label={`updating from version ${APP_VERSION} to version ${release.version}`}
          className="mono"
          role="img"
        >
          v{APP_VERSION} → v{release.version}
        </span>
        <a href={release.changelogUrl} rel="noreferrer" target="_blank">
          Full changelog
        </a>
      </div>
      {notes.map((note) => (
        <section className="release-changelog-section" key={note.version}>
          {notes.length > 1 ? (
            <h3 className="release-changelog-heading">
              <a href={`${release.repositoryUrl}/releases/tag/v${note.version}`} rel="noreferrer" target="_blank">
                v{note.version}
              </a>
            </h3>
          ) : null}
          {note.groups.map((group) => (
            <div className="release-changelog" key={`${note.version}:${group.title}`}>
              {group.title ? <h4 className="release-changelog-group">{group.title}</h4> : null}
              <ul className="release-changelog-entries">
                {group.entries.map((entry) => (
                  <li key={`${entry.commit || ""}:${entry.summary}`}>
                    {entry.scope ? <strong>{entry.scope}: </strong> : null}
                    {entry.summary}
                    {/* The PR is the readable reference; fall back to the commit so an
                        entry release-please recorded without a PR still links somewhere. */}
                    {entryRef(entry, release.repositoryUrl)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
      {truncated ? <div className="changelog-note">…</div> : null}
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
        if (release && release.version !== APP_VERSION) {
          setState({ entries: [], release, status: "loaded", truncated: false });
          return;
        }
        const { entries, truncated } = commitsSinceCurrent(all);
        setState({ entries, status: "loaded", truncated });
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

  return (
    <Modal
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
      {state.status === "loaded" ? (
        state.release ? (
          <ReleaseNotes release={state.release} />
        ) : (
          <>
            <ul className="changelog">
              {state.entries.map((entry) => (
                <li className="changelog-item" key={entry.hash}>
                  <span className="changelog-subject">{entry.subject}</span>
                  <span className="changelog-meta mono">
                    {entry.hash}
                    {entry.date ? ` · ${formatDate(entry.date)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
            {state.truncated ? <div className="changelog-note">…</div> : null}
            {/* No newer commits: a same-commit rebuild (notably dirty dev deploys, whose
                uncommitted changes never reach git log). Fall back to the build id - the
                one thing that differs between such builds - so the dialog isn't blank. */}
            {state.entries.length === 0 && !state.truncated ? (
              <div className="changelog-note changelog-version mono">{APP_BUILD_VERSION}</div>
            ) : null}
          </>
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
