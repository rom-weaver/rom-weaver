#!/usr/bin/env node
//
// Publish the deployment state for the commit the webapp build represents.
// Success links to the exact Cloudflare deployment; pending and failure link
// back to the workflow run so the status is useful before a URL exists.

import { createGitHubApi, createStatusPoster } from "./github-api.mjs";

const {
  GH_TOKEN,
  GITHUB_REPOSITORY: REPO,
  DEPLOYMENT_SHA,
  DEPLOYMENT_CHANNEL,
  DEPLOYMENT_STATE = "",
  DEPLOYMENT_URL = "",
  STATUS_CONTEXT,
  GITHUB_API_URL = "https://api.github.com",
  GITHUB_SERVER_URL = "https://github.com",
  GITHUB_RUN_ID = "",
} = process.env;

for (const [name, value] of Object.entries({
  GH_TOKEN,
  REPO,
  DEPLOYMENT_SHA,
  DEPLOYMENT_CHANNEL,
  STATUS_CONTEXT,
})) {
  if (!value) throw new Error(`deployment-status: ${name} is required but was empty`);
}

const state = DEPLOYMENT_STATE || (DEPLOYMENT_URL ? "success" : "failure");
if (!["error", "failure", "pending", "success"].includes(state)) {
  throw new Error(`deployment-status: invalid state ${state}`);
}
if (state === "success" && !DEPLOYMENT_URL) {
  throw new Error("deployment-status: a successful deployment must provide a URL");
}

const runUrl = `${GITHUB_SERVER_URL}/${REPO}/actions/runs/${GITHUB_RUN_ID}`;
const targetUrl = DEPLOYMENT_URL || runUrl;
const description =
  state === "success"
    ? `Webapp deployed to ${DEPLOYMENT_CHANNEL}`
    : state === "pending"
      ? `Deploying webapp to ${DEPLOYMENT_CHANNEL}`
      : `Webapp deployment to ${DEPLOYMENT_CHANNEL} failed`;

const { api } = createGitHubApi({
  token: GH_TOKEN,
  apiUrl: GITHUB_API_URL,
  name: "deployment-status",
});

await createStatusPoster({
  api,
  repo: REPO,
  sha: DEPLOYMENT_SHA,
  context: STATUS_CONTEXT,
})(state, description, targetUrl);

console.log(`${STATUS_CONTEXT} ${state} on ${DEPLOYMENT_SHA}: ${targetUrl}`);
