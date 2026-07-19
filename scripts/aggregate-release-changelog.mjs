#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_HEADING = /^## .+$/gm;
const VERSION_FROM_HEADING = /^## \[?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/;

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

const mergeReleaseBodies = (bodies) => {
  const categories = new Map();
  const uncategorized = [];

  for (const body of bodies) {
    let category;
    for (const line of body.split(/\r?\n/)) {
      const text = line.trim();
      if (!text) continue;
      if (text.startsWith("### ")) {
        category = text.slice(4);
        if (!categories.has(category)) categories.set(category, []);
        continue;
      }
      if (category) addUnique(categories.get(category), text);
      else addUnique(uncategorized, text);
    }
  }

  const lines = [...uncategorized];
  for (const [category, entries] of categories) {
    if (lines.length) lines.push("");
    lines.push(`### ${category}`, "", ...entries);
  }
  return lines.join("\n").trim();
};

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

const aggregatePrereleaseChangelog = (changelog, version) => {
  if (version.includes("-")) return { changed: false, changelog, section: "" };

  const sections = parseSections(changelog);
  const current = sections.find((section) => section.version === version);
  if (!current) return { changed: false, changelog, section: "" };

  const prereleases = sections.filter((section) => section.version.startsWith(`${version}-`));
  if (!prereleases.length) {
    return { changed: false, changelog, section: currentSection(changelog, version) };
  }

  const previousStable = sections.slice(current.index + 1).find((section) => !section.version.includes("-"));
  const mergedBody = mergeReleaseBodies([current.body, ...prereleases.map((section) => section.body)]);
  const mergedHeading = updateCompareHeading(current.heading, previousStable?.version, version);
  const mergedSection = `${mergedHeading}\n\n${mergedBody}`.trim();

  let updated = changelog;
  for (const section of [...prereleases].sort((left, right) => right.start - left.start)) {
    updated = updated.slice(0, section.start) + updated.slice(section.end);
  }
  updated = updated.slice(0, current.start) + `${mergedSection}\n\n` + updated.slice(current.end);

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

const run = () => {
  const version = process.env.RELEASE_VERSION || JSON.parse(readFileSync("package.json", "utf8")).version;
  const changelogPath = process.env.CHANGELOG_PATH || "CHANGELOG.md";
  const original = readFileSync(changelogPath, "utf8");
  const result = aggregatePrereleaseChangelog(original, version);

  if (result.changed) {
    writeFileSync(changelogPath, result.changelog);
    execFileSync("git", ["config", "user.name", "github-actions[bot]"]);
    execFileSync("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
    execFileSync("git", ["add", changelogPath]);
    execFileSync("git", ["commit", "-m", "chore(release): aggregate prerelease changelog"]);
    execFileSync("git", ["push", "origin", `HEAD:${process.env.RELEASE_PR_BRANCH}`]);
  }

  if (process.env.RELEASE_PR && result.section) {
    const currentBody = execFileSync(
      "gh",
      ["pr", "view", process.env.RELEASE_PR, "--json", "body", "--jq", ".body"],
      { encoding: "utf8" },
    );
    const updatedBody = replaceReleasePullRequestNotes(currentBody, result.section);
    if (updatedBody !== currentBody.trim()) {
      const bodyPath = `${process.env.RUNNER_TEMP || "/tmp"}/release-pr-body-${process.pid}.md`;
      writeFileSync(bodyPath, updatedBody);
      execFileSync("gh", ["pr", "edit", process.env.RELEASE_PR, "--body-file", bodyPath], {
        stdio: "inherit",
      });
    }
  }
};

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) run();

export { aggregatePrereleaseChangelog, mergeReleaseBodies, replaceReleasePullRequestNotes };
