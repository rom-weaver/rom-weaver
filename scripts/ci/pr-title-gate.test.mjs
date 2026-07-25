import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const run_ = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "pr-title-gate.mjs");
const repoRoot = join(here, "..", "..");

const REPO = "rom-weaver/rom-weaver";
const HEAD_SHA = "deadbeef";
const STATUS_CONTEXT = "Gates/PR Title Lint";
const MARKER = "<!-- rom-weaver-pr-title-gate -->";

// A stand-in GitHub API, served over real HTTP so the script's own JSON and
// status handling runs rather than a stub of it - the same shape the CLA gate's
// test uses, and for the same reason.
function startApi({ title, comments }) {
  const calls = [];

  const server = createServer((request, response) => {
    const [path] = request.url.split("?");
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const parsed = body ? JSON.parse(body) : null;
      calls.push({ method: request.method, path, body: parsed });

      const send = (status, payload) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload ?? {}));
      };

      if (path === `/repos/${REPO}/pulls/7`) {
        return send(200, { head: { sha: HEAD_SHA }, title });
      }
      if (path === `/repos/${REPO}/issues/7/comments`) {
        if (request.method === "POST") return send(201, {});
        return send(200, comments);
      }
      if (path.startsWith(`/repos/${REPO}/issues/comments/`)) {
        return request.method === "DELETE" ? send(204) : send(200, {});
      }
      if (path === `/repos/${REPO}/statuses/${HEAD_SHA}`) return send(201, {});
      return send(404, { message: "Not Found" });
    });
  });

  server.listen(0);
  return { server, calls, url: () => `http://127.0.0.1:${server.address().port}` };
}

// Must not block the event loop: the stub API is served from this very process,
// so a synchronous child would deadlock waiting on a server that cannot run.
async function run({ title = "chore: something", verdict, problems, comments = [] } = {}) {
  const api = startApi({ title, comments });
  const summary = join(mkdtempSync(join(tmpdir(), "pr-title-gate-")), "summary.md");
  writeFileSync(summary, "");
  const outputFile = join(dirname(summary), "commitlint.txt");
  writeFileSync(outputFile, problems ?? "");

  let status = 0;
  let stdout = "";
  try {
    ({ stdout } = await run_(process.execPath, [script], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        GH_TOKEN: "test-token",
        GITHUB_API_URL: api.url(),
        GITHUB_REPOSITORY: REPO,
        PR_NUMBER: "7",
        LINT_VERDICT: verdict,
        LINT_OUTPUT_FILE: outputFile,
        GITHUB_STEP_SUMMARY: summary,
      },
    }));
  } catch (error) {
    status = error.code;
    stdout = error.stdout ?? "";
  } finally {
    api.server.close();
  }
  return { status, stdout, calls: api.calls, summary: readFileSync(summary, "utf8") };
}

const called = (calls, method, path) =>
  calls.some((call) => call.method === method && call.path.includes(path));

// The status is the verdict; the job's exit code only reports whether the gate
// itself ran. Assert the status, never the exit code alone.
const statusState = (calls) =>
  calls.find((call) => call.path === `/repos/${REPO}/statuses/${HEAD_SHA}`)?.body.state;

const commentBody = (calls) =>
  calls.find(
    (call) => call.method === "POST" && call.path === `/repos/${REPO}/issues/7/comments`,
  )?.body.body ??
  calls.find((call) => call.method === "PATCH" && call.path.includes("issues/comments/"))?.body.body;

test("the status context matches the one the ruleset requires", () => {
  const context = readFileSync(script, "utf8").match(/STATUS_CONTEXT = "(.+?)"/)[1];
  assert.equal(context, STATUS_CONTEXT);
  assert.ok(
    readFileSync(join(repoRoot, "docs/ci.md"), "utf8").includes(`\`${STATUS_CONTEXT}\``),
    "docs/ci.md must name the status context the ruleset requires",
  );
});

test("a conventional title passes and says nothing", async () => {
  const { status, calls } = await run({ verdict: "pass" });
  assert.equal(status, 0);
  assert.equal(statusState(calls), "success");
  assert.ok(!called(calls, "POST", "issues/7/comments"));
  assert.ok(!called(calls, "DELETE", "issues/comments/"));
});

test("passing deletes a comment left by an earlier failure", async () => {
  const { calls } = await run({
    verdict: "pass",
    comments: [{ id: 11, body: `${MARKER}\nrename this` }],
  });
  assert.equal(statusState(calls), "success");
  assert.ok(called(calls, "DELETE", "issues/comments/11"));
});

test("passing leaves comments from anyone else alone", async () => {
  const { calls } = await run({
    verdict: "pass",
    comments: [{ id: 12, body: "looks good to me" }],
  });
  assert.ok(!called(calls, "DELETE", "issues/comments/"));
});

test("a bad title fails the status and explains itself in a comment", async () => {
  const { status, calls } = await run({
    title: "fixed the thing",
    verdict: "fail",
    problems: "✖ subject may not be empty [subject-empty]",
  });
  // Green job, red status: a red job is reserved for the gate itself breaking.
  assert.equal(status, 0);
  assert.equal(statusState(calls), "failure");
  const body = commentBody(calls);
  assert.ok(body.startsWith(MARKER), "the comment must carry the marker it is found by");
  assert.ok(body.includes("subject-empty"), "commitlint's problems must reach the contributor");
  // Drift here is the whole failure mode: advice listing a type the config
  // rejects sends contributors round in circles.
  assert.ok(body.includes("`feat`") && body.includes("`dx`"));
  assert.match(body, /^!\[PR title: not conventional\]\(https:\/\/img\.shields\.io\/badge\//m);
  assert.match(body, /^> \[!WARNING\]$/m);
});

test("the rename is spelled out against the contributor's own title", async () => {
  const { calls } = await run({
    title: "Fixed the broken thing",
    verdict: "fail",
    problems: "\u2716 type may not be empty [type-empty]",
  });
  const body = commentBody(calls);
  assert.ok(body.includes("**Edit** button"), "the comment must say how to rename");
  assert.ok(
    body.includes("fix: fixed the broken thing"),
    "the suggestion must be built from the real title, not a placeholder",
  );
});

test("no suggestion is offered when it would break header-max-length", async () => {
  const { calls } = await run({
    title: `feat ${"x".repeat(150)}`,
    verdict: "fail",
    problems: "\u2716 header may not be longer than 150 characters [header-max-length]",
  });
  const body = commentBody(calls);
  assert.ok(!body.includes("For this title, that would be"), "a rejected rename must not be proposed");
  assert.ok(body.includes("feat(webapp): add sample assets"), "the generic example must stand in");
});

test("a second failing run edits the comment instead of adding another", async () => {
  const { calls } = await run({
    title: "still wrong",
    verdict: "fail",
    problems: "✖ type may not be empty [type-empty]",
    comments: [{ id: 11, body: `${MARKER}\nrename this` }],
  });
  assert.ok(called(calls, "PATCH", "issues/comments/11"));
  assert.ok(!called(calls, "POST", "issues/7/comments"));
});

test("a title carrying a code fence cannot break out of the quoted block", async () => {
  const { calls } = await run({
    title: "```\n**bold**",
    verdict: "fail",
    problems: 'found "```" in the title\n```\nnot a fence',
  });
  const body = commentBody(calls);
  const fence = body.match(/^`{4,}$/gm);
  assert.equal(fence?.length, 2, "the block must open and close on a fence of its own length");
  assert.ok(
    fence[0].length > 3,
    "an embedded fence must be outgrown by the block's own, not merely indented",
  );
  const [, quoted] = body.split(fence[0]);
  assert.ok(quoted.includes("```"), "the offending text must survive verbatim");
});

test("the failure is repeated in the job summary", async () => {
  const { summary } = await run({ title: "nope", verdict: "fail", problems: "✖ nope" });
  assert.ok(summary.includes("Invalid pull request title"));
  assert.ok(summary.includes("✖ nope"));
});

test("an unusable verdict is the gate breaking, not a bad title", async () => {
  const { status, calls } = await run({ verdict: "maybe" });
  assert.notEqual(status, 0);
  assert.equal(statusState(calls), undefined, "no status may be posted on a broken gate");
});
