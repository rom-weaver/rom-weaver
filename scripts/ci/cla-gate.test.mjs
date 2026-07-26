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
const STATUS_CONTEXT = "CLA Signed";
const SIGN_PHRASE = "I have read and agree to the CLA";

// A stand-in GitHub API. Serving real HTTP means the script's own JSON parsing,
// base64 decoding and status handling are exercised rather than stubbed - both
// bugs the shell version shipped lived in exactly that layer.
function startApi({ prAuthor, commitAuthors, signatures, comments }) {
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
      if (path === `/repos/${REPO}/issues/7/comments`) return send(200, comments);
      if (path.startsWith(`/repos/${REPO}/issues/comments/`)) return send(200, {});
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
async function run({
  prAuthor,
  commitAuthors = [],
  signatures = [],
  comment,
  comments = [],
  env = {},
} = {}) {
  const api = startApi({ prAuthor, commitAuthors, signatures, comments });
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
        // Defaults to the author, which is what GitHub sends on a new comment.
        // An edit by somebody else is the case worth spelling out.
        COMMENT_SENDER: comment?.sender ?? comment?.author ?? "",
        ...env,
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

// The phrase is a signature only because CLA.md says it is: a wording the gate
// accepts but the document never mentions would be a signature nobody agreed to
// give.
test("the signing phrase matches the one CLA.md tells contributors to post", () => {
  const phrase = readFileSync(script, "utf8").match(/^const SIGN_PHRASE = "(.+)";$/m)[1];
  assert.equal(phrase, SIGN_PHRASE);
  assert.ok(
    readFileSync(join(repoRoot, "CLA.md"), "utf8").includes(phrase),
    `CLA.md does not quote the phrase the gate accepts: ${phrase}`,
  );
});

// The phrase belongs to the script alone. A second copy in the workflow's
// trigger condition would rot without ever failing a test, and a stale one
// there means the job never runs - a correct signature swallowed in silence.
test("the workflow does not keep its own copy of the signing phrase", () => {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/pull-request.yml"), "utf8");
  assert.ok(
    !workflow.includes(SIGN_PHRASE),
    "pull-request.yml must prefilter on a stable substring, not the exact phrase",
  );
});

test("the status context matches the one the ruleset requires", () => {
  const context = readFileSync(script, "utf8").match(/STATUS_CONTEXT = "(.+?)"/)[1];
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

// The badge and the callout are how the verdict reads at a glance, the way the
// CLA Assistant comment did. A comment that says "required" while the status
// says success is worse than no comment at all.
test("the request comment carries the warning badge and callout", async () => {
  const { calls } = await run({ prAuthor: "outsider", signatures: [] });
  const body = calls.find((call) => call.method === "POST" && call.path.endsWith("/comments")).body
    .body;
  assert.match(body, /^!\[CLA: signature required\]\(https:\/\/img\.shields\.io\/badge\//m);
  assert.match(body, /^> \[!WARNING\]$/m);
  assert.ok(!body.includes("CLA-signed-"), "the signed badge must not appear on a failing gate");
});

test("signing rewrites that comment to the signed badge and callout", async () => {
  const { calls } = await run({
    prAuthor: "outsider",
    signatures: [],
    comment: { author: "outsider", body: SIGN_PHRASE },
    comments: [{ id: 11, user: { type: "Bot" }, body: "<!-- rom-weaver-cla-gate -->\nCLA signature required" }],
  });
  const edit = calls.find((call) => call.method === "PATCH" && call.path.includes("issues/comments/"));
  assert.ok(edit, "the existing comment must be edited, not left saying a signature is required");
  assert.match(edit.body.body, /^!\[CLA: signed\]\(https:\/\/img\.shields\.io\/badge\//m);
  assert.match(edit.body.body, /^> \[!TIP\]$/m);
});

// One person is told to post a comment; several have to each post their own, and
// a shared instruction reads as though one signature would cover the branch.
test("several unsigned contributors are each told to post", async () => {
  const { calls } = await run({
    prAuthor: "octocat",
    commitAuthors: ["octocat", "hubot"],
    signatures: [],
  });
  const body = calls.find((call) => call.method === "POST" && call.path.endsWith("/comments")).body
    .body;
  assert.ok(body.includes("Each of you must post a comment"), "each contributor has to sign");
  assert.ok(body.includes("@octocat") && body.includes("@hubot"));
});

test("a single unsigned contributor is not addressed as a group", async () => {
  const { calls } = await run({ prAuthor: "octocat", signatures: [] });
  const body = calls.find((call) => call.method === "POST" && call.path.endsWith("/comments")).body
    .body;
  assert.ok(body.includes("has not signed"), "one person, singular");
  assert.ok(!body.includes("Each of you"));
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

// Section 6 of the CLA promises the record names the version signed and links
// to that exact text. A `blob/main` link cannot: publishing a new version
// silently repoints every past record at wording its signer never read.
test("the record names the CLA version and pins the link to the commit read", async () => {
  const { calls } = await run({
    prAuthor: "outsider",
    signatures: [],
    comment: { author: "outsider", body: SIGN_PHRASE },
    env: { CLA_REF: "c0ffee" },
  });
  const write = calls.find((call) => call.method === "PUT");
  const recorded = JSON.parse(Buffer.from(write.body.content, "base64").toString("utf8"));
  const version = readFileSync(join(repoRoot, "CLA.md"), "utf8").match(/^Version\s+(\S+)/m)[1];
  assert.equal(recorded[0].claVersion, version);
  assert.equal(recorded[0].cla, `https://github.com/${REPO}/blob/c0ffee/CLA.md`);
});

// A gate that cannot read the version cannot keep that promise, so it must go
// red rather than record signatures against nothing.
for (const [what, CLA_FILE] of [
  ["with no version line", ".github/cla-allowlist.txt"],
  ["that does not exist", "CLA-does-not-exist.md"],
]) {
  test(`a CLA document ${what} fails the gate instead of signing`, async () => {
    const { status, calls } = await run({
      prAuthor: "outsider",
      signatures: [],
      comment: { author: "outsider", body: SIGN_PHRASE },
      env: { CLA_FILE },
    });
    assert.ok(!wrote(calls, "PUT", "contents/signatures.json"));
    assert.notEqual(status, 0);
  });
}

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

// The gate runs on edited comments because the near-miss note asks for a
// correction, and editing the comment you just posted is the obvious way to make
// one. Posting a second comment must not be the only path that works.
test("editing your own comment into the phrase signs", async () => {
  const { calls } = await run({
    prAuthor: "outsider",
    signatures: [],
    comment: { author: "outsider", sender: "outsider", body: SIGN_PHRASE },
  });
  assert.ok(wrote(calls, "PUT", "contents/signatures.json"));
  assert.equal(statusState(calls), "success");
});

// Anyone with write access can edit somebody else's comment. Without this the
// phrase could be typed into a contributor's comment on their behalf and
// recorded as their signature - one they never gave.
test("a comment edited by somebody other than its author does not sign", async () => {
  const { calls } = await run({
    prAuthor: "outsider",
    signatures: [],
    comment: { author: "outsider", sender: "maintainer", body: SIGN_PHRASE },
  });
  assert.ok(!wrote(calls, "PUT", "contents/signatures.json"), "a signature may not be forged");
  assert.equal(statusState(calls), "failure");
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

// Every one of these failed before, silently: the gate said nothing and the
// contributor believed they had signed.
for (const [what, body] of [
  ["a trailing full stop", `${SIGN_PHRASE}.`],
  ["a capital letter out of place", SIGN_PHRASE.toUpperCase()],
  ["leading and trailing whitespace", `   ${SIGN_PHRASE}   `],
  ["the emphasis GitHub's editor adds", `**${SIGN_PHRASE}**`],
  ["a doubled space", SIGN_PHRASE.replace(" agree", "  agree")],
  // The gate offers the phrase in a fenced block, so backticks are exactly what
  // a contributor has to hand. The leading and trailing delimiter classes drifted
  // apart once and this was rejected while `**bold**` signed.
  ["an inline code span", `\`${SIGN_PHRASE}\``],
  ["a dash bullet", `- ${SIGN_PHRASE}`],
]) {
  test(`${what} still signs`, async () => {
    // A variant built by a `replace` that no longer matches stops being a
    // variant and silently re-tests the plain phrase - which is exactly how the
    // doubled space stopped testing anything when the phrase was shortened.
    assert.notEqual(body, SIGN_PHRASE, `${what} is not a variant of the phrase`);
    const { calls } = await run({
      prAuthor: "outsider",
      signatures: [],
      comment: { author: "outsider", body },
    });
    assert.ok(wrote(calls, "PUT", "contents/signatures.json"), `${what} was rejected`);
    assert.equal(statusState(calls), "success");
  });
}

// Quoting the request while asking what it means must not be assent. This is
// why the leading `>` is left in place rather than stripped with the rest.
test("quoting the request back does not sign", async () => {
  const { calls } = await run({
    prAuthor: "outsider",
    signatures: [],
    comment: { author: "outsider", body: `> ${SIGN_PHRASE}\n\nwait, what does this mean?` },
  });
  assert.ok(!wrote(calls, "PUT", "contents/signatures.json"));
  assert.equal(statusState(calls), "failure");
});

// Not signing is the right verdict for all of these. Not SAYING so is not: a
// contributor who typed the words and got nothing back believes they signed.
const commentText = (calls) =>
  calls.find((call) => call.method === "POST" && call.path.endsWith("/comments"))?.body.body ??
  calls.find((call) => call.method === "PATCH" && call.path.includes("issues/comments/"))?.body.body;

for (const [what, body] of [
  ["quoted", `> ${SIGN_PHRASE}\n\nwait, what does this mean?`],
  ["padded with other words", `${SIGN_PHRASE} and I think it is fine`],
]) {
  test(`a near miss - ${what} - is told why it did not count`, async () => {
    const { calls } = await run({
      prAuthor: "outsider",
      signatures: [],
      comment: { author: "outsider", body },
    });
    assert.ok(!wrote(calls, "PUT", "contents/signatures.json"), "a near miss must not sign");
    assert.match(commentText(calls), /^> \[!NOTE\]$/m);
    assert.ok(commentText(calls).includes("not as the whole line"));
  });
}

test("an ordinary unsigned pull request is not accused of a near miss", async () => {
  const { calls } = await run({ prAuthor: "outsider", signatures: [] });
  assert.ok(!commentText(calls).includes("not as the whole line"));
});

// Naming the document is not the same as reaching it. Every place the comment
// says CLA is a way to go read it.
test("the comment links every mention of the CLA to the document", async () => {
  const { calls } = await run({ prAuthor: "outsider", signatures: [] });
  const body = calls.find((call) => call.method === "POST" && call.path.endsWith("/comments")).body
    .body;
  const doc = "https://github.com/rom-weaver/rom-weaver/blob/main/CLA.md";
  assert.ok(body.includes(`[CLA](${doc})`), "the warning must link the CLA it names");
  assert.ok(!body.includes("[Agreement]"), "the document is named, not paraphrased");
});

// The magic word is gone: editing a comment is what re-runs the gate, and that
// is the correction path the near-miss note asks for. A comment advertising a
// keyword the workflow no longer matches would be worse than saying nothing.
test("the comment offers editing, not a recheck keyword", async () => {
  const { calls } = await run({ prAuthor: "outsider", signatures: [] });
  const body = calls.find((call) => call.method === "POST" && call.path.endsWith("/comments")).body
    .body;
  assert.ok(body.includes("Edit a comment or post another to retry."));
  assert.ok(!body.includes("recheck"), "no keyword the prefilter would ignore");
});

test("the workflow prefilter matches no keyword the comment does not offer", () => {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/pull-request.yml"), "utf8");
  const clauses = [...workflow.matchAll(/contains\(github\.event\.comment\.body, '([^']+)'\)/g)];
  assert.deepEqual(
    clauses.map(([, keyword]) => keyword),
    ["CLA"],
    "the prefilter keeps exactly one keyword, and the signing phrase carries it",
  );
  // The guarantee the single keyword rests on.
  const phrase = readFileSync(script, "utf8").match(/^const SIGN_PHRASE = "(.+)";$/m)[1];
  assert.ok(phrase.includes("CLA"), "the phrase must carry the keyword that lets the job run");
});

test("the phrase is offered in a fenced block, which is what carries the copy button", async () => {
  const { calls } = await run({ prAuthor: "outsider", signatures: [] });
  const body = calls.find((call) => call.method === "POST" && call.path.endsWith("/comments")).body
    .body;
  assert.ok(body.includes(`\`\`\`\n${SIGN_PHRASE}\n\`\`\``), "the phrase must be fenced");
});

test("a commit author with no linked account is reported, not skipped", async () => {
  const { calls } = await run({
    prAuthor: "dependabot[bot]",
    commitAuthors: [null],
    signatures: [],
  });
  assert.equal(statusState(calls), "failure");
});
