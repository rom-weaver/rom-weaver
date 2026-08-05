#!/usr/bin/env node
//
// Publish the deployment state for the commit the webapp build represents.
// The commit status keeps the immutable deployment URL; the GitHub deployment
// record can use a stable target alias for pull-request navigation.

import { createGitHubApi, createStatusPoster } from "./github-api.mjs";

const {
  GH_TOKEN,
  GITHUB_REPOSITORY: REPO,
  DEPLOYMENT_SHA,
  DEPLOYMENT_REF = DEPLOYMENT_SHA,
  DEPLOYMENT_CHANNEL,
  DEPLOYMENT_STATE = "",
  DEPLOYMENT_URL = "",
  DEPLOYMENT_TARGET_URL = "",
  DEPLOYMENT_RECORD = "false",
  DEPLOYMENT_ENVIRONMENT = "",
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
const statusUrl = state === "success" ? DEPLOYMENT_URL : runUrl;
const deploymentTargetUrl = state === "success" ? DEPLOYMENT_TARGET_URL || DEPLOYMENT_URL : runUrl;
const description =
  state === "success"
    ? `Webapp deployed to ${DEPLOYMENT_CHANNEL}`
    : state === "pending"
      ? `Deploying webapp to ${DEPLOYMENT_CHANNEL}`
      : `Webapp deployment to ${DEPLOYMENT_CHANNEL} failed`;

const createDeploymentRecord = DEPLOYMENT_RECORD === "true";
if (createDeploymentRecord && !DEPLOYMENT_ENVIRONMENT) {
  throw new Error("deployment-status: DEPLOYMENT_ENVIRONMENT is required for a deployment record");
}
if (createDeploymentRecord && !["error", "failure", "success"].includes(state)) {
  throw new Error(`deployment-status: cannot create a final deployment record for ${state}`);
}

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
})(state, description, statusUrl);

if (createDeploymentRecord) {
  const deployment = await api(`/repos/${REPO}/deployments`, {
    method: "POST",
    body: {
      ref: DEPLOYMENT_REF,
      task: "deploy",
      auto_merge: false,
      required_contexts: [],
      environment: DEPLOYMENT_ENVIRONMENT,
      description,
      transient_environment: DEPLOYMENT_CHANNEL === "preview",
      production_environment: false,
    },
  });

  await api(`/repos/${REPO}/deployments/${deployment.id}/statuses`, {
    method: "POST",
    body: {
      state,
      target_url: deploymentTargetUrl,
      environment_url: state === "success" ? deploymentTargetUrl : undefined,
      description,
    },
  });
}

console.log(`${STATUS_CONTEXT} ${state} on ${DEPLOYMENT_SHA}: ${statusUrl}`);
