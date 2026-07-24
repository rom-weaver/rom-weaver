import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const run_ = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "cla-gate.mjs");
const repoRoot = join(here, "..", "..");

const REPO = "rom-weaver/rom-weaver";
const HEAD_SHA = "deadbeef";
const STATUS_CONTEXT = "CLA Status";
const SIGN_PHRASE = "I have read the CLA Document and I hereby sign the CLA";

// A stand-in GitHub API. Serving real HTTP means the script's own JSON parsing,
// base64 decoding and status handling are exercised rather than stubbed - both
// bugs the shell version shipped lived in exactly that layer.
function startApi({ prAuthor, commitAuthors, signatures }) {
  const calls = [];
  let stored = signatures;

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
        return send(200, { head: { sha: HEAD_SHA }, user: { login: prAuthor } });
      }
      if (path === `/repos/${REPO}/pulls/7/commits`) {
        return send(
          200,
          commitAuthors.map((login) => ({
            author: login ? { login } : null,
            commit: { author: { name: "Nobody" } },
          })),
        );
      }
      if (path === `/repos/${REPO}/contents/signatures.json`) {
        if (request.method === "PUT") {
          stored = JSON.parse(Buffer.from(parsed.content, "base64").toString("utf8"));
          return send(200, { content: { sha: "newsha" } });
        }
        if (stored === null) return send(404, { message: "Not Found" });
        // The contents API line-wraps its base64 at 60 characters. Reproducing
        // that is the point: jq's @base64d rejected the newlines outright.
        const content = Buffer.from(JSON.stringify(stored))
          .toString("base64")
          .replaceAll(/.{1,60}/g, "$&\n");
        return send(200, { sha: "sigsha", content });
      }
      if (path === `/repos/${REPO}/issues/7/comments`) return send(200, []);
      if (path.startsWith("/users/")) return send(200, { id: 4242 });
      if (path === `/repos/${REPO}/statuses/${HEAD_SHA}`) return send(201, {});
      return send(404, { message: "Not Found" });
    });
  });

  server.listen(0);
  return { server, calls, url: () => `http://127.0.0.1:${server.address().port}` };
}

// Must not block the event loop: the stub API is served from this very
// process, so a synchronous child would deadlock waiting on a server that
// cannot run.
async function run({ prAuthor, commitAuthors = [], signatures = [], comment } = {}) {
  const api = startApi({ prAuthor, commitAuthors, signatures });
  let status = 0;
  try {
    await run_(process.execPath, [script], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
      env: {
        ...process.env,
        GH_TOKEN: "test-token",
        GITHUB_API_URL: api.url(),
        GITHUB_REPOSITORY: REPO,
        PR_NUMBER: "7",
        COMMENT_BODY: comment?.body ?? "",
        COMMENT_AUTHOR: comment?.author ?? "",
      },
    });
  } catch (error) {
    status = error.code;
  } finally {
    api.server.close();
  }
  return { status, calls: api.calls };
}

const wrote = (calls, method, path) =>
  calls.some((call) => call.method === method && call.path.includes(path));

// The status is the verdict; the job's exit code only reports whether the gate
// itself ran. Assert the status, never the exit code alone.
const statusState = (calls) =>
  calls.find((call) => call.path === `/repos/${REPO}/statuses/${HEAD_SHA}`)?.body.state;

test("the signing phrase matches the one CLA.md tells contributors to post", () => {
  const phrase = readFileSync(script, "utf8").match(/^const SIGN_PHRASE = "(.+)";$/m)[1];
  assert.equal(phrase, SIGN_PHRASE);
  assert.ok(
    readFileSync(join(repoRoot, "CLA.md"), "utf8").includes(phrase),
    `CLA.md does not quote the phrase the gate accepts: ${phrase}`,
  );
});

test("the status context matches the one the ruleset requires", () => {
  const context = readFileSync(script, "utf8").match(/context: "(.+?)"/)[1];
  assert.equal(context, STATUS_CONTEXT);
  assert.ok(
    readFileSync(join(repoRoot, "docs/ci.md"), "utf8").includes(`\`${STATUS_CONTEXT}\``),
    "docs/ci.md must name the status context the ruleset requires",
  );
});

test("a signed contributor passes", async () => {
  const { status, calls } = await run({ prAuthor: "outsider", signatures: [{ login: "outsider" }] });
  assert.equal(status, 0);
  assert.equal(statusState(calls), "success");
  // Nothing to say when the check already passes.
  assert.ok(!wrote(calls, "POST", "issues/7/comments"));
});

test("an unsigned contributor gets a failing status and is asked to sign", async () => {
  const { status, calls } = await run({ prAuthor: "outsider", signatures: [] });
  assert.equal(statusState(calls), "failure");
  assert.ok(wrote(calls, "POST", "issues/7/comments"));
  // Green job, red status: a red job is reserved for the gate itself breaking.
  assert.equal(status, 0);
});

test("bots are exempt without any signature", async () => {
  const { calls } = await run({ prAuthor: "dependabot[bot]", signatures: [] });
  assert.equal(statusState(calls), "success");
});

test("a bot pull request carrying a human's commit still needs that human", async () => {
  const { calls } = await run({
    prAuthor: "dependabot[bot]",
    commitAuthors: ["outsider"],
    signatures: [],
  });
  assert.equal(statusState(calls), "failure");
});

test("the maintainer is no longer exempt and must sign like anyone else", async () => {
  const { calls } = await run({ prAuthor: "brandonocasey", signatures: [] });
  assert.equal(statusState(calls), "failure");
});

test("the signing phrase records a signature and passes", async () => {
  const { status, calls } = await run({
    prAuthor: "outsider",
    signatures: [],
    comment: { author: "outsider", body: SIGN_PHRASE },
  });
  const write = calls.find((call) => call.method === "PUT");
  assert.ok(write, "expected the signature to be written");
  const recorded = JSON.parse(Buffer.from(write.body.content, "base64").toString("utf8"));
  assert.equal(recorded[0].login, "outsider");
  assert.equal(recorded[0].id, 4242);
  assert.equal(recorded[0].pullRequest, 7);
  assert.equal(statusState(calls), "success");
  assert.equal(status, 0);
});

test("the first signature ever creates the file instead of updating it", async () => {
  // `signatures: null` stands for "the file does not exist yet", which is a
  // separate code path: the write must omit the blob sha.
  const { status, calls } = await run({
    prAuthor: "outsider",
    signatures: null,
    comment: { author: "outsider", body: SIGN_PHRASE },
  });
  const write = calls.find((call) => call.method === "PUT");
  assert.ok(write, "expected the signature to be written");
  assert.ok(!("sha" in write.body), "creating a file must not send a blob sha");
  assert.equal(statusState(calls), "success");
  assert.equal(status, 0);
});

test("the phrase from a bystander records nothing", async () => {
  const { calls } = await run({
    prAuthor: "outsider",
    signatures: [],
    comment: { author: "drive-by", body: SIGN_PHRASE },
  });
  assert.ok(!wrote(calls, "PUT", "contents/signatures.json"));
});

test("quoting the phrase mid-sentence does not sign", async () => {
  const { calls } = await run({
    prAuthor: "outsider",
    signatures: [],
    comment: { author: "outsider", body: `do I just say "${SIGN_PHRASE}" here?` },
  });
  assert.ok(!wrote(calls, "PUT", "contents/signatures.json"));
  assert.equal(statusState(calls), "failure");
});

test("the phrase on its own line among others still signs", async () => {
  const { calls } = await run({
    prAuthor: "outsider",
    signatures: [],
    comment: { author: "outsider", body: `Happy to contribute!\n\n${SIGN_PHRASE}\n\nThanks.` },
  });
  assert.ok(wrote(calls, "PUT", "contents/signatures.json"));
  assert.equal(statusState(calls), "success");
});

test("a commit author with no linked account is reported, not skipped", async () => {
  const { calls } = await run({
    prAuthor: "dependabot[bot]",
    commitAuthors: [null],
    signatures: [],
  });
  assert.equal(statusState(calls), "failure");
});
