#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";
import { createGitHubApi } from "./github-api.mjs";

export async function updateAutoMergePrs({
  api,
  paginate,
  repo,
  base = "main",
  dryRun = false,
  log = console.log,
}) {
  const candidates = await paginate(
    `/repos/${repo}/pulls?state=open&base=${encodeURIComponent(base)}`,
  );
  const results = [];
  const failures = [];
  for (const candidate of candidates) {
    if (candidate.draft || !candidate.auto_merge || candidate.head.repo?.full_name !== repo)
      continue;
    try {
      // Selection MUST use fresh state: auto-merge may be disabled after listing.
      const pr = await api(`/repos/${repo}/pulls/${candidate.number}`);
      if (
        pr.state !== "open" ||
        pr.draft ||
        !pr.auto_merge ||
        pr.base.ref !== base ||
        pr.head.repo?.full_name !== repo
      )
        continue;
      const comparison = await api(`/repos/${repo}/compare/${pr.base.sha}...${pr.head.sha}`);
      if (comparison.behind_by === 0) continue;
      if (pr.mergeable !== true) {
        log(
          `PR #${pr.number}: skipped (${pr.mergeable === false ? "merge conflict" : "mergeability pending"})`,
        );
        continue;
      }
      if (!dryRun) {
        // GitHub MUST reject the update if another push changed this head.
        await api(`/repos/${repo}/pulls/${pr.number}/update-branch`, {
          method: "PUT",
          body: { expected_head_sha: pr.head.sha },
        });
      }
      log(`PR #${pr.number}: ${dryRun ? "would update" : "update requested"} from ${base}`);
      results.push(pr.number);
    } catch (error) {
      log(`PR #${candidate.number}: update failed: ${error.message}`);
      failures.push(candidate.number);
    }
  }
  if (failures.length) throw new Error(`Branch updates failed for PRs: ${failures.join(", ")}`);
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.GH_TOKEN;
  const repo = process.env.GH_REPO;
  if (!token || !repo) throw new Error("GH_TOKEN and GH_REPO are required for branch updates");
  const client = createGitHubApi({
    token,
    apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    name: "rom-weaver-branch-updates",
  });
  await updateAutoMergePrs({
    ...client,
    repo,
    base: process.env.PR_BASE || "main",
    dryRun: process.argv.includes("--dry-run"),
  });
}
