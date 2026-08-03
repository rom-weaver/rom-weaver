import { GITHUB_URL } from "../project-links.ts";
import { readAppBaseUrl } from "../webapp-controller.ts";

/**
 * The deploy-root `changelog.json` and the pieces every view of it shares.
 *
 * The asset is emitted by the build (vite.config.mjs → scripts/version.mjs) as
 * the newest commits, newest first, with the release notes parsed out of
 * CHANGELOG.md riding on the first entry. Release builds carry those notes;
 * nightly, PR and local builds carry commits alone, which is why both shapes
 * render through the same `ReleaseGroup` structure - a nightly's subjects are
 * parsed into the groups a release would have written.
 *
 * Two views consume it: the update dialog, which answers "what am I about to
 * get", and the Changelog tab, which answers "what has shipped".
 */

const REPOSITORY_URL = GITHUB_URL.replace(/\/$/, "");

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

const releaseTagUrl = (repositoryUrl: string, version: string) => `${repositoryUrl}/releases/tag/v${version}`;

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

// Against the app's own base, not the current URL: a nested route (`/system/
// changelog`, `/docs/<guide>`) would otherwise resolve a bare name inside
// itself, and whether that happens to work depends on a `<base>` tag the dev
// server and the build inject differently.
const changelogAssetUrl = () => {
  const documentUrl = typeof window === "undefined" ? "http://localhost/" : window.location.href;
  return new URL(`changelog.json?t=${Date.now()}`, new URL(readAppBaseUrl(), documentUrl)).href;
};

const fetchChangelog = async (): Promise<{ entries: ChangelogEntry[]; release?: ReleaseChangelog }> => {
  const response = await fetch(changelogAssetUrl(), { cache: "no-store" });
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
// out here is one release-please hides from CHANGELOG.md; the views still show
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

// The shared body of every view: `### type` group headings over
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

export { commitGroups, EntryGroups, fetchChangelog, releaseTagUrl, REPOSITORY_URL };
export type { ChangelogEntry, ReleaseChangelog };
