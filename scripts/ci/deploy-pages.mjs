#!/usr/bin/env node

import { spawnSync as spawnSync_ } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_POLLS = 60;
const DEFAULT_MAX_DEPLOYMENT_PAGES = 4;
const RETRY_DELAYS_MS = [10000, 30000];
const defaultSleep = (milliseconds) => new Promise((resolve_) => setTimeout(resolve_, milliseconds));

function isPermanentFailure(message) {
  return /authentication|authorization|unauthori[sz]ed|forbidden|invalid (?:api )?token|invalid configuration|configuration error|build failed|failed to build|could not resolve|syntax error/i.test(message);
}

function isTransientFailure(message) {
  if (isPermanentFailure(message)) return false;
  return /internal (?:server )?error|\b(?:HTTP|status(?: code)?)[: =]+5\d\d\b|service unavailable|bad gateway|gateway time[ -]?out|fetch failed|network (?:error|failure|connection)|socket hang up|connection (?:reset|closed|timed out)|\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)\b/i.test(message);
}

function isRetryableError(error) {
  if (error.name === "AbortError") return false;
  if (error.retryable !== undefined) return error.retryable;
  return isTransientFailure([error.message, error.code, error.cause?.message, error.cause?.code].join("\n"));
}

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
  let body;
  try {
    body = await response.json();
  } catch (cause) {
    if (cause.name === "AbortError") throw cause;
    throw Object.assign(new Error(`Cloudflare Pages API ${method} ${path} returned invalid JSON with HTTP ${response.status}`, { cause }), {
      retryable: response.status >= 500 || (response.ok && cause.name !== "SyntaxError" && isRetryableError(cause)),
    });
  }
  if (!response.ok || !body?.success) {
    throw Object.assign(new Error(
      `Cloudflare Pages API ${method} ${path} failed with HTTP ${response.status}:\n${JSON.stringify(body, null, 2)}`,
    ), {
      status: response.status,
      retryable: !isPermanentFailure(JSON.stringify(body?.errors)) && (response.status >= 500 || (response.ok && isTransientFailure(JSON.stringify(body?.errors)))),
    });
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
  maxPages = DEFAULT_MAX_DEPLOYMENT_PAGES,
}) {
  const environment = branch === "main" ? "production" : "preview";
  for (let page = 1; page <= maxPages; page += 1) {
    const body = await cloudflareRequest({
      fetchImpl,
      accountId,
      token,
      project,
      path: `/deployments?env=${environment}&page=${page}`,
    });
    const deployments = Array.isArray(body.result) ? body.result : [];
    const matching = deployments
      .filter((deployment) => {
        const metadata = deployment?.deployment_trigger?.metadata;
        return metadata?.branch === branch && metadata.commit_hash === commitHash;
      })
      .sort((left, right) => Date.parse(right.created_on) - Date.parse(left.created_on));
    if (matching.length > 0) return matching[0];
    if (page >= (body.result_info?.total_pages || page)) break;
  }
  return null;
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
  maxDeploymentPages = DEFAULT_MAX_DEPLOYMENT_PAGES,
}) {
  for (let poll = 0; poll <= maxPolls; poll += 1) {
    const deployment = await findMatchingDeployment({
      accountId,
      token,
      project,
      branch,
      commitHash,
      fetchImpl,
      maxPages: maxDeploymentPages,
    });
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

function uploadPages({ project, branch, commitHash, directory, cwd, spawnImpl }) {
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
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`wrangler terminated by signal ${result.signal}`);
  if (result.status !== 0) {
    throw Object.assign(new Error(`wrangler exited with status ${result.status}`), { retryable: isTransientFailure(output) });
  }
  const reportedUrl = extractPagesUrl(output);
  if (!reportedUrl) throw new Error("Cloudflare Pages deploy produced no pages.dev URL");
  return reportedUrl;
}

async function findReusableDeployment(options, state) {
  if (state.deployment) return state.deployment;
  if (state.uploaded) return waitForMatchingDeployment(options);
  if (!state.lookup) return null;
  const deployment = await findMatchingDeployment({ ...options, maxPages: options.maxDeploymentPages });
  state.lookup = false;
  if (deploymentStatus(deployment) === "success" && options.branch === "main" && !state.uploadAttempted) {
    process.stdout.write(`existing production deployment ${deployment.id} is complete; uploading a fresh deployment\n`);
    state.productionDeploymentId = deployment.id;
    return null;
  }
  if (deployment?.id === state.productionDeploymentId) return null;
  return deployment;
}

async function deployAttempt(options, state) {
  state.deployment = await findReusableDeployment(options, state);
  const status = deploymentStatus(state.deployment);
  if (status === "failure" || status === "canceled") {
    const id = state.deployment.id;
    state.deployment = null;
    state.lookup = true;
    process.stdout.write(`retrying existing Cloudflare Pages deployment ${id}\n`);
    try {
      state.deployment = await retryDeployment({ ...options, id });
    } catch (error) {
      if (error.status !== 409 || isPermanentFailure(error.message)) throw error;
      process.stderr.write(`retrying existing Cloudflare Pages deployment ${id} failed; uploading a fresh deployment: ${error.message}\n`);
      state.lookup = false;
      state.uploaded = false;
      error.retryable = true;
      throw error;
    }
  } else if (state.deployment) {
    process.stdout.write(`reusing existing Cloudflare Pages deployment ${state.deployment.id}\n`);
  } else {
    state.uploadAttempted = true;
    const canVerify = Boolean(options.accountId && options.token);
    state.lookup = options.reuse && canVerify;
    const reportedUrl = uploadPages(options);
    state.uploaded = true;
    if (!canVerify) return reportedUrl;
    state.deployment = await waitForMatchingDeployment(options);
  }
  return waitForDeployment({ ...options, deployment: state.deployment });
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
  sleep = defaultSleep,
  pollIntervalMs,
  maxPolls,
  reuse = false,
  maxDeploymentPages = DEFAULT_MAX_DEPLOYMENT_PAGES,
} = {}) {
  const options = {
    project, branch, commitHash, accountId, token, directory, fetchImpl, spawnImpl, reuse,
    sleep, pollIntervalMs, maxPolls, maxDeploymentPages, cwd: resolve(root, workingDirectory),
  };
  const state = { lookup: Boolean(reuse && accountId && token) };
  for (let attempt = 0; ; attempt += 1) {
    let url;
    try {
      url = await deployAttempt(options, state);
    } catch (error) {
      if (!isRetryableError(error) || attempt >= RETRY_DELAYS_MS.length) throw error;
      const delayMs = RETRY_DELAYS_MS[attempt];
      process.stderr.write(`Cloudflare Pages attempt ${attempt + 1} failed; retrying in ${delayMs} ms: ${error.message}\n`);
      await sleep(delayMs);
      continue;
    }
    writeOutput(outputFile, url);
    process.stdout.write(`deployed to ${url}\n`);
    return url;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await deployPages({
      project: process.env.PROJECT,
      branch: process.env.BRANCH,
      commitHash: process.env.PAGES_COMMIT_HASH || process.env.GITHUB_SHA,
      directory: process.env.PAGES_DIRECTORY || undefined,
      workingDirectory: process.env.PAGES_WORKING_DIRECTORY || undefined,
      reuse: process.env.PAGES_REUSE === "true",
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
