import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
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

function queuedFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request: ${url}`);
    if (next instanceof Error) throw next;
    if (next.json) return next;
    return Response.json(next.body ?? next, { status: next.status ?? 200 });
  };
  return { calls, fetchImpl };
}

const listResponse = (items, resultInfo = {}) => ({ success: true, result: items, result_info: resultInfo });
const deploymentResponse = (item) => ({ success: true, result: item });
const errorResponse = (status, message) => ({ status, body: { success: false, errors: [{ message }] } });

const INTERNAL_ERROR = "Failed to publish your Function. Got error: Unknown internal error occurred.";

function deployOptions(overrides = {}) {
  return {
    accountId: null,
    token: null,
    project: PROJECT,
    branch: "pr-12",
    commitHash: SHA,
    outputFile: null,
    fetchImpl: async () => assert.fail("unexpected network request"),
    ...overrides,
  };
}

function deploymentOutput(t) {
  const scratchRoot = new URL("../../.cache/agents/scratch/", import.meta.url);
  mkdirSync(scratchRoot, { recursive: true });
  const directory = mkdtempSync(new URL("deploy-pages-test-", scratchRoot));
  t.after(() => rmSync(directory, { recursive: true }));
  return join(directory, "github-output");
}

test("recovers from Wrangler's Function publish internal error", async () => {
  const sleeps = [];
  let uploads = 0;
  const url = await deployPages(deployOptions({
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    spawnImpl: (_command, _args, options) => {
      uploads += 1;
      assert.equal(options.maxBuffer, Infinity);
      if (uploads === 1) return { status: 1, stdout: "", stderr: INTERNAL_ERROR };
      return { status: 0, stdout: "https://recovered.pages.dev\n", stderr: "" };
    },
  }));

  assert.equal(url, "https://recovered.pages.dev");
  assert.equal(uploads, 2);
  assert.deepEqual(sleeps, [10000]);
});

test("exhausts three Wrangler attempts with ten then thirty second waits and no success output", async (t) => {
  const outputFile = deploymentOutput(t);
  const sleeps = [];
  let uploads = 0;
  await assert.rejects(deployPages(deployOptions({
    outputFile,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    spawnImpl: () => {
      uploads += 1;
      return { status: 1, stdout: "https://failed.pages.dev\n", stderr: INTERNAL_ERROR };
    },
  })), /wrangler exited with status 1/);
  assert.equal(uploads, 3);
  assert.deepEqual(sleeps, [10000, 30000]);
  assert.equal(existsSync(outputFile), false);
});

test("Wrangler authentication, configuration, build, unknown, and cancellation failures are fatal", async (t) => {
  const cases = [
    { stderr: "Authentication error [code: 10000]" },
    { stderr: "Invalid configuration: missing project name" },
    { stderr: "Build failed with 1 error: Could not resolve './missing.js'" },
    { stderr: `${INTERNAL_ERROR}\nAuthentication error [code: 10000]` },
    { stderr: "an unrecognized failure" },
    { stderr: INTERNAL_ERROR, status: null, signal: "SIGTERM" },
    { stderr: INTERNAL_ERROR, status: null, error: Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" }) },
  ];
  for (const failure of cases) {
    const outputFile = deploymentOutput(t);
    const sleeps = [];
    let uploads = 0;
    await assert.rejects(deployPages(deployOptions({
      outputFile,
      sleep: async (milliseconds) => sleeps.push(milliseconds),
      spawnImpl: () => {
        uploads += 1;
        return { status: 1, stdout: "https://failed.pages.dev\n", ...failure };
      },
    })), failure.error ? /spawn npx ENOENT/ : /wrangler (?:exited with status 1|terminated by signal SIGTERM)/);
    assert.equal(uploads, 1, failure.stderr);
    assert.deepEqual(sleeps, []);
    assert.equal(existsSync(outputFile), false);
  }
});

test("retries Wrangler server and network diagnostics", async () => {
  for (const stderr of ["HTTP 503 Service Unavailable", "TypeError: fetch failed", "Error: socket hang up (ECONNRESET)"]) {
    const sleeps = [];
    let uploads = 0;
    const url = await deployPages(deployOptions({
      sleep: async (milliseconds) => sleeps.push(milliseconds),
      spawnImpl: () => {
        uploads += 1;
        return uploads === 1
          ? { status: 1, stdout: "", stderr }
          : { status: 0, stdout: "https://recovered.pages.dev\n" };
      },
    }));
    assert.equal(url, "https://recovered.pages.dev");
    assert.equal(uploads, 2);
    assert.deepEqual(sleeps, [10000]);
  }
});

test("retries API discovery server, internal, and network failures before reusing the exact deployment", async () => {
  const existing = deployment({ deployment_trigger: { metadata: { branch: "pr-12", commit_hash: SHA } } });
  const decoys = [
    deployment({ deployment_trigger: { metadata: { branch: "pr-99", commit_hash: SHA } } }),
    deployment({ deployment_trigger: { metadata: { branch: "pr-12", commit_hash: "other-sha" } } }),
  ];
  const failures = [
    errorResponse(503, "Service unavailable"),
    errorResponse(200, "Unknown internal error occurred."),
    new TypeError("fetch failed", { cause: Object.assign(new Error("connection reset"), { code: "ECONNRESET" }) }),
    { ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token '<'"); } },
  ];
  for (const failure of failures) {
    const { calls, fetchImpl } = queuedFetch([failure, listResponse([...decoys, existing])]);
    const sleeps = [];
    const url = await deployPages(deployOptions({
      accountId: ACCOUNT, token: "token", fetchImpl, reuse: true,
      spawnImpl: () => assert.fail("reusing a deployment uploaded again"),
      sleep: async (milliseconds) => sleeps.push(milliseconds),
    }));
    assert.equal(url, existing.url);
    assert.equal(calls.length, 2);
    assert.ok(calls.every(({ url: requestUrl }) => requestUrl.includes(`/accounts/${ACCOUNT}/pages/projects/${PROJECT}/deployments?`)));
    assert.deepEqual(sleeps, [10000]);
  }
});

test("API authentication, configuration, rate-limit, malformed success, and cancellation errors are fatal", async (t) => {
  const failures = [
    errorResponse(401, "Authentication error"),
    errorResponse(403, "Forbidden: internal error"),
    errorResponse(404, "Project does not exist"),
    errorResponse(429, "Too many requests"),
    errorResponse(500, "Invalid configuration"),
    { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token '<'"); } },
    { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token in internal error response"); } },
    new DOMException("The operation was aborted", "AbortError"),
  ];
  for (const failure of failures) {
    const outputFile = deploymentOutput(t);
    const { calls, fetchImpl } = queuedFetch([failure]);
    const sleeps = [];
    await assert.rejects(deployPages(deployOptions({
      accountId: ACCOUNT, token: "token", fetchImpl, reuse: true, outputFile,
      spawnImpl: () => assert.fail("fatal API error launched Wrangler"),
      sleep: async (milliseconds) => sleeps.push(milliseconds),
    })), failure.name === "AbortError" ? /operation was aborted/ : /Cloudflare Pages API GET/);
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(existsSync(outputFile), false);
  }
});

test("a failed fresh upload discovers and finishes its exact matching deployment", async () => {
  const trigger = { metadata: { branch: "pr-12", commit_hash: SHA } };
  const active = deployment({ deployment_trigger: trigger, latest_stage: { status: "active" } });
  const finished = deployment({ deployment_trigger: trigger });
  const { calls, fetchImpl } = queuedFetch([listResponse([active]), deploymentResponse(finished)]);
  const sleeps = [];
  let uploads = 0;
  const url = await deployPages(deployOptions({
    accountId: ACCOUNT, token: "token", fetchImpl, reuse: false,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    spawnImpl: () => {
      assert.equal(calls.length, 0, "reuse=false looked up an old deployment before uploading");
      uploads += 1;
      return { status: 1, stdout: "", stderr: INTERNAL_ERROR };
    },
  }));
  assert.equal(url, finished.url);
  assert.equal(uploads, 1);
  assert.deepEqual(sleeps, [10000, 1000]);
});

test("production refresh survives API visibility and poll failures without uploading again", async () => {
  const old = deployment();
  const active = deployment({ id: "fresh-production", latest_stage: { status: "active" } });
  const finished = deployment({ id: "fresh-production" });
  const { calls, fetchImpl } = queuedFetch([
    listResponse([old]),
    errorResponse(503, "Service unavailable"),
    listResponse([]),
    listResponse([active]),
    new TypeError("fetch failed"),
    deploymentResponse(finished),
  ]);
  const sleeps = [];
  let uploads = 0;
  const url = await deployPages(deployOptions({
    accountId: ACCOUNT, token: "token", branch: BRANCH, fetchImpl, reuse: true,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    spawnImpl: () => {
      uploads += 1;
      return { status: 0, stdout: "https://fresh.pages.dev\n" };
    },
  }));
  assert.equal(url, finished.url);
  assert.equal(uploads, 1);
  assert.equal(calls.length, 6);
  assert.deepEqual(sleeps, [10000, 1000, 1000, 30000, 1000]);
});

test("failed production refresh does not reuse the completed deployment it replaced", async () => {
  const old = deployment();
  const fresh = deployment({ id: "fresh-production" });
  const { fetchImpl } = queuedFetch([listResponse([old]), listResponse([old]), listResponse([fresh])]);
  const sleeps = [];
  let uploads = 0;
  const url = await deployPages(deployOptions({
    accountId: ACCOUNT, token: "token", branch: BRANCH, fetchImpl, reuse: true,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    spawnImpl: () => {
      uploads += 1;
      return uploads === 1
        ? { status: 1, stderr: INTERNAL_ERROR }
        : { status: 0, stdout: "https://fresh.pages.dev\n" };
    },
  }));
  assert.equal(url, fresh.url);
  assert.equal(uploads, 2);
  assert.deepEqual(sleeps, [10000]);
});

test("API retry and Wrangler fallback share three attempts", async (t) => {
  const outputFile = deploymentOutput(t);
  const failed = deployment({ latest_stage: { status: "failure" } });
  const { calls, fetchImpl } = queuedFetch([
    listResponse([failed]), errorResponse(503, "Service unavailable"),
    listResponse([failed]), errorResponse(409, "retry is unavailable"),
  ]);
  const sleeps = [];
  let uploads = 0;
  await assert.rejects(deployPages(deployOptions({
    accountId: ACCOUNT, token: "token", branch: BRANCH, fetchImpl, reuse: true, outputFile,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    spawnImpl: () => {
      uploads += 1;
      return { status: 1, stderr: INTERNAL_ERROR };
    },
  })), /wrangler exited with status 1/);
  assert.equal(calls.filter(({ options }) => options.method === "POST").length, 2);
  assert.equal(uploads, 1);
  assert.deepEqual(sleeps, [10000, 30000]);
  assert.equal(existsSync(outputFile), false);
});

test("API retry recovers canceled deployments and stops after three server failures", async (t) => {
  for (const recover of [true, false]) {
    const outputFile = deploymentOutput(t);
    const canceled = deployment({ latest_stage: { status: "canceled" } });
    const responses = [listResponse([canceled]), errorResponse(503, "Service unavailable"), listResponse([canceled])];
    if (recover) {
      responses.push(deploymentResponse(deployment()));
    } else {
      responses.push(errorResponse(503, "Service unavailable"), listResponse([canceled]), errorResponse(503, "Service unavailable"));
    }
    const { calls, fetchImpl } = queuedFetch(responses);
    const sleeps = [];
    const pending = deployPages(deployOptions({
      accountId: ACCOUNT, token: "token", branch: BRANCH, fetchImpl, reuse: true, outputFile,
      sleep: async (milliseconds) => sleeps.push(milliseconds),
      spawnImpl: () => assert.fail("a retryable API error launched Wrangler"),
    }));
    if (recover) {
      assert.equal(await pending, deployment().url);
    } else {
      await assert.rejects(pending, /Cloudflare Pages API POST .* HTTP 503/);
      assert.equal(existsSync(outputFile), false);
    }
    assert.equal(calls.filter(({ options }) => options.method === "POST").length, recover ? 2 : 3);
    assert.deepEqual(sleeps, recover ? [10000] : [10000, 30000]);
  }
});

test("API retry authentication and configuration failures never fall back to Wrangler", async () => {
  for (const failure of [errorResponse(401, "Authentication error"), errorResponse(409, "Invalid configuration")]) {
    const failed = deployment({ latest_stage: { status: "failure" } });
    const { calls, fetchImpl } = queuedFetch([listResponse([failed]), failure]);
    const sleeps = [];
    await assert.rejects(deployPages(deployOptions({
      accountId: ACCOUNT, token: "token", branch: BRANCH, fetchImpl, reuse: true,
      spawnImpl: () => assert.fail("fatal API retry error launched Wrangler"),
      sleep: async (milliseconds) => sleeps.push(milliseconds),
    })), /Cloudflare Pages API POST/);
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, []);
  }
});

test("unsuccessful, skipped, URL-less, and timed-out deployments never publish success output", async (t) => {
  const cases = [
    [deployment({ latest_stage: { status: "failure", name: "build" } }), /ended with status failure/],
    [deployment({ latest_stage: { status: "canceled" } }), /ended with status canceled/],
    [deployment({ is_skipped: true }), /was skipped/],
    [deployment({ url: "" }), /has no URL/],
    [deployment({ latest_stage: { status: "active" } }), /did not finish after 0 polls/],
  ];
  for (const [created, expectedError] of cases) {
    const outputFile = deploymentOutput(t);
    const { calls, fetchImpl } = queuedFetch([listResponse([created])]);
    let uploads = 0;
    await assert.rejects(deployPages(deployOptions({
      accountId: ACCOUNT, token: "token", branch: BRANCH, fetchImpl, outputFile, maxPolls: 0,
      sleep: async () => assert.fail("unverified deployment retried"),
      spawnImpl: () => {
        uploads += 1;
        return { status: 0, stdout: "https://reported.pages.dev\n" };
      },
    })), expectedError);
    assert.equal(uploads, 1);
    assert.equal(calls.length, 1);
    assert.equal(existsSync(outputFile), false);
  }
});

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
