#!/usr/bin/env node

// Finds the CI run whose `wasm-prod` artifact a release may try to reuse. Finding a run proves
// nothing about its bytes: fetch-verified-wasm.mjs still verifies the attestation before any
// file is used. This only narrows the search to runs of trusted code, because `gh run list
// --commit` also returns runs of other workflows files and branches whose head is the same
// commit (a pull request whose head is the release commit and whose base is an attacker's
// branch runs the attacker's ci.yml with that head_sha).

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { RELEASE_PR_BRANCH_PREFIX } from "./release-pr.mjs";

// Matched exactly: the API reports the workflow file's path, and no other file may stand in.
export const WORKFLOW_PATH = ".github/workflows/ci.yml";
export const DEFAULT_BRANCH = "main";
// The artifact and the checksum manifest that ci.yml's `wasm-attest` job signs.
export const REQUIRED_ARTIFACTS = ["wasm-prod", "wasm-prod-manifest"];

const gh = (args, env) => execFileSync("gh", args, { encoding: "utf8", env }).trim();

// A pull request number is digits only; anything else is "no pull request", which accepts
// push-to-main runs alone.
export const normalizePrNumber = (value) => (/^[1-9][0-9]*$/u.test(String(value ?? "")) ? String(value) : "");

// Pure: true only for a successful run of this repository's own ci.yml on code that is trusted
// to build the module. A push run must be on main. A pull request run must be for the given
// release pull request, which must target main, from the release branch of this repository.
export function isTrustedRun(run, { repository, prNumber = "" }) {
  if (!run || typeof run !== "object") return false;
  if (run.path !== WORKFLOW_PATH) return false;
  if (run.status !== "completed" || run.conclusion !== "success") return false;
  if (run.repository?.full_name !== repository) return false;
  if (run.head_repository?.full_name !== repository) return false;
  if (run.event === "push") return run.head_branch === DEFAULT_BRANCH;
  if (run.event === "pull_request") {
    const number = normalizePrNumber(prNumber);
    if (!number) return false;
    if (typeof run.head_branch !== "string" || !run.head_branch.startsWith(RELEASE_PR_BRANCH_PREFIX)) return false;
    return (run.pull_requests ?? []).some((pr) => String(pr?.number) === number && pr?.base?.ref === DEFAULT_BRANCH);
  }
  return false;
}

// Newest first by creation time, then by id, so a rerun that replaced a run wins.
export const newestFirst = (runs) =>
  [...runs].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) || (b.id ?? 0) - (a.id ?? 0));

export function trustedRuns(runs, { repository, targetSha, prNumber = "" }) {
  return newestFirst(runs).filter((run) => run.head_sha === targetSha && isTrustedRun(run, { repository, prNumber }));
}

export function artifactsAvailable(artifacts) {
  const live = new Set((artifacts ?? []).filter((artifact) => artifact.expired === false).map((artifact) => artifact.name));
  return REQUIRED_ARTIFACTS.every((name) => live.has(name));
}

export function resolveWasmRun({ repository, targetSha, prNumber = "", preferredRunId = "", env = process.env, runGh = (args) => gh(args, env) }) {
  const json = (args) => JSON.parse(runGh(args) || "null");
  const hasArtifacts = (runId) => artifactsAvailable(json(["api", `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`, "--jq", ".artifacts"]));
  const options = { repository, targetSha, prNumber };
  if (preferredRunId) {
    const preferred = json(["api", `repos/${repository}/actions/runs/${preferredRunId}`]);
    if (trustedRuns([preferred], options).length) return { runId: String(preferred.id), available: hasArtifacts(preferred.id) };
    process.stdout.write(`run ${preferredRunId} is not a trusted ci.yml run for ${targetSha} - searching by commit\n`);
  }
  const runs = json(["api", `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${targetSha}&status=success&per_page=100`, "--jq", ".workflow_runs"]) ?? [];
  // The newest trusted run can have skipped the WASM build, so keep looking until one has it.
  for (const run of trustedRuns(runs, options)) if (hasArtifacts(run.id)) return { runId: String(run.id), available: true };
  return { runId: "", available: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (!process.env.GITHUB_REPOSITORY || !process.env.TARGET_SHA) throw new Error("GITHUB_REPOSITORY and TARGET_SHA are required");
    const { runId, available } = resolveWasmRun({ repository: process.env.GITHUB_REPOSITORY, targetSha: process.env.TARGET_SHA, prNumber: normalizePrNumber(process.env.PR_NUMBER), preferredRunId: process.env.PREFERRED_RUN_ID });
    const line = `run_id=${runId} available=${available} (sha ${process.env.TARGET_SHA})\n`;
    process.stdout.write(line);
    // Written to stdout directly when unset rather than opening "/dev/stdout",
    // which is a Linux-ism the shell could afford and this cannot.
    const outputs = `run_id=${runId}\navailable=${available}\n`;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs);
    else process.stdout.write(outputs);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
