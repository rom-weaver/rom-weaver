import assert from "node:assert/strict";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";

const run_ = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "deployment-status.mjs");

const REPO = "rom-weaver/rom-weaver";
const SHA = "deadbeef";
const CONTEXT = "Webapp Deploy / preview";

function startApi() {
  const calls = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      calls.push({
        method: request.method,
        path: request.url,
        body: body ? JSON.parse(body) : null,
      });
      response.writeHead(201, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  server.listen(0);
  return { server, calls, url: () => `http://127.0.0.1:${server.address().port}` };
}

async function run(env = {}) {
  const api = startApi();
  try {
    await run_(process.execPath, [script], {
      cwd: join(here, "..", ".."),
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        GH_TOKEN: "test-token",
        GITHUB_API_URL: api.url(),
        GITHUB_REPOSITORY: REPO,
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_RUN_ID: "123",
        DEPLOYMENT_SHA: SHA,
        DEPLOYMENT_CHANNEL: "preview",
        STATUS_CONTEXT: CONTEXT,
        ...env,
      },
    });
  } finally {
    api.server.close();
  }
  return api.calls;
}

const statusCall = (calls) => calls.find((call) => call.path === `/repos/${REPO}/statuses/${SHA}`);

test("success links the commit status to the exact deployment", async () => {
  const calls = await run({ DEPLOYMENT_URL: "https://abc.rom-weaver-preview.pages.dev" });
  assert.deepEqual(statusCall(calls).body, {
    state: "success",
    context: CONTEXT,
    description: "Webapp deployed to preview",
    target_url: "https://abc.rom-weaver-preview.pages.dev",
  });
});

test("pending links to the workflow run until deployment exists", async () => {
  const calls = await run({ DEPLOYMENT_STATE: "pending" });
  assert.deepEqual(statusCall(calls).body, {
    state: "pending",
    context: CONTEXT,
    description: "Deploying webapp to preview",
    target_url: `https://github.com/${REPO}/actions/runs/123`,
  });
});

test("a failed deployment links to the workflow run", async () => {
  const calls = await run({ DEPLOYMENT_STATE: "failure" });
  assert.deepEqual(statusCall(calls).body, {
    state: "failure",
    context: CONTEXT,
    description: "Webapp deployment to preview failed",
    target_url: `https://github.com/${REPO}/actions/runs/123`,
  });
});
