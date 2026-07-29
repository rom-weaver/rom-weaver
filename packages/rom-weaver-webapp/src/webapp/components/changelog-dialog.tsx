import { useEffect, useState } from "react";
import { createLogger } from "../../lib/logging.ts";
import { Modal } from "../../public/react/components/ds/index.ts";
import { useUiLocalizer } from "../../public/react/settings-context.tsx";
import { APP_BUILD_VERSION, APP_VERSION, COMMIT_HASH } from "../build-version.ts";
import { GITHUB_URL } from "../project-links.ts";

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

const REPOSITORY_URL = GITHUB_URL.replace(/\/$/, "");
const FALLBACK_CHANGELOG_URL = `${REPOSITORY_URL}/blob/main/CHANGELOG.md`;

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

// Conventional-commit subject, the same shape release-please reads when it
// writes CHANGELOG.md. The trailing `(#123)` is the squash-merge PR reference
// GitHub appends, which becomes the entry's link.
const COMMIT_SUBJECT_REGEX = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?!?: +(?<summary>.+?)$/;
const COMMIT_PR_REGEX = / +\(#(\d+)\)$/;
// release-please's changelog-sections, in its order, so a nightly's groups are
// titled and sorted exactly like the release notes they turn into. A type left
// out here is one release-please hides from CHANGELOG.md; the dialog still shows
// it, under the catch-all, because a nightly has nothing else to show.
const COMMIT_GROUP_TITLES: Record<string, string> = {
  build: "Build System",
  chore: "Miscellaneous Chores",
  ci: "Continuous Integration",
  docs: "Documentation",
  feat: "Features",
  fix: "Bug Fixes",
  perf: "Performance Improvements",
  refactor: "Code Refactoring",
  revert: "Reverts",
  style: "Styles",
  test: "Tests",
};
const COMMIT_GROUP_ORDER = [
  "feat",
  "fix",
  "perf",
  "revert",
  "docs",
  "refactor",
  "test",
  "build",
  "ci",
  "style",
  "chore",
];
const OTHER_GROUP_KEY = "";
const OTHER_GROUP_TITLE = "Other Changes";

// One commit subject as a CHANGELOG-style entry. A subject that is not a
// conventional commit still gets shown verbatim under the catch-all group -
// dropping it would silently hide a change from the list.
const parseCommitEntry = (entry: ChangelogEntry): { entry: ReleaseEntry; type: string } => {
  const prMatch = COMMIT_PR_REGEX.exec(entry.subject);
  const subject = prMatch ? entry.subject.slice(0, prMatch.index) : entry.subject;
  const match = COMMIT_SUBJECT_REGEX.exec(subject);
  const reference = prMatch ? { pr: prMatch[1] } : { commit: entry.hash };
  if (!match?.groups) return { entry: { ...reference, summary: subject }, type: OTHER_GROUP_KEY };
  const { scope, summary, type } = match.groups;
  if (!(summary && type)) return { entry: { ...reference, summary: subject }, type: OTHER_GROUP_KEY };
  return {
    entry: { ...reference, ...(scope ? { scope } : {}), summary },
    type: type in COMMIT_GROUP_TITLES ? type : OTHER_GROUP_KEY,
  };
};

const commitGroups = (entries: ChangelogEntry[]): ReleaseGroup[] => {
  const byType = new Map<string, ReleaseEntry[]>();
  for (const entry of entries) {
    const { entry: parsed, type } = parseCommitEntry(entry);
    const bucket = byType.get(type);
    if (bucket) bucket.push(parsed);
    else byType.set(type, [parsed]);
  }
  // Known types in release-please's order, then the catch-all last.
  const types = [
    ...COMMIT_GROUP_ORDER.filter((type) => byType.has(type)),
    ...(byType.has(OTHER_GROUP_KEY) ? [OTHER_GROUP_KEY] : []),
  ];
  return types.map((type) => ({
    entries: byType.get(type) ?? [],
    title: COMMIT_GROUP_TITLES[type] ?? OTHER_GROUP_TITLE,
  }));
};

const EntryRef = ({ entry, repositoryUrl }: { entry: ReleaseEntry; repositoryUrl: string }) => {
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

// The shared body of both views: `### type` group headings over
// `**scope:** summary #ref` lines, mirroring CHANGELOG.md.
const EntryGroups = ({
  groups,
  keyPrefix,
  repositoryUrl,
}: {
  groups: ReleaseGroup[];
  keyPrefix: string;
  repositoryUrl: string;
}) => (
  <>
    {groups.map((group) => (
      <div className="release-changelog" key={`${keyPrefix}:${group.title}`}>
        {group.title ? <h4 className="release-changelog-group">{group.title}</h4> : null}
        <ul className="release-changelog-entries">
          {group.entries.map((entry) => (
            <li key={`${entry.pr || entry.commit || ""}:${entry.summary}`}>
              {entry.scope ? <strong>{entry.scope}: </strong> : null}
              {entry.summary}
              {/* The PR is the readable reference; fall back to the commit so an
                  entry recorded without a PR still links somewhere. */}
              <EntryRef entry={entry} repositoryUrl={repositoryUrl} />
            </li>
          ))}
        </ul>
      </div>
    ))}
  </>
);

type HeaderMeta = { changelogUrl: string; label: string; transition: string };

// What you're moving from and to, plus the escape hatch to the whole file. Both
// views share it, and it rides in the modal's title bar next to "What's new"
// rather than at the top of the body.
const headerMeta = (state: FetchState): HeaderMeta | undefined => {
  if (state.status !== "loaded") return undefined;
  const changelogUrl = state.release?.changelogUrl ?? FALLBACK_CHANGELOG_URL;
  if (state.release && state.release.version !== APP_VERSION) {
    return {
      changelogUrl,
      label: `updating from version ${APP_VERSION} to version ${state.release.version}`,
      transition: `v${APP_VERSION} → v${state.release.version}`,
    };
  }
  // No version bump, so the transition is between builds of the same version.
  // With nothing newer at all there is no transition either - fall back to the
  // build id, the one thing that differs between same-commit rebuilds.
  const incoming = state.entries[0]?.hash;
  if (!incoming) {
    return { changelogUrl, label: `version ${APP_VERSION}, build ${APP_BUILD_VERSION}`, transition: APP_BUILD_VERSION };
  }
  return {
    changelogUrl,
    label: `updating version ${APP_VERSION} from build ${COMMIT_HASH} to build ${incoming}`,
    transition: `${COMMIT_HASH} → ${incoming}`,
  };
};

const ChangelogHeader = ({ meta }: { meta: HeaderMeta }) => (
  <div className="changelog-head-meta">
    {/* role="img" so the arrow is announced as the transition it means rather
        than by its glyph name. */}
    <span aria-label={meta.label} className="changelog-head-transition mono" role="img">
      {meta.transition}
    </span>
    <a className="changelog-head-link" href={meta.changelogUrl} rel="noreferrer" target="_blank">
      Full changelog
    </a>
  </div>
);

const ReleaseNotes = ({ release }: { release: ReleaseChangelog }) => {
  const { notes, truncated } = releaseNotesSince(release);
  return (
    <>
      {notes.map((note) => (
        <section className="release-changelog-section" key={note.version}>
          {notes.length > 1 ? (
            <h3 className="release-changelog-heading">
              <a href={`${release.repositoryUrl}/releases/tag/v${note.version}`} rel="noreferrer" target="_blank">
                v{note.version}
              </a>
            </h3>
          ) : null}
          <EntryGroups groups={note.groups} keyPrefix={note.version} repositoryUrl={release.repositoryUrl} />
        </section>
      ))}
      {truncated ? <div className="changelog-note">…</div> : null}
    </>
  );
};

// Same-version update - a nightly or a rebuild.
const CommitNotes = ({
  entries,
  repositoryUrl,
  truncated,
}: {
  entries: ChangelogEntry[];
  repositoryUrl: string;
  truncated: boolean;
}) => {
  return (
    <>
      <EntryGroups groups={commitGroups(entries)} keyPrefix="commits" repositoryUrl={repositoryUrl} />
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
      {state.status === "loaded" ? (
        state.release && state.release.version !== APP_VERSION ? (
          <ReleaseNotes release={state.release} />
        ) : (
          // A dev build has no embedded release payload, so fall back to the
          // constants baked in here.
          <CommitNotes
            entries={state.entries}
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
