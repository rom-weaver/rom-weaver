#!/usr/bin/env node

// Rewrites the release-please changelog section of the release under way and
// mirrors it into the release pull request body, which Release Please copies
// verbatim into the GitHub release. The section is laid out as a short
// hand-written `### Highlights` list followed by every generated entry inside a
// collapsed `All changes` block, with the `Internal` group collapsed once more
// inside it. Stable releases also absorb the sections of their own
// prereleases. Every rewrite parses the section back into groups first, so
// running it again over its own output changes nothing.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_HEADING = /^## .+$/gm;
const VERSION_FROM_HEADING = /^## \[?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/;
const HIGHLIGHTS_CATEGORY = "Highlights";
const INTERNAL_CATEGORY = "Internal";
const ALL_CHANGES_SUMMARY = "All changes";
// Marks the pull request comment that keeps the highlights across dispatches:
// Release Please rewrites both the branch and the pull request body on every
// run, so the comment is the only place they survive.
const HIGHLIGHTS_COMMENT_MARKER = "<!-- release-highlights -->";

const parseSections = (changelog) => {
  const headings = [...changelog.matchAll(RELEASE_HEADING)];
  return headings
    .map((match, index) => {
      const start = match.index;
      const end = headings[index + 1]?.index ?? changelog.length;
      const heading = match[0];
      const version = heading.match(VERSION_FROM_HEADING)?.[1];
      if (typeof start !== "number" || !version) return undefined;
      return {
        body: changelog.slice(start + heading.length, end).trim(),
        end,
        heading,
        index,
        start,
        version,
      };
    })
    .filter(Boolean);
};

const addUnique = (entries, entry) => {
  if (entry && !entries.includes(entry)) entries.push(entry);
};

// Reads a section body in either the raw release-please layout or the
// collapsed layout this script writes. Highlights are kept apart from the
// generated groups because they are the one part a person wrote.
const parseReleaseBody = (body) => {
  const highlights = [];
  const categories = new Map();
  const uncategorized = [];
  let category;

  for (const line of body.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    if (text === "<details>" || text === "</details>") continue;
    if (text === `<summary>${ALL_CHANGES_SUMMARY}</summary>`) {
      category = undefined;
      continue;
    }
    if (text === `<summary>${INTERNAL_CATEGORY}</summary>`) {
      category = INTERNAL_CATEGORY;
      if (!categories.has(category)) categories.set(category, []);
      continue;
    }
    if (text.startsWith("### ")) {
      category = text.slice(4).trim();
      if (category !== HIGHLIGHTS_CATEGORY && !categories.has(category)) categories.set(category, []);
      continue;
    }
    if (category === HIGHLIGHTS_CATEGORY) addUnique(highlights, text);
    else if (category) addUnique(categories.get(category), text);
    else addUnique(uncategorized, text);
  }

  return { categories, highlights, uncategorized };
};

const mergeParsedBodies = (bodies) => {
  const merged = { categories: new Map(), highlights: [], uncategorized: [] };
  for (const body of bodies) {
    for (const entry of body.highlights) addUnique(merged.highlights, entry);
    for (const entry of body.uncategorized) addUnique(merged.uncategorized, entry);
    for (const [category, entries] of body.categories) {
      if (!merged.categories.has(category)) merged.categories.set(category, []);
      for (const entry of entries) addUnique(merged.categories.get(category), entry);
    }
  }
  return merged;
};

const renderGroup = (category, entries) => {
  if (category === INTERNAL_CATEGORY) {
    return ["<details>", `<summary>${INTERNAL_CATEGORY}</summary>`, "", ...entries, "</details>"];
  }
  return [`### ${category}`, "", ...entries];
};

// A breaking-change group stays visible above the collapsed list: a reader who
// only skims the release page MUST still see what they have to change.
const isBreakingCategory = (category) => /BREAKING CHANGES/.test(category);

const renderReleaseBody = ({ categories, highlights, uncategorized }) => {
  const visible = [];
  const groups = [];
  if (uncategorized.length) groups.push(uncategorized);
  for (const [category, entries] of categories) {
    (isBreakingCategory(category) ? visible : groups).push(renderGroup(category, entries));
  }

  const lines = [];
  if (highlights.length) lines.push(`### ${HIGHLIGHTS_CATEGORY}`, "", ...highlights, "");
  for (const group of visible) lines.push(...group, "");
  lines.push("<details>", `<summary>${ALL_CHANGES_SUMMARY}</summary>`);
  for (const group of groups) lines.push("", ...group);
  lines.push("</details>");
  return lines.join("\n");
};

const repositoryUrlFromHeading = (heading) => heading.match(/(https?:\/\/[^)\s]+?)\/compare\//)?.[1];

// Turns free-form highlight text into changelog entries: one `* ` bullet per
// line, a leading `### Highlights` heading dropped, and bare `(#123)` pull
// request references linked the way release-please links them so the webapp
// changelog parser picks them up.
const normalizeHighlights = (text, repositoryUrl) => {
  if (!text) return [];
  const linkReference = (line) => {
    if (!repositoryUrl) return line;
    return line.replace(/\(#(\d+)\)/g, (_, number) => `([#${number}](${repositoryUrl}/issues/${number}))`);
  };
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^#+\s/.test(trimmed)) continue;
    addUnique(entries, `* ${linkReference(trimmed.replace(/^[*-]\s+/, ""))}`);
  }
  return entries;
};

const replaceSection = (changelog, section, heading, body) => {
  const rest = changelog.slice(section.end).replace(/^\s+/, "");
  return `${changelog.slice(0, section.start)}${heading}\n\n${body}${rest ? `\n\n${rest}` : "\n"}`;
};

// Removes the `</details>## [...]` boundary an older version of this script
// left behind, so the next heading is a heading again.
const repairBoundaries = (changelog) => changelog.replace(/<\/details>(?=## )/g, "</details>\n");

const updateCompareHeading = (heading, previousVersion, version) => {
  if (!previousVersion) return heading;
  const compare = heading.match(/(https?:\/\/[^)]+\/compare\/)[^)]*/);
  if (!compare) return heading;
  const replacement = `${compare[1]}v${previousVersion}...v${version}`;
  return heading.slice(0, compare.index) + replacement + heading.slice(compare.index + compare[0].length);
};

const currentSection = (changelog, version) => {
  const section = parseSections(changelog).find((entry) => entry.version === version);
  return section ? changelog.slice(section.start, section.end).trim() : "";
};

// Rewrites the section for `version` into the collapsed layout. `highlights`
// (raw text) replaces the highlights already in the section when given;
// otherwise the existing ones stay. A stable version also swallows the
// sections of its own prereleases, keeping every entry once.
const aggregatePrereleaseChangelog = (changelog, version, highlights = "") => {
  const repaired = repairBoundaries(changelog);
  const sections = parseSections(repaired);
  const current = sections.find((section) => section.version === version);
  if (!current) return { changed: repaired !== changelog, changelog: repaired, section: "" };

  const prereleases = version.includes("-")
    ? []
    : sections.filter((section) => section.version.startsWith(`${version}-`));
  const merged = mergeParsedBodies([current.body, ...prereleases.map((section) => section.body)].map(parseReleaseBody));
  const explicit = normalizeHighlights(highlights, repositoryUrlFromHeading(current.heading));
  if (explicit.length) merged.highlights = explicit;

  const previousStable = sections.slice(current.index + 1).find((section) => !section.version.includes("-"));
  const heading = prereleases.length
    ? updateCompareHeading(current.heading, previousStable?.version, version)
    : current.heading;

  let updated = repaired;
  for (const section of [...prereleases].sort((left, right) => right.start - left.start)) {
    updated = updated.slice(0, section.start) + updated.slice(section.end);
  }
  const target = parseSections(updated).find((section) => section.version === version);
  updated = replaceSection(updated, target, heading, renderReleaseBody(merged));

  return {
    changed: updated !== changelog,
    changelog: updated,
    section: currentSection(updated, version),
  };
};

const replaceReleasePullRequestNotes = (body, section) => {
  const lines = body.trim().split(/\r?\n/);
  const firstDelimiter = lines.indexOf("---");
  const lastDelimiter = lines.lastIndexOf("---");
  if (firstDelimiter < 0 || lastDelimiter <= firstDelimiter || !section) return body;
  return [...lines.slice(0, firstDelimiter + 1), "", section.trim(), "", ...lines.slice(lastDelimiter)].join("\n");
};

const highlightsComment = (highlights) =>
  [
    HIGHLIGHTS_COMMENT_MARKER,
    "_Kept by the Release workflow. A dispatch with an empty `highlights` input reuses these; a dispatch with new ones replaces them._",
    "",
    `### ${HIGHLIGHTS_CATEGORY}`,
    "",
    ...highlights,
  ].join("\n");

const highlightsFromComment = (body) =>
  body?.startsWith(HIGHLIGHTS_COMMENT_MARKER) ? parseReleaseBody(body).highlights : [];

const gh = (args, options = {}) => execFileSync("gh", args, { encoding: "utf8", ...options });

const findHighlightsComment = (repository, pullRequest) => {
  const comments = JSON.parse(gh(["api", "--paginate", `repos/${repository}/issues/${pullRequest}/comments`]));
  return comments.findLast((comment) => comment.body?.startsWith(HIGHLIGHTS_COMMENT_MARKER));
};

const storeHighlightsComment = (repository, pullRequest, highlights) => {
  const bodyPath = `${process.env.RUNNER_TEMP || "/tmp"}/release-highlights-comment-${process.pid}.md`;
  writeFileSync(bodyPath, highlightsComment(highlights));
  const existing = findHighlightsComment(repository, pullRequest);
  if (existing) {
    gh(["api", "-X", "PATCH", `repos/${repository}/issues/comments/${existing.id}`, "-F", `body=@${bodyPath}`]);
    return;
  }
  gh(["api", "-X", "POST", `repos/${repository}/issues/${pullRequest}/comments`, "-F", `body=@${bodyPath}`]);
};

const run = () => {
  const version = process.env.RELEASE_VERSION || JSON.parse(readFileSync("package.json", "utf8")).version;
  const changelogPath = process.env.CHANGELOG_PATH || "CHANGELOG.md";
  const pullRequest = process.env.RELEASE_PR;
  const repository = process.env.GITHUB_REPOSITORY;
  const original = readFileSync(changelogPath, "utf8");

  let highlights = process.env.RELEASE_HIGHLIGHTS?.trim() || "";
  if (highlights) {
    console.log("Using the highlights from the workflow input");
  } else if (pullRequest && repository) {
    const stored = highlightsFromComment(findHighlightsComment(repository, pullRequest)?.body);
    highlights = stored.join("\n");
    console.log(stored.length ? `Reusing ${stored.length} stored highlights` : "No highlights given or stored");
  }

  const result = aggregatePrereleaseChangelog(original, version, highlights);

  if (result.changed) {
    writeFileSync(changelogPath, result.changelog);
    execFileSync("git", ["config", "user.name", "github-actions[bot]"]);
    execFileSync("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
    execFileSync("git", ["add", changelogPath]);
    execFileSync("git", ["commit", "-m", "chore(release): aggregate release changelog"]);
    execFileSync("git", ["push", "origin", `HEAD:${process.env.RELEASE_PR_BRANCH}`]);
  }

  if (!pullRequest || !result.section) return;

  const currentBody = gh(["pr", "view", pullRequest, "--json", "body", "--jq", ".body"]);
  const updatedBody = replaceReleasePullRequestNotes(currentBody, result.section);
  if (updatedBody !== currentBody.trim()) {
    const bodyPath = `${process.env.RUNNER_TEMP || "/tmp"}/release-pr-body-${process.pid}.md`;
    writeFileSync(bodyPath, updatedBody);
    gh(["pr", "edit", pullRequest, "--body-file", bodyPath], { stdio: "inherit" });
  }

  const final = parseReleaseBody(result.section).highlights;
  if (process.env.RELEASE_HIGHLIGHTS?.trim() && repository && final.length) {
    storeHighlightsComment(repository, pullRequest, final);
    console.log(`Stored ${final.length} highlights on pull request #${pullRequest}`);
  }
};

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) run();

export {
  aggregatePrereleaseChangelog,
  highlightsComment,
  highlightsFromComment,
  normalizeHighlights,
  parseReleaseBody,
  renderReleaseBody,
  replaceReleasePullRequestNotes,
};
