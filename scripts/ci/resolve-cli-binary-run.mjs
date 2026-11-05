#!/usr/bin/env node

// Finds the release pull request CI run whose CLI binaries the release can reuse, and marks each
// platform in the matrix with that run's id (`ci_run_id`, empty when nothing is reusable).
//
// This only looks up where an artifact might be. The platform build still refuses it unless its
// build.json matches the release commit's tree and every file matches its hash
// (scripts/ci/cli-release-binary.mjs), and then builds from source. So every failure here MUST leave
// `ci_run_id` empty for every platform instead of failing the release.
//
// Required env: GITHUB_REPOSITORY, MATRIX (the platform matrix JSON)
// Optional env: GH_TOKEN, ARTIFACT_SHA (the release pull request's head commit), GITHUB_OUTPUT

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { artifactName } from "./cli-release-binary.mjs";
import { RELEASE_PR_BRANCH_PREFIX } from "./release-pr.mjs";

const gh = (args) => execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

export function latestReleaseRun(runs, { repository, sha }) {
  return (
    runs
      .filter(
        (run) =>
          run.head_sha === sha &&
          run.event === "pull_request" &&
          run.conclusion === "success" &&
          run.path?.startsWith(".github/workflows/ci.yml") &&
          run.head_repository?.full_name === repository &&
          run.head_branch?.startsWith(RELEASE_PR_BRANCH_PREFIX),
      )
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null
  );
}

export function planReuse({ repository, sha, matrix, runGh = gh }) {
  const none = (reason) => ({ matrix: matrix.map((platform) => ({ ...platform, ci_run_id: "" })), reason });
  if (!sha) return none("no release pull request head commit");
  const runs = JSON.parse(runGh(["api", `repos/${repository}/actions/runs?head_sha=${sha}&event=pull_request&status=success&per_page=30`])).workflow_runs;
  const run = latestReleaseRun(runs ?? [], { repository, sha });
  if (!run) return none(`no successful release pull request CI run for ${sha}`);
  const artifacts = JSON.parse(runGh(["api", `repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`])).artifacts ?? [];
  const available = new Set(artifacts.filter((artifact) => !artifact.expired).map((artifact) => artifact.name));
  const marked = matrix.map((platform) => ({ ...platform, ci_run_id: available.has(artifactName(platform.package)) ? String(run.id) : "" }));
  const count = marked.filter((platform) => platform.ci_run_id).length;
  return { matrix: marked, reason: `run ${run.id} (${run.html_url}) has ${count} of ${marked.length} CLI binaries` };
}

export function main(env = process.env, runGh = gh) {
  const matrix = JSON.parse(env.MATRIX);
  let result;
  try {
    result = planReuse({ repository: env.GITHUB_REPOSITORY, sha: env.ARTIFACT_SHA, matrix, runGh });
  } catch (error) {
    result = { matrix: matrix.map((platform) => ({ ...platform, ci_run_id: "" })), reason: `lookup failed: ${error.message}` };
  }
  process.stdout.write(`CLI binary reuse: ${result.reason}\n`);
  const line = `matrix=${JSON.stringify(result.matrix)}\n`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, line);
  else process.stdout.write(line);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
