#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createGitHubApi, createStatusPoster } from "./github-api.mjs";

const CONTEXTS = ["PR Title Lint", "CLA Signed"];
const QUEUE_QUERY = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    mergeQueue(branch: $branch) {
      entries(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          position
          headCommit { oid }
          pullRequest { number headRefOid baseRefName state }
        }
      }
    }
  }
}`;

export async function checkMergeGroupGates({ api, paginate, repo, group, runUrl }) {
  const posters = CONTEXTS.map((context) =>
    createStatusPoster({ api, repo, sha: group.head_sha, context }),
  );
  try {
    await Promise.all(posters.map((post) => post("pending", "Checking queued PR gates", runUrl)));
    const branch = group.base_ref.replace(/^refs\/heads\//, "");
    const [owner, name] = repo.split("/");
    const result = await api("/graphql", {
      method: "POST",
      body: { query: QUEUE_QUERY, variables: { owner, name, branch } },
    });
    if (result.errors?.length) throw new Error(JSON.stringify(result.errors));
    const entries = result.data?.repository?.mergeQueue?.entries;
    if (!entries || entries.pageInfo.hasNextPage) {
      throw new Error("Cannot read the complete merge queue");
    }
    const target = entries.nodes.find((entry) => entry.headCommit?.oid === group.head_sha);
    if (!target) throw new Error(`Merge group ${group.head_sha} is no longer in the queue`);

    // A later queue entry can include earlier PRs; every included head MUST pass.
    const included = entries.nodes.filter((entry) => entry.position <= target.position);
    for (const { pullRequest: pr } of included) {
      if (pr.state !== "OPEN" || pr.baseRefName !== branch) {
        throw new Error(`PR #${pr.number} is not open against ${branch}`);
      }
      const statuses = await paginate(`/repos/${repo}/commits/${pr.headRefOid}/statuses`);
      for (const context of CONTEXTS) {
        // GitHub returns newest statuses first. A stale success MUST NOT mask a newer failure.
        const status = statuses.find((item) => item.context === context);
        if (status?.state !== "success" || status.creator?.login !== "github-actions[bot]") {
          throw new Error(`PR #${pr.number}: ${context} is not successful from GitHub Actions`);
        }
      }
    }
    await Promise.all(
      posters.map((post) => post("success", "All queued PR heads passed this gate", runUrl)),
    );
    console.log(`Verified ${CONTEXTS.join(" and ")} for ${included.length} queued PR(s)`);
  } catch (error) {
    await Promise.all(
      posters.map((post) =>
        post("failure", "Queued PR gate verification failed; see workflow log", runUrl),
      ),
    );
    throw error;
  }
}

export async function main(env = process.env) {
  for (const key of ["GH_TOKEN", "GITHUB_REPOSITORY", "GITHUB_EVENT_PATH", "GITHUB_RUN_ID"]) {
    if (!env[key]) throw new Error(`merge-group-gates: ${key} is required`);
  }
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  if (!event.merge_group?.head_sha || !event.merge_group?.base_ref) {
    throw new Error("merge-group-gates: a merge_group event is required");
  }
  await checkMergeGroupGates({
    ...createGitHubApi({
      token: env.GH_TOKEN,
      apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
      name: "merge-group-gates",
    }),
    repo: env.GITHUB_REPOSITORY,
    group: event.merge_group,
    runUrl: `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
