import { execFileSync, execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LINE_BREAK_REGEX = /\r?\n/;

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

const findPackageRoot = (startDir) => {
  let currentDir = startDir;
  while (true) {
    const candidatePath = path.join(currentDir, "package.json");
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) return currentDir;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  throw new Error(`Could not locate package.json from ${startDir}`);
};

const packageRoot = findPackageRoot(scriptsDir);
const packageJsonPath = path.join(packageRoot, "package.json");
const changelogPath = path.resolve(packageRoot, "../..", "CHANGELOG.md");

const readPackageVersion = () => {
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  return typeof packageJson.version === "string" && packageJson.version ? packageJson.version : "0.0.0";
};

const runGit = (command) => {
  try {
    return execSync(command, {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
};

const runGitArgs = (...args) => {
  try {
    return execFileSync("git", args, {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "";
  }
};

const getUntrackedFileDigestInput = () => {
  try {
    const untracked = runGit("git ls-files --others --exclude-standard -z")
      .split("\0")
      .filter(Boolean)
      .filter((fileName) => !fileName.startsWith("dist/"))
      .sort();
    if (!untracked.length) return "";
    const hash = crypto.createHash("sha1");
    for (const fileName of untracked) {
      const filePath = path.join(packageRoot, fileName);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) continue;
      hash.update(fileName);
      hash.update("\0");
      hash.update(fs.readFileSync(filePath));
      hash.update("\0");
    }
    return hash.digest("hex");
  } catch {
    return "";
  }
};

const sanitizeVersionToken = (value) =>
  String(value || "")
    .trim()
    .replace(/[^0-9A-Za-z-]+/g, "-")
    .replace(/^-+|-+$/g, "");

const hasPackageVersionTag = (version) => {
  if (!version) return false;
  const versionTags = new Set([version, `v${version}`]);
  return runGit("git tag --points-at HEAD")
    .split(LINE_BREAK_REGEX)
    .some((tagName) => versionTags.has(tagName.trim()));
};

const getCommitsSinceVersion = (version) => {
  const versionTag = [version, `v${version}`].find((tagName) =>
    runGitArgs("rev-parse", "--verify", "--quiet", `refs/tags/${tagName}`),
  );
  if (!versionTag) return null;
  const tagCommit = runGitArgs("rev-list", "-n", "1", versionTag);
  if (!tagCommit || runGitArgs("merge-base", versionTag, "HEAD") !== tagCommit) return null;
  const count = runGitArgs("rev-list", "--count", `${versionTag}..HEAD`);
  return /^\d+$/.test(count) ? Number.parseInt(count, 10) : null;
};

const getGitMetadata = (version) => {
  const revision = sanitizeVersionToken(runGit("git rev-parse --short HEAD"));
  if (!revision) return null;

  const branchName = runGit("git rev-parse --abbrev-ref HEAD");
  const normalizedBranch = sanitizeVersionToken(branchName);
  const isVersionTag = hasPackageVersionTag(version);
  // Default-branch builds carry no branch prefix; the tag check alone can't
  // cover them because CI's shallow checkout doesn't fetch tags.
  const isDefaultBranch = normalizedBranch === "main" || normalizedBranch === "master";
  const gitBranch =
    normalizedBranch && normalizedBranch !== "HEAD" && !isDefaultBranch && !isVersionTag ? normalizedBranch : "";

  const dirtyDiff = runGit("git diff --binary HEAD --");
  const untrackedDigest = getUntrackedFileDigestInput();
  const dirtyHash =
    dirtyDiff || untrackedDigest
      ? crypto.createHash("sha1").update(dirtyDiff).update(untrackedDigest).digest("hex").slice(0, revision.length)
      : "";

  return {
    commitsSinceVersion: getCommitsSinceVersion(version),
    dirtyHash,
    gitBranch,
    isVersionTag,
    revision,
  };
};

const buildVersionString = (baseVersion, gitMetadata) => {
  if (!gitMetadata?.revision) return baseVersion;
  // A clean checkout of the tagged release commit IS the release: no suffix.
  if (gitMetadata.isVersionTag && !gitMetadata.dirtyHash) return baseVersion;
  const branchPrefix = gitMetadata.gitBranch ? `${gitMetadata.gitBranch}.` : "";
  const hashToken = gitMetadata.dirtyHash ? `dirty.${gitMetadata.dirtyHash}` : gitMetadata.revision;
  return `${baseVersion}+${branchPrefix}${hashToken}`;
};

// Unit separator between fields; %s (subject) and %cI (ISO date) are single-line,
// so newline-per-record splitting is safe.
const CHANGELOG_FIELD_SEP = "\x1f";
const REPOSITORY_URL = "https://github.com/rom-weaver/rom-weaver";
// Never 404s. The tag link does, briefly: nightly deploys on the release PR's
// merge commit, but `vX.Y.Z` only exists once the fan-out publishes the draft.
const CHANGELOG_URL = `${REPOSITORY_URL}/blob/main/CHANGELOG.md`;
// A client a few releases behind gets every section it missed, not just the
// newest. Capped like the commit list is: the dialog re-fetches this asset
// uncached every time it opens. Anyone further behind gets the ellipsis and the
// full-changelog link instead.
const RELEASE_NOTES_LIMIT = 5;
// Line-anchored: an unanchored search would also match the string inside a
// section body or a deeper heading.
const RELEASE_HEADING_REGEX = /^## \[([^\]]+)\]/gm;
const GROUP_HEADING_REGEX = /^### +(.+?) *$/;
// release-please's entry shape. Everything after the summary is optional: a
// hand-written `BREAKING CHANGES` line carries no links at all, and a squashed
// commit with no PR carries only the trailing commit link.
const ENTRY_REGEX =
  /^\* +(?:\*\*(?<scope>[^*]+?):\*\* +)?(?<summary>.+?)(?: +\(\[#(?<pr>\d+)\]\([^)]*\)\))?(?: +\(\[(?<commit>[0-9a-f]{7,40})\]\([^)]*\)\))?(?:, +closes.*)?$/;
// Any link left inside a summary keeps its text and drops its target - the
// dialog renders plain strings, so a raw URL would just be noise.
const INLINE_LINK_REGEX = /\[([^\]]*)\]\([^)]*\)/g;

// Every `## [version]` section, newest first, paired with its body.
const readChangelogSections = (sourcePath) => {
  if (!fs.existsSync(sourcePath)) return [];
  const changelog = fs.readFileSync(sourcePath, "utf8");
  const headings = [...changelog.matchAll(RELEASE_HEADING_REGEX)];
  return headings.map((heading, index) => {
    const bodyStart = changelog.indexOf("\n", heading.index) + 1;
    const nextHeading = headings[index + 1];
    return {
      body: changelog.slice(bodyStart, nextHeading ? nextHeading.index : undefined).trim(),
      version: heading[1],
    };
  });
};

// Structured rather than rendered HTML: the dialog builds the DOM itself, so
// nothing from a merged PR title can reach it as markup, and dropping the
// repeated github.com URLs shrinks the asset several times over.
const parseEntry = (line) => {
  const match = ENTRY_REGEX.exec(line);
  if (!match) return undefined;
  const { commit, pr, scope, summary } = match.groups;
  const text = summary.replace(INLINE_LINK_REGEX, "$1").trim();
  if (!text) return undefined;
  // Only one reference is rendered and the PR reads better, so the commit is
  // carried only when release-please recorded the entry without a PR.
  const reference = pr ? { pr } : {};
  if (!pr && commit) reference.commit = commit;
  return { ...reference, ...(scope ? { scope } : {}), summary: text };
};

const parseEntryGroups = (body) => {
  const groups = [];
  let current = null;
  for (const line of body.split(LINE_BREAK_REGEX)) {
    const heading = GROUP_HEADING_REGEX.exec(line);
    if (heading) {
      current = { entries: [], title: heading[1] };
      groups.push(current);
      continue;
    }
    const entry = line.startsWith("*") ? parseEntry(line) : undefined;
    if (!entry) continue;
    // An entry before any `###` heading is still worth showing; give it a home.
    if (!current) {
      current = { entries: [], title: "" };
      groups.push(current);
    }
    current.entries.push(entry);
  }
  return groups.filter((group) => group.entries.length);
};

// The requested version's section plus the ones below it, so a client several
// releases behind can render everything it missed.
const readReleaseNotes = (version, sourcePath = changelogPath) => {
  if (!version) return undefined;
  const sections = readChangelogSections(sourcePath);
  const start = sections.findIndex((section) => section.version === version);
  if (start < 0) return undefined;
  const notes = sections
    .slice(start, start + RELEASE_NOTES_LIMIT)
    .map((section) => ({ groups: parseEntryGroups(section.body), version: section.version }))
    .filter((note) => note.groups.length);
  if (!notes.length) return undefined;
  return {
    changelogUrl: CHANGELOG_URL,
    notes,
    // Stored once and joined client-side; per-entry these were most of the bytes.
    repositoryUrl: REPOSITORY_URL,
    truncated: sections.length > start + RELEASE_NOTES_LIMIT,
    version: notes[0].version,
  };
};

// Recent commit log for the in-app "What's new" dialog. Capped so the emitted
// asset stays flat-sized forever - anyone more than `limit` builds behind falls
// off the tail, which the dialog covers with an "earlier" note.
const readGitLog = (limit) =>
  runGit(`git log -n ${limit} --pretty=format:%h${CHANGELOG_FIELD_SEP}%s${CHANGELOG_FIELD_SEP}%cI`);

const getChangelog = (limit = 50, releaseVersion = "", gitLogReader = readGitLog) => {
  const raw = gitLogReader(limit);
  const entries = raw
    ? raw
        .split(LINE_BREAK_REGEX)
        .map((line) => {
          const [hash, subject, date] = line.split(CHANGELOG_FIELD_SEP);
          return { date: date || "", hash: hash || "", subject: subject || "" };
        })
        .filter((entry) => entry.hash)
    : [];
  const release = readReleaseNotes(releaseVersion);
  // Parsing CHANGELOG.md couples this to release-please's entry format. A silent
  // miss would ship an empty "What's new" dialog and nobody would notice until a
  // user opened it, so a release-channel build that cannot read its own notes
  // fails here instead. Local and dev builds pass no version and skip this.
  if (releaseVersion && !release) {
    throw new Error(
      `No release notes for v${releaseVersion} in ${changelogPath}. Either that section is missing, or release-please's entry format changed and readReleaseNotes() in ${import.meta.url} can no longer parse it.`,
    );
  }
  if (!release) return entries;
  // The release rides on the newest entry to preserve the array shape running
  // older bundles expect; they ignore the extra field. With no git log - the
  // Docker build excludes `.git` - there is no entry to ride on, so carry the
  // notes on a subject-less placeholder the dialog skips rather than drop them.
  if (!entries.length) return [{ date: "", hash: `v${releaseVersion}`, release, subject: "" }];
  return entries.map((entry, index) => (index === 0 ? { ...entry, release } : entry));
};

const getBuildInfo = () => {
  const version = readPackageVersion();
  const gitMetadata = getGitMetadata(version);
  const commitHash = gitMetadata?.revision || "unknown";
  const dirtyHash = gitMetadata?.dirtyHash || "";
  const gitBranch = gitMetadata?.gitBranch || "";
  const isVersionTag = (gitMetadata?.isVersionTag ?? false) && !dirtyHash;
  const hashSuffix = dirtyHash ? `.dirty#${dirtyHash}` : `#${commitHash}`;
  const displayVersion = isVersionTag ? version : `${version}${gitBranch ? `.${gitBranch}` : ""}${hashSuffix}`;
  return {
    buildVersion: buildVersionString(version, gitMetadata),
    commitHash,
    commitsSinceVersion: gitMetadata?.commitsSinceVersion ?? null,
    dirtyHash,
    displayVersion,
    gitBranch,
    hasDirtyChanges: !!dirtyHash,
    isVersionTag,
    version,
  };
};

export { getBuildInfo, getChangelog, readReleaseNotes };
