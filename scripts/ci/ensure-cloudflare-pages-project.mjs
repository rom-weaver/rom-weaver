#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

const API_ROOT = "https://api.cloudflare.com/client/v4";
const BROTLI_COMPATIBILITY_FLAG = "brotli_content_encoding";

const authorizationHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});

const projectUrl = (accountId, project) => `${API_ROOT}/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}`;

const compatibilityFlags = (config) =>
  Array.isArray(config?.compatibility_flags) ? config.compatibility_flags : [];

const removeObsoleteBrotliCompatibility = async ({ accountId, token, project, fetchImpl }) => {
  const url = projectUrl(accountId, project);
  const response = await fetchImpl(url, {
    headers: authorizationHeaders(token),
  });
  const body = await response.json();
  if (!response.ok || !body.success) {
    throw new Error(`unexpected response reading '${project}' Pages project:\n${JSON.stringify(body, null, 2)}`);
  }

  const configs = body.result?.deployment_configs ?? {};
  const deploymentConfigs = {};
  for (const environment of ["preview", "production"]) {
    const flags = compatibilityFlags(configs[environment]);
    const remainingFlags = flags.filter((flag) => flag !== BROTLI_COMPATIBILITY_FLAG);
    if (remainingFlags.length !== flags.length) {
      deploymentConfigs[environment] = {
        compatibility_flags: remainingFlags,
      };
    }
  }

  if (Object.keys(deploymentConfigs).length === 0) return false;

  const updateResponse = await fetchImpl(url, {
    method: "PATCH",
    headers: authorizationHeaders(token),
    body: JSON.stringify({ deployment_configs: deploymentConfigs }),
  });
  const updateBody = await updateResponse.json();
  if (!updateResponse.ok || !updateBody.success) {
    throw new Error(`unexpected response updating '${project}' Pages project:\n${JSON.stringify(updateBody, null, 2)}`);
  }
  return true;
};

export async function ensurePagesProject({ accountId, token, project, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects`, {
    method: "POST",
    headers: authorizationHeaders(token),
    body: JSON.stringify({ name: project, production_branch: "main" }),
  });
  const body = await response.json();
  let result;
  if (body.success) {
    result = "created";
  } else if ((body.errors || []).some((error) => error.code === 8000002 || /already exists/i.test(error.message || ""))) {
    result = "exists";
  } else {
    throw new Error(`unexpected response creating '${project}':\n${JSON.stringify(body, null, 2)}`);
  }

  if (await removeObsoleteBrotliCompatibility({ accountId, token, project, fetchImpl })) {
    return result === "created" ? "created" : "updated";
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await ensurePagesProject({ accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN, project: process.env.PROJECT });
    const message = result === "created" ? "created" : result === "updated" ? "updated" : "already exists";
    process.stdout.write(`${message} Pages project '${process.env.PROJECT}'\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
