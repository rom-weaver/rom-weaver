#!/usr/bin/env node

// A release tag's CI run usually starts before main saves its tested bundle. This waits for that
// save, so the tag's deploy legs restamp the bundle instead of building. It stops early when main
// has no run for the commit. It also stops when that run ends without saving.

import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { createGitHubApi } from "./github-api.mjs";

const MAIN_REF = "refs/heads/main";
const POLL_INTERVAL_MS = 30_000;
const WAIT_LIMIT_MS = 30 * 60_000;

export const SAVED = "saved";
export const PENDING = "pending";

/** Returns SAVED, PENDING, or the reason main's bundle for `sha` will not be saved. */
export async function bundleState(api, { repository, sha, key }) {
  const isSaved = async () => {
    const query = new URLSearchParams({ key, ref: MAIN_REF });
    const result = await api(`/repos/${repository}/actions/caches?${query}`);
    if (!Array.isArray(result?.actions_caches)) throw new Error("wait-webapp-bundle: missing actions_caches");
    // `key` matches by prefix. Only main's runs write entries on its ref.
    return result.actions_caches.some((cache) => cache.key === key && cache.ref === MAIN_REF);
  };
  if (await isSaved()) return SAVED;
  const query = new URLSearchParams({ branch: "main", event: "push", head_sha: sha, per_page: "100" });
  const result = await api(`/repos/${repository}/actions/workflows/ci.yml/runs?${query}`);
  if (!Array.isArray(result?.workflow_runs)) throw new Error("wait-webapp-bundle: missing workflow_runs");
  if (result.workflow_runs.length === 0) return "main has no CI run for this commit";
  if (result.workflow_runs.some((run) => run.status !== "completed")) return PENDING;
  // The save can land between the first check and the run completing.
  return (await isSaved()) ? SAVED : "main's CI run ended without saving a bundle";
}

/** Polls [bundleState] until it is not PENDING, or returns "timed out" after `limitMs`. */
export async function waitForBundle({
  api,
  bundle,
  now = Date.now,
  wait = sleep,
  limitMs = WAIT_LIMIT_MS,
  intervalMs = POLL_INTERVAL_MS,
}) {
  const deadline = now() + limitMs;
  for (;;) {
    const state = await bundleState(api, bundle);
    if (state !== PENDING) return state;
    if (now() >= deadline) return "timed out";
    await wait(intervalMs);
  }
}

async function main() {
  const { api } = createGitHubApi({
    token: process.env.GITHUB_TOKEN,
    apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    name: "wait-webapp-bundle",
  });
  const bundle = { repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA, key: process.env.BUNDLE_KEY };
  if (!bundle.repository || !bundle.sha || !bundle.key)
    throw new Error("wait-webapp-bundle: GITHUB_REPOSITORY, GITHUB_SHA and BUNDLE_KEY are required");
  const state = await waitForBundle({ api, bundle });
  process.stdout.write(
    state === SAVED
      ? `main saved ${bundle.key}\n`
      : `::warning::No tested bundle from main (${state}); the deploy builds its own.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // A refused dual-stack connect fails with an AggregateError whose own message is empty.
    const causes = error.cause instanceof AggregateError ? error.cause.errors : [error.cause];
    const messages = [error, ...causes].map((cause) => cause?.message).filter(Boolean);
    // API error bodies span lines, and an annotation is one line.
    const reason = messages.join(": ").replace(/\s+/g, " ").trim();
    process.stdout.write(`::warning::Could not check for main's tested bundle (${reason}); the deploy builds its own.\n`);
    process.exitCode = 1;
  });
}
