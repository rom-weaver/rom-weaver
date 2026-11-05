#!/usr/bin/env node

// Plans release.yml's semver-check matrix: one leg per published workspace crate, or none when
// every crate's bump already allows breaking changes. cargo-semver-checks skips every lint for
// such a bump, but still builds the rustdoc of both versions, which is most of the job's time.
//
// Skipping is decided only from facts this script is certain of. A failed lookup, a crate with no
// published baseline, a prerelease, or a version that is not greater than the baseline leaves the
// check running (the leg repeats the lookup and fails or skips by its own rules).
//
// Required env: GITHUB_OUTPUT, CRATES_IO_USER_AGENT
// Optional env: GITHUB_STEP_SUMMARY, CRATES_IO_LOOKUP_DELAY_MS (default 1000: crates.io asks for
// at most one request per second)

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(text) {
  const match = SEMVER.exec(text ?? "");
  if (!match) return null;
  return {
    text,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? "",
  };
}

// Compares release triples only; callers reject prereleases first.
function compareTriple(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export function listPublishedCrates(metadata) {
  const members = new Set(metadata.workspace_members);
  const crates = metadata.packages
    .filter((pkg) => members.has(pkg.id))
    .filter((pkg) => !(Array.isArray(pkg.publish) && pkg.publish.length === 0))
    .map((pkg) => ({ name: pkg.name, version: pkg.version }));
  if (crates.length === 0) throw new Error("the workspace publishes no crates");
  return crates;
}

// The latest stable release cargo-semver-checks would compare against, or null when this script
// cannot name it with certainty: no live stable version, an unparsable version, or a live
// prerelease ahead of the newest stable one (the tool's choice between them is not worth guessing).
export function latestBaseline(versions) {
  const live = versions.filter((entry) => !entry.yanked).map((entry) => parseVersion(entry.num));
  if (live.some((version) => version === null)) return null;
  const stable = live.filter((version) => !version.prerelease);
  if (stable.length === 0) return null;
  const best = stable.reduce((top, version) => (compareTriple(version, top) > 0 ? version : top));
  if (live.some((version) => version.prerelease && compareTriple(version, best) >= 0)) return null;
  return best;
}

// Whether `current` may break API relative to `baseline`: a major bump, or a 0.x minor bump.
// Anything else - patch, a minor bump from 1.0 on, 0.0.x, prereleases, not greater - needs the check.
export function bumpAllowsBreaking(current, baseline) {
  if (!current || !baseline || current.prerelease || baseline.prerelease) return false;
  if (compareTriple(current, baseline) <= 0) return false;
  if (current.major > baseline.major) return true;
  return current.major === 0 && baseline.major === 0 && current.minor > baseline.minor;
}

// `lookup(name)` resolves `{ status, versions }`; any other shape or a thrown error means "unknown".
export function planSemver(crates, lookup) {
  const decisions = crates.map((crate) => {
    let reason = "baseline lookup failed";
    try {
      const result = lookup(crate.name);
      if (result.status === 404) reason = "no published baseline";
      else if (result.status !== 200 || !Array.isArray(result.versions)) reason = `baseline lookup returned HTTP ${result.status}`;
      else {
        const baseline = latestBaseline(result.versions);
        const current = parseVersion(crate.version);
        if (!baseline) reason = "baseline version is ambiguous";
        else if (!current) reason = `version ${crate.version} is not semver`;
        else if (bumpAllowsBreaking(current, baseline))
          return { ...crate, baseline: baseline.text, skip: true, reason: "breaking bump allowed" };
        else {
          const greater = !current.prerelease && compareTriple(current, baseline) > 0;
          const why = greater ? "bump is not shown to allow breaking changes" : "version is not a greater stable release";
          return { ...crate, baseline: baseline.text, skip: false, reason: why };
        }
      }
    } catch (error) {
      reason = `baseline lookup failed (${error.message})`;
    }
    return { ...crate, baseline: "", skip: false, reason };
  });
  const skipped = decisions.every((decision) => decision.skip);
  return { skipped, crates: skipped ? [] : crates.map((crate) => crate.name), decisions };
}

export function summaryMarkdown(plan) {
  const rows = plan.decisions.map(
    (decision) => `| ${decision.name} | ${decision.baseline || "n/a"} | ${decision.version} | ${decision.skip ? "skip" : "check"}: ${decision.reason} |`,
  );
  return [
    plan.skipped
      ? "### Semver check skipped: breaking bump allowed"
      : "### Semver check runs",
    "",
    plan.skipped
      ? "Every published crate's bump allows breaking changes, so no rustdoc is built for the API comparison."
      : "At least one published crate's bump is not shown to allow breaking changes, so every crate is checked.",
    "",
    "| Crate | Latest on crates.io | This release | Decision |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

// Same request as the semver-check leg: three retries on every error, 404 is the only "no baseline".
export function fetchCratesIo(name, userAgent) {
  const directory = mkdtempSync(join(tmpdir(), "semver-plan-"));
  try {
    const body = join(directory, "body.json");
    const result = spawnSync(
      "curl",
      ["--silent", "--retry", "3", "--retry-all-errors", "--fail", "--output", body, "--write-out", "%{http_code}", "--user-agent", userAgent, `https://crates.io/api/v1/crates/${name}`],
      { encoding: "utf8" },
    );
    const status = Number(result.stdout);
    if (status !== 200) return { status: Number.isFinite(status) ? status : 0 };
    return { status, versions: JSON.parse(readFileSync(body, "utf8")).versions };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function main(env = process.env, run = { metadata: () => JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], { encoding: "utf8", maxBuffer: 1 << 28 })), lookup: fetchCratesIo, sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }) {
  const crates = listPublishedCrates(run.metadata());
  const userAgent = env.CRATES_IO_USER_AGENT ?? "";
  const delay = Number(env.CRATES_IO_LOOKUP_DELAY_MS ?? 1000);
  let first = true;
  const plan = planSemver(crates, (name) => {
    if (!first) run.sleep(delay);
    first = false;
    return run.lookup(name, userAgent);
  });
  const summary = summaryMarkdown(plan);
  process.stdout.write(`${summary}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `crates=${JSON.stringify(plan.crates)}\nskipped=${plan.skipped}\n`);
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
