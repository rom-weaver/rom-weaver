#!/usr/bin/env node

import { spawnSync as spawnSync_ } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_POLLS = 60;
const defaultSleep = (milliseconds) => new Promise((resolve_) => setTimeout(resolve_, milliseconds));

export const extractPagesUrl = (output) =>
  [...output.matchAll(/https:\/\/[a-z0-9.-]+\.pages\.dev/g)].at(-1)?.[0] || "";

export const deploymentStatus = (deployment) =>
  deployment?.latest_stage?.status || deployment?.stages?.at(-1)?.status || "";

export const deploymentUrl = (deployment) => deployment?.url || deployment?.aliases?.[0] || "";

function apiPath({ accountId, project, path = "" }) {
  return `${CLOUDFLARE_API}/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(project)}${path}`;
}

async function cloudflareRequest({ fetchImpl, accountId, token, project, path, method = "GET" }) {
  const response = await fetchImpl(apiPath({ accountId, project, path }), {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  if (!response.ok || !body?.success) {
    throw new Error(
      `Cloudflare Pages API ${method} ${path} failed with HTTP ${response.status}:\n${JSON.stringify(body, null, 2)}`,
    );
  }
  return body;
}

// Wrangler has no idempotency flag for Pages Direct Upload. Pages exposes the
// branch, commit, stage, and retry data needed to make the wrapper idempotent:
// https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/
export async function findMatchingDeployment({
  accountId,
  token,
  project,
  branch,
  commitHash,
  fetchImpl = globalThis.fetch,
}) {
  const environment = branch === "main" ? "production" : "preview";
  const deployments = [];
  for (let page = 1; ; page += 1) {
    const body = await cloudflareRequest({
      fetchImpl,
      accountId,
      token,
      project,
      path: `/deployments?env=${environment}&page=${page}&per_page=100`,
    });
    deployments.push(...(Array.isArray(body.result) ? body.result : []));
    if (page >= (body.result_info?.total_pages || page)) break;
  }

  return deployments
    .filter((deployment) => {
      const metadata = deployment?.deployment_trigger?.metadata;
      return metadata?.branch === branch && metadata.commit_hash === commitHash;
    })
    .sort((left, right) => Date.parse(right.created_on) - Date.parse(left.created_on))[0] || null;
}

export async function waitForMatchingDeployment({
  accountId,
  token,
  project,
  branch,
  commitHash,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPolls = DEFAULT_MAX_POLLS,
}) {
  for (let poll = 0; poll <= maxPolls; poll += 1) {
    const deployment = await findMatchingDeployment({ accountId, token, project, branch, commitHash, fetchImpl });
    if (deployment) return deployment;
    if (poll < maxPolls) await sleep(pollIntervalMs);
  }
  throw new Error(`Cloudflare Pages deployment for ${project}/${branch} at ${commitHash} was not visible after ${maxPolls} polls`);
}

async function getDeployment({ accountId, token, project, id, fetchImpl }) {
  const body = await cloudflareRequest({
    fetchImpl,
    accountId,
    token,
    project,
    path: `/deployments/${encodeURIComponent(id)}`,
  });
  if (!body.result) throw new Error(`Cloudflare Pages deployment ${id} lookup returned no deployment`);
  return body.result;
}

async function retryDeployment({ accountId, token, project, id, fetchImpl }) {
  const body = await cloudflareRequest({
    fetchImpl,
    accountId,
    token,
    project,
    path: `/deployments/${encodeURIComponent(id)}/retry`,
    method: "POST",
  });
  if (!body.result) throw new Error(`Cloudflare Pages deployment ${id} retry returned no deployment`);
  return body.result;
}

export async function waitForDeployment({
  accountId,
  token,
  project,
  deployment,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPolls = DEFAULT_MAX_POLLS,
}) {
  let current = deployment;
  for (let poll = 0; ; poll += 1) {
    if (!current?.id) throw new Error("Cloudflare Pages deployment response had no deployment ID");
    const status = deploymentStatus(current);
    if (status === "success") {
      if (current.is_skipped) throw new Error(`Cloudflare Pages deployment ${current.id} was skipped`);
      const url = deploymentUrl(current);
      if (!url) throw new Error(`Cloudflare Pages deployment ${current.id} has no URL`);
      return url;
    }
    if (status === "failure" || status === "canceled") {
      throw new Error(`Cloudflare Pages deployment ${current.id} ended with status ${status}`);
    }
    if (poll >= maxPolls) {
      throw new Error(`Cloudflare Pages deployment ${current.id} did not finish after ${maxPolls} polls`);
    }
    await sleep(pollIntervalMs);
    current = await getDeployment({ accountId, token, project, id: current.id, fetchImpl });
  }
}

function writeOutput(outputFile, url) {
  if (outputFile) appendFileSync(outputFile, `url=${url}\n`);
}

export async function deployPages({
  project,
  branch,
  commitHash,
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
  token = process.env.CLOUDFLARE_API_TOKEN,
  root = process.cwd(),
  directory = "dist",
  workingDirectory = "packages/rom-weaver-webapp",
  outputFile = process.env.GITHUB_OUTPUT,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawnSync_,
  sleep,
  pollIntervalMs,
  maxPolls,
} = {}) {
  const cwd = resolve(root, workingDirectory);

  if (accountId && token) {
    const existing = await findMatchingDeployment({ accountId, token, project, branch, commitHash, fetchImpl });
    if (existing) {
      let deployment = existing;
      const status = deploymentStatus(deployment);
      if (status === "failure" || status === "canceled") {
        process.stdout.write(`retrying existing Cloudflare Pages deployment ${deployment.id}\n`);
        deployment = await retryDeployment({ accountId, token, project, id: deployment.id, fetchImpl });
      } else {
        process.stdout.write(`reusing existing Cloudflare Pages deployment ${deployment.id}\n`);
      }
      const url = await waitForDeployment({ accountId, token, project, deployment, fetchImpl, sleep, pollIntervalMs, maxPolls });
      writeOutput(outputFile, url);
      process.stdout.write(`deployed to ${url}\n`);
      return url;
    }
  }

  // maxBuffer is lifted because spawnSync KILLS the child once the default
  // 1 MiB is exceeded - on a deploy that means a half-uploaded site, not just a
  // truncated log.
  const result = spawnImpl(
    "npx",
    [
      "--yes",
      "wrangler@4",
      "pages",
      "deploy",
      directory,
      `--project-name=${project}`,
      `--branch=${branch}`,
      `--commit-hash=${commitHash}`,
    ],
    { cwd, encoding: "utf8", maxBuffer: Infinity },
  );
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  process.stdout.write(output);
  if (result.status !== 0) throw new Error(`wrangler exited with status ${result.status}`);
  const reportedUrl = extractPagesUrl(output);
  if (!reportedUrl) throw new Error("Cloudflare Pages deploy produced no pages.dev URL");
  let url = reportedUrl;
  if (accountId && token) {
    const deployment = await waitForMatchingDeployment({
      accountId,
      token,
      project,
      branch,
      commitHash,
      fetchImpl,
      sleep,
      pollIntervalMs,
      maxPolls,
    });
    url = await waitForDeployment({ accountId, token, project, deployment, fetchImpl, sleep, pollIntervalMs, maxPolls });
  }
  writeOutput(outputFile, url);
  process.stdout.write(`deployed to ${url}\n`);
  return url;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await deployPages({
      project: process.env.PROJECT,
      branch: process.env.BRANCH,
      commitHash: process.env.PAGES_COMMIT_HASH || process.env.GITHUB_SHA,
      directory: process.env.PAGES_DIRECTORY || undefined,
      workingDirectory: process.env.PAGES_WORKING_DIRECTORY || undefined,
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
