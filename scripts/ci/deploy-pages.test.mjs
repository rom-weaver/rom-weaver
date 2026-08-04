import assert from "node:assert/strict";
import test from "node:test";

import { deployPages, findMatchingDeployment } from "./deploy-pages.mjs";

const ACCOUNT = "account";
const PROJECT = "rom-weaver";
const BRANCH = "main";
const SHA = "0123456789abcdef";

function deployment(overrides = {}) {
  return {
    id: "deployment-id",
    created_on: "2026-08-04T12:00:00.000Z",
    deployment_trigger: { metadata: { branch: BRANCH, commit_hash: SHA } },
    latest_stage: { status: "success" },
    url: "https://deployment.rom-weaver.pages.dev",
    ...overrides,
  };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function queuedFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request: ${url}`);
    return response(next.body ?? next, next.status ?? 200);
  };
  return { calls, fetchImpl };
}

const listResponse = (items, resultInfo = {}) => ({ success: true, result: items, result_info: resultInfo });
const deploymentResponse = (item) => ({ success: true, result: item });
const errorResponse = (status, message) => ({ status, body: { success: false, errors: [{ message }] } });

test("reuses a successful deployment for the same branch and commit", async () => {
  const existing = deployment({ deployment_trigger: { metadata: { branch: "pr-12", commit_hash: SHA } } });
  const { calls, fetchImpl } = queuedFetch([listResponse([existing])]);
  const spawned = [];

  const url = await deployPages({
    accountId: ACCOUNT,
    token: "token",
    project: PROJECT,
    branch: "pr-12",
    commitHash: SHA,
    outputFile: null,
    fetchImpl,
    spawnImpl: (...args) => spawned.push(args),
    reuse: true,
  });

  assert.equal(url, existing.url);
  assert.equal(spawned.length, 0);
  assert.match(calls[0].url, /\/deployments\?env=preview&page=1$/);
});

test("waits for an in-progress matching deployment", async () => {
  const existing = deployment({ latest_stage: { status: "active" } });
  const finished = deployment({ latest_stage: { status: "success" } });
  const { calls, fetchImpl } = queuedFetch([
    listResponse([existing]),
    deploymentResponse(finished),
  ]);
  let sleeps = 0;

  const url = await deployPages({
    accountId: ACCOUNT,
    token: "token",
    project: PROJECT,
    branch: BRANCH,
    commitHash: SHA,
    outputFile: null,
    fetchImpl,
    sleep: async () => { sleeps += 1; },
    reuse: true,
  });

  assert.equal(url, finished.url);
  assert.equal(sleeps, 1);
  assert.match(calls[1].url, /\/deployments\/deployment-id$/);
});

test("retries a failed matching deployment instead of creating another one", async () => {
  const failed = deployment({ latest_stage: { status: "failure" } });
  const retried = deployment({ latest_stage: { status: "active" } });
  const finished = deployment({ latest_stage: { status: "success" } });
  const { calls, fetchImpl } = queuedFetch([
    listResponse([failed]),
    deploymentResponse(retried),
    deploymentResponse(finished),
  ]);

  const url = await deployPages({
    accountId: ACCOUNT,
    token: "token",
    project: PROJECT,
    branch: BRANCH,
    commitHash: SHA,
    outputFile: null,
    fetchImpl,
    sleep: async () => {},
    reuse: true,
  });

  assert.equal(url, finished.url);
  assert.equal(calls[1].options.method, "POST");
  assert.match(calls[1].url, /\/deployments\/deployment-id\/retry$/);
});

test("runs Wrangler when no deployment matches the branch and commit", async () => {
  const trigger = { metadata: { branch: "pr-12", commit_hash: SHA } };
  const created = deployment({ id: "created-deployment", deployment_trigger: trigger, latest_stage: { status: "active" } });
  const finished = deployment({ id: "created-deployment", deployment_trigger: trigger, latest_stage: { status: "success" } });
  const { calls, fetchImpl } = queuedFetch([
    listResponse([]),
    listResponse([created]),
    deploymentResponse(finished),
  ]);
  const spawned = [];
  let sleeps = 0;

  const url = await deployPages({
    accountId: ACCOUNT,
    token: "token",
    project: PROJECT,
    branch: "pr-12",
    commitHash: SHA,
    outputFile: null,
    fetchImpl,
    sleep: async () => { sleeps += 1; },
    spawnImpl: (...args) => {
      spawned.push(args);
      return { status: 0, stdout: "https://new-deployment.pages.dev\n", stderr: "" };
    },
    reuse: true,
  });

  assert.equal(url, finished.url);
  assert.equal(spawned.length, 1);
  assert.match(calls[1].url, /\/deployments\?env=preview&page=1$/);
  assert.match(calls[2].url, /\/deployments\/created-deployment$/);
  assert.equal(sleeps, 1);
  assert.deepEqual(spawned[0][1].slice(0, 5), ["--yes", "wrangler@4", "pages", "deploy", "dist"]);
});

test("uploads a fresh deployment when reuse is disabled", async () => {
  const trigger = { metadata: { branch: "lighthouse-pr-12", commit_hash: SHA } };
  const created = deployment({ id: "created-deployment", deployment_trigger: trigger, latest_stage: { status: "active" } });
  const finished = deployment({ id: "created-deployment", deployment_trigger: trigger, latest_stage: { status: "success" } });
  const { calls, fetchImpl } = queuedFetch([
    listResponse([created]),
    deploymentResponse(finished),
  ]);
  const spawned = [];

  const url = await deployPages({
    accountId: ACCOUNT,
    token: "token",
    project: PROJECT,
    branch: "lighthouse-pr-12",
    commitHash: SHA,
    outputFile: null,
    fetchImpl,
    sleep: async () => {},
    spawnImpl: (...args) => {
      spawned.push(args);
      return { status: 0, stdout: "https://new-deployment.pages.dev\n", stderr: "" };
    },
    reuse: false,
  });

  assert.equal(url, finished.url);
  assert.equal(spawned.length, 1);
  assert.match(calls[0].url, /\/deployments\?env=preview&page=1$/);
});

test("uploads a new production deployment instead of reusing a completed one", async () => {
  const existing = deployment();
  const created = deployment({ id: "new-production-deployment", latest_stage: { status: "active" } });
  const finished = deployment({ id: "new-production-deployment", latest_stage: { status: "success" } });
  const { calls, fetchImpl } = queuedFetch([
    listResponse([existing]),
    listResponse([created]),
    deploymentResponse(finished),
  ]);
  const spawned = [];

  const url = await deployPages({
    accountId: ACCOUNT,
    token: "token",
    project: PROJECT,
    branch: BRANCH,
    commitHash: SHA,
    outputFile: null,
    fetchImpl,
    sleep: async () => {},
    spawnImpl: (...args) => {
      spawned.push(args);
      return { status: 0, stdout: "https://new-deployment.pages.dev\n", stderr: "" };
    },
    reuse: true,
  });

  assert.equal(url, finished.url);
  assert.equal(spawned.length, 1);
  assert.match(calls[1].url, /\/deployments\?env=production&page=1$/);
});

test("uploads a fresh deployment when retrying an existing deployment fails", async () => {
  const trigger = { metadata: { branch: "pr-12", commit_hash: SHA } };
  const failed = deployment({ deployment_trigger: trigger, latest_stage: { status: "failure" } });
  const created = deployment({ id: "fresh-deployment", deployment_trigger: trigger, latest_stage: { status: "active" } });
  const finished = deployment({ id: "fresh-deployment", deployment_trigger: trigger, latest_stage: { status: "success" } });
  const { calls, fetchImpl } = queuedFetch([
    listResponse([failed]),
    errorResponse(409, "retry is unavailable"),
    listResponse([created]),
    deploymentResponse(finished),
  ]);
  const spawned = [];

  const url = await deployPages({
    accountId: ACCOUNT,
    token: "token",
    project: PROJECT,
    branch: "pr-12",
    commitHash: SHA,
    outputFile: null,
    fetchImpl,
    sleep: async () => {},
    spawnImpl: (...args) => {
      spawned.push(args);
      return { status: 0, stdout: "https://new-deployment.pages.dev\n", stderr: "" };
    },
    reuse: true,
  });

  assert.equal(url, finished.url);
  assert.equal(spawned.length, 1);
  assert.equal(calls[1].options.method, "POST");
});

test("bounds deployment history pagination", async () => {
  const { calls, fetchImpl } = queuedFetch([
    listResponse([], { total_pages: 20 }),
    listResponse([], { total_pages: 20 }),
  ]);

  const result = await findMatchingDeployment({
    accountId: ACCOUNT,
    token: "token",
    project: PROJECT,
    branch: BRANCH,
    commitHash: SHA,
    fetchImpl,
    maxPages: 2,
  });

  assert.equal(result, null);
  assert.equal(calls.length, 2);
});
