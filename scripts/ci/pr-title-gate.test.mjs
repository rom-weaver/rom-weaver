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
// Verbatim from commitlint, so a test that asserts on rendering asserts on the
// text a contributor really gets.
const MESSAGES = {
  "type-empty": "type may not be empty",
  "subject-empty": "subject may not be empty",
  "type-case": "type must be lower-case",
  "type-enum":
    "type must be one of [build, chore, ci, docs, dx, feat, fix, perf, refactor, revert, style, test]",
  "header-max-length": "header must not be longer than 150 characters, current length is 205",
};

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
async function run({
  title = "chore: something",
  verdict,
  errors = [],
  warnings = [],
  report,
  comments = [],
} = {}) {
  const api = startApi({ title, comments });
  const summary = join(mkdtempSync(join(tmpdir(), "pr-title-gate-")), "summary.md");
  writeFileSync(summary, "");
  const reportFile = join(dirname(summary), "commitlint.json");
  // The shape `commitlint-report.mjs` writes: a rule name and a message per
  // problem, which is the whole reason this gate can say more than "invalid".
  writeFileSync(
    reportFile,
    report ??
      JSON.stringify({
        valid: errors.length === 0,
        errorCount: errors.length,
        warningCount: warnings.length,
        results: [
          {
            valid: errors.length === 0,
            errors: errors.map((name) => ({ level: 2, valid: false, name, message: MESSAGES[name] })),
            warnings: warnings.map((name) => ({
              level: 1,
              valid: false,
              name,
              message: MESSAGES[name],
            })),
            input: title,
          },
        ],
      }),
  );

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
        LINT_REPORT_FILE: reportFile,
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
    comments: [{ id: 11, user: { type: "Bot" }, body: `${MARKER}\nrename this` }],
  });
  assert.equal(statusState(calls), "success");
  assert.ok(called(calls, "DELETE", "issues/comments/11"));
});

test("passing leaves comments from anyone else alone", async () => {
  const { calls } = await run({
    verdict: "pass",
    comments: [{ id: 12, user: { type: "User" }, body: "looks good to me" }],
  });
  assert.ok(!called(calls, "DELETE", "issues/comments/"));
});

// The marker is an HTML comment - invisible once rendered, and nothing stops a
// contributor pasting one. The token here could delete their comment on the
// strength of a string they chose, so the author is checked too.
test("a marker pasted by a human is neither deleted nor edited", async () => {
  const pasted = { id: 13, user: { type: "User" }, body: `${MARKER}\nnot the gate's comment` };

  const passing = await run({ verdict: "pass", comments: [pasted] });
  assert.ok(!called(passing.calls, "DELETE", "issues/comments/"));

  const failing = await run({
    title: "still wrong",
    verdict: "fail",
    errors: ["type-empty"],
    comments: [pasted],
  });
  assert.ok(!called(failing.calls, "PATCH", "issues/comments/"));
  assert.ok(
    called(failing.calls, "POST", "issues/7/comments"),
    "the gate must post its own comment rather than take over somebody else's",
  );
});

test("a bad title fails the status and explains itself in a comment", async () => {
  const { status, calls } = await run({
    title: "fixed the thing",
    verdict: "fail",
    errors: ["subject-empty", "type-empty"],
  });
  // Green job, red status: a red job is reserved for the gate itself breaking.
  assert.equal(status, 0);
  assert.equal(statusState(calls), "failure");
  const body = commentBody(calls);
  assert.ok(body.startsWith(MARKER), "the comment must carry the marker it is found by");
  // Every problem, named by its rule and by what it means - not one paragraph
  // the contributor has to take apart.
  assert.match(body, /^\| `subject-empty` \| subject may not be empty \|$/m);
  assert.match(body, /^\| `type-empty` \| type may not be empty \|$/m);
  // Drift here is the whole failure mode: advice listing a type the config
  // rejects sends contributors round in circles.
  assert.ok(body.includes("`feat`") && body.includes("`dx`"));
  assert.match(body, /^!\[PR title: not conventional\]\(https:\/\/img\.shields\.io\/badge\//m);
  assert.match(body, /^> \[!WARNING\]$/m);
});

test("the comment says how to rename without renaming for them", async () => {
  const { calls } = await run({
    title: "Fixed the broken thing",
    verdict: "fail",
    errors: ["type-empty"],
  });
  const body = commentBody(calls);
  assert.ok(body.includes("**Edit** button"), "the comment must say how to rename");
  assert.ok(body.includes("feat(webapp): add sample assets"), "the shape is shown by example");
});

test("a missing type explains the empty subject it drags in with it", async () => {
  const { calls } = await run({
    title: "fixed the thing",
    verdict: "fail",
    errors: ["subject-empty", "type-empty"],
  });
  // Two rules fire, one mistake caused them. Saying so is the point of reading
  // rule names instead of reprinting commitlint's paragraph.
  assert.ok(commentBody(calls).includes("neither a type nor a subject"));
});

// commitlint hands over a rule name and a message, never a corrected title, so
// any rename would be one this script invented - and the type is the part it
// cannot know. Squash merges make the title the commit subject and Release
// Please reads the type, so a guessed `fix:` on a feature is a wrong version
// bump and a wrong changelog entry, landed silently.
for (const [what, title, errors] of [
  ["no type at all", "Fixed the broken thing", ["subject-empty", "type-empty"]],
  ["a miscased type", "Fix: the thing", ["type-case", "type-enum"]],
  ["a trailing full stop", "Fixed the thing.", ["type-empty"]],
  ["a start-case subject", "Fix: The Thing", ["type-case", "type-enum"]],
  ["an invented type", "wibble: the thing", ["type-enum"]],
]) {
  test(`${what} is named, never silently renamed`, async () => {
    const body = commentBody((await run({ title, verdict: "fail", errors })).calls);
    assert.ok(!body.includes("Rename it to"), "the gate must not propose a title of its own");
    assert.ok(!body.includes("\nfix: "), "no fenced replacement title may be offered");
    assert.ok(body.includes("`feat`"), "the allowed types are what a contributor gets instead");
  });
}

test("an over-long title is told how much to cut, and gets no suggestion", async () => {
  const { calls } = await run({
    title: `fix: ${"x".repeat(200)}`,
    verdict: "fail",
    errors: ["header-max-length"],
  });
  const body = commentBody(calls);
  assert.ok(body.includes("55 have to go"), "the arithmetic is the gate's job, not the contributor's");
  assert.ok(!body.includes("Rename it to"), "a rejected rename must not be proposed");
  // Nothing about this title's shape was wrong, so neither the type list nor an
  // example of the shape has anything to tell whoever wrote it.
  assert.ok(!body.includes("Valid types"));
  assert.ok(!body.includes("feat(webapp): add sample assets"));
});

test("a warning riding along with an error is graded in the table", async () => {
  const { calls } = await run({
    title: "wibble: the thing",
    verdict: "fail",
    errors: ["type-enum"],
    warnings: ["subject-empty"],
  });
  const body = commentBody(calls);
  assert.match(body, /^\| Level \| Rule \| Problem \|$/m);
  assert.match(body, /^\| warning \| `subject-empty` \|/m);
});

test("a second failing run edits the comment instead of adding another", async () => {
  const { calls } = await run({
    title: "still wrong",
    verdict: "fail",
    errors: ["type-empty"],
    comments: [{ id: 11, user: { type: "Bot" }, body: `${MARKER}\nrename this` }],
  });
  assert.ok(called(calls, "PATCH", "issues/comments/11"));
  assert.ok(!called(calls, "POST", "issues/7/comments"));
});

// Every fenced block in a body, so an assertion about one of them cannot be
// satisfied by another block that happens to sit nearby.
function fencedBlocks(body) {
  const blocks = [];
  let open = null;
  for (const line of body.split("\n")) {
    const fence = line.match(/^(`{3,})$/)?.[1];
    if (open && fence === open.fence) {
      blocks.push({ fence: open.fence, content: open.lines.join("\n") });
      open = null;
    } else if (open) {
      open.lines.push(line);
    } else if (fence) {
      open = { fence, lines: [] };
    }
  }
  return blocks;
}

test("a title carrying a code fence cannot break out of the quoted block", async () => {
  const title = "```\n**bold**";
  const { calls } = await run({ title, verdict: "fail", errors: ["type-empty"] });
  const blocks = fencedBlocks(commentBody(calls));
  const quoted = blocks.find((block) => block.content === title);
  assert.ok(quoted, "the offending title must survive verbatim inside a block of its own");
  assert.ok(
    quoted.fence.length > 3,
    "an embedded fence must be outgrown by the block's own, not merely indented",
  );
});

test("the failure is repeated in the job summary", async () => {
  const { summary } = await run({ title: "nope", verdict: "fail", errors: ["type-empty"] });
  assert.ok(summary.includes("Invalid pull request title"));
  assert.ok(summary.includes("type-empty"));
});

test("an unusable verdict is the gate breaking, not a bad title", async () => {
  const { status, calls } = await run({ verdict: "maybe" });
  assert.notEqual(status, 0);
  assert.equal(statusState(calls), undefined, "no status may be posted on a broken gate");
});

test("a failure with no lint result is the gate breaking, not a bad title", async () => {
  // commitlint exiting non-zero without linting anything - a missing config, a
  // broken install. Reporting that as an invalid title sends the contributor
  // after a fault that is not theirs.
  const { status, calls } = await run({
    verdict: "fail",
    report: JSON.stringify({ valid: false, results: [] }),
  });
  assert.notEqual(status, 0);
  assert.equal(statusState(calls), undefined, "no status may be posted on a broken gate");
});
